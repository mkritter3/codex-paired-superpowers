# Unified Execution Driver — Plan 1: Shared split dispatcher

**Spec:** `docs/specs/2026-05-29-unified-execution-driver-design.md`
**Date:** 2026-05-29
**Owner:** mkr
**Validation:** critical

## Orientation

The spec is app-scoped and rolls out over several plans (see "App rollout map" below). This is **Plan 1**:
the shared split dispatcher — the pure routing-and-normalization core that every later plan wires
through. It introduces no user-facing behavior change: no skill, command, or README edits land here.
That isolation is deliberate — the routing core is fully unit-testable with dependency injection (spec
§"Shared split dispatcher", lines 159-199), so it can ship and be trusted before any entry point depends
on it.

Reuse-over-rebuild is load-bearing. The spec's audit (and an independent re-audit while drafting this
plan, plus Codex's round-1 plan audit) confirmed the parsers and runners already exist; this plan
**routes through** them and adds only the `**Split:**` directive reader, an `**Orchestration:**` marker
reader, and a thin router:

- `parseImplementersBlock(planMarkdown, sliceSection)` — `lib/codex-bridge/implementer/frontmatter.js:440`;
  returns `{ implementers, high_cost, high_cost_rationale }` or `null`, validates the implementer cap
  (4-5 require `high_cost`+rationale; >5 throws `role-composer-fan-out-unjustified`) and file overlap.
  **Critical constraint (verified round 1):** its `allowedAdapters` set is `{claude-cli, codex-cli}`
  (`frontmatter.js:303`), so it **throws `implementer-directive-malformed` on hybrid owner blocks**
  (`adapter: claude-ui` / `codex-background-bash`). It must therefore only be called on the
  single / two-disjoint paths — never before hybrid is ruled out.
- `parseHybridOwners(planMarkdown, sliceSection)` + `validateHybridOwnership({ sliceFiles, implementers })`
  — `lib/codex-bridge/hybrid/ownership.js:78,113`; `parseHybridOwners` reads the raw owner entries
  without the implementer adapter allow-list, and `validateHybridOwnership` throws `Error` with `.code`
  set to an existing `hybrid-*` halt reason on any owner-shape violation. This is the correct parser for
  hybrid slices.
- `parseFilesBlock(sliceSection)` + `extractSliceSection(planMarkdown, sliceId)` — `lib/codex-bridge/plan-parsers.js:151,43`.
- `dispatchImplementers({ specPath, repoRoot, sliceId, implementerRunId, baseSha, implementers, dispatchFn, _deps })`
  — `lib/codex-bridge/implementer/orchestrator.js:73`.
- `runHybridSlice(args)` with `{ mode, repoRoot, specPath, sliceId, sliceStartSha, integrationBranch, contractWaitMs, deps }`
  — `lib/codex-bridge/hybrid/runner.js:329`; `mode ∈ {interactive, autopilot}`.
- `HALT_MAP` registry — `lib/codex-bridge/halt-envelope.js:17` (exported at :800); new halt reasons are
  added as `[reason, { terminal, resume_hint }]` entries and require updating the count/snapshot
  assertions in `tests/codex-bridge/halt-envelope.test.js`.

There is **no existing programmatic `**Orchestration:** hybrid` reader** in `lib/` (confirmed round 1 —
it lives only in skill prose), so the marker reader added here is genuinely new, not a reinvention.
The only new module is `lib/codex-bridge/execution/split-dispatcher.js` (confirmed absent:
`find lib/codex-bridge/execution` returns nothing).

### Goal → slice map (this plan)

| Spec goal | Covered here |
| --- | --- |
| Goal 2 (split independent of driver) — directive + marker parsing, normalization, invalid-combo halts | Slice 1 |
| Goal 2 — shared router + driver `mode` pass-through to the hybrid runner | Slice 2 |

Goals 1, 3, 4, 5, 6 are later plans. This plan delivers the substrate they all call.

### Dependency order

Slice 1 (parse + normalize, pure) → Slice 2 (`runSplit` routing, depends on Slice 1's `normalizeSplit`).

### App rollout map (informational — not built in this plan)

The user runs `writing-plans` + `autopilot` once per plan, same spec, until all six goals ship:

1. **Plan 1 (this plan):** shared split dispatcher — `normalizeSplit` + `runSplit`. (Goal 2 core.)
2. **Plan 2:** unified `skills/execution/SKILL.md` + `commands/execute.md` + `/autopilot` thin alias;
   interactive-hybrid wiring through `runSplit`; replaces the `_runSingle` placeholder with the real
   single path. (Goals 1, 3, 5.)
3. **Plan 3:** reviewer-naming migration (`composeReviewers`, `reviewer-*` modules/ids/prompts, sidecar
   field migration, compatibility wrappers). (Goal 4.)
4. **Plan 4:** `docs/execution-model.md` canonical doc + README/skill cross-links + the duplicate-matrix
   grep guard. (Goal 6, plus the structure tests in spec §"Tests and verification" item 1.)

---

## Slice 1: Parse and normalize the `**Split:**` directive

**Validation:** critical

Spec authority: §"Split directive" (lines 133-162) and §"Shared split dispatcher" `normalizeSplit`
(lines 184-192). Pure functions only — no dispatch, no I/O beyond reading the passed markdown.

**Parse-order invariant (the round-1 fix):** hybrid is detected and routed to `parseHybridOwners`
*before* `parseImplementersBlock` is ever called, because the latter throws on hybrid adapters.
Resolution order inside `normalizeSplit`:
1. `directive = parseSplitDirective(sliceSection)` (`single|two-disjoint|hybrid-ui-backend|null`).
2. `orchestrationHybrid = parseOrchestrationMarker(sliceSection) === 'hybrid'`.
3. If `directive === 'hybrid-ui-backend'` OR (`directive === null` AND `orchestrationHybrid`) → **hybrid
   path**: `parseHybridOwners` + `validateHybridOwnership`; never call `parseImplementersBlock`.
4. Else if `directive === 'two-disjoint'` → `parseImplementersBlock`, require exactly two.
5. Else if `directive === null` AND an `**Implementers:**` block is present → legacy `two-disjoint`
   (delegate to `parseImplementersBlock` caps, push warning).
6. Else → `single` (guard: a `single` slice with an implementers block OR an orchestration-hybrid
   marker throws `split-single-with-implementers`). **Block-presence is detected with the raw
   `extractImplementersBlockLines(sliceSection) !== null` check (exported, `frontmatter.js:119`), NOT
   `parseImplementersBlock`** — so `split-single-with-implementers` wins even when the block body uses
   hybrid-like adapters (which would otherwise throw `implementer-directive-malformed`).

**Precedence rule (explicit directive wins).** An explicit `**Split:**` directive always takes
precedence; the `**Orchestration:** hybrid` marker is consulted only for legacy inference when no
directive is present. The single case is the one definitional exception: a `single` slice has no
parallel structure, so ANY implementers/owner block or hybrid marker contradicts it and halts
(`split-single-with-implementers`). For an explicit `**Split:** two-disjoint` slice that also carries a
stray `**Orchestration:** hybrid` marker, the directive wins and the marker is **not silently dropped** —
normalization pushes a warning ("orchestration marker ignored; `**Split:**` directive takes precedence")
into `warnings`. Directive-value matching is case-sensitive against the three canonical lowercase values
after trimming surrounding whitespace; any other value (including non-canonical casing like
`Two-Disjoint`) is `split-directive-unknown`.

### Tests required

File: `tests/codex-bridge/execution/split-dispatcher.test.js` (new). All integration (real parsers), no
mocks. Each case builds a minimal in-memory plan-markdown string + slice section.

1. No directive, no legacy blocks → `{ split: 'single', legacySyntax: [], warnings: [] }`.
2. `**Split:** single` → `single`.
3. `**Split:** single` with an `**Implementers:**` block → throws `split-single-with-implementers` (assert `.code`).
4. `**Split:** two-disjoint` with exactly two implementers → `two-disjoint`, `config.implementers.length === 2`.
5. `**Split:** two-disjoint` with three implementers → throws `split-two-disjoint-not-exactly-two` (assert `.code`).
6. No `**Split:**`, legacy `**Implementers:**` (3 members, valid under existing caps) → `two-disjoint`, `legacySyntax: ['implementers']`, ≥1 warning.
7. `**Split:** hybrid-ui-backend` with one `owner: claude-ui` + one `owner: codex-backend` → `hybrid-ui-backend`, `config.owners` has both.
8. `**Split:** hybrid-ui-backend` missing the `codex-backend` owner → throws `.code === 'hybrid-ownership-malformed'` (proves delegation to `validateHybridOwnership`, NOT an `implementer-directive-malformed` from the wrong parser).
9. No `**Split:**`, legacy `**Orchestration:** hybrid` + valid owners → `hybrid-ui-backend`, `legacySyntax: ['orchestration']`, ≥1 warning.
10. Unknown `**Split:**` value (e.g. `**Split:** parallel`) → throws `split-directive-unknown` (assert `.code`).
11. `parseOrchestrationMarker`: a line `**Orchestration:** hybrid` → `'hybrid'`; absent → `null`; an unrecognized value (e.g. `**Orchestration:** serial`) → `null` (only `hybrid` is recognized; anything else is treated as no marker).
12. `**Split:** single` with an `**Orchestration:** hybrid` marker and NO implementers block → throws `split-single-with-implementers` (pins the second guard trigger, distinct from case 3's block trigger).
13. `**Split:** single` whose implementers block body uses a hybrid-like adapter (`adapter: claude-ui`) → throws `split-single-with-implementers`, and the test asserts the `.code` is NOT `implementer-directive-malformed` (pins the raw-detector design: the guard must not route a single slice through `parseImplementersBlock`).
14. `**Split:** two-disjoint` with exactly ONE implementer → throws `split-two-disjoint-not-exactly-two` (lower boundary; case 5 only covers the >2 boundary).
15. `**Split:** two-disjoint` directive line with extra inline whitespace and trailing whitespace (e.g. `**Split:**   two-disjoint  `) → parses to `two-disjoint` (pins the trim contract); a non-canonical casing `**Split:** Two-Disjoint` → throws `split-directive-unknown` (pins case-sensitivity).
16. `**Split:** two-disjoint` (two valid implementers) that ALSO carries a stray `**Orchestration:** hybrid` marker → `two-disjoint` (directive wins) with a non-empty `warnings` entry naming the ignored marker (pins the precedence rule; nothing silently dropped).
17. `**Split:** hybrid-ui-backend` with valid owners but an empty per-owner `**Files:**` partition → throws a `hybrid-*` halt code from `validateHybridOwnership` (proves the `sliceFiles` from `parseFilesBlock` is threaded into the delegated validator, not ignored).

### Tasks

1. **(RED — directive parser)** Create the test file with cases 1, 2, 10, 11. Run
   `node --test tests/codex-bridge/execution/split-dispatcher.test.js`; confirm red (module absent).
2. **(GREEN — directive + marker parsers)** Create `lib/codex-bridge/execution/split-dispatcher.js`.
   Add a local `haltError(code, detail)` helper returning an `Error` with `.code = code` (mirror
   `lib/codex-bridge/hybrid/ownership.js`). Implement `parseSplitDirective(sliceSection)` (line-anchored
   `**Split:** <value>` regex; returns the value for the three known values, `null` when absent, throws
   `split-directive-unknown` otherwise) and `parseOrchestrationMarker(sliceSection)` (line-anchored
   `**Orchestration:** <value>` regex; returns `'hybrid'` only for `hybrid`, else `null`). Re-run cases
   1, 2, 10, 11 → green.
3. **(RED — halt reasons)** Add cases 3 and 5 (they assert thrown `.code`s that don't exist yet). Run; confirm red.
4. **(GREEN — register halts)** Add three terminal entries to `HALT_MAP` in
   `lib/codex-bridge/halt-envelope.js` (after the v0.14.0 hybrid block, ~line 600), each
   `{ terminal: true, resume_hint: <plain-English fix> }`:
   - `split-single-with-implementers` — "A slice declares `**Split:** single` but also has an implementers/hybrid owner block. Remove the block or change the split."
   - `split-two-disjoint-not-exactly-two` — "A `**Split:** two-disjoint` slice must declare exactly two implementers. Use exactly two, or drop `**Split:**` to use the legacy N-member path."
   - `split-directive-unknown` — "The `**Split:**` value must be single, two-disjoint, or hybrid-ui-backend. Fix the directive."
   Update the count/snapshot assertions in `tests/codex-bridge/halt-envelope.test.js`. Run that suite + the dispatcher suite (cases 3, 5 still need `normalizeSplit`, so they stay red until task 6) — confirm the halt-envelope suite is green.
5. **(RED — normalization cases)** Add cases 4, 6, 7, 8, 9 and the boundary/precedence cases 12-17. Run;
   confirm red (`normalizeSplit` absent).
6. **(GREEN — normalizeSplit)** Implement `normalizeSplit({ planMarkdown, sliceSection })` →
   `{ split, legacySyntax: string[], warnings: string[], config: object }` following the parse-order
   invariant above exactly:
   - hybrid path: `owners = parseHybridOwners(planMarkdown, sliceSection)`;
     `validateHybridOwnership({ sliceFiles: parseFilesBlock(sliceSection), implementers: owners })` (let
     its `.code` propagate); set `config.owners = owners`.
   - explicit `two-disjoint`: `impl = parseImplementersBlock(...)`; throw
     `split-two-disjoint-not-exactly-two` unless `impl && impl.implementers.length === 2`;
     `config.implementers = impl.implementers`.
   - legacy `two-disjoint`: `impl = parseImplementersBlock(...)` (non-null); accept N per its caps;
     `legacySyntax: ['implementers']`, push a warning naming the legacy path; `config.implementers`.
   - `single`: throw `split-single-with-implementers` if `extractImplementersBlockLines(sliceSection) !== null`
     (raw presence check — never `parseImplementersBlock` here) or `orchestrationHybrid` is true; else
     `{ split: 'single', legacySyntax: [], warnings: [] }`.
   - precedence: when an explicit `two-disjoint` directive coexists with an orchestration-hybrid marker,
     keep `two-disjoint` and push the "orchestration marker ignored" warning (case 16). The explicit
     two-disjoint `length === 2` guard also covers the one-implementer lower boundary (case 14).
   - directive matching: trim the captured value and match case-sensitively against the three canonical
     values; anything else throws `split-directive-unknown` (cases 10, 15).
   Re-run cases 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17 → green. Run the full dispatcher suite → all green.
7. **(verify)** Run `node --test tests/codex-bridge/halt-envelope.test.js tests/codex-bridge/execution/split-dispatcher.test.js` → green.

### Acceptance

- All 17 Slice-1 tests pass.
- `normalizeSplit` never calls `parseImplementersBlock` on a hybrid slice (case 8 proves the error comes
  from `validateHybridOwnership`, not the wrong parser) nor on a `single` slice (case 13 proves the
  single guard uses the raw block detector).
- Both single-guard triggers (block present, orchestration marker) are independently pinned (cases 3, 12).
- Both `two-disjoint` count boundaries are pinned (case 14 lower, case 5 upper); the explicit-directive
  precedence over a stray orchestration marker is pinned with a warning (case 16, nothing silently dropped).
- `normalizeSplit` never dispatches or performs I/O beyond parsing the passed markdown.
- The three new halt reasons are registered terminal in `HALT_MAP` with plain-English resume hints, and
  the halt-envelope known-set tests pass.

---

## Slice 2: `runSplit` routing with driver `mode` pass-through

**Validation:** critical

Spec authority: §"Shared split dispatcher" `runSplit` (lines 193-199), §"Driver behavior" hybrid
`mode` mapping (lines 219, 231, 335-336), Goal-3 test evidence (lines 402-404). Router only: it calls
`normalizeSplit`, validates the driver, then delegates to the existing runners via injected
dependencies. It must NOT spawn real workers — every downstream runner is dependency-injected so tests
assert routing in isolation.

### Tests required

Append to `tests/codex-bridge/execution/split-dispatcher.test.js`. Injected spies for all runners.

1. `single` routes to `deps.runSingle` exactly once; `dispatchImplementers`/`runHybridSlice` spies not called.
2. `two-disjoint` routes to `deps.dispatchImplementers` once with `{ specPath, sliceId, implementers }` threaded from `normalizeSplit.config`.
3. `hybrid-ui-backend` routes to `deps.runHybridSlice` once.
4. `driver: 'interactive'` → `runHybridSlice` spy first-arg `.mode === 'interactive'` (Goal-3 evidence, line 404).
5. `driver: 'autopilot'` → `.mode === 'autopilot'` (line 336).
6. Invalid split (`two-disjoint` + 3 implementers) throws from `normalizeSplit`; NONE of the runner spies are called (line 337).
7. Uniform outcome shape across drivers: a `single` slice under both drivers returns the same key shape `{ ok, split, outcome }` (line 171).
8. Unknown `driver` (e.g. `'yolo'`) throws `split-unknown-driver` BEFORE `normalizeSplit` or any dispatch runs (no runner spy called).
9. `single` routed with no `deps.runSingle` → the `_runSingle` default throws the explicit "not yet wired — inject deps.runSingle" error.

### Tasks

1. **(RED — driver guard)** Add cases 8 and 9. Run; confirm red (`runSplit` absent).
2. **(GREEN — driver guard + single route)** Add a fourth `HALT_MAP` entry `split-unknown-driver`
   (`{ terminal: true, resume_hint: "Driver must be 'interactive' or 'autopilot'." }`) and update the
   halt-envelope count/snapshot tests. Implement `runSplit({ driver, planPath, specPath, workItem, repoRoot, deps = {} })`:
   validate `driver ∈ {interactive, autopilot}` first, else `throw haltError('split-unknown-driver', ...)`;
   then `const normalized = normalizeSplit({ planMarkdown: workItem.planMarkdown, sliceSection: workItem.sliceSection })`
   (let halts throw before dispatch); resolve `runSingle = deps.runSingle ?? _runSingle` where
   `_runSingle` throws "single-implementer path not yet wired — inject deps.runSingle" (Plan 2 replaces
   it); route `single → runSingle({ driver, specPath, sliceId: workItem.sliceId, repoRoot })`; return
   `{ ok, split: normalized.split, outcome }`. Re-run cases 8, 9 → green.
3. **(RED — split routing)** Add cases 1, 2, 3, 6, 7. Run; confirm red.
4. **(GREEN — two-disjoint + hybrid routes + mode map)** Import the real runners at module top
   (`dispatchImplementers`, `runHybridSlice`) as defaults; resolve `dispatch = deps.dispatchImplementers ?? dispatchImplementers`,
   `runHybrid = deps.runHybridSlice ?? runHybridSlice`. Map driver→mode once:
   `const mode = driver === 'interactive' ? 'interactive' : 'autopilot'` (safe now that unknown drivers
   are rejected in task 2). Route: `two-disjoint → dispatch({ specPath, repoRoot, sliceId, baseSha: workItem.sliceStartSha, implementers: normalized.config.implementers, dispatchFn: deps.dispatchFn })`;
   `hybrid-ui-backend → runHybrid({ mode, repoRoot, specPath, sliceId, sliceStartSha: workItem.sliceStartSha, integrationBranch: workItem.integrationBranch, deps: deps.hybridDeps })`. Add a one-line comment that
   `runSplit` only routes and owns no sidecar state (spec §"Non-responsibilities", 173-179). Re-run
   cases 1, 2, 3, 6, 7 → green.
5. **(RED — mode pass-through)** Add cases 4 and 5. Run; confirm red (or green if already satisfied — if
   green, keep them as regression pins).
6. **(GREEN/verify)** Ensure cases 4, 5 pass; run the full dispatcher suite → all green.
7. **(regression)** Run `npm run test:affected` and confirm no regressions in the implementer/hybrid/halt
   suites the new module imports from.

### Acceptance

- All Slice-2 routing tests pass; the 2×3 driver×split routing is covered (single/two-disjoint/hybrid ×
  interactive/autopilot), satisfying spec Goal-2 test evidence (lines 392-393) for the dispatcher layer.
- `runSplit` rejects unknown driver values before any parse or dispatch (no silent autopilot fallback).
- `runSplit` performs no dispatch when `normalizeSplit` throws (invalid combos halt first).
- `driver` maps to the correct `runHybridSlice` `mode` in both directions.
- No real workers are spawned by any test (all downstream runners injected).
