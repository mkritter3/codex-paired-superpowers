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

> **v0.7.1 — domain-aware routing dispatch.** Phase B routes implementation work to one of two plugin subagents (`slice-implementer-codex`, `slice-implementer-sonnet`) defined in the plugin's `agents/` directory, gated by a domain policy declared in `agents/dispatchers.json`. UI/UX and AI-harness slices route to Sonnet (Codex `forbidden` for those domains). Backend slices route to Codex by default. Other v0.7.0 properties carry forward: worktree isolation, optional parallel batching for non-overlapping `**Files:**` sets, Node-mechanical worktree/reconciler/integration primitives, subagent JSON advisory + reconciler authoritative.

Phase B has nine steps, executed in order:

1. **Resolve domain** — Claude reads `**Domain:**` directive or infers from `**Files:**` paths.
2. **Pre-dispatch checklist** — Claude inspects the slice section directly; enforces domain policy via the registry.
3. **Conflict comparison** — Claude compares Files sets across consecutive parallel-candidate slices.
4. **Worktree setup per batch** — create + bootstrap + verify (two-tier gate).
5. **Dispatch** — invoke the routed subagent(s); parallel batches dispatch in a SINGLE assistant turn.
6. **Reconcile** — call `reconcileWorktree` from `lib/codex-bridge/reconciler.js`.
7. **Apply routing rules** — preferred → fallback → halt; fallback respects domain policy.
8. **Persist** — sidecar `setImplementMeta` / `setImplementBootstrap` / `appendImplementDispatch` (now includes resolved domain).
9. **Integration** — ordered cherry-pick via `lib/codex-bridge/worktree-integrate.js`; clean up worktrees.

The rest of this section spells each step out verbatim.

#### Phase B.0 — Domain resolution (v0.7.1)

Before the implementer checklist, resolve the slice's domain. The domain governs which implementers are `forbidden` / `allowed` / `preferred` per `agents/dispatchers.json`.

**Step 1: Look for a `**Domain:**` directive in the slice section.**

| Slice line content (after trimming) | Action |
|---|---|
| `**Domain:** ui` (exact, lower-case) | domain = `ui` |
| `**Domain:** ai-harness` | domain = `ai-harness` |
| `**Domain:** backend` | domain = `backend` |
| `**Domain:** general` | domain = `general` |
| `**Domain:**` with empty value | halt `domain-directive-malformed` |
| `**Domain:** Backend` / mixed case / any other value | halt `domain-directive-malformed` |
| line absent entirely | proceed to step 2 (inference) |

**Step 2: If no directive, infer from `**Files:**` paths.**

Path-based heuristics, applied to every entry in the slice's Files block:

- A path matching any of these signals → `ui`:
  - `web/`, `app/`, `frontend/`
  - `*.tsx`, `*.css`, `*.html`, `*.scss`, `*.svelte`, `*.vue`
- A path matching any of these signals → `ai-harness`:
  - `skills/`, `agents/`, `hooks/`
  - `lib/codex-bridge/`
  - `*.skill.md`
- All other paths → `backend` if they look like server/data/runtime code (`lib/server/`, `db/`, `api/`, `*.sql`, etc.), else `general`.

If multiple paths in the same slice yield different domain signals, pick the strongest match in this priority order: `ui` > `ai-harness` > `backend` > `general`. (Rationale: a slice that touches BOTH a UI file and a backend file is still UI work in spirit — Codex must not write the React component even if it also touches an API endpoint in the same slice.)

If the slice has no `**Files:**` block (single-slice serial batch where Files isn't required), inspect the slice's `### Tasks` body for path mentions and apply the same heuristics. If still ambiguous, default to `general`.

**Step 3: Ambiguity rule.**

If inference yields multiple plausible domains AND the slice has an `**Implementer:**` directive selecting an implementer that is `forbidden` for any of those plausible domains, halt `domain-policy-ambiguous`. The user must add an explicit `**Domain:**` directive to disambiguate.

In all other ambiguous cases (no implementer directive or all plausible domains share the same policy for the chosen implementer), pick the highest-priority plausible domain per the order above and continue.

**Smart-parallelization implication.** Two consecutive slices with different inferred domains should be inspected for tight coupling before parallelizing them. A `ui` slice and an `ai-harness` slice that touch independent files can still parallel-batch (different domains, both safe for Sonnet). A `ui` slice and a `backend` slice cross domain boundaries — verify the `**Files:**` are genuinely disjoint and the slices aren't logically joined (e.g., a UI component slice that imports a type from a backend slice should NOT parallelize even if the Files don't overlap, because the backend slice's exports are the UI slice's contract).

#### Phase B.1 — Pre-dispatch checklist (Claude reads the slice section)

Before any worktree work, read the current slice section directly from the plan markdown. Apply these checks **literally** — paraphrase or guesswork is non-conforming.

**Implementer directive (`**Implementer:**` line in the slice section):**

First, parse the directive itself:

| Slice line content (after trimming) | Action |
|---|---|
| line absent entirely | proceed to registry-default selection |
| `**Implementer:** codex` (exact, lower-case) | candidate preferred = `codex` |
| `**Implementer:** sonnet` (exact, lower-case) | candidate preferred = `sonnet` |
| `**Implementer:** auto` | halt `implementer-directive-malformed` |
| `**Implementer:**` with empty value | halt `implementer-directive-malformed` |
| `**Implementer:** Codex` / `**Implementer:** SONNET` / any mixed case | halt `implementer-directive-malformed` |
| any other value | halt `implementer-directive-malformed` |

**Then enforce domain policy via the dispatcher registry (v0.7.1):**

Use the resolved domain from Phase B.0 and the candidate preferred implementer from the table above. Look up `enforceDomainPolicy(implementer, domain)` from `lib/codex-bridge/dispatchers.js` (returns `forbidden` | `allowed` | `preferred`).

| Directive state | Domain policy result | Action |
|---|---|---|
| Line absent (registry-default selection) | — | preferred = the implementer in the registry whose domain policy for this domain is `preferred`; if none is `preferred`, the first whose policy is `allowed`. If none is allowed, halt `implementer-unavailable`. |
| Directive selected `codex` or `sonnet` | `forbidden` | halt `domain-policy-violation` |
| Directive selected `codex` or `sonnet` | `allowed` or `preferred` | preferred = directive value |

For the v0.7.1 registry shipped in `agents/dispatchers.json`:
- `Domain: ui` → registry-default preferred = `sonnet`. Codex is `forbidden`.
- `Domain: ai-harness` → registry-default preferred = `sonnet`. Codex is `forbidden`.
- `Domain: backend` → registry-default preferred = `codex`. Sonnet is `allowed`.
- `Domain: general` → registry-default preferred = `sonnet`. Codex is `allowed`.

**Fallback implementer** is the other one of {codex, sonnet} — but only if the registry permits the fallback for this domain. If the only fallback is `forbidden` for the resolved domain and the preferred dispatch fails, halt `implementer-unavailable` (NOT `domain-policy-violation` — the user didn't pick the forbidden combo; policy blocked the fallback after the preferred-fail).

**Files block (only validated when this slice is a parallel candidate):**

A slice is a "parallel candidate" iff Claude is considering dispatching it concurrently with one or more consecutive slices in the current candidate window. A single-slice batch is NOT a parallel candidate and the Files block is NOT required.

For every parallel candidate, locate the `**Files:**` block. The block:

- Starts at a line equal to `**Files:**` after trimming.
- Continues through consecutive `- <path>` bullet lines.
- Ends at a blank line, a heading, or another bold directive.

Apply these checks in order. The first failure halts the entire candidate window:

| Condition | Halt reason |
|---|---|
| `**Files:**` block missing on a parallel candidate | `parallel-files-missing` |
| `**Files:**` block exists but contains zero bullets | `parallel-files-malformed` |
| Inline form like `**Files:** lib/foo.js` (no bullet list under it) | `parallel-files-malformed` |
| Any path contains a glob character (`*`, `?`, `[`) | `parallel-files-malformed` |
| Any path contains a `.` or `..` traversal segment | `parallel-files-malformed` |
| Any absolute path (starts with `/`) | `parallel-files-malformed` |
| Any backslash separator (`\`) | `parallel-files-malformed` |
| Duplicate path inside the same slice | `parallel-files-malformed` |
| Directory-only path with trailing `/` | `parallel-files-malformed` |

**Candidate-window halt rule:** if any of the above halts fire on any candidate slice, halt **before creating or bootstrapping any worktree** in that window. Do not partially set up worktrees and roll back. The halt summary must surface the exact offending slice id, path, and value.

#### Phase B.2 — Conflict comparison

Once every candidate's directive and Files block is valid, compute parallelism.

1. For each candidate, build the Files set: trim each bullet, normalize as repo-relative path strings (no normalization beyond trim — paths are already validated).
2. Compare every pair of candidates' Files sets for exact path overlap.
3. Decision:
   - **No overlap across all candidates** → form one parallel batch containing all candidates. Mixed Codex/Sonnet implementers are allowed in the same parallel batch.
   - **Any overlap** → force serial execution. Drop back to single-slice batches; record `parallel_suppressed_reason: "files-overlap"` in the sidecar implement meta for each affected slice. Process the slices one at a time in order.

Conflict detection runs only on Files sets, never on implementer choice. Two Sonnet slices may run in parallel if their Files sets are disjoint; a Codex slice and a Sonnet slice may run in parallel if their Files sets are disjoint.

#### Phase B.3 — Worktree setup per batch

For each slice in the batch, build an isolated worktree using the `worktree.js` primitives from slice 2:

1. Resolve the slice's `slice_start_sha` (from the autopilot block; for parallel candidates this is the same SHA across the batch — they all branch from the same starting point).
2. Call:
   ```js
   import { create, bootstrap, verifyBootstrap } from '<plugin>/lib/codex-bridge/worktree.js';
   const c = create(repoRoot, sliceId, sliceStartSha);
   ```
   `create` enforces the `.git-worktrees/` gitignore, the path-conflict check, and runs `git worktree add -b <slice-id>-impl <repo>/.git-worktrees/<slice-id> <slice_start_sha>`. Surface its halt unchanged (e.g., `worktree-gitignore-missing`, `worktree-path-conflict`, `worktree-create-failed`).
3. Resolve the configured symlinks via `loadProjectConfig(repoRoot)` — the `worktree_bootstrap.symlinks` array of `{path, required}` entries, with v0.7.0 defaults applied (slice 1).
4. Call:
   ```js
   const b = bootstrap(repoRoot, c.worktreePath, symlinks);
   ```
   On halt, surface unchanged (e.g., `worktree-bootstrap-failed`).
5. Persist the bootstrap record before dispatch:
   ```bash
   cli sidecar-set-implement-bootstrap --specPath <spec> --sliceId <slice-N> \
     --bootstrap '{"symlinks":[<recorded paths>],"completed_at":"<ISO now>"}'
   ```
   Recorded symlinks are the paths that were actually linked (skipped optional missing entries are not recorded).

**Two-tier bootstrap gate (run immediately before dispatching the implementer for that worktree):**

- **Tier 1 — sidecar marker.** Read the sidecar. Confirm `slice_reviews[slice-N].phases.implement.bootstrap.completed_at` is a non-empty string. Missing → halt `worktree-bootstrap-failed`.
- **Tier 2 — symlink reality check.** Call `verifyBootstrap(worktreePath, recordedSymlinks, repoRoot)`. Each recorded path must `lstat` as a symlink and `readlink` to `<repoRoot>/<path>`. If `{ok:false}`, halt `worktree-bootstrap-stale`. Diagnostics include the per-symlink `{symlink, expected, actual}` triples returned by `verifyBootstrap`.

Both tiers must pass for every worktree in the batch before any subagent dispatch fires. A single Tier-1/Tier-2 failure in a parallel batch halts the whole batch — do not dispatch the other slice(s) while one worktree is broken.

#### Phase B.4 — Dispatch (subagent files, single-turn parallel)

For each slice in the batch, dispatch the routed subagent. The subagents are the markdown files in the plugin's `agents/` directory:

- `agents/slice-implementer-codex.md` — invokes Codex MCP in a fresh thread inside the worktree. Tool name: `slice-implementer-codex`.
- `agents/slice-implementer-sonnet.md` — implements directly with `Read/Edit/Write/Bash`. Tool name: `slice-implementer-sonnet`.

Choice is mechanical: directive `codex` (or absent) → `slice-implementer-codex`; directive `sonnet` → `slice-implementer-sonnet`.

Every dispatch's prompt includes:

- Slice id (e.g., `slice-3`).
- Full slice section text from the plan, verbatim.
- Worktree absolute path (the subagent's `cwd`).
- `slice_start_sha`.
- Phase A's structured `validation_coverage` for this slice if available.
- Commit Conventions (subject-only, slice number = current slice; trailer not required, presence does not break compliance).
- Required test/verification commands.
- Instruction to leave all changes committed in the worktree before reporting `DONE`.
- Reminder of the final-message JSON contract: `{"status":"DONE"|"BLOCKED"|"NEEDS_CONTEXT","concerns":[]}`.

**Single-turn parallel dispatch (load-bearing).** When the batch contains more than one slice, dispatch ALL implementer subagents in a SINGLE assistant turn using Claude's parallel-tool-call mechanism — i.e., emit multiple `Agent` tool calls in the same response. Issuing them across separate turns is non-conforming: it serializes the work and breaks the wall-clock assertion in the empirical parallel smoke (`tests/smoke/implementer-routing-parallel.sh`, slice 9). The structural smoke (`tests/smoke/phase-b-routing-structural.sh`) verifies orchestrator output contains all parallel `Agent` calls in one turn for the non-overlap path.

Do not begin reconciliation for any slice until all parallel subagents in the batch have returned. Single-slice batches use a single subagent call as usual.

**Subagent return contract.** The subagent's final message ends with a fenced JSON block. Read its `status` field. The orchestrator only consults this status for `BLOCKED` and `NEEDS_CONTEXT` halts; for everything else the reconciler is authoritative (Phase B.5). If the JSON is missing or malformed, treat it as `missing-or-malformed-json` and route into the fallback rules in Phase B.6 — unless the message is an unambiguous blocker phrased as natural language ("blocked: X"), in which case record `BLOCKED` and halt without fallback.

#### Phase B.5 — Reconcile (reconciler is truth)

For each returned subagent, call:

```js
import { reconcileWorktree } from '<plugin>/lib/codex-bridge/reconciler.js';
const r = reconcileWorktree({
  worktreePath: <worktree absolute path>,
  sliceStartSha: <slice_start_sha>,
  sliceId: <slice-N>,
});
```

The reconciler reads `git -C <worktree> log <slice_start_sha>..HEAD` and verifies every subject against `^(feat|test|fix|docs|refactor|chore)\(slice:<N>\): <description>`. It returns:

```js
{
  ok: true,
  commits: [{sha, subject}, ...],     // oldest → newest
  head_sha,
  commit_count,
  non_conforming_subjects: [{sha, subject, reason}, ...],
}
```

or `{ok:false, halt:{reason:"reconciler-failed", detail}}` on git failure.

**Reconciler is the source of truth.** Subagent JSON `status` is advisory — never use it to populate `commit_count`, `head_sha`, or `commits`. The orchestrator trusts what git says. Specifically:

- Subagent reports `DONE` but reconciler says `commit_count == 0` → fallback trigger (zero-commits).
- Subagent reports `DONE` but `non_conforming_subjects` is non-empty → fallback trigger (non-conforming-commits). Cite the SHA in diagnostics.
- Subagent reports `DONE` and reconciler returns ≥1 commits with empty `non_conforming_subjects` → success.
- Subagent reports `BLOCKED` → halt with `codex-blocked` (Codex implementer) or `subagent-blocked` (Sonnet implementer). Do **not** fall back. Reconcile commits the subagent made before bailing for the audit trail, but do not advance.
- Subagent reports `NEEDS_CONTEXT` → halt with `codex-needs-context` or `subagent-needs-context`. Same no-fallback rule.
- `reconcileWorktree` returns `{ok:false}` (e.g., bad sha, broken worktree) → fallback trigger (treated as a dispatch failure: the worktree is unreliable).

#### Phase B.6 — Apply routing rules

The routing sequence is:

```text
preferred implementer
  -> fallback implementer on implementation-dispatch failure
  -> halt with implementer-unavailable only if both fail
```

**Failure triggers fallback** (any one of these from the preferred dispatch):

1. MCP error from the subagent (Codex MCP tool error for `slice-implementer-codex`; subagent dispatch error for either).
2. Subagent dispatch error (the `Agent` tool call itself failed).
3. 10-minute implementation timeout.
4. Zero commits produced (`commit_count == 0`).
5. Non-conforming commits emitted (`non_conforming_subjects` non-empty).
6. Missing or malformed final-message JSON, when there is no clear blocker signal.

**NOT fallback triggers** (these halt without trying the other implementer):

- `BLOCKED` (real blocker — spec is unclear, missing dependency, etc.).
- `NEEDS_CONTEXT` (real blocker — agent needs information the orchestrator does not have).

**Fallback procedure** (per spec §9):

1. Append the failed dispatch to sidecar with `outcome: "failed-fallback-pending"` (see B.7).
2. Reset the worktree to `slice_start_sha`:
   ```js
   import { reset } from '<plugin>/lib/codex-bridge/worktree.js';
   reset(worktreePath, sliceStartSha);
   ```
   On halt, surface `worktree-reset-failed`.
3. Re-run worktree bootstrap (`bootstrap(repoRoot, worktreePath, symlinks)`), update sidecar bootstrap marker, re-verify with `verifyBootstrap`. Halt with `worktree-bootstrap-failed` or `worktree-bootstrap-stale` on tier failure.
4. Dispatch the fallback subagent fresh. Do not salvage partial work. Do not pass any context from the failed attempt other than the slice section, worktree path, and sha.
5. Reconcile only the fallback's commits (range is still `slice_start_sha..HEAD` because the reset moved HEAD back).

**Both implementers fail** → halt `implementer-unavailable`. Record both dispatch failures in the sidecar. Leave the worktree in place for inspection.

For parallel batches, fallback is per-slice. One slice failing the preferred implementer does not trigger fallback or halt for the other slice in the batch. Each slice's reconcile/fallback/halt decision is independent.

#### Phase B.7 — Persist (sidecar)

Use the slice-3 implement-phase persistence CLI/methods (sidecar.js):

- **Before the first dispatch in this slice's Phase B**, write routing meta:
  ```bash
  cli sidecar-set-implement-meta --specPath <spec> --sliceId <slice-N> --meta '{
    "preferred_implementer":"codex|sonnet",
    "fallback_implementer":"sonnet|codex",
    "parallel_group":"<batch id or null>",
    "parallel_suppressed_reason":"files-overlap|null",
    "worktree":"<absolute worktree path>"
  }'
  ```
  Use a single batch id (e.g., `parallel-<ISO>-<slice-from>-<slice-to>`) for all slices in a parallel batch. For serial single-slice batches, `parallel_group: null`.

- **After bootstrap completes** (per Phase B.3, before dispatch), write the bootstrap record (already shown above):
  ```bash
  cli sidecar-set-implement-bootstrap --specPath <spec> --sliceId <slice-N> \
    --bootstrap '{"symlinks":[...],"completed_at":"<ISO now>"}'
  ```

- **After each reconcile** (whether successful, fallback-pending, or halted), append a dispatch record:
  ```bash
  cli sidecar-append-implement-dispatch --specPath <spec> --sliceId <slice-N> --dispatch '{
    "slice_id":"<slice-N>",
    "agent":"codex|sonnet",
    "thread_id":"<codex thread id or null>",
    "dispatched_at":"<ISO>",
    "completed_at":"<ISO>",
    "worktree":"<absolute worktree path>",
    "head_sha":"<reconciler.head_sha>",
    "commit_count":<reconciler.commit_count>,
    "outcome":"shipped|failed-fallback-pending|failed-halted"
  }'
  ```
  Dispatch entries are append-only. If fallback ships, both records persist: the failed preferred dispatch and the shipped fallback dispatch.

- **After successful integration** (Phase B.8), update `last_commit_sha` via `sidecar-set-autopilot` and write `slice_reviews[slice-N].phases.implement` shipped/commits via `sidecar-set-phase`.

#### Phase B.8 — Integration (ordered cherry-pick)

Once every slice in the batch has a successful reconcile (Phase B.5 returned commits with no non-conforming subjects, no halt, no fallback pending), integrate the worktree branches onto the integration branch (the autopilot's primary working branch).

Use the slice-6 module:

```js
import { integrate } from '<plugin>/lib/codex-bridge/worktree-integrate.js';
const r = integrate({
  repoRoot,
  integrationBranch: '<current branch>',
  slices: [
    { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: <sha> },
    { sliceId: 'slice-4', branchName: 'slice-4-impl', sliceStartSha: <sha> },
  ],
});
```

The module:
- Enumerates each slice's source commits with `git patch-id --stable`.
- Runs resume detection: if all source commits already appear in order on the integration branch, the slice is `resumed-already-integrated` and skipped. Partial / order-broken matches halt with `worktree-resume-ambiguous` (diagnostics include `slice_id`, `branch_name`, `integrated_subjects`, `missing_subjects`, `integration_branch_head`).
- Otherwise cherry-picks each commit in order. Conflict → `git cherry-pick --abort`, halt with `worktree-merge-conflict` (diagnostics include `slice_id`, `branch_name`, `conflicting_paths`).
- Empty source range after a supposedly shipped dispatch halts with `worktree-integration-empty` (broken upstream invariant).

Always integrate slices in **ascending slice order**, regardless of which subagent reconciled first. The plan order is the integration order.

**On success:**
1. Read the integration branch HEAD; this is the new `last_commit_sha`.
2. Update `sidecar.autopilot.last_commit_sha = <new HEAD>` atomically.
3. For each slice, write `phases.implement` shipped state via `sidecar-set-phase` with the reconciler's `commits` and `head_sha`.
4. Remove each slice's worktree:
   ```js
   import { remove, removeBranch } from '<plugin>/lib/codex-bridge/worktree.js';
   remove(repoRoot, worktreePath);
   removeBranch(repoRoot, branchName); // only after commits are reachable from integration branch
   ```
   Cleanup failures are warnings, not halts (`worktree-cleanup-failed` / `worktree-branch-cleanup-failed` recorded but execution continues).
5. Advance each slice's `current_phase` to `review-slice` per the main loop (note: only after integration is complete for the whole batch).

**On halt (any of the worktree-* reasons above):** leave the worktrees and branches in place for inspection. Record the halt summary with absolute worktree paths and branch names. Do not delete diagnostic worktrees.

#### Phase B.9 — Worked example: slices 3 + 4 in parallel

Slice 3 declares `**Implementer:** codex` and `**Files:** [lib/codex-bridge/foo.js, tests/codex-bridge/foo.test.js]`. Slice 4 declares `**Implementer:** sonnet` and `**Files:** [lib/codex-bridge/bar.js, tests/codex-bridge/bar.test.js]`. Both are Phase B-ready (Phase A double-SHIP'd). The autopilot has just shipped slice 2's docs-update; HEAD is `abc123`.

1. **B.1 checklist.** Slice 3 directive valid (`codex`). Slice 3 Files block valid (4 paths, no globs/traversal/abs/dups). Slice 4 directive valid (`sonnet`). Slice 4 Files block valid.
2. **B.2 conflict.** `{lib/codex-bridge/foo.js, tests/codex-bridge/foo.test.js}` ∩ `{lib/codex-bridge/bar.js, tests/codex-bridge/bar.test.js}` = ∅. Form parallel batch `parallel-2026-05-08T12:00:00.000Z-3-4`. Persist `parallel_group` for both slices via `sidecar-set-implement-meta`.
3. **B.3 worktree setup.** `slice_start_sha = abc123` for both. Create `.git-worktrees/slice-3` (branch `slice-3-impl`) and `.git-worktrees/slice-4` (branch `slice-4-impl`). Bootstrap each with the project's symlinks (`node_modules` etc.). Persist bootstrap records. Verify both worktrees with `verifyBootstrap`. Both Tier 1 and Tier 2 pass.
4. **B.4 dispatch.** In a SINGLE assistant turn, emit two `Agent` tool calls — one for `slice-implementer-codex` with slice 3's prompt, one for `slice-implementer-sonnet` with slice 4's prompt. Each `cwd` is the slice's worktree path. Wait for both to return.
5. **B.5 reconcile.** Call `reconcileWorktree` for each. Slice 3 returns `commit_count: 2, non_conforming_subjects: []`. Slice 4 returns `commit_count: 1, non_conforming_subjects: []`. No fallback needed. Append dispatch records with `outcome: "shipped"` for each.
6. **B.8 integration.** Call `integrate({ repoRoot, integrationBranch: <branch>, slices: [{slice-3, slice-3-impl, abc123}, {slice-4, slice-4-impl, abc123}] })` in slice-ascending order. Cherry-pick slice 3's two commits onto the integration branch, then slice 4's one commit. Update `last_commit_sha`. Mark each slice's `phases.implement` shipped. `remove` both worktrees and `removeBranch` both slice-impl branches. Advance both slices to `review-slice` (which still runs serially in slice order, per spec §10).

#### Phase B reference: failure modes (cross-reference spec §17)

| Halt reason | Trigger |
|---|---|
| `implementer-directive-malformed` | Bad/empty/mixed-case/`auto` Implementer directive |
| `parallel-files-missing` | Parallel candidate has no `**Files:**` block |
| `parallel-files-malformed` | Parallel candidate has invalid `**Files:**` block (per B.1 table) |
| `worktree-gitignore-missing` | `.git-worktrees/` not in `.gitignore` |
| `worktree-path-conflict` | `.git-worktrees/slice-N` exists and isn't a clean same-slice worktree |
| `worktree-create-failed` | `git worktree add` exited nonzero |
| `worktree-bootstrap-failed` | Bootstrap symlink failure OR sidecar bootstrap marker missing (Tier 1) |
| `worktree-bootstrap-stale` | `verifyBootstrap` symlink reality check failed (Tier 2) |
| `worktree-reset-failed` | `git reset --hard` failed before fallback |
| `codex-blocked` / `codex-needs-context` | Codex implementer reported BLOCKED/NEEDS_CONTEXT |
| `subagent-blocked` / `subagent-needs-context` | Sonnet implementer reported BLOCKED/NEEDS_CONTEXT |
| `implementer-unavailable` | Both preferred and fallback failed |
| `worktree-merge-conflict` | Cherry-pick conflict during integration |
| `worktree-resume-ambiguous` | Partial / order-broken patch-id match on integration branch |
| `worktree-integration-empty` | Empty source range after supposedly-shipped dispatch (broken invariant) |

Cleanup-only warnings (not halts): `worktree-cleanup-failed`, `worktree-branch-cleanup-failed`.

This reconciliation discipline matters because if a Claude session crashes mid-subagent, the subagent may have committed several tasks already. The reconciler-as-truth invariant means the next tick's Phase B.5 call will pick up exactly the commits in the worktree, regardless of what the subagent self-reported. Sidecar dispatch records are append-only so the audit trail survives every retry.

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
