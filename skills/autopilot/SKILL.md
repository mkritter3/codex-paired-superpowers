---
name: autopilot
description: Use to run a written, double-SHIP'd implementation plan slice-by-slice unattended. Drives 4 phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with own 7-round Claude↔Codex budget. Wraps via ralph-loop for cross-session continuity.
---

# Autopilot

## What this is
Given a plan that's already double-SHIP'd in `writing-plans`, run it slice-by-slice with full Claude↔Codex review at every phase, until all slices ship or the loop halts on a real blocker. Designed to be wrapped by `ralph-loop` so it survives Claude session boundaries.

## Required inputs
- A double-SHIP'd plan at `docs/superpowers/plans/<plan>.md`.
- The plan's parent spec at `docs/superpowers/specs/<spec>.md` with a sidecar (`<spec>.codex.json`) containing the persistent Codex threadId.
- The plan's frontmatter must reference the spec path explicitly (`**Spec:** docs/superpowers/specs/...`).

If any of these are missing, halt with a clear error message. Do NOT try to brainstorm or write a plan from inside autopilot.

## Lifecycle

### On run start (called once per autopilot session, NOT once per ralph tick)
1. Resolve `<repo-root>` (the directory containing the plan; usually `git rev-parse --show-toplevel`).
2. Write the active anchor:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js anchor-write \
     --repoRoot <repo-root> --specPath <spec-path>
   ```
3. If the sidecar's `autopilot` block is null, initialize it:
   ```json
   {
     "started_at": "<now>",
     "last_tick_at": "<now>",
     "current_slice": "<first unfinished slice number>",
     "current_phase": "plan-slice",
     "phase_attempt": 1,
     "phase_started_at": "<now>",
     "slice_start_sha": "<HEAD>",
     "phase_start_sha": "<HEAD>",
     "last_commit_sha": "<HEAD>",
     "inflight_subagent_id": null,
     "halt_reason": null
   }
   ```
   Atomic write via `sidecar-set-autopilot`.
4. Proceed to the main loop.

### Main loop (one tick = one phase progression)
Read the current `autopilot` block. Dispatch on `current_phase`:

- **plan-slice + test-list review** → run Phase A.
- **implement** → run Phase B.
- **review-slice** → run Phase C.
- **docs-update** → run Phase D.
- **live-verification** → run Phase E (see below).
- **shipped** → mark the slice shipped (`slice_reviews[slice-N].shipped = true`), advance `current_slice` to the next unfinished slice, set `current_phase = "plan-slice"`, reset `phase_start_sha = HEAD`.
- **all_done** → write a final autopilot block with `halt_reason: "completed"`, clear the anchor, return success.

After each phase ships (double-SHIP), advance `current_phase` to the next phase in the sequence and update `phase_start_sha = HEAD` and `last_commit_sha = HEAD` atomically.

### On halt (any reason)
1. Set `autopilot.halt_reason` in the sidecar (atomic).
2. Print a summary to the user: which slice, which phase, what blocked.
3. **Clear the active anchor** (`anchor-clear --repoRoot <repo>`). This is critical: while halted, the user must be able to make manual recovery commits without the provenance hook blocking them. The sidecar's `autopilot` block (with `halt_reason` set) remains and is the source of truth for resumption.
4. On the next `/autopilot` invocation (manually or via ralph), the autopilot reads the sidecar, sees `halt_reason` set, and either re-writes the anchor and resumes (if the halt cause has been addressed) or exits with the same halt reason.

### On ralph tick (cross-session resume or post-halt continuation)
Ralph re-invokes `/autopilot <plan-path>` on each tick. The plan path is the authoritative entrypoint — autopilot uses it to rediscover the spec and sidecar regardless of whether the active anchor is present.

1. Resolve the spec path from the plan's `**Spec:** ...` frontmatter line.
2. Load the sidecar via the spec path.
3. Inspect `sidecar.autopilot.halt_reason`:
   - `null` (and anchor present): normal in-session resume — re-write anchor if missing, run cross-session reconciliation (step 5 below), continue current phase.
   - `"completed"`: exit success. Ralph's completion-promise is now satisfied.
   - any other value (a real halt): the user has either resolved the cause and is asking to continue, or the cause persists. Either way, autopilot rewrites the active anchor (so the hook re-engages) and runs cross-session reconciliation. If reconciliation now succeeds (e.g., dirty tree was cleaned), clear `halt_reason` to null and continue. If reconciliation produces a NEW halt reason (e.g., previously halted on `subagent-blocked`, now halts on `dirty-tree-on-phase-retry` because the user left edits behind), write the NEW reason — do NOT preserve the stale one. The current halt reason must always reflect the current blocker.
4. If `sidecar.autopilot` is null entirely: this is the very first tick. Initialize the autopilot block, write the anchor, start at the first unfinished slice's plan-slice phase.
5. Cross-session reconciliation (used by step 3 paths above):
   - **Dirty-tree check first.** Run `git status --porcelain`. If output is non-empty, the working tree has uncommitted changes from a prior crash or external edit. Halt with `halt_reason: "dirty-tree-on-phase-retry"`, list the affected files, ping user.
   - **HEAD divergence check.** If HEAD does NOT descend from `phase_start_sha` (history rewrite/force-push/branch switch), halt with `halt_reason: "history-divergence"`.
   - **Range walk.** Walk every commit in `last_commit_sha..HEAD`. Each must conform to Commit Conventions (subject prefix matching the slice, plus `Co-Authored-By: Claude` trailer). If any commit doesn't conform, halt with `halt_reason: "external-commit-detected"` citing the offending SHA.
   - If all three checks pass: update `last_commit_sha = HEAD` (atomic) and continue from the current phase.

**The active anchor is the HOOK's discovery mechanism, not autopilot's.** Autopilot uses the plan path. The anchor exists during active runs so the hook can find the right sidecar. It's cleared on halt/completion to keep the hook out of the way during user-driven recovery.

## Per-phase procedures

### Phase A: plan-slice + test-list review
Three artifacts reviewed in one phase: the task list, the test list, AND the validation rubric coverage for this slice.

1. **Task list extraction.** Parse the plan's slice-N section. Extract the bullet list of tasks. Format as markdown.
2. **Test list extraction.** From the same slice section, extract every `Write the failing test` or test-creation step. Format as a numbered list with: invariant pinned, inputs, expected outcome, mock/integration choice.
3. **Validation tier extraction.** Look for `validation: critical` (or `light` / `standard`) in the slice's frontmatter or section header in the plan. If absent, default to `standard`. Pass this tier into the prompt so Codex knows whether to apply Tier 3 (residual-risk question).
4. Compose the prompt by concatenating:
   - Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/system-rubric.md`
   - Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/verdict-format.md`
   - Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/validation-rubric.md`
   - Phase header + slice content:
     ```
     Phase: plan-slice + test-list review
     Round: <N>
     Slice: <slice-N>
     Validation tier: <light|standard|critical>
     ## Task list
     <task list>
     ## Test list
     <test list>
     Critique with L11 rigor. Apply the validation rubric. SHIP only if every Tier-1 subcategory has an explicit entry in your verdict's critique array AND every Tier-2 trigger is stated as fired-or-not. If validation tier is `critical`, also answer Tier 3.
     ```
5. Send via `codex-reply`. Run the standard 7-round loop. Append rounds to sidecar via `sidecar-append-round` with phase `plan-slice:<slice-N>`.
6. **On double-SHIP, parse and validate structured rubric coverage via the bridge CLI, then persist.** The verdict's `critique` array contains the rubric coverage bullets. Pipe it as JSON to the `validation-parse` subcommand and dispatch on the exit code:

   ```bash
   echo '<JSON array of critique bullets>' | \
     node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js validation-parse \
     --tier <slice-tier-from-frontmatter>
   ```

   Three-way exit-code dispatch:
   - **Exit 0**: success. Stdout is `{"tier": ..., "coverage": {...}}` JSON. Parse it; merge `tier` into the coverage map; write to `slice_reviews[slice-N].phases.plan-slice.validation_coverage`. Advance to Phase B.
   - **Exit 2**: parser defect. Stderr is `{"defect": "<code>", "detail": "..."}` JSON. Halt with `halt_reason: "validation-coverage-malformed:<defect>"`. The next /autopilot tick must re-prompt Codex; this is NOT a retry path autopilot handles automatically — escalate to user.
   - **Exit 1**: CLI infrastructure failure (parser crashed, fs error, etc.). Stderr is the raw error message. Halt with `halt_reason: "cli-infrastructure-error"`. Do NOT retry — escalate to user.

   The orchestrator no longer interprets the rubric — it shells out to a deterministic parser whose behavior is unit-tested.

The system rubric only needs to be sent on the first plan-slice round of the feature's lifetime (it persists in Codex's thread context). The verdict-format and validation-rubric should be re-sent whenever phase changes, since the role they play differs per phase.

### Phase B: implement
1. Dispatch implementing subagent (NOT in background — autopilot waits). Subagent prompt MUST include the Commit Conventions: every commit uses `(feat|test|fix|docs|refactor|chore)(slice:<N>):` subject + `Co-Authored-By: Claude` trailer.
2. Subagent reports DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.
3. **Reconcile sidecar with git after subagent returns.** Walk every commit in `last_commit_sha..HEAD`:
   - Verify each commit's subject matches `(feat|test|fix|docs|refactor|chore)(slice:<N>):` AND has the `Co-Authored-By: Claude` trailer.
   - If all conform: update `last_commit_sha = HEAD` in the autopilot block (atomic write via `sidecar-set-autopilot`). Move on.
   - If any commit doesn't conform (subagent violated conventions): halt with `halt_reason: "subagent-broke-commit-conventions"`, cite the offending SHA, ping user. Don't try to auto-fix.
4. On DONE / DONE_WITH_CONCERNS (post-reconciliation): write phase state via `sidecar-set-phase`, advance to Phase C.
5. On BLOCKED / NEEDS_CONTEXT: halt per Spec § failure modes (and still reconcile any commits the subagent did make before bailing).

This reconciliation step matters because if a Claude session crashes mid-subagent, the subagent may have committed several tasks. Without this step, `last_commit_sha` would stay at `phase_start_sha` and the recovery range walk on next tick would have the same effect — but doing it eagerly here keeps the sidecar honest.

### Phase C: review-slice
1. Compute the diff: `git diff <slice_start_sha>..HEAD`.
2. Read Phase A's structured `validation_coverage` from the sidecar:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-show --specPath "<spec-path>" \
     | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const sc=JSON.parse(d);console.log(JSON.stringify(sc.slice_reviews['slice-<N>'].phases['plan-slice'].validation_coverage,null,2))})"
   ```
3. Compose the prompt: prepend `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/validation-rubric.md` (and verdict-format.md) so Codex applies the rubric to the implementation, not just the plan. Send to Codex via `codex-reply` (or via background subagent if the orchestrator has unrelated prep to do):
   ```
   Phase: review-slice
   Round: <N>
   Slice: <slice-N>
   Validation tier: <light|standard|critical>
   ## Slice scope
   <task list from Phase A>
   ## Phase A's structured validation coverage (the contract you are verifying)
   <JSON from step 2>
   ## Diff
   <diff>
   ## Test output
   <last test run>
   Review only what is in this slice's scope. Out-of-slice issues = `## Deferred`. Apply the validation rubric in Phase C mode (rubric.diff-vs-plan / rubric.test-results / rubric.uncovered-paths / rubric.new-triggers). End with verdict.
   ```
3. **On Codex REVISE:**
   a. Apply anti-yes-man discipline: verify each critique against actual code before accepting. If a critique is wrong, push back via the next round; don't act on it.
   b. For accepted critiques, dispatch a fix-subagent (foreground) with: the slice's task list, the slice scope, the accepted critiques, and the Commit Conventions. The subagent makes the fixes, runs the tests, and commits using `fix(slice:<N>):` subjects (one commit per logical fix).
   c. After the fix-subagent returns, reconcile sidecar with git per the same rules as Phase B step 3 (walk `last_commit_sha..HEAD`, verify all conform, update `last_commit_sha = HEAD`).
   d. Recompute the slice diff (it now includes the fixes) and send to Codex with the next round's prompt.
4. On double-SHIP, write phase state via `sidecar-set-phase`, advance to Phase D.

### Phase D: docs-update
1. Compute the slice's diff again: `git diff <slice_start_sha>..HEAD`.
2. Ask Codex via `codex-reply` (round 1 prompt):
   ```
   Phase: docs-update
   Round: 1
   Slice: <slice-N>
   Given this diff, what doc files require updates?
   - Plan checkbox (always required).
   - README.md (only if public surface changed: new commands, flags, MCP tools, file structure).
   - CHANGELOG.md (one-line entry under the in-progress version).
   - AGENTS.md / CLAUDE.md (only if conventions for agents changed).
   - Auto-memory in ~/.claude/projects/<project>/memory (only if a non-obvious decision was locked in).
   ## Diff
   <diff>
   List required updates. End with verdict.
   ```
3. Claude drafts the doc changes per Codex's required-updates list AND independently judges whether anything Codex missed should also be updated.
4. **Apply the doc edits to the working tree but do NOT commit yet.** Send the uncommitted draft to Codex for review:
   ```
   Phase: docs-update
   Round: <N+1>
   ## Working-tree diff (uncommitted docs draft)
   <git diff -- README.md CHANGELOG.md docs/plans/...md AGENTS.md CLAUDE.md (only files touched)>
   Are these accurate? Complete? Are they referencing files/symbols that don't exist? Anything missing? End with verdict.
   ```
5. 7-round loop. On Codex REVISE, edit the working tree (still no commit) and send the next round.
6. **Only on double-SHIP:** commit the docs as a single commit with `docs(slice:<N>): <summary>` subject + `Co-Authored-By: Claude` trailer. Then reconcile sidecar (`last_commit_sha = HEAD`), mark phase shipped via `sidecar-set-phase`, and advance the autopilot to next-slice or all-done.

This deferred-commit pattern matters: if Codex finds doc errors across 3 rounds, we end up with ONE clean docs commit, not 3 commit-then-fix-it commits cluttering history.

### Phase E: live-verification

Phase E runs after `docs-update.shipped == true` and before `shipped`. It launches the real app, drives Codex-generated user-visible scenarios through `/computer-use`, captures logs and screenshots, and fixes verified failures. A slice cannot reach `shipped` unless Phase E either ships (double-SHIP'd evidence verdict) or is validly skipped.

The phase sequence is now:
```text
plan-slice -> implement -> review-slice -> docs-update -> live-verification -> shipped
```

When `current_phase` is `live-verification`, execute the following 9 sub-phases in order.

#### E.1 — Skip-frontmatter check

Pipe the slice's section markdown to the skip-frontmatter CLI:

```bash
echo '<slice section markdown>' | \
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js parse-skip-frontmatter
```

Dispatch on output:

- **Exit 0, `{skip: true, reason}`** → write `phases.live-verification.skipped = true` and `phases.live-verification.skip_reason = <reason>` to the sidecar via `sidecar-set-live-verification`, then advance `current_phase` to `shipped`. Do NOT run sub-phases E.2–E.9.
- **Exit 0, `{skip: false}`** → continue to E.2.
- **Exit 2, `{defect, ...}`** → halt with `halt_reason: "live-verification-skip-malformed"`.

#### E.2 — Pure-library project check

Load the project config:

```bash
# In orchestrator JS context:
const result = loadProjectConfig(repoRoot);
```

Dispatch:

- If `result` is null and the slice is behavior-changing → halt with `halt_reason: "live-verification-config-missing"`.
- If `result.ok === false` → halt with `halt_reason: "live-verification-config-malformed"`.
- If `result.config.app.type === "library"` AND `result.config.live_verification.default === "skip"` → write `phases.live-verification.skipped = true`, `phases.live-verification.skip_reason = <result.config.live_verification.skip_reason>` via `sidecar-set-live-verification`, advance to `shipped`. Do NOT run sub-phases E.3–E.9.
- Otherwise continue to E.3.

#### E.3 — Safety gate

Call the pure safety-gate evaluator:

```js
const outcome = evaluateSafetyGate(config, new Date());
```

Dispatch on `outcome.status`:

- **`'ok'`** → continue to E.4. (Current time is inside a configured scheduled window.)
- **`'requires-confirmation'`** → display `outcome.promptText` directly in the active Claude Code session:
  ```text
  Phase E live verification is about to take screen control via /computer-use for ~<estimate>.
  It may move the mouse, click, type, and switch focus.
  Continue now?
  ```
  Read the user's response from the conversation:
  - "continue" (or any affirmative) → proceed to E.4.
  - "cancel", "postpone", or any negative → write `halt_reason: "live-verification-user-postponed"` to the sidecar via `sidecar-set-autopilot`, clear the active anchor (`anchor-clear`), and halt. Do NOT launch the app.
- **`'halt'`** → halt with `halt_reason: outcome.haltReason`.

A prior confirmation from a previous Claude Code session does NOT carry over. Every ralph tick that reaches Phase E must re-evaluate the safety gate in that session.

#### E.4 — Scenario generation

Build the scenario-generation prompt by reading `${CLAUDE_PLUGIN_ROOT}/skills/autopilot/scenario-gen-prompt.md` and substituting:

| Placeholder | Source |
|---|---|
| `<round>` | Current round number (1 on first entry) |
| `<slice-N>` | Current slice id |
| `<validation-tier>` | Tier from Phase A |
| `<project-app-name>` | `config.app.name` |
| `<project-app-description>` | `config.app.description` |
| `<project-app-type>` | `config.app.type` |
| `<phase-A-task-list>` | Phase A task list (from sidecar or re-parsed) |
| `<phase-A-validation-coverage>` | `slice_reviews[slice-N].phases.plan-slice.validation_coverage` |
| `<plan-frontmatter-ui-surface>` | UI surface from plan frontmatter if declared |
| `<slice-diff>` | `git diff <slice_start_sha>..HEAD` |
| `<relevant-ui-files-or-paths>` | `config.live_verification.evidence.ui_globs` expansion |

Send the prompt via `mcp__plugin_codex-paired-superpowers_codex__codex-reply` on the feature's threadId.

Pipe Codex's content to:

```bash
echo '<codex content>' | \
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js scenario-validate --require-scenarios
```

Dispatch on exit code:

- **Exit 2** → increment round counter. If round ≤ 7, compose a REVISE prompt (include the defect detail) and send to Codex; retry scenario-validate on the next response. After round 7 without exit-0, halt with `halt_reason: "live-verification-scenario-deadlock"`.
- **Exit 0** → persist the scenario list to the sidecar:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-live-verification \
    --specPath <spec-path> --sliceId <slice-N> \
    --block '{"scenario_generation":{"shipped":true,"scenario_count":<N>}}'
  ```
  Then write each scenario to the evidence dir via the evidence store. Continue to E.5.

#### E.5 — App launch

Call the app launcher:

```js
const handle = await launchApp(config.live_verification);
```

On rejection → capture any available logs, run cleanup (kill), halt with `halt_reason: "live-verification-launch-failure"`.

On success, write launch metadata to the sidecar:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-live-verification \
  --specPath <spec-path> --sliceId <slice-N> \
  --block '{"launch":{"ready":true,"ready_signal":"<ready_signal_description>"}}'
```

#### E.6 — For each scenario: precondition + execution + flake-retry

**Claude is the `/computer-use` adapter at this layer.** The scenario runner injects an adapter object; in autopilot execution Claude Code provides the real implementation:

| Adapter method | Claude's runtime action |
|---|---|
| `executeStep(step, ctx)` | Drive `/computer-use` per the step's `action` and `target` (see below) |
| `captureScreenshot(path)` | Use Claude Code's native screenshot facility; save to `path` |
| `openRoute(url)` | Navigate the browser to the given URL via `/computer-use` |
| `getHeadSha()` | Run `git rev-parse HEAD` |
| `now()` | Return `new Date()` |

**Scenario driver instruction block** — how to execute steps via `/computer-use`:

Steps use human-readable `target` descriptions, not DOM selectors. Examples:
- `{action: "click", target: "Save Display Name button"}` → use `/computer-use` to find and click the button labeled "Save Display Name" as it appears on screen. `/computer-use` reasons over visible UI (pixel coordinates, rendered text, layout), not over DOM structure or CSS class names.
- `{action: "type", target: "Display name input", value: "Avery"}` → click the field that accepts display name text, then type "Avery".
- `{action: "navigate", target: "http://127.0.0.1:3000/settings"}` → navigate to that URL.
- `{action: "wait_for", target: "Success message is visible"}` → wait until the described element or state appears on screen, up to `timeout_ms`.
- `{action: "assert", target: "No error toast appears"}` → verify the stated condition using a screenshot.

If an action fails (element not found, click missed, etc.):
1. Retry the action up to `config.live_verification.computer_use.max_action_retries` times.
2. If still failing after retries, record `{ok: false, error: "<description>"}` and mark the scenario step failed.

For each scenario, use `createPreconditionEnforcer` and `createScenarioRunner` (via the injected adapter), wrapped in `createFlakeChecker`:

```js
const enforcer = createPreconditionEnforcer({ adapter, spawn, now });
const runner = createScenarioRunner({
  adapter,          // Claude is the adapter
  evidenceStore,
  preconditionEnforcer: enforcer,
  logTailer,
  projectConfig: config,
});
const checker = createFlakeChecker({
  runner,
  evidenceStore,
  sliceId,
  maxFlakes: 2,
});
const result = await checker.runWithFlakeRetry(scenario);
```

Capture evidence for each scenario attempt:
1. Record current `git rev-parse HEAD` (getHeadSha).
2. Enforce preconditions (reset → seed → navigate → login → setup_steps in declared order).
3. Capture `before.png` via `captureScreenshot`.
4. Execute each step via `/computer-use`.
5. Capture `after.png`.
6. Capture log excerpt from the log tailer.
7. Evaluate assertions (screenshot + logs).
8. Write `result.json` to the evidence path.

Flake-retry logic: if a scenario fails, do NOT modify files. Re-run the same scenario once at the same HEAD (re-enforcing preconditions from scratch). If it passes on retry → mark `flaky`. If it fails again with materially the same evidence → treat as deterministic failure and enter the fix loop (E.7). Two flake results across separate scenarios → halt with `halt_reason: "live-verification-flaky-runner"`.

Persist per-scenario results via `sidecar-set-live-verification` as they complete:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-live-verification \
  --specPath <spec-path> --sliceId <slice-N> \
  --block '{"scenarios":{"<scenario-id>":{"status":"passed|failed|flaky|blocked-precondition"}}}'
```

#### E.7 — Fix loop (on deterministic failure)

On any deterministic scenario failure, instantiate the fix loop:

```js
const fixLoop = createLiveFixLoop({
  specPath,
  sliceId,
  config,
  evidenceStore,
  adapter,          // Claude is the adapter
  codexReply: (prompt) => mcp__plugin_codex-paired-superpowers_codex__codex-reply({ threadId, content: prompt }),
  dispatchFixSubagent: (prompt) => /* dispatch foreground subagent with prompt */,
  runScenarios: (scenarios) => /* re-run all scenarios per E.6 */,
  reconcile: () => /* walk last_commit_sha..HEAD; verify conventions; update last_commit_sha */,
  sidecar: { setLiveVerification, getAutopilot, setAutopilot },
  now: () => new Date(),
});
const outcome = await fixLoop.runFixLoop(sliceId, scenarios, initialFailures);
```

The fix-loop (implemented in `lib/codex-bridge/live-fix-loop.js`) handles:
1. Package failure context: failing scenario(s), screenshot paths, log excerpts, `git diff <slice_start_sha>..HEAD`, git status.
2. Send to Codex for diagnosis via `codex-reply`.
3. Claude verifies the diagnosis against actual code (anti-yes-man discipline applies here).
4. Dispatch a fix-subagent (foreground) with the diagnosis and Commit Conventions. Fix commits use `fix(slice:<N>): live-verification fix - <scenario-id> <short name>`.
5. Git reconciliation: walk `last_commit_sha..HEAD`, verify all commits conform to `fix(slice:<N>):` + `Co-Authored-By: Claude` trailer, update `last_commit_sha = HEAD`.
6. Re-run ALL scenarios for this slice (not just the failing ones). This is intentionally conservative — any Phase E fix commit could affect any scenario.
7. Round budget: max 7. After round 7 without `{outcome: 'shipped'}`, halt with `halt_reason: "live-verification-deadlock"`.

Dispatch on fix-loop outcome:
- **`{outcome: 'shipped'}`** → continue to E.8 (evidence verdict).
- **`{outcome: 'deadlock'}`** → halt with `halt_reason: "live-verification-deadlock"`.

#### E.8 — Evidence verdict

Compile the evidence bundle:
- Scenario list (from sidecar or evidence dir `scenarios.json`).
- Pass/fail/flake matrix across all scenarios.
- Screenshots (`before.png`, `after.png` per attempt).
- Log excerpts.
- Phase E fix commits (from `last_commit_sha` range walk since phase_start_sha).
- Final app readiness metadata from launch.json.
- Deferred scenarios.
- Cleanup status (preliminary).

Send to Codex via `codex-reply` for evidence review. The prompt should include the evidence bundle summary and request a verdict using the 13 Phase E `live.*` keys.

Pipe Codex's response to:

```bash
echo '<JSON array of critique bullets>' | \
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js live-validation-parse \
  --tier <slice-tier>
```

Dispatch on exit code:
- **Exit 0** → parse the `{tier, coverage}` output; write to `slice_reviews[slice-N].phases.live-verification.validation_coverage`. Both Claude and Codex must SHIP the same round. On double-SHIP:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-live-verification \
    --specPath <spec-path> --sliceId <slice-N> \
    --block '{"shipped":true,"validation_coverage":<coverage>}'
  ```
  Then advance `current_phase` to `shipped`.
- **Exit 2** → REVISE round. Iterate up to 7 rounds total (shared with the fix-loop budget in Phase E). If round 7 passes without double-SHIP, halt with `halt_reason: "live-verification-deadlock"`.
- **Exit 1** → CLI infrastructure failure. Halt with `halt_reason: "cli-infrastructure-error"`.

#### E.9 — Cleanup

Call cleanup per project config:

```js
await cleanup(handle, config.live_verification.cleanup);
```

- **`on_success: "kill"`** (default) → send SIGTERM, wait `shutdown.grace_ms`, SIGKILL if still running.
- **`on_success: "leave_running"`** → do NOT kill the process. Write the following metadata to the sidecar's live-verification block so the halt summary surfaces it:
  ```json
  {
    "leave_running": {
      "pid": <pid>,
      "command": "<launch command>",
      "port_or_url": "<start URL>",
      "suggested_cleanup": "kill <pid>"
    }
  }
  ```
  The halt summary MUST include this information. Autopilot must never leave a process running invisibly.

On cleanup success, Phase E is complete. The sidecar already has `phases.live-verification.shipped = true` from E.8. The main loop advances `current_phase` from `live-verification` to `shipped` (which triggers the existing shipped handler: mark `slice_reviews[slice-N].shipped = true`, advance to next slice or `all_done`).

**Halt-mode cleanup:** if any sub-phase E.1–E.8 triggers a halt, cleanup runs according to `config.live_verification.cleanup.on_halt` (defaults to `"kill"`). Evidence write failure always uses `kill` regardless of config, because the run is not inspectable through persisted evidence.

## Non-blocking Codex (UI sense, not concurrency sense)
- Background subagent calls let the orchestrator continue prep work while Codex thinks.
- BUT: only ONE codex-reply may be in flight against the feature's threadId at any time. Single-writer mutex enforced by the orchestrator.
- See `skills/autopilot/codex-via-subagent-prompt.md` for the subagent prompt template.

## Failure modes
See Spec § "Failure modes" — implement every row of that table. Each halt sets `autopilot.halt_reason` to a specific string the user can search for, and prints a human-readable summary.

## Anti-yes-man discipline
Same as upstream `codex-paired-superpowers:receiving-code-review`. Never accept a Codex critique without verifying against actual code. Never accept a SHIP without applying the pre-SHIP checklist (which is now in `system-rubric.md` and Codex sees it on every prompt).

## Integration with ralph-loop
Run autopilot under ralph for cross-session continuity:

```
/ralph-loop /autopilot <plan-path> --completion-promise "all slices in <plan-path> shipped"
```

Each ralph tick re-invokes `/autopilot <plan-path>`. Autopilot uses the plan path to resolve the spec via the plan's frontmatter and reads the sidecar's `autopilot` block to determine state — the active anchor is the HOOK's discovery mechanism, not the autopilot's. Ralph's completion-promise is met only when `sidecar.autopilot.halt_reason == "completed"`.
