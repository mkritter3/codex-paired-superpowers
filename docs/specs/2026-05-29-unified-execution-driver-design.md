# Unified Execution Driver Design

Date: 2026-05-29
Scope: app-scoped, multi-plan rollout
Status: spec draft

## Goals

This spec unifies the stable execution entry points without replacing the execution engines that already exist.

1. A user launches any stable execution driver from one canonical place by choosing a `driver` value: `interactive` or `autopilot`.
2. A user chooses the per-work-item split independently of the driver: `single`, `two-disjoint`, or `hybrid-ui-backend`.
3. Interactive execution can run the hybrid UI plus backend split.
4. Reviewer naming is distinct from writer naming: the reviewer sense of "expert" becomes "reviewer"; writer naming remains implementer-oriented.
5. `/autopilot` keeps working and has behavior-identical unattended-single-plan semantics through a thin alias into the unified skill.
6. There is one short canonical three-choice mental model for users and maintainers.

## Non-goals

- Do not fold `app-autopilot` into the unified skill in v1. It remains experimental and opt-in because its own skill documents transcript-loop failure modes.
- Do not rewrite the autopilot engine, sidecar format, halt-envelope semantics, mailbox system, worktree fan-out, or hybrid runner.
- Do not remove legacy `expert-*`, `**Experts:**`, or `expert_teammates` compatibility in the first migration. Existing sidecars, plans, and docs must still be readable.

## Codebase audit

Commands were run from `/Users/mkr/local-coding/plugins/codex-paired-superpowers`.

| Audit item | Command | Result |
| --- | --- | --- |
| Worktree and file inventory | `pwd && git status --short && rg --files | sort | sed -n '1,220p'` | Repo path confirmed. Worktree has untracked `.claude/`; no pre-existing target spec file was listed. |
| Existing primitive sizes | `wc -l skills/subagent-driven-development/SKILL.md skills/autopilot/SKILL.md skills/app-autopilot/SKILL.md lib/codex-bridge/hybrid/runner.js lib/codex-bridge/implementer/orchestrator.js lib/codex-bridge/role-composer.js commands/autopilot.md` | Counts match the goal block: subagent-driven 277, autopilot 1776, app-autopilot 229, hybrid runner 502, implementer orchestrator 273, role composer 128, `/autopilot` command 59. |
| Slash commands | `find commands -maxdepth 1 -type f -name '*.md' -print | sort` | Only `commands/autopilot.md` exists today. |
| Skills | `find skills -maxdepth 2 -name SKILL.md -print | sort` | Existing skills are `app-autopilot`, `autopilot`, `brainstorming`, `doctor`, `honest-reporting`, `receiving-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, and `writing-plans`; no unified execution skill exists. |
| Interactive driver characterization | `nl -ba skills/subagent-driven-development/SKILL.md | sed -n '1,80p;180,277p'` | Lines 2-3 name the skill; lines 20-49 show the current one-implementer-per-work-item flow; lines 180-263 show reviewer composition and post-implementation review. It is the stable interactive/human-paced driver but does not currently branch on split. |
| Autopilot driver characterization | `nl -ba skills/autopilot/SKILL.md | sed -n '1,135p;202,225p;313,385p;1738,1776p'` | Lines 2-3 describe unattended single-plan autopilot; lines 16-52 document outer-mode only for `app-autopilot`; lines 202-223 describe Phase B; lines 313-371 select reviewer-domain "experts"; lines 1741-1757 route `**Implementers:**` to `dispatchImplementers`; lines 1758-1772 route `**Orchestration:** hybrid` to `runHybridSlice` in autopilot mode. |
| App-autopilot non-goal | `nl -ba skills/app-autopilot/SKILL.md | sed -n '1,40p;80,130p'` | Lines 2-3 and 8-14 explicitly mark `app-autopilot` experimental and list known infinite-loop failure modes; lines 98-123 show it invokes existing `autopilot` as an outer driver. |
| Hybrid runner interactive support | `nl -ba lib/codex-bridge/hybrid/runner.js | sed -n '1,90p;180,215p;320,450p;450,485p'` and `rg -n "export async function runHybridSlice|resolveUiRuntimeKind" lib/codex-bridge/hybrid/runner.js` | Lines 61-68 accept `mode` values `interactive` and `autopilot`, returning `claude-inline` for interactive and `claude-subagent` for autopilot. Lines 199-201 and 469-471 are interactive-specific dirty-checkout guards. Lines 329-450 show `runHybridSlice(args)` already dispatches both owners and waits on the contract. Goal 3 needs entry-point wiring, not a new runner. |
| Symmetric implementer primitive | `nl -ba lib/codex-bridge/implementer/orchestrator.js | sed -n '1,160p'` | Lines 34-73 document `dispatchImplementers`, and lines 73-160 show create/reuse modes and per-member dispatch event persistence. This is the existing symmetric parallel writer primitive. |
| Reviewer composer primitive | `nl -ba lib/codex-bridge/role-composer.js | sed -n '1,140p'` | Lines 1-18 and 47-128 confirm `composeExperts` selects reviewer identities from phases, signals, and `**Experts:**`. This is the reviewer sense that must be renamed. |
| Current plan split docs | `nl -ba skills/writing-plans/SKILL.md | sed -n '250,365p'` | Lines 288-315 document implementer-experts syntax using `**Implementers:**`; lines 317-357 document hybrid syntax using `**Orchestration:** hybrid` and the two owners. |
| Current README entry points | `nl -ba README.md | sed -n '30,50p;145,190p;220,235p'` | README currently lists `subagent-driven-development` and `autopilot` separately, and the command tree only shows `/autopilot`. This confirms the user-facing split-brain. |
| Structural tests around split docs | `nl -ba tests/skills/skill-structure.test.js | sed -n '722,810p'` | Tests pin hybrid docs in `writing-plans` and `autopilot`; they will need to move or expand to the unified mental model and interactive reachability. |
| Dispatch integration tests | `nl -ba tests/skills/skill-dispatch-integration.test.js | sed -n '1,25p;322,415p'` | Tests currently name `subagent-driven-development` and `autopilot` as separate dispatch seams and assert reviewer "expert" persistence. They must be migrated with compatibility assertions. |
| Expert/reviewer rename blast radius | `rg -l --glob '!node_modules/**' "expert|Expert|Experts|expert-" lib skills agents commands docs tests scripts package.json README.md | sort` | The reviewer rename is broader than the abbreviated goal-block list. It includes runtime modules (`expert-runtime`, `expert-turn`, `expert-resolver`, `expert-output-parser`, `expert-dm-scheduler`), sidecar fields, tests, prompts, registry ids, docs, and README. |
| Writer-side expert collision | `rg -l --glob '!node_modules/**' "expert-implementer|implementer-expert|implementer_expert|Implementers|parseImplementersBlock|dispatchImplementers" lib skills agents commands docs tests scripts README.md | sort` | Writer-side naming appears under implementer modules, docs, tests, and `skills/writing-plans/SKILL.md`. New public prose should use `two-disjoint implementers`; legacy `expert-implementer` ids remain accepted. |
| Search for existing unified primitive | `rg -n --glob '!node_modules/**' "unified.*execution|execution.*driver|driver:|driver value|split directive|Slice Split|Reviewers:|Experts:|composeReviewers|reviewer-composer|reviewer-" skills lib commands docs tests README.md` and `find docs/specs -maxdepth 1 -type f -name '*unified*execution*' -o -name '*execution*driver*' -o -name '*driver*design*'` | No existing unified execution driver, canonical split directive, `composeReviewers`, reviewer-named module family, or prior unified spec was found. Existing matches are legacy `**Experts:**`, reviewer warnings, and hybrid `**Orchestration:**` docs. |
| Proposed new paths | `for p in skills/execution/SKILL.md commands/execute.md docs/execution-model.md lib/codex-bridge/execution/split-dispatcher.js; do ...; done` | All proposed paths are absent today, so creating them will not overwrite existing primitives. |
| Test commands available | `node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"` | Verification can use `npm test`, `npm run test:affected`, `npm run test:all`, `npm run test:replay`, and targeted `node --test ...`. |

Audit conclusion: the right design is a thin unified execution layer plus docs and aliases. The engines already exist. The missing pieces are canonical driver selection, split dispatch in the interactive driver, compatibility-preserving split normalization, and reviewer naming migration.

## Canonical mental model

Create one short canonical document at `docs/execution-model.md`. README and relevant skills link to it rather than restating it.

Canonical text:

```md
# Execution Model

Choose three independent things before running implementation work:

1. Driver: who keeps the work moving.
   - `interactive`: you and Claude move one work item at a time.
   - `autopilot`: Claude keeps going across a reviewed plan until it finishes, needs help, or the session ends.

2. Split: how one work item is written.
   - `single`: one implementer writes it.
   - `two-disjoint`: two implementers work in parallel on separate files, then the branches are merged.
   - `hybrid-ui-backend`: Claude builds the UI side while Codex builds the backend side, joined by a published contract.

3. Review: who checks the result.
   - Codex paired review always runs.
   - Additional domain reviewers may be selected from the work item, affected files, or a `Reviewers` directive.

Stable combinations:

| Driver | single | two-disjoint | hybrid-ui-backend |
| --- | --- | --- | --- |
| interactive | yes | yes | yes |
| autopilot | yes | yes | yes |

The experimental multi-plan app driver is intentionally outside this table for now.
```

All user-facing status output produced by the unified skill must use plain English. It must not say "slice", "SHIP", "Phase B", or other internal workflow labels. Skill and doc identifiers may use precise implementation terms.

## User-facing entry points

### Canonical skill

Create `skills/execution/SKILL.md` as the one stable execution skill. It takes:

```yaml
driver: interactive | autopilot
plan: docs/plans/<plan>.md | omitted-for-resume
```

Selection rules:

1. If invoked by `/autopilot`, the command supplies `driver: autopilot` and forwards `$ARGUMENTS` unchanged.
2. If invoked by `/execute` with a plan path, the command requires `driver=interactive` or `driver=autopilot`.
3. If invoked by `/execute` with no arguments, v1 resume is autopilot-only: scan sidecars exactly like today's no-argument `/autopilot`, resume only if exactly one autopilot run is in progress, and otherwise show the same "none or several runs" choice/error shape as `/autopilot`.
4. `driver=interactive` is not resumable in v1. It must be invoked with a plan path, and if the session ends mid-work the user restarts interactive execution by pointing at the plan and choosing the next unfinished work item. The unified skill must not infer an interactive run from sidecar state because no interactive active-run contract exists today.
5. If invoked directly as a skill with a plan path and `driver` is missing, ask one short question: "Run this step-by-step with you in the loop, or let autopilot continue the reviewed plan?"
6. `driver: interactive` delegates to the existing interactive driver flow after split normalization.
7. `driver: autopilot` delegates to the existing autopilot flow after split normalization.

### Slash commands

Create `commands/execute.md`:

```md
---
description: "Run or resume reviewed implementation work with an explicit driver"
argument-hint: "driver=<interactive|autopilot> <plan-path>  |  omit arguments to resume one autopilot run"
---

# /execute

Invoke `codex-paired-superpowers:execution` with the supplied driver and plan path. With no arguments,
resume only the single in-progress autopilot run, using the same sidecar scan as `/autopilot`.

Arguments: $ARGUMENTS
```

Modify `commands/autopilot.md` to be a thin alias:

- Keep the existing usage and resume prose.
- Replace the final "Invoke the `codex-paired-superpowers:autopilot` skill" instruction with "Invoke `codex-paired-superpowers:execution` with `driver: autopilot`".
- Preserve `$ARGUMENTS` exactly.
- Do not add new behavior, flags, resume semantics, or wording that changes existing `/autopilot` expectations.

Rationale: `/execute` gives the unified place required by Goal 1. `/autopilot` remains the compatibility entry point required by Goal 5.

## Split directive

Add a canonical per-work-item directive:

```md
**Split:** single | two-disjoint | hybrid-ui-backend
```

Normalization rules:

| Plan syntax | Canonical split | Compatibility behavior |
| --- | --- | --- |
| No `**Split:**`, no `**Implementers:**`, no `**Orchestration:** hybrid` | `single` | Existing plans keep working. |
| `**Split:** single` | `single` | Must not include `**Implementers:**` or `**Orchestration:** hybrid`. |
| `**Split:** two-disjoint` plus `**Implementers:**` | `two-disjoint` | New canonical plans must declare exactly two disjoint implementers. This keeps the stable mental model to one symmetric pair and avoids making users reason about N-way writer topology in v1. |
| No `**Split:**`, with legacy `**Implementers:**` | `two-disjoint` compatibility mode | Existing plans keep routing through `dispatchImplementers`, including N>2 members subject to the existing parser caps (`4-5` require `high_cost` plus rationale; `6+` halt). New plans should not use this to bypass the canonical two-implementer split. |
| `**Split:** hybrid-ui-backend` plus hybrid owners | `hybrid-ui-backend` | New spelling maps to the existing `**Orchestration:** hybrid` structure. Legacy `**Orchestration:** hybrid` without `**Split:**` remains valid. |

Invalid combinations halt before implementation:

- `**Split:** single` with an `**Implementers:**` block.
- `**Split:** two-disjoint` with anything other than exactly two implementers.
- `**Split:** two-disjoint` with overlapping claimed files and no existing overlap-rationale path.
- `**Split:** hybrid-ui-backend` without exactly one `owner: claude-ui` and one `owner: codex-backend`.
- `**Split:** hybrid-ui-backend` where the backend owner does not publish the contract or the UI owner does not claim the local stand-in file.

`skills/writing-plans/SKILL.md` must emit `**Split:**` for every new work item. It may continue to include legacy `**Orchestration:** hybrid` for one release as a compatibility marker, but the canonical reader is `**Split:**`.

## Shared split dispatcher

Create `lib/codex-bridge/execution/split-dispatcher.js` as a small routing module, not a new engine.

Responsibilities:

- Parse and normalize one work item's split directive.
- Validate split-specific preconditions before dispatch.
- Route `single` to the current single-implementer path.
- Route `two-disjoint` to existing `dispatchImplementers` and the existing merge/post-merge-review path.
- Route `hybrid-ui-backend` to existing `runHybridSlice`.
- Pass driver mode through to split runners: `interactive` or `autopilot`.
- Return a normalized outcome shape for both stable drivers.

Non-responsibilities:

- It does not decide which driver is active.
- It does not replace sidecar persistence.
- It does not replace `dispatchImplementers`.
- It does not replace `runHybridSlice`.
- It does not include `app-autopilot`.

Suggested API:

```js
export function normalizeSplit({ workItemText }) {
  return {
    split: 'single' | 'two-disjoint' | 'hybrid-ui-backend',
    legacySyntax: [],
    warnings: [],
    config: {},
  };
}

export async function runSplit({ driver, planPath, specPath, workItem, repoRoot, deps }) {
  const normalized = normalizeSplit({ workItemText: workItem.text });
  // Route only; delegate all real work to existing primitives.
}
```

The API should be dependency-injected enough for unit tests to verify routing without spawning real workers.

## Driver behavior

### `driver: interactive`

Extend `skills/subagent-driven-development/SKILL.md` or have `skills/execution/SKILL.md` call it as an implementation detail. The user-facing entry point should be `execution`, not `subagent-driven-development`.

For each work item:

1. Normalize the split directive.
2. Run the corresponding split path.
3. Run domain reviewers using reviewer-named APIs.
4. Run Codex paired review.
5. Show plain-English progress and blockers to the user.

Split-specific behavior:

- `single`: current behavior, one implementing subagent or foreground implementer, then reviewer checks and Codex review.
- `two-disjoint`: use the existing implementer worktree fan-out and `dispatchImplementers`; merge with the existing merge coordinator and post-merge review. The interactive driver may pause between dispatch, merge, and review, but the split is the same split reachable under autopilot.
- `hybrid-ui-backend`: call `runHybridSlice({ mode: 'interactive', ... })`. The UI owner uses `claude-inline`; the backend owner uses `codex-background-bash`. This uses the runner behavior already audited in `lib/codex-bridge/hybrid/runner.js`.

Resume behavior:

- Interactive execution has no no-argument resume path in v1.
- `driver=interactive` always requires a plan path.
- `/execute` with no arguments never resumes interactive work, even if reviewer state exists in a sidecar.
- If a user asks to continue interactive work, ask for the plan path or have them run `/execute driver=interactive docs/plans/<plan>.md`.

### `driver: autopilot`

Keep current unattended single-plan behavior. The unified skill delegates to the existing autopilot flow and only adds split normalization at the decision point where Phase B already chooses among single, implementer-experts, and hybrid.

Required compatibility:

- `/autopilot docs/plans/<plan>.md` starts or resumes the same way it does today.
- `/autopilot` with no argument scans sidecars and resumes exactly as documented today.
- `/execute` with no arguments uses the same autopilot sidecar scan as `/autopilot` and resumes only autopilot runs.
- Existing plans with no split directive behave as `single` unless they already contain `**Implementers:**` or `**Orchestration:** hybrid`.
- Existing plans with `**Implementers:**` keep routing to `dispatchImplementers`, including N>2 legacy implementer sets that satisfy the existing implementer parser's cost and cap rules.
- Existing plans with `**Orchestration:** hybrid` keep routing to `runHybridSlice({ mode: 'autopilot', ... })`.
- Outer-mode behavior used by `app-autopilot` remains in `skills/autopilot/SKILL.md` and is not moved into v1 `execution`.

## Reviewer naming migration

### Target language

- Reviewer sense: `reviewer`, `reviewers`, `composeReviewers`, `reviewer_teammates`, `reviewer-*`.
- Writer sense: `implementer`, `implementers`, `two-disjoint implementers`, `hybrid-ui`, `hybrid-backend`.
- Legacy writer ids containing `expert-implementer` remain accepted but should not appear in new user-facing docs.

### New canonical plan directive

Use:

```md
**Reviewers:** ui, architecture, test
```

`**Experts:**` remains a deprecated alias. If both are present, `**Reviewers:**` wins and the compatibility layer emits a warning into the sidecar audit.

### Module and API migration

Add reviewer-named modules as canonical APIs:

- `lib/codex-bridge/reviewer-composer.js` exports `composeReviewers`.
- `lib/codex-bridge/reviewer-runtime.js` exports `selectReviewers`, `runTurn`, and `archive`.
- `lib/codex-bridge/reviewer-resolver.js` resolves `reviewer-*` identities.
- `lib/codex-bridge/reviewer-turn.js`, `reviewer-output-parser.js`, `reviewer-dm-scheduler.js`, and `reviewer-archive.js` become canonical names where touched by the implementation.

Compatibility wrappers:

- Existing `expert-*` modules stay for one migration window and re-export or call the reviewer-named implementations.
- `composeExperts` becomes a wrapper around `composeReviewers`.
- `selectTeammates` remains for compatibility but returns reviewer identities.
- Old error codes such as `role-composer-fan-out-unjustified` may stay for one release if tests or sidecars depend on them; new code should use reviewer-named error messages.

### Prompt and role ids

Canonical ids become:

- `reviewer-ui`
- `reviewer-ux`
- `reviewer-architecture`
- `reviewer-backend`
- `reviewer-ai-harness`
- `reviewer-test`
- `reviewer-security`

Migration behavior:

- Rename prompt files to `reviewer-*.md`.
- Keep `expert-*.md` prompt files as thin compatibility stubs or loader aliases for one release.
- Update `agents/dispatchers.json` to list canonical `reviewer-*` ids.
- `role-prompts-loader.js` must accept both `reviewer-*` and `expert-*`; canonical lookups and new sidecar writes use `reviewer-*`.
- `role-prompts.lock.json` must be regenerated after prompt renames.

### Sidecar migration

Canonical sidecar fields:

- `reviewer_teammates.selected[]`
- `reviewer_teammates.turns[]`
- `reviewer_teammates.fan_out_rationales[]`
- dispatch records use `reviewers_selected`, `reviewer_turn_ids`, `reviewer_blockers`.

Compatibility behavior:

- On load, if only `expert_teammates` exists, expose it through the reviewer API and append a migration record.
- During the migration window, readers accept both old and new field names.
- New writes use reviewer field names.
- Replay and sidecar migration tests must include old sidecars containing `expert_teammates`.

This is intentionally a migration, not a mechanical same-turn rename. The audit shows reviewer "expert" naming spans runtime modules, sidecar schema, prompts, tests, docs, and examples.

## Documentation changes

Update docs and skills so the mental model is discoverable but not duplicated:

- Create `docs/execution-model.md` with the canonical three-choice description.
- Add `skills/execution/SKILL.md` and link to `docs/execution-model.md`.
- Update `README.md` skill table to list `execution` as the stable implementation entry point, with `/autopilot` documented as a compatibility alias for `driver: autopilot`.
- Update `skills/writing-plans/SKILL.md` so new plans emit `**Split:**` and `**Reviewers:**`.
- Update `skills/autopilot/SKILL.md` to state it is now reached through `execution` for stable use, while `/autopilot` remains supported.
- Update `skills/subagent-driven-development/SKILL.md` to state it is the interactive driver implementation under `execution`, not the preferred user-facing launch name.
- Update `skills/brainstorming/SKILL.md` handoff prose to offer `execution` with driver choices rather than separate named skills.
- Update old docs only where they are active user guidance. Historical architecture docs can keep old terms, but add a short note if they are linked from README or skills.

## Tests and verification

Add or update tests at the failure boundaries:

1. `tests/skills/skill-structure.test.js`
   - Assert `skills/execution/SKILL.md` exists.
   - Assert `docs/execution-model.md` contains the stable driver/split matrix.
   - Assert README links to `docs/execution-model.md` instead of duplicating the full matrix.
   - Assert `commands/execute.md` documents no-argument resume as autopilot-only.
   - Assert `/autopilot` command text invokes `execution` with `driver: autopilot`.
   - Assert `writing-plans` documents `**Split:**` and `**Reviewers:**`.

2. `tests/codex-bridge/execution/split-dispatcher.test.js`
   - No split directive normalizes to `single`.
   - Legacy `**Implementers:**` normalizes to `two-disjoint` compatibility mode, including a three-member legacy block.
   - Explicit `**Split:** two-disjoint` with exactly two implementers routes to `dispatchImplementers`.
   - Explicit `**Split:** two-disjoint` with three implementers halts before dispatch.
   - Legacy `**Orchestration:** hybrid` normalizes to `hybrid-ui-backend`.
   - Explicit `**Split:** hybrid-ui-backend` routes to `runHybridSlice`.
   - `driver: interactive` passes `mode: 'interactive'` to `runHybridSlice`.
   - `driver: autopilot` passes `mode: 'autopilot'` to `runHybridSlice`.
   - Invalid split combinations halt before dispatch.

3. `tests/skills/skill-dispatch-integration.test.js`
   - Add unified execution seam tests: `driver: interactive` plus each split, and `driver: autopilot` plus each split.
   - Keep compatibility coverage for current `subagent-driven-development` and `autopilot` paths until old names are removed from user-facing docs.

4. Reviewer migration tests
   - `composeReviewers` returns canonical `reviewer-*` ids.
   - `composeExperts` remains a compatibility alias.
   - `**Reviewers:**` directive wins over `**Experts:**` when both are present.
   - `role-prompts-loader` resolves both `reviewer-test` and `expert-test`.
   - Sidecar reads old `expert_teammates` and writes new `reviewer_teammates`.
   - Replay of legacy sidecars remains stable.

5. Command behavior smoke tests
   - `/autopilot <plan>` still resolves to unattended single-plan behavior.
   - `/autopilot` with no argument keeps the existing resume scan semantics.
   - `/execute driver=interactive <plan>` reaches the interactive driver.
   - `/execute driver=interactive` without a plan halts with a plan-path-required message.
   - `/execute driver=autopilot <plan>` reaches the autopilot driver.
   - `/execute` with no arguments uses the autopilot sidecar scan and never resumes interactive work.

Verification commands:

```bash
node --test tests/codex-bridge/execution/split-dispatcher.test.js
node --test tests/skills/skill-structure.test.js tests/skills/skill-dispatch-integration.test.js
node --test tests/codex-bridge/role-composer.test.js tests/codex-bridge/role-prompts-loader.test.js tests/codex-bridge/replay-legacy-sidecar.test.js
npm test
```

## Acceptance criteria

### Goal 1: Unified stable driver launch

Acceptance:

- `skills/execution/SKILL.md` is the canonical stable execution skill.
- `commands/execute.md` launches `execution` with a required `driver` value whenever a plan path is supplied.
- `/execute` with no arguments resumes only a single in-progress autopilot run; interactive execution is non-resumable in v1 and always requires a plan path.
- README points users to `execution` for stable execution, not separately to `subagent-driven-development` and `autopilot` as peer launch choices.
- `subagent-driven-development` and `autopilot` remain implementation details or aliases, not the primary stable mental model.

Test evidence:

- Skill structure tests assert the new skill and command exist.
- README/skill structure tests assert the stable launch prose names `driver: interactive` and `driver: autopilot`.
- Command smoke tests assert no-argument `/execute` uses autopilot resume discovery and `driver=interactive` without a plan is rejected.

### Goal 2: Split independent of driver

Acceptance:

- `**Split:** single`, `**Split:** two-disjoint`, and `**Split:** hybrid-ui-backend` are documented in one place and parsed by the shared split dispatcher.
- Both stable drivers route through the same split normalization.
- Every stable driver/split combination in `docs/execution-model.md` is marked available and has a routing test.
- New `**Split:** two-disjoint` plans are intentionally capped at exactly two implementers; legacy N-member `**Implementers:**` plans remain valid only when no `**Split:**` directive is present and continue through existing parser caps.

Test evidence:

- Split dispatcher tests cover a 2 x 3 matrix: `interactive`/`autopilot` by `single`/`two-disjoint`/`hybrid-ui-backend`.
- Split dispatcher tests pin both sides of the cap: explicit `**Split:** two-disjoint` with three implementers halts, while legacy three-member `**Implementers:**` without `**Split:**` remains valid.

### Goal 3: Interactive hybrid support

Acceptance:

- Interactive execution can route a hybrid work item to `runHybridSlice({ mode: 'interactive', ... })`.
- The UI owner uses the runner's `claude-inline` mode and the backend owner uses `codex-background-bash`.
- Interactive dirty-checkout halts from the existing runner are surfaced in plain English.

Test evidence:

- A split dispatcher unit test asserts `driver: interactive` plus `**Split:** hybrid-ui-backend` calls the injected hybrid runner with `mode: 'interactive'`.
- Existing hybrid runner tests remain green.

### Goal 4: Reviewer naming distinct from writer naming

Acceptance:

- New user-facing docs and skill prose use `reviewer` for code reviewers and `implementer` for code writers.
- New plan directives use `**Reviewers:**`; `**Experts:**` is accepted as a deprecated alias.
- Canonical reviewer APIs and ids are reviewer-named.
- Legacy expert-named APIs, ids, sidecar fields, and prompts remain readable during migration.
- New writer split docs do not use "expert" for implementers; they use `two-disjoint implementers`.

Test evidence:

- Grep-based tests fail if active user-facing docs introduce new reviewer-sense `expert` wording outside compatibility notes.
- API tests prove both `composeReviewers` and `composeExperts` work.
- Sidecar migration tests prove old `expert_teammates` reads and new `reviewer_teammates` writes.

### Goal 5: `/autopilot` behavior-identical alias

Acceptance:

- `commands/autopilot.md` still exists and keeps the same usage shapes.
- `/autopilot` invokes `execution` with `driver: autopilot` and forwards arguments unchanged.
- Resume discovery, sidecar state, halt-envelope behavior, outer-mode behavior, and self-continuation remain owned by the existing autopilot implementation.
- Existing plans using current syntax keep running.

Test evidence:

- Command structure tests assert `/autopilot` delegates to `execution` with `driver: autopilot`.
- Resume smoke tests cover no-argument `/autopilot`.
- Legacy split syntax tests cover no split, `**Implementers:**`, and `**Orchestration:** hybrid`.

### Goal 6: One short canonical three-choice doc

Acceptance:

- `docs/execution-model.md` is the only canonical driver/split/review mental-model document.
- README and skills link to it rather than copying the full matrix.
- The doc clearly marks `app-autopilot` as outside v1.

Test evidence:

- Skill/README tests assert links to `docs/execution-model.md`.
- A structure test asserts the matrix appears in `docs/execution-model.md`.
- A grep guard prevents additional full driver/split/review matrices from being added elsewhere unless they explicitly point back to the canonical doc.

## Deferred

- Folding `app-autopilot` into `execution` as `driver: app-autopilot` is deferred. The seam is reserved by keeping driver parsing extensible, but v1 `/execute driver=app-autopilot` must stop with a plain-English warning that the app driver is experimental and must be invoked explicitly through `skills/app-autopilot/SKILL.md`.
- Removing legacy `expert-*` APIs, prompt names, sidecar fields, and directives is deferred until a later migration plan after compatibility tests have shipped.
- Renaming historical architecture docs is deferred unless those docs are active user guidance.

## Residual risk

The strongest implementation risk is accidentally making `/autopilot` more than an alias. If the unified skill adds extra prompts, new defaults, or different resume discovery before delegating to autopilot, Goal 5 fails even if the code looks cleaner. The implementation plan must put `/autopilot` compatibility tests before refactoring the command.

The main compatibility edge case is legacy plans that use `**Implementers:**` with more than two members. The spec intentionally caps new `**Split:** two-disjoint` plans at two implementers, but the compatibility path must preserve existing `dispatchImplementers` behavior for legacy N-member plans that omit `**Split:**`.
