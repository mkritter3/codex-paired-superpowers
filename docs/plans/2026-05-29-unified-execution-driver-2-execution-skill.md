# Unified Execution Driver — Plan 2: execution skill, commands, and driver wiring

**Spec:** `docs/specs/2026-05-29-unified-execution-driver-design.md`

Date: 2026-05-29
Status: plan draft

## What this plan delivers

The spec is app-scoped and rolls out over four plans. **Plan 1** (shipped) built the pure routing
core `lib/codex-bridge/execution/split-dispatcher.js` (`normalizeSplit` + `runSplit`). This is
**Plan 2**: the user-facing entry-point layer that sits on top of that core.

Goals delivered here (spec §"Goals"):

- **Goal 1** — a user launches any stable driver (`interactive` | `autopilot`) from one canonical
  place: a new `skills/execution/SKILL.md` front door and a new `/execute` command.
- **Goal 3** — interactive execution can run the `hybrid-ui-backend` split by threading
  `mode: 'interactive'` through `runSplit` into the existing `runHybridSlice`.
- **Goal 5** — `/autopilot` keeps working with behavior-identical unattended-single-plan semantics,
  now as a thin alias that invokes `execution` with `driver: autopilot`.

Goal 2 substrate (split parse/normalize/route) shipped in Plan 1. Goals 4 (reviewer rename) and 6
(canonical doc) are Plans 3 and 4.

## Design decisions (read before the slices)

### 1. The single-implementer split returns a directive; it does not dispatch

Plan 1 left a `_runSingle()` placeholder in `split-dispatcher.js` that throws. The reason it can't
simply "call the single path" is structural: the single-implementer path is **skill-level
orchestration** — Claude (the orchestrator) dispatches one implementing subagent via the Task tool
(`skills/subagent-driven-development/SKILL.md` Step A, lines 22-23). There is no callable JS function
that spawns a subagent, and `runSplit` (a pure routing module by Plan 1's charter) must not acquire
one.

Resolution: `runSplit`'s `single` route returns a **normalized dispatch directive**
(`{ kind: 'dispatch-single', driver, specPath, sliceId, repoRoot }`) instead of throwing. The skill
orchestrator reads `outcome.kind === 'dispatch-single'` and performs the existing Step A subagent
dispatch (interactive) or the existing single-implementer phase (autopilot). This keeps `runSplit`
total over all three splits, keeps it pure (no Task/subagent I/O), and matches how single dispatch
works today. `deps.runSingle` injection is preserved for tests; production uses the default that
returns the directive.

This is asymmetric with `two-disjoint` (which *calls* `dispatchImplementers`) and `hybrid-ui-backend`
(which *calls* `runHybridSlice`) — but that asymmetry is real: those two have JS engines, single does
not. The directive is the honest representation of "the orchestrator must do this step."

### Section-scoping helper for `skill-dispatch-integration.test.js`

Slices 4 and 5 add **section-scoped** assertions (so a test can't pass on prose living elsewhere in
the skill). The `sectionByHeader` helper exists only in `tests/skills/skill-structure.test.js`
(lines 727-736), NOT in `tests/skills/skill-dispatch-integration.test.js`. Those slices must therefore
add a small local copy of `sectionByHeader` (or an equivalent inline section slice) inside
`skill-dispatch-integration.test.js` — do not assume it is importable. (Codex plan-review round-1
caution.)

### 2. `execution` is a thin front door that delegates to the existing driver skills

Per spec §"Driver behavior", `skills/execution/SKILL.md` does not reimplement either driver. It
normalizes the split decision and delegates:

- `driver: interactive` → the existing `subagent-driven-development` flow, per work item.
- `driver: autopilot` → the existing `autopilot` flow, unchanged.

The existing skills remain the implementations; `execution` is the user-facing name.

### 3. `/autopilot` compatibility tests land before the command is touched

Spec §"Residual risk": the strongest risk is accidentally making `/autopilot` more than an alias.
Slice 3 writes the compatibility assertions (delegates to `execution` with `driver: autopilot`,
preserves `$ARGUMENTS`, keeps usage/resume prose) **before** editing `commands/autopilot.md`.

## Dependency order

```
Slice 1 (single-path directive, pure JS — no skill deps)
  └─> Slice 2 (execution skill + /execute command — the front door)
        ├─> Slice 3 (/autopilot alias — needs execution skill to point at)
        ├─> Slice 4 (interactive driver wiring incl. hybrid — extends execution skill)
        └─> Slice 5 (autopilot split-normalization decision point — extends execution + autopilot)
```

Slice 1 is independent and ships first (it unblocks the skill's single route). Slices 3-5 all build on
Slice 2's `execution` skill.

---

## Slice 1: Single-path dispatch directive (replace the `_runSingle` placeholder)

**Validation:** standard

Spec authority: §"Shared split dispatcher" — `runSplit` "Route `single` to the current
single-implementer path" and "Return a normalized outcome shape for both stable drivers." Pure JS,
fully unit-testable with injected deps.

### Files

- `lib/codex-bridge/execution/split-dispatcher.js` (modify): replace the throwing `_runSingle()` with
  one that returns the normalized dispatch directive.
- `tests/codex-bridge/execution/split-dispatcher.test.js` (modify): update the existing "case 9"
  (currently asserts `_runSingle` throws) to assert the directive; add a directive-shape assertion.

### Tasks

1. (RED) In `split-dispatcher.test.js`, rewrite "slice-2 case 9: single with no deps.runSingle →
   _runSingle default throws not-yet-wired" to instead assert: `runSplit({driver:'autopilot', ...})`
   on a `**Split:** single` slice with NO `deps.runSingle` resolves to
   `{ ok: true, split: 'single', outcome: { kind: 'dispatch-single', driver: 'autopilot',
   specPath: 's.md', sliceId: 'slice-1', repoRoot: '/repo' } }`. Run the file — it fails (current
   default throws).
2. (GREEN) In `split-dispatcher.js`, replace the body of `_runSingle` with:
   ```js
   function _runSingle({ driver, specPath, sliceId, repoRoot }) {
     return { kind: 'dispatch-single', driver, specPath, sliceId, repoRoot };
   }
   ```
   Update the doc comment to describe the directive contract (the orchestrator performs the actual
   Task/subagent dispatch; this function only names the work). Update the `single` case in `runSplit`
   to pass `driver` through: `outcome = await runSingle({ driver, specPath, sliceId: workItem.sliceId, repoRoot });`
   (it already passes the other three — add `driver`).
3. (GREEN) Add "slice-2 case 9b": injected `deps.runSingle` still wins over the default (DI preserved)
   — pass a spy and assert the spy is called once and the default directive is NOT produced.
4. Run `node --test tests/codex-bridge/execution/split-dispatcher.test.js` — all green.

### Tests required

1. **Default single directive shape.** `**Split:** single`, no `deps.runSingle`, `driver: autopilot`
   → outcome is exactly `{kind:'dispatch-single', driver, specPath, sliceId, repoRoot}`. Pins the
   contract the skill orchestrator reads. Integration via the real `runSplit` (no mock of the unit
   under test). Fails on Plan 1's throwing placeholder.
2. **Driver threaded into the directive.** Same as (1) but `driver: interactive` → directive carries
   `driver: 'interactive'`. Pins that the single path knows which driver is active (the orchestrator
   uses it to pick Step A vs autopilot single phase).
3. **DI override still wins.** `deps.runSingle` spy provided → spy called once, default directive not
   used. Pins that Slice 1 does not break the injection seam tests rely on.
4. **No regression in the other two routes.** Re-run the full dispatcher file (29 existing + new) →
   two-disjoint and hybrid routes unchanged.

---

## Slice 2: Unified `execution` skill + `/execute` command

**Validation:** standard

Spec authority: §"User-facing entry points" (lines 88-134) and §"Driver behavior" (lines 206-245).
This slice creates the front door and its command; the per-split driver wiring prose is filled in by
Slices 4-5.

### Files

- `skills/execution/SKILL.md` (new): the canonical stable execution skill.
- `commands/execute.md` (new): the `/execute` command.
- `tests/skills/skill-structure.test.js` (modify): add a `## ` section for the unified execution
  entry points with presence + selection-rule assertions.

### Tasks

1. (RED) In `skill-structure.test.js`, add tests asserting:
   - `skills/execution/SKILL.md` exists (read via the existing `readSkill('execution')` helper or a
     direct path read).
   - The execution skill names both `driver: interactive` and `driver: autopilot`.
   - The execution skill documents the no-argument resume rule as **autopilot-only** (matches spec
     selection rule 3) and that `driver: interactive` always requires a plan path / is non-resumable
     in v1 (rules 4).
   - `commands/execute.md` exists, documents `driver=<interactive|autopilot>` with a plan path, and
     documents no-argument resume as autopilot-only.
   Run the file — fails (files absent).
2. (GREEN) Create `skills/execution/SKILL.md` with:
   - Frontmatter `name: execution`, a description naming it the stable execution entry point.
   - Inputs block: `driver: interactive | autopilot`, `plan: docs/plans/<plan>.md | omitted-for-resume`.
   - Selection rules 1-7 verbatim-in-spirit from spec lines 99-107 (invoked by `/autopilot` →
     `driver: autopilot`; `/execute` with plan requires driver; `/execute` no-arg → autopilot-only
     resume via the same sidecar scan as `/autopilot`; interactive non-resumable + plan-path-required;
     the one-question fallback when driver missing; interactive delegates to the interactive flow
     after split normalization; autopilot delegates to the autopilot flow after split normalization).
   - A short "what this delegates to" note: interactive → `subagent-driven-development`; autopilot →
     `autopilot`. Plain-English status requirement (no "slice"/"SHIP"/"Phase B" in user-visible output).
   - Placeholder section headers `## Driver: interactive` and `## Driver: autopilot` that Slices 4-5
     fill (so those slices have a stable anchor to extend). Each may carry a one-line "(wired in a
     later step)" stub for now — but the selection-rule prose this slice's tests assert must be
     complete.
3. (GREEN) Create `commands/execute.md` per spec lines 113-125: frontmatter `description` +
   `argument-hint`; body invokes `codex-paired-superpowers:execution` with the supplied driver and
   plan path; no-arg resumes only the single in-progress autopilot run using the same sidecar scan as
   `/autopilot`; `Arguments: $ARGUMENTS`.
4. Run `node --test tests/skills/skill-structure.test.js` — green.

### Tests required

1. **`execution` skill exists and names both drivers.** Structure test reads the skill and asserts it
   contains `driver: interactive` and `driver: autopilot`. Pins Goal 1's single canonical place.
2. **No-arg resume is autopilot-only, scoped to the skill's selection-rules section.** Use the
   `sectionByHeader` helper (already in the test file, lines 727-736) to scope the assertion to the
   selection-rules `## ` section so it can't pass on unrelated prose. Asserts the section states
   no-argument resume resolves only autopilot runs and reuses the `/autopilot` sidecar scan.
3. **Interactive requires a plan path / is non-resumable.** Scoped section assertion: the skill states
   `driver: interactive` always needs a plan path and is not resumed from sidecar state in v1.
4. **`/execute` command exists and documents driver + no-arg autopilot resume.** Structure test reads
   `commands/execute.md`, asserts it requires `driver=<interactive|autopilot>` with a plan path and
   documents no-argument resume as autopilot-only. Pins the command surface for Goal 1.
5. **Plain-English output guard.** Assert the execution skill's user-facing-output instruction forbids
   internal labels (`slice`, `SHIP`, `Phase B`) in user-visible status — mirrors spec line 86 and the
   user's output-tone preference.
6. **`/execute` actually launches the skill and forwards arguments.** Assert `commands/execute.md`
   contains `codex-paired-superpowers:execution` (the command invokes the skill, not merely documents
   it) AND ends with / contains `Arguments: $ARGUMENTS` (raw argument forwarding). Without this, the
   command could document driver/resume correctly yet launch the wrong skill or drop the plan path —
   a real broken-command bug the other Slice-2 tests would miss. (Expert-test panel finding.)

---

## Slice 3: `/autopilot` thin alias (behavior-identical)

**Validation:** critical

Spec authority: §"Slash commands" lines 127-134, §"Goal 5" acceptance lines 445-458, and
§"Residual risk" lines 480-482 (compatibility tests **before** the command edit). `high_stakes:
false` (no auth/credentials/multi-tenant surface), but `critical` validation because a regression here
silently breaks every existing `/autopilot` user.

### Files

- `tests/skills/skill-structure.test.js` (modify): add `/autopilot`-delegation + preservation tests.
- `commands/autopilot.md` (modify): convert the "What happens" section into a thin alias.

### Tasks

1. (RED) In `skill-structure.test.js`, add tests asserting on the content of `commands/autopilot.md`:
   - It invokes `codex-paired-superpowers:execution` with `driver: autopilot` (string match on both
     `codex-paired-superpowers:execution` and `driver: autopilot`).
   - It still ends with `Plan: $ARGUMENTS` (argument forwarding preserved).
   - The usage block (lines 15-18 today) and the "How resume works" section header
     (`## How resume works (read this for session handoff)`) are still present (no behavior/wording
     change to resume semantics).
   Run the file — fails (command still says "Invoke the `codex-paired-superpowers:autopilot` skill").
2. (GREEN) Edit `commands/autopilot.md`:
   - In the "## What happens" section (lines 45-54), replace "Invoke the
     `codex-paired-superpowers:autopilot` skill with the plan path (or the resolved in-progress plan)"
     with "Invoke `codex-paired-superpowers:execution` with `driver: autopilot` and the plan path (or
     the resolved in-progress plan). The execution skill forwards to the same autopilot flow — resume
     discovery, sidecar state, halt-envelope behavior, and self-continuation are unchanged."
   - Leave the description, argument-hint, usage block, resume prose, preconditions, and the trailing
     `Plan: $ARGUMENTS` untouched.
3. Run `node --test tests/skills/skill-structure.test.js` — green.

### Tests required

1. **`/autopilot` delegates to `execution` with `driver: autopilot`.** String match on the command
   file for both tokens. Pins Goal 5's alias behavior. Fails on the pre-edit command text.
2. **`$ARGUMENTS` forwarding preserved.** Assert the file still ends with `Plan: $ARGUMENTS`. Pins that
   the alias does not drop the plan path.
3. **Full resume-discovery section unchanged (scoped snapshot).** Not just the header + usage lines:
   capture the entire `## How resume works (read this for session handoff)` section (header to the next
   `## `, via a local section slice) and assert it is byte-identical to the pre-edit text. This catches
   accidental changes to the sidecar-scan semantics, terminal-halt handling, the "exactly one / several
   / none" ambiguity branches, and the handoff note — the body where a critical-alias regression would
   actually hide (spec §"Residual risk"). Also keep the two usage lines (`/autopilot` resume,
   `/autopilot docs/plans/<plan>.md`) asserted present. (Expert-test panel finding — header-only was
   too weak for a critical alias.)
4. **No new flags introduced.** Negative assertion: the command file introduces no `--` flags or
   argument shapes absent today (guard against accidental scope creep flagged in residual risk).

---

## Slice 4: Interactive driver wiring through `runSplit` (incl. interactive hybrid)

**Validation:** critical

Spec authority: §"Driver behavior → driver: interactive" lines 208-231 and §"Goal 3" lines 416-427.
`critical` because the hybrid path is the headline new capability and its dirty-checkout halt must
surface correctly. `high_stakes: false`.

### Files

- `skills/execution/SKILL.md` (modify): fill the `## Driver: interactive` section.
- `tests/skills/skill-dispatch-integration.test.js` (modify): add interactive-driver seam tests.
- (read-only reference, no edit) `lib/codex-bridge/hybrid/runner.js` — `runHybridSlice` accepts
  `mode: 'interactive'` (lines 329-330) with a dirty-checkout guard returning
  `hybrid-preflight-dirty` (lines 199-202). Plan 1's `runSplit` already threads
  `mode = driver === 'interactive' ? 'interactive' : 'autopilot'` into `runHybridSlice` (verified by
  dispatcher "slice-2 case 4"). This slice wires the *skill* to call `runSplit` per work item.

### Tasks

1. (RED) In `skill-dispatch-integration.test.js`, first add a local `sectionByHeader` helper (copy the
   shape from `skill-structure.test.js:727-736`; it is not importable). Then add a scoped
   `## Driver: interactive` section assertion set on `skills/execution/SKILL.md`:
   - The section instructs, per work item: normalize the split (via `normalizeSplit`/`runSplit`), then
     run the corresponding split path, then domain reviewers, then Codex paired review (mirrors spec
     lines 212-218).
   - `single` → act on the `dispatch-single` directive by running the existing Step A subagent
     dispatch (names `subagent-driven-development` Step A).
   - `two-disjoint` → `dispatchImplementers` + existing merge/post-merge-review path.
   - `hybrid-ui-backend` → `runHybridSlice({ mode: 'interactive', ... })`, UI owner `claude-inline`,
     backend owner `codex-background-bash`.
   - The interactive dirty-checkout halt (`hybrid-preflight-dirty`) is surfaced to the user in plain
     English (no raw halt code in user-visible text).
   Run the file — fails (section is a stub from Slice 2).
2. (GREEN) Write the `## Driver: interactive` section of `skills/execution/SKILL.md` with that
   per-work-item flow, naming `runSplit`, the three split paths, the `claude-inline`/
   `codex-background-bash` owner runtimes, and a plain-English rendering of the dirty-checkout halt
   ("Your working tree has uncommitted changes; commit or stash them before running a hybrid step,
   then re-run.").
3. (GREEN) Add a one-line cross-reference in `skills/subagent-driven-development/SKILL.md` noting it is
   the interactive driver implementation reached through `execution` (spec line 328) — minimal, does
   not change its per-slice flow.
4. Run `node --test tests/skills/skill-dispatch-integration.test.js` and
   `node --test tests/codex-bridge/hybrid/runner.test.js` (existing hybrid runner tests stay green —
   Goal 3 test evidence) .

### Tests required

1. **Interactive section documents the per-work-item flow.** Scoped section assertion: normalize →
   run split → reviewers → Codex review, in that order. Pins Goal 3 + the interactive driver shape.
2. **Interactive hybrid routes with `mode: 'interactive'`.** Assert the section states hybrid calls
   `runHybridSlice({ mode: 'interactive' })` with `claude-inline` UI + `codex-background-bash` backend.
   The unit that the dispatcher actually threads `mode: 'interactive'` is already pinned by dispatcher
   "slice-2 case 4" (Plan 1) — this test pins the skill prose that triggers it. Cite both so the TDD
   panel sees the unit+prose pairing.
3. **Dirty-checkout halt surfaced in plain English.** Assert the section renders `hybrid-preflight-dirty`
   as a plain-English message and does NOT print the raw code to the user. Pins spec line 422-423 +
   output-tone.
4. **Existing hybrid runner tests remain green.** Re-run `tests/codex-bridge/hybrid/runner.test.js`
   unchanged — proves Goal 3 wires the existing runner, not a new one (spec line 427).

---

## Slice 5: Autopilot split-normalization decision point

**Validation:** critical

Spec authority: §"Driver behavior → driver: autopilot" lines 233-245 and §"Goal 5"/§"Residual risk"
(legacy `**Implementers:**` N>2 plans must keep working). `critical` because this must be
behavior-identical for every existing plan. `high_stakes: false`.

### Files

- `skills/execution/SKILL.md` (modify): fill the `## Driver: autopilot` section (delegates to
  `autopilot` after split normalization).
- `skills/autopilot/SKILL.md` (modify): note that the Phase B decision point now reads the canonical
  `**Split:**` directive via `normalizeSplit`, falling back to the existing legacy inference; behavior
  identical for legacy plans.
- `tests/skills/skill-dispatch-integration.test.js` (modify): add autopilot-driver seam tests + the
  legacy-compatibility assertions.

### Tasks

1. (RED) In `skill-dispatch-integration.test.js`, add:
   - A scoped `## Driver: autopilot` section assertion on `skills/execution/SKILL.md`: it delegates to
     the existing `autopilot` flow and only adds split normalization at the Phase B decision point;
     no new resume discovery, defaults, or prompts (residual-risk guard).
   - An autopilot Phase B assertion on `skills/autopilot/SKILL.md`: the Phase B branch consults
     `normalizeSplit` / the `**Split:**` directive, and explicitly preserves the legacy paths — no
     `**Split:**` + no block → single; legacy `**Implementers:**` (incl. N>2 under existing parser
     caps) → `dispatchImplementers`; legacy `**Orchestration:** hybrid` → `runHybridSlice` autopilot.
   Run the file — fails (autopilot section stub + no normalization prose in autopilot).
2. (GREEN) Write the `## Driver: autopilot` section of `skills/execution/SKILL.md`: "Delegate to the
   `autopilot` skill unchanged; the only addition is reading the canonical `**Split:**` directive at
   the existing Phase B decision point via `normalizeSplit`. For a `single` work item, the router
   returns the `dispatch-single` directive (Slice 1) and autopilot runs its existing single-implementer
   phase on it — autopilot, not the router, still owns that dispatch. Resume discovery, sidecar state,
   halt envelope, outer-mode, and self-continuation remain owned by `autopilot`." Make the
   `single` → `dispatch-single` → autopilot-single-phase relationship explicit so a future maintainer
   cannot accidentally bypass the Plan 1 router (Codex plan-review round-1 caution).
3. (GREEN) Edit `skills/autopilot/SKILL.md` Phase B sections (the implementer-experts branch at
   ~1741 and the hybrid branch at ~1758): add a short lead-in stating the canonical reader is
   `**Split:**` via `normalizeSplit` (Plan 1's `lib/codex-bridge/execution/split-dispatcher.js`), and
   that absent a `**Split:**` directive the existing legacy inference (no block → single;
   `**Implementers:**` → dispatchImplementers; `**Orchestration:** hybrid` → runHybridSlice) is
   unchanged. Do NOT change the actual routing targets or the N>2 cap behavior.
4. Run `node --test tests/skills/skill-dispatch-integration.test.js` and the legacy split-syntax
   coverage in `tests/codex-bridge/execution/split-dispatcher.test.js` (Plan 1 already pins: no
   directive → single, legacy `**Implementers:**` → two-disjoint incl. 3-member, legacy
   `**Orchestration:** hybrid` → hybrid). Then `npm run test:affected`.

### Tests required

1. **Autopilot section delegates without new behavior.** Scoped section assertion: `execution`'s
   autopilot section states it delegates to `autopilot` unchanged and only adds split normalization at
   Phase B. Negative check: no new resume/flag prose. Pins residual-risk guard.
2. **Autopilot Phase B reads `**Split:**` via `normalizeSplit`, preserves legacy inference.** Scoped
   assertion on `skills/autopilot/SKILL.md`: names `normalizeSplit` and re-states the three legacy
   routings as still valid. Pins Goal 5 compatibility.
3. **Legacy N-member `**Implementers:**` still routes to `dispatchImplementers`.** Reuse the Plan 1
   dispatcher test (legacy 3-member block → two-disjoint, no `**Split:**`) as the executable evidence;
   cite it here so the TDD panel sees the compatibility floor is pinned. No new code path.
4. **Behavior-identical smoke for the three legacy shapes.** Assert (via the dispatcher unit tests
   already present) that no-directive → single, `**Implementers:**` → two-disjoint, and
   `**Orchestration:** hybrid` → hybrid still hold after the skill edits (the edits are prose-only, so
   the unit behavior must be unchanged — this is the regression guard).

---

## Verification (whole plan)

```bash
node --test tests/codex-bridge/execution/split-dispatcher.test.js
node --test tests/skills/skill-structure.test.js tests/skills/skill-dispatch-integration.test.js
node --test tests/codex-bridge/hybrid/runner.test.js
npm run test:affected
```

All four must be green before the plan is considered shipped. The dispatcher and hybrid-runner suites
prove no engine behavior changed; the skill structure/dispatch-integration suites prove the new
entry-point surfaces exist and carry the required prose.

## Out of scope (later plans)

- Reviewer/expert naming migration (`composeReviewers`, `reviewer-*` ids/modules/prompts, sidecar
  field migration) — Plan 3.
- `docs/execution-model.md` canonical three-choice doc + README cross-links + duplicate-matrix grep
  guard — Plan 4.
- Folding `app-autopilot` into `execution` — deferred (spec §"Deferred"); `/execute
  driver=app-autopilot` must stop with a plain-English "experimental, invoke via app-autopilot"
  warning, but even that warning is deferred to a later plan unless the user pulls it forward.
