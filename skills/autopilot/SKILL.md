---
name: autopilot
description: Use to run a written, double-SHIP'd implementation plan slice-by-slice unattended. Drives 4 phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with own 7-round Claude↔Codex budget. Wraps via ralph-loop for cross-session continuity.
---

# Autopilot

## What this is
Given a plan that's already double-SHIP'd in `writing-plans`, run it slice-by-slice with full Claude↔Codex review at every phase, until all slices ship or the loop halts on a real blocker. Designed to be wrapped by `ralph-loop` so it survives Claude session boundaries.

## Honest-reporting activation (v0.8.1, do this first)
On entry, write the honest-reporting marker so the Stop/PreToolUse hook keeps claims sourced for the autopilot run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill autopilot --spec <spec-path>
```

The marker has an 8-hour TTL; for longer autopilot runs, refresh it on each major phase boundary (or pass `--ttl-hours 24`). See `skills/honest-reporting/SKILL.md` for the VERIFIED / ASSUMED / UNTESTED vocabulary.

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

> **v0.7.3 — dependency-graph batching + mailbox coordination.** Phase B builds a DAG from each slice's `**DependsOn:**` directive (block form, parsed by `lib/codex-bridge/dependency-graph.js`), computes the *ready-set* (pending slices with all deps shipped), and dispatches the *deterministic first-fit non-overlap subset* of the ready-set. This replaces v0.7.1's consecutive-slice batching — non-consecutive slices can now parallelize when deps + Files allow. Mailbox infrastructure (file-based JSON inboxes per recipient under `.codex-paired/mailboxes/`) lets in-flight agents send progress/blocker messages to the orchestrator + each other; orchestrator polls between turns.
>
> Carry forward from v0.7.1: domain-aware routing per `agents/dispatchers.json`. Carry forward from v0.7.2: codex via background Bash + status file; sonnet via Task subagent.

Phase B has the following steps, executed in order. v0.7.3 adds **B.PRE** (DAG build/verify, runs once per autopilot session AND on every resume) and replaces B.2 entirely.

1. **PRE: Build + verify DAG** (v0.7.3) — `buildDAG(planPath)`; persist digest to sidecar; on resume halt `plan-changed-during-autopilot` if digest mismatches.
2. **Resolve domain** — Claude reads `**Domain:**` directive or infers from `**Files:**` paths.
3. **Pre-dispatch checklist** — Claude inspects the slice section directly; enforces domain policy via the registry.
4. **Ready-set + first-fit batching** (v0.7.3 REPLACES old conflict comparison) — `computeReadySet(dag, sliceStates)` then `maximalFirstFitNonOverlap(readySet, filesIndex)`.
5. **Worktree setup per batch** — create + bootstrap + verify (two-tier gate).
6. **Dispatch** — invoke routed subagent(s); parallel batches dispatch in a SINGLE assistant turn. v0.7.3 dispatch prompts include the agent's mailbox protocol.
7. **Between turns** (v0.7.3) — orchestrator polls in-flight inboxes + own inbox; surfaces unread messages.
8. **Reconcile** — call `reconcileWorktree` from `lib/codex-bridge/reconciler.js`.
9. **Apply routing rules** — preferred → fallback → halt; fallback respects domain policy.
10. **Failure cascade halt** (v0.7.3) — on any slice's `failed-halted` outcome, halt the run with `dependency-cascade-halt` listing descendants.
11. **Persist** — sidecar `setImplementMeta` / `setImplementBootstrap` / `appendImplementDispatch`.
12. **Integration** — ordered cherry-pick via `lib/codex-bridge/worktree-integrate.js`; clean up worktrees.

The rest of this section spells each step out verbatim.

#### Phase B.PRE — Build + verify DAG (v0.7.3)

Read the autopilot block from sidecar to get the planPath:

```bash
PLAN_PATH=$(node <plugin>/lib/codex-bridge/cli.js sidecar-show --specPath <spec> | jq -r '.autopilot.plan_path')
```

At the start of an autopilot session AND at the start of every Phase B turn (including resume after crash), follow these 4 steps:

**Step 1: Build the DAG.**

```js
import { buildDAG } from '<plugin>/lib/codex-bridge/dependency-graph.js';
const built = buildDAG(planPath);
```

**Step 2: Halt on validation failure.** On `{ ok: false, halt }` — halt with the returned reason (`dep-block-malformed`, `dep-self-reference`, `dep-unknown-slice`, `dep-cycle`, etc.). These are pre-dispatch fatal — no worktree work.

**Step 3: Decide write-vs-verify by checking sidecar.**

```bash
EXISTING=$(node <plugin>/lib/codex-bridge/cli.js sidecar-get-dependency-graph --specPath <spec>)
```

- **`EXISTING` is empty (first call)**: persist the freshly-built graph:

  ```bash
  node <plugin>/lib/codex-bridge/cli.js sidecar-set-dependency-graph \
    --specPath <spec> \
    --graph "$(jq -nc --arg digest "$built.digest" --argjson dag "$built.dag" \
                '{digest: $digest, dag: $dag}')"
  ```

- **`EXISTING` is non-empty (subsequent call / resume)**: parse it as JSON, compare `EXISTING.digest` with `built.digest`. If mismatch → halt `plan-changed-during-autopilot` with both digests in diagnostic. The user has edited the plan mid-run; autopilot must re-validate before continuing.

**Step 4: Compute current slice states from sidecar.**

For each slice id in `built.dag.nodes`:

- `shipped` — `slice_reviews[sliceId].phases.implement.shipped === true`
- `failed` — most recent entry in `dispatches[]` has `outcome: "failed-halted"`
- `in-progress` — most recent entry has `outcome: "in-progress"` (codex-background-bash awaiting completion)
- `pending` — otherwise (no dispatches yet, or last outcome was `failed-fallback-pending` and a fallback hasn't been attempted)

The orchestrator carries `dag`, `filesIndex`, and `sliceStates` through the rest of Phase B.

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

#### Phase B.0.5 — Expert selection per slice (v0.8.0)

For each slice in the current batch, the orchestrator selects an expert teammate set based on signals (slice frontmatter `**Domain:**`, file paths in the slice's `**Files:**` block, content keywords). The selection is recorded in the sidecar's `expert_teammates.selected[]`:

```js
// Pseudo-code: orchestrator selects experts via expert-runtime.
// IMPORTANT: if the orchestrator believes a broad selection (>5 experts) is
// warranted, it MUST pre-compute fanOutRationale and pass it INTO signals
// BEFORE calling selectTeammates. role-composer.js throws
// `role-composer-fan-out-unjustified` if it returns >5 selections without
// a fanOutRationale, so providing it after the fact is too late.
const { selectTeammates } = await import('<plugin>/lib/codex-bridge/expert-runtime.js');

// First pass: estimate breadth from signals (or attempt a narrow call first
// without rationale and recover via try/catch if it throws).
const signals = {
  specHas: [/* spec keywords */],
  filePaths: [/* slice Files block */],
  domains: [sliceDomain],
  explicitDirective: sliceFrontmatter.experts,  // optional **Experts:** directive
};

// If the orchestrator anticipates broad selection (touches UI + UX + arch
// + security + AI), include the rationale up front:
if (anticipatesFanOut) {
  signals.fanOutRationale = "<concrete justification of the breadth>";
}

const result = selectTeammates({
  phase: 'post-implementation-review',
  signals,
  repoRoot: <repoRoot>,
});
// result.selected: ExpertIdentity[]
// result.fanOutRationale: string|null  (populated when >5 selected)
// result.selectionReasons: {[expertId]: string}

// Persist:
for (const identity of result.selected) {
  appendExpertSelection(specPath, {
    id: identity.id,
    role: identity.role,
    source: identity.source,
    phase: 'post-implementation-review',
    selectionReason: result.selectionReasons[identity.id],
  });
}
if (result.fanOutRationale !== null) {
  appendFanOutRationale(specPath, {
    phase: 'post-implementation-review',
    selected_count: result.selected.length,
    rationale: result.fanOutRationale,
  });
}
```

The role-composer enforces the fan-out contract via `role-composer-fan-out-unjustified` (thrown from `composeExperts`, not from `appendFanOutRationale`). `appendFanOutRationale` is purely a persistence call — it validates that `selected_count > 5` but cannot detect missing rationale on the composer side.

**Composition with existing Phase B.0:** B.0 still chooses implementer transport (codex vs sonnet) via `dispatchers.json`. B.0.5 augments by selecting domain-expert REVIEWERS for the same slice. Experts do not replace implementers in MVP — they are advisory reviewers that emit verdicts and findings, never accepted manuscript writes.

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

#### Phase B.1.5 — Optional expert pre-review (v0.8.0)

For each expert tagged with `pre-dispatch` in its registry phases (currently `architecture` and `test` per `agents/dispatchers.json`), drive the expert turn via the **two-step orchestration pattern**. Claude Code does not expose the Agent tool to Node modules, so the runtime cannot dispatch the subagent itself — Claude (orchestrator) drives the Agent dispatch, and the runtime drives everything else around it.

**Step 1: Assemble the spawn prompt + dispatch the Task subagent yourself.**

```js
const { assembleSpawnPrompt } = await import('<plugin>/lib/codex-bridge/expert-turn.js');
const request = {
  identity: expertIdentity,            // from selectTeammates result
  repoRoot: <repoRoot>,
  specPath: <specPath>,
  specSnippet: <slice plan section as context>,
  phase: 'pre-dispatch',
  sliceId: <currentSliceId>,
  sidecarParticipantState: <prior turn summaries for this expert, if any>,
  task: 'Pre-dispatch review of the planned slice. Surface blocking ' +
        'architectural / test-coverage concerns before implementation begins.',
};
// Need unreadMessages array to render the prompt; readUnreadMessages is exported by mailbox.js.
const { readUnreadMessages } = await import('<plugin>/lib/codex-bridge/mailbox.js');
const unreadMessages = await readUnreadMessages(request.repoRoot, request.identity.id);
const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
```

Then YOU (Claude as orchestrator) dispatch the Task tool with `prompt` as the subagent's instructions. Capture the subagent's final response as `taskResponseText`.

**Step 2: Drive the rest of the pipeline via `runTurnWithDeps`** with an `agentDispatch` impl that just returns `taskResponseText`:

```js
const { runTurnWithDeps } = await import('<plugin>/lib/codex-bridge/expert-turn.js');
const result = await runTurnWithDeps(request, {
  agentDispatch: async () => taskResponseText,
});
// result: { ok: true, result: ParsedMachineResult } | { ok: false, reason: ... }
```

This runs through: re-read unread → re-assemble prompt (idempotent + cheap) → call your `agentDispatch` stub → parse → repair if needed → mark-read on success → append sidecar turn.

**DO NOT call `runTurn(request)` directly.** The default `agentDispatch` is intentionally unwired (throws with a clear message pointing here) because Claude Code's Agent surface is not callable from a Node module. The two-step pattern above is the executable orchestration contract for v0.8.0.

Do NOT call `runTurn(expert, {phase})` with two arguments — that's the scheduler's INTERNAL wrapper signature inside B.5.5's `drainPeerDMs` deps, not a public API.

If all pre-review experts SHIP (no blocking findings), held turn records flow through to B.7 where they are attached to the dispatch record's `expert_blockers: []` (empty) + `experts_selected[]` + `expert_turn_ids[]`. Normal flow continues to B.2.

If any pre-review expert returns blocking findings (parsed `Machine Result.blocking_findings[]` non-empty), the slice does NOT proceed to B.4 dispatch. To preserve the durable-state requirement, the orchestrator immediately appends a **sentinel halted dispatch record** to anchor the blockers on a durable record:

```js
appendImplementDispatch(specPath, sliceId, {
  /* ...required dispatch fields... */
  outcome: "failed-halted",
  failure_reason: "pre-dispatch-blocker",
  dispatched_at: <now-iso>,
  experts_selected: <expert ids>,
  expert_turn_ids: <turn ids from pre-review>,
  expert_blockers: [/* ...findings with disposition:"open"... */],
});
```

The sentinel exists ONLY to anchor blocker state on a durable record — it does NOT represent a real dispatch (no worker spawned, no commits made). The sentinel makes `updateDispatchExpertBlocker({sliceId, dispatched_at}, findingId, ...)` resolution work uniformly across pre-dispatch and post-dispatch blockers. After the sentinel is appended, halt with `expert-blocker-open` (preserves expert mailboxes per slice 7 archival policy).

On resume, Claude reads the sentinel's `expert_blockers[]` and either:

- (a) overrides technical false-positives via `updateDispatchExpertBlocker({sliceId, dispatched_at}, findingId, {disposition: "technical-override", rationale, evidence})`
- (b) routes product/UX/business findings to the human user (halt code `expert-blocker-needs-user`).

Once all blockers reach `disposition !== "open"`, the orchestrator may advance to B.4 (treating the sentinel as a resolved pre-dispatch gate) or supersede with a real dispatch.

#### Phase B.2 — Ready-set + first-fit batching (v0.7.3 REPLACEMENT)

v0.7.3 replaces the v0.7.0 "consecutive non-overlapping slices" logic with DAG-aware batching. Non-consecutive slices can now parallelize when both deps and Files allow.

```js
import { computeReadySet, maximalFirstFitNonOverlap } from '<plugin>/lib/codex-bridge/dependency-graph.js';

const readySet = computeReadySet(dag, sliceStates);
//   pending slices whose every dep has shipped state.

const batch = maximalFirstFitNonOverlap(readySet, filesIndex);
//   deterministic first-fit by numeric slice id; greedy-include if Files
//   set disjoint from already-included.
```

**Algorithm guarantees:**

- **Deterministic.** Same DAG + same Files yields the same batch every time. Sort key is numeric slice id.
- **Conservative.** Returns the largest non-overlapping subset achievable via first-fit. Doesn't attempt combinatorial-optimal bin-packing (NP-hard for arbitrary inputs; first-fit is good enough for typical N=2-10).
- **Mixed-implementer compatible.** Conflict detection still runs only on Files sets, not on implementer choice. A Codex backend slice and a Sonnet UI slice can both batch together if their Files don't overlap.
- **Empty ready-set is OK.** When a session has only in-progress codex-background-bash dispatches and no pending slices have all deps shipped, `readySet === []` and `batch === []`. Phase B turn ends; orchestrator waits for in-flight completions (Phase B between-turns inbox polling, see B.4.5).

**Per-slice sidecar update for the batch:**

For each slice in the chosen batch, write `setImplementMeta` with:
- `parallel_group`: a batch id like `parallel-<ISO>-<slice-from>-<slice-to>` if `batch.length > 1`, else `null`.
- `parallel_suppressed_reason`: typically `null` under v0.7.3 (we no longer "suppress" — we just don't include conflicting slices in the batch). For backward compatibility with v0.7.1 sidecars, this field is preserved as `null`.

Slices in `readySet` that did NOT make it into `batch` (because they overlap with a higher-priority pick) stay `pending` and become candidates next turn.

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

#### Phase B.4 — Dispatch (transport-aware, single-turn parallel)

v0.7.2 splits dispatch by **transport**. Look up the chosen implementer's transport in `agents/dispatchers.json`:

- `transport: claude-subagent` → use the `Task` tool to dispatch the named subagent. The subagent file is at `agents/<agent>.md` (e.g., `slice-implementer-sonnet.md`).
- `transport: codex-background-bash` → use the `Bash` tool with `run_in_background: true` to spawn the codex wrapper script. The contract for codex's invocation lives at `docs/codex-implementer-contract.md` (NOT a Claude Code subagent file).

##### Pre-dispatch mailbox injection (v0.7.3.1)

Before issuing the dispatch tool call (either transport), the orchestrator pre-injects any unread messages the recipient already has queued. This guarantees that messages written between B.4.5 polling cycles and this dispatch are delivered to the agent at start, without races.

For each slice in the parallel batch, in the same turn that will issue dispatches:

1. **Read the recipient's unread inbox** as orchestrator:
   ```bash
   node <plugin>/lib/codex-bridge/cli.js mailbox-read \
     --for slice-N --actor orchestrator --unread \
     --repoRoot "$REPO_ROOT"
   ```
2. **If non-empty, prepend a `<codex-paired-pending-messages>` block** to the dispatch prompt (same wrapper format the hook emits, so codex- and Sonnet-path agents see a single canonical shape). The **trailing note differs** from the hook's: pre-injected messages are NOT marked read until terminal result, so use the queued-not-marked phrasing:
   ```xml
   <codex-paired-pending-messages recipient="slice-N">
     <pending-message id="<id>" from="<sender>" timestamp="<iso>">
     <body>
     </pending-message>
     ...
   </codex-paired-pending-messages>

   (Messages above were queued for you before this dispatch. They have NOT yet been marked read — the orchestrator marks them read when this dispatch reaches a terminal result.)
   ```
   The hook's mid-run delivery uses "have been marked read" because the hook marks-read immediately after stdout flush; pre-injection's mark-read is deferred to terminal-result handling (step 4 below). Keeping the wrappers visually similar but the trailers semantically accurate prevents agents from assuming a delivery means a mark.
3. **Include `injected_message_ids`** in the dispatch record at the time the orchestrator appends/finalizes it. For the Codex path, that's the immediate `outcome: "in-progress"` record (Phase B.7) — include the captured ids there. For the Sonnet path, include the ids in whichever dispatch record the existing flow appends (typically at terminal-result time). Empty array is a positive assertion of "nothing was pre-injected"; absent field is back-compat with pre-0.7.3.1 records.
4. **On terminal result** (slice reports DONE/BLOCKED, or codex task exits), mark the pre-injected ids as read using the batch CLI:
   ```bash
   node <plugin>/lib/codex-bridge/cli.js mailbox-mark-read-batch \
     --for slice-N --actor orchestrator \
     --message-ids "<csv>" \
     --repoRoot "$REPO_ROOT"
   ```
   If dispatch failed **before** the agent process started (codex binary not found, Task tool refused), SKIP the mark-read — messages stay unread for the next dispatch attempt. Duplicate delivery is preferred over silent loss.

For the **Sonnet path**, in-flight mailbox messages that arrive AFTER dispatch are auto-delivered by the PostToolUse hook (`hooks/mailbox-inject.sh` → `lib/codex-bridge/hook-mailbox-inject.js`). Identity flows through the subagent's `cwd` (which is the worktree path) — no env-var manipulation required. The hook reads the slice's unread inbox after every Bash/Edit/Write/Read tool call, emits an `additionalContext` block, and marks the delivered messages read.

For the **Codex path**, mid-run injection is architecturally impossible (codex is an opaque subprocess; MCP protocol has no spec-level push). Pre-injection here covers the start-of-run case; cooperative checkpoints in the dispatch prompt body cover the rest (see "Mailbox protocol in agent prompts" below).

##### Sonnet path (`transport: claude-subagent`)

Dispatch via `Task` tool with `subagent_type: slice-implementer-sonnet`. Prompt content:

- Slice id (e.g., `slice-3`).
- Full slice section text from the plan, verbatim.
- Worktree absolute path (the subagent's `cwd`).
- `slice_start_sha`.
- Phase A's structured `validation_coverage` for this slice if available.
- Commit Conventions (subject-only, slice number = current slice; trailer not required, presence does not break compliance).
- Required test/verification commands.
- Instruction to leave all changes committed in the worktree before reporting `DONE`.
- Reminder of the final-message JSON contract: `{"status":"DONE"|"BLOCKED"|"NEEDS_CONTEXT","concerns":[]}`.

##### Codex path (`transport: codex-background-bash`, v0.7.2)

The orchestrator dispatches `codex exec` directly via `Bash` with `run_in_background: true`. No subagent wrapper. This pattern mirrors Claude Code's `LocalShellTask` (per `src/tasks/LocalShellTask/` in the runtime source) and supports unbounded codex runtimes (subject to `codex_dispatch.max_runtime_ms` configured via `.codex-paired/project.json`, default 2 hours).

Locked invocation (orchestrator constructs and runs):

```bash
<plugin>/scripts/codex-exec-with-status.sh \
  <status-file-path> \
  -- \
  codex exec \
    --skip-git-repo-check \
    -s workspace-write \
    -C <worktree-absolute-path> \
    -m gpt-5.5 \
    -c model_reasoning_effort=high \
    "<implementation prompt>" \
  </dev/null
```

The wrapper at `scripts/codex-exec-with-status.sh` captures exit code + timestamps + signal in a JSON status file. This is durable evidence — the on-disk status file survives orchestrator session termination, unlike Claude Code's in-memory Bash task registry.

Per-dispatch path generation (orchestrator computes):

- `<status-file-path>`: `~/Library/Application Support/Inkling/diagnostics/codex-dispatch/<slice-id>-<ISO-timestamp>.status.json`
- `<output-file-path>`: same prefix with `.log` suffix; passed to Bash via the standard background-task output capture.

`<implementation prompt>` argument: same content as the Sonnet path's prompt, but composed as a single string and passed as the final positional argument to `codex exec`. See `docs/codex-implementer-contract.md` for the full contract.

**Bash invocation parameters:**

- `run_in_background: true` — required. Returns immediately with a Bash task id.
- No `timeout` parameter (background tasks have no synchronous cap; runtime bound is `codex_dispatch.max_runtime_ms`).

After dispatch, the orchestrator immediately writes an `outcome: "in-progress"` dispatch record (Phase B.7) with `transport: codex-background-bash`, `task_id`, `output_file`, `status_file`. This is durability evidence — if the orchestrator crashes between dispatch and completion, the next session can read the status file to determine codex's terminal state.

##### Single-turn parallel dispatch (load-bearing for both transports)

When the batch contains more than one slice, dispatch ALL implementers in a SINGLE assistant turn using Claude's parallel-tool-call mechanism — emit multiple tool calls in the same response. This works across transports: a mixed batch may emit one `Bash run_in_background:true` for a codex slice + one `Task` for a sonnet slice in the same turn. Both empirically parallelize:

- Codex via `Bash`: 18s for 2 × 5s tasks (proven in v0.7.0 release validation).
- Sonnet via `Task`: 1s gap between two 5s tasks (proven in v0.7.1 validation; Task subagents parallelize natively).

Issuing dispatches across separate turns is non-conforming and breaks the wall-clock assertion in `tests/smoke/implementer-routing-parallel.sh`.

##### Subagent return contract (Sonnet path)

The Sonnet subagent's final message ends with a fenced JSON block. Read its `status` field. The orchestrator only consults this status for `BLOCKED` and `NEEDS_CONTEXT` halts; for everything else the reconciler is authoritative (Phase B.5). If the JSON is missing or malformed, treat it as `missing-or-malformed-json` and route into fallback rules in Phase B.6 — unless the message is an unambiguous blocker phrased as natural language ("blocked: X"), in which case record `BLOCKED` and halt without fallback.

##### Codex completion (codex path)

The codex background task completes asynchronously. Claude Code emits a task-notification when the Bash task exits. The orchestrator handles this notification — possibly across multiple assistant turns from when dispatch happened — by:

1. Reading the status file at `<status-file-path>` (see schema in `docs/codex-implementer-contract.md`).
2. Inspecting `exit_code`:
   - `0` → proceed to Phase B.5 reconciler.
   - non-zero → fallback trigger; route to Phase B.6.
   - missing status file (orchestrator crashed mid-dispatch and Bash task entry is gone) → halt `codex-background-task-lost`.
3. Calling `finalizeImplementDispatch(specPath, sliceId, taskId, terminal)` to promote the in-progress dispatch entry to its terminal outcome (Phase B.7).

If the in-progress codex task exceeds `codex_dispatch.max_runtime_ms`, the orchestrator MUST kill it (best-effort SIGTERM via `kill <pid>`, then SIGKILL after 5s grace) and halt `codex-background-timeout`. The wrapper script writes a status file on signal-kill recording `signal: "SIGTERM"` and `exit_code: 143`.

Multi-turn completion handling does NOT violate the single-turn parallel dispatch invariant. The invariant is: all parallel batch dispatches are issued in one turn. Completion is inherently async.

Do not begin Phase B.8 integration cherry-pick until ALL slices in the parallel batch are terminal (shipped / blocked / failed). Reconcile each slice as it completes, but defer integration until the batch is done.

##### Mailbox protocol in agent prompts (v0.7.3)

Every dispatch prompt — codex (Bash invocation prompt) and sonnet (Task subagent prompt) — appends this protocol block:

```
=== Mailbox protocol ===

Your inbox: <repo>/.codex-paired/mailboxes/<your-slice-id>.json

To send a status / progress / blocker message to the orchestrator:
  node <plugin>/lib/codex-bridge/cli.js mailbox-write \
    --to orchestrator \
    --from <your-slice-id> \
    --text-stdin
  (then write your message body to stdin)

Tip: prefix BLOCKER messages with "BLOCKER:" so the orchestrator surfaces
them immediately. Progress messages are best-effort logging — failure to
deliver does not block your work. BLOCKER delivery failure DOES block:
if your mailbox-write call for a BLOCKER fails, set your final-message
JSON status to BLOCKED/NEEDS_CONTEXT with the delivery-failure noted in
concerns.

To send a message to another in-flight slice (rare; usually mediated by
orchestrator instead):
  node <plugin>/lib/codex-bridge/cli.js mailbox-write \
    --to slice-N --from <your-slice-id> --text-stdin

To read your own inbox (orchestrator may have asked you something):
  node <plugin>/lib/codex-bridge/cli.js mailbox-read \
    --for <your-slice-id> --actor <your-slice-id> --unread

For long-running slices: send a progress update every 5-10 minutes so the
orchestrator has visibility (e.g., "Progress: 30% — finished test list").
```

##### Mailbox cooperative checkpoints (v0.7.3.1, codex-transport only)

For `transport: codex-background-bash` dispatches, the orchestrator additionally appends the following checkpoints block AFTER the shared protocol block. Sonnet-transport dispatches MUST NOT receive this block — the PostToolUse `mailbox-inject` hook delivers in-flight messages to Sonnet automatically, and adding ritual-polling instructions on top would just teach the agent to second-guess auto-delivery.

```
=== Mailbox checkpoints (codex transport) ===

The orchestrator cannot mid-run-inject messages into codex sessions (codex is
an opaque subprocess from Claude Code's perspective). Cooperative polling at
named semantic checkpoints is the mechanism. Call:

  node <plugin>/lib/codex-bridge/cli.js mailbox-read \
    --for <your-slice-id> --actor <your-slice-id> --unread \
    --repoRoot "$REPO_ROOT"

at exactly these five points:

  1. At the START of your work — after reading this prompt, before
     implementation planning or any repo-mutating command. (The poll itself
     is a command, but it's a read-only one; this checkpoint is about
     surfacing inbox context before you commit to a plan.)
  2. BEFORE running each test (before `npm test`, `pytest`, `cargo test`,
     etc.).
  3. BEFORE each `git commit`.
  4. AFTER any command that takes longer than ~30 seconds (long build, long
     test run, long network call).
  5. BEFORE composing your final response JSON.

Do NOT poll before every file edit. That trains ritual polling rather than
thoughtful integration; the checkpoints above are the ones where new context
is most likely to be load-bearing.

If `mailbox-read` returns one or more messages, process them inline before
continuing your current step (each message is a JSON object with `from`,
`text`, `timestamp` — read them and decide whether they change your plan).
Then, to acknowledge that you have consumed them, mark them read:

  node <plugin>/lib/codex-bridge/cli.js mailbox-mark-read-batch \
    --for <your-slice-id> --actor <your-slice-id> \
    --message-ids "<csv>" \
    --repoRoot "$REPO_ROOT"

Read failures and mark-read failures are best-effort logging from your
perspective — they do not block your work; the orchestrator's between-turn
polling (Phase B.4.5) is the authoritative halt path for mailbox-corruption.
```

Architectural framing: pre-injection (Phase B.4 pre-injection flow) covers the START-of-run delivery for codex; checkpoints (this block) cover the rest of the run. Combined they bound the worst-case mid-run latency to the gap between two semantic checkpoints (typically seconds-to-minutes, not the whole codex runtime).

The orchestrator reads in-flight inboxes between turns (Phase B.4.5).

#### Phase B.4.5 — Between-turns inbox polling (v0.7.3)

Between every assistant turn during Phase B (after dispatching parallel batches, before the next turn's actions), the orchestrator:

1. Reads `orchestrator.json` inbox (`mailbox-read --for orchestrator --actor orchestrator --unread`). Surfaces every unread message as diagnostics.
2. For every slice with outcome=in-progress: reads its inbox (`--for slice-N --actor orchestrator --unread`). Surfaces unread messages.
3. Marks each surfaced message as read via `mailbox-mark-read`.
4. Special handling for messages whose `text` starts with `BLOCKER:`: pause forward-progress for that slice's batch and surface the blocker to the user. Halt code: `slice-blocker-from-mailbox` (slice still in-progress; user investigates whether to abort or wait).

**v0.7.3.1 role for Sonnet slices.** B.4.5 polling for Sonnet inboxes was the primary delivery path in v0.7.3. Starting v0.7.3.1 the PostToolUse `mailbox-inject` hook is the primary in-flight delivery mechanism for Sonnet subagents; B.4.5 polling becomes a **crash-recovery safety net** that catches messages still unread in two scenarios: (a) hook failed (breadcrumb in `.codex-paired/diagnostics/hook-failures.jsonl`); (b) slice has not yet hit a Bash/Edit/Write/Read tool call that would trigger the hook. Codex slices still rely on B.4.5 polling as primary (no auto-injection is possible for the codex subprocess transport).

**v0.7.3.1 race guard for pre-injection (load-bearing).** Pre-injected messages (per the pre-injection flow above) sit in the recipient's inbox as unread until terminal result, because mark-read is deferred to step 4 per the queued-not-marked contract. B.4.5 between-turns polling MUST exclude these ids; otherwise it would surface and mark-read messages that the dispatch already delivered, breaking the "terminal-result owns the mark" invariant and causing duplicate diagnostic surfacing. When polling a slice with `outcome=in-progress`, the orchestrator computes the in-progress dispatch's `injected_message_ids` set and skips any inbox messages whose `id` appears in it. Terminal-result handling owns those ids' mark-read via `mailbox-mark-read-batch`. Messages NOT in `injected_message_ids` (new arrivals after pre-injection) are surfaced and marked as usual.

Mailbox failures during polling halt the orchestrator (per spec rev5 §6.3 boundary table — orchestrator ops are NOT best-effort):
- `mailbox-corrupt` — inbox JSON unparseable; corrupt file moved to archive (best-effort) before halt.
- `mailbox-lock-timeout` — 50-retry budget exhausted; filesystem trouble.
- `mailbox-permission-denied` — should never fire here (orchestrator can read any inbox); indicates programming error.

**Archive rotation timing:** the orchestrator runs the size check + `archiveAndReset` decision **once per Phase B turn, AFTER reading inboxes but BEFORE the next dispatch**. Per-poll size checks are too aggressive (write-amplification under heavy contention); once-per-turn is the right granularity. For each in-flight slice + orchestrator inbox:

```js
import { inboxSizeBytes, archiveAndReset } from '<plugin>/lib/codex-bridge/mailbox.js';
import { applyMailboxDefaults } from '<plugin>/lib/codex-bridge/project-config.js';

const cfg = applyMailboxDefaults(projectConfig);
const size = await inboxSizeBytes(repoRoot, recipient);
if (size > cfg.max_bytes) {
  await archiveAndReset(repoRoot, recipient, { archive_policy: cfg.archive_policy });
}
```

All-unread overflow during `archiveAndReset` throws `MailboxError(code='mailbox-overflow-unread')` — orchestrator halts (no silent loss). Run `cleanupArchives` periodically (once per autopilot session is enough) to apply retention policy.

##### Mailbox archival policy (v0.8.0)

At **terminal-state halt** (autopilot is stopping forward progress —
either `completed` / `abandoned-by-user` or any of the preserve-class
halt reasons below), iterate every active expert in
`expert_teammates.selected[]` and call:

```js
import { archive } from '<plugin>/lib/codex-bridge/expert-runtime.js';

for (const expert of sidecar.expert_teammates.selected) {
  if (expert.status === 'archived' || expert.status === 'failed') continue;
  const result = await archive(
    { id: expert.id },
    haltReason,
    { repoRoot }      // required for ARCHIVE reasons; ignored for PRESERVE
  );
  // result = { expert_id, status, archive_reason, archived_at }
  // Persist via updateExpertStatus(specPath, expert.id, result.status === 'archived' ? 'archived' : expert.status)
  // (PRESERVE reasons retain the prior status — the mailbox is kept for resume.)
}
```

The policy from `lib/codex-bridge/expert-archive.js`:

| Halt reason                              | Action   | Rationale                                              |
|------------------------------------------|----------|--------------------------------------------------------|
| `completed`                              | ARCHIVE  | Feature done; queued teammate state no longer needed.  |
| `abandoned-by-user`                      | ARCHIVE  | Explicit cleanup intent.                               |
| `external-commit-detected`               | PRESERVE | Operator must inspect why HEAD diverged.               |
| `slice-blocker-from-mailbox`             | PRESERVE | Slice in-progress; user decides abort vs wait.         |
| `expert-blocker-open`                    | PRESERVE | Blocking finding awaiting override/resolution.         |
| `expert-peer-dm-drain-cap-exceeded`      | PRESERVE | Pending peer DMs must survive for resume.              |
| `expert-peer-dm-enqueue-failed`          | PRESERVE | v0.8.1: writeToMailbox failed for one or more outbound peer DMs; targets recorded in `peer_messages_failed` for triage. |
| `subagent-dispatch-failed`               | PRESERVE | Transient dispatch failure; retry needs queued state.  |
| `reconcile-failed`                       | PRESERVE | Worktree unreliable; operator must inspect.            |
| `validation-failed`                      | PRESERVE | Live verification halted; expert state may inform fix. |
| `user-input-required`                    | PRESERVE | User answers may reshape queued DMs.                   |

ARCHIVE drains the inbox via `archiveAndReset` (preserves read messages
under `.codex-paired/archives/`, resets the inbox to unread-only).
PRESERVE is a no-op on the mailbox — read messages stay, unread stay
unread — so the next autopilot resume picks up where the last run
stopped.

Unknown halt reasons throw `ExpertArchiveError` code
`unknown-halt-reason`. If you find yourself reaching for a new halt
reason, extend the set in `expert-archive.js` deliberately (the
audit-grep target is "every halt reason maps to ARCHIVE or PRESERVE,
no silent skip").

**v0.8.0 update.** B.4.5 now ALSO polls active expert inboxes (as recorded in `expert_teammates.selected[]`) alongside orchestrator + in-flight slice inboxes. If an active expert has unread messages at B.4.5:

- Record the inbox state (don't immediately spawn — expert review should see reconciled implementation truth at B.5.5, not partial worker output).
- Schedule the expert for B.5.5 post-review drain.
- Exception: if the unread message indicates a dispatch safety issue (stale basis, wrong slice, command failure), halt before B.5 and route through B.6 fallback.

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

#### Phase B.5.5 — Expert post-review and peer-DM drain (v0.8.0)

After reconcile and before routing/fallback, invoke the peer-DM drain scheduler. For each active expert selected for the slice (per `expert_teammates.selected[]`), the scheduler:

1. Reads unread messages for that expert.
2. Spawns the expert with the reconciled slice output plus unread messages.
3. Parses the machine result.
4. Marks injected messages read **only after parse success**.
5. Records findings, DMs sent, and status in the sidecar via `appendExpertTurn` + `updateExpertStatus`.
6. If the expert sent DMs to another active expert, schedules the recipient in the same B.5.5 drain loop.

```js
const { drainPeerDMs } = await import('<plugin>/lib/codex-bridge/expert-dm-scheduler.js');
const drainResult = await drainPeerDMs(
  activeExperts,
  {
    hasUnread: async (expertId) => (await readUnreadMessages(repoRoot, expertId)).length,
    // runTurn wrapper for the scheduler: applies the same two-step pattern
    // as B.1.5 (Claude dispatches the Task subagent itself; passes the
    // response as agentDispatch). The scheduler invokes this once per
    // turn it schedules.
    runTurn: async (expert, drainContext) => {
      const request = {
        identity: expert,
        repoRoot,
        specPath,
        specSnippet: <reconciled slice diff snippet>,
        phase: drainContext.phase,
        sliceId: drainContext.sliceId,
        sidecarParticipantState: <prior turn summaries>,
        task: 'Post-implementation review of the reconciled slice.',
      };
      const unreadMessages = await readUnreadMessages(repoRoot, expert.id);
      const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
      // YOU (Claude) dispatch the Task tool here with `prompt`, capture
      // taskResponseText, then:
      return await runTurnWithDeps(request, {
        agentDispatch: async () => taskResponseText,
      });
    },
    readExpertTurns,  // sidecar.readExpertTurns directly
    writeBreadcrumb,
  },
  {
    maxRespawnsPerExpert: 2,
    maxTotalTurns: 8,
    specPath,
    drainContext: { phase: "post-implementation-review", sliceId: <currentSliceId> },
    resumeFromSidecar: <true if recovering>,
  }
);
```

`drainContext` is REQUIRED. The scheduler fails closed (throws) if it's missing or if `readExpertTurns` errors during resume — refusing to fail open prevents double-spawning experts already capped from prior turns.

**Loop bounds:**

- Maximum 2 respawns per expert per slice per B.5.5 drain.
- Maximum 8 total expert turns per slice per B.5.5 drain.

**Halt handling:**

- `drainResult.halt === "expert-peer-dm-drain-cap-exceeded"`: caps were exhausted while DMs remain unread. Halt with `expert-peer-dm-drain-cap-exceeded` (preserves expert mailboxes per slice 7). Claude may narrow the question and retry, defer non-blocking peer discussion, or ask the user.
- `drainResult.halt === "expert-peer-dm-enqueue-failed"` (**v0.8.1**): an outbound peer-DM write failed for one or more requested recipients. The scheduler observes `turnResult.peer_dm_summary.failed > 0` immediately after a `runTurn` returns and halts. Inspect the most recent turn's `peer_messages_failed[]` to see which recipients and why (`invalid-recipient`, `self-dm`, `empty-body`, `malformed-item`, or a MailboxError code). PRESERVE policy keeps mailboxes intact so resume can fix-and-replay.
- `drainResult.halt === null`: drain converged normally. Continue to B.6 routing.

**Sidecar safety net (v0.8.1).** Scheduler-observed halt is the primary detector. As a backstop, before declaring drain converged autopilot also scans `expert_teammates.turns[]` for any turn with non-empty `peer_messages_failed` belonging to the current slice/phase. If found AND `drainResult.halt === null`, treat it as `expert-peer-dm-enqueue-failed` (the scheduler missed the signal — e.g., `appendExpertTurn` succeeded while the scheduler crashed mid-loop). This is a backup, not the primary path.

**Peer-DM schema (v0.8.1).** Expert Machine Result emits `peer_messages_requested: array of {to, body, summary?}`. The orchestrator's runtime (`runTurnWithDeps`) enqueues each valid item into the recipient's mailbox via `writeToMailbox(repoRoot, to, {from: identity.id, text: body ?? summary, summary})`. The expert does NOT call `mailbox-write` itself. Legacy `peer_messages_sent` (v0.8.0) is accepted as an alias for one release with a parse warning.

**Integration gate.** Block integration if any unresolved blocking finding remains — i.e., any entry in `expert_blockers[]` (across all dispatch records for this slice) with `disposition: "open"`. See the Blocking-Finding Override Authority section below for resolution paths.

##### Blocking-Finding Override Authority (v0.8.0)

When an expert emits a blocking finding, the orchestrator MUST resolve its disposition before proceeding past the integration gate.

**Technical overrides (Claude may apply).** Claude can override a blocking expert finding ONLY when ALL of these are true:

1. The finding is technical, not product/UX/business.
2. Claude writes a specific rationale citing concrete evidence (file path, line/function, current slice version, command output, reconciler result).
3. The override is recorded via `updateDispatchExpertBlocker(specPath, {sliceId, dispatched_at}, findingId, {disposition: "technical-override", rationale, evidence})`.

Examples of valid technical overrides:

- Expert referenced a stale slice version.
- Expert misread a command boundary.
- Expert claimed a missing test that exists at the failure boundary.
- Expert flagged a behavior that reconciler output proves is not present.

**Product/UX/business overrides (REQUIRE human authorization).** Halt with `expert-blocker-needs-user`. Surface the finding to the user. On user response, record via `updateDispatchExpertBlocker(specPath, {sliceId, dispatched_at}, findingId, {disposition: "needs-user", rationale: <user's rationale>})`.

Examples requiring the human:

- Expert says the workflow is confusing but technically works.
- Expert says a visual choice weakens the intended product feel.
- Expert says the user-facing copy changes the promise of the feature.
- Expert says the feature scope no longer matches the requested outcome.

Claude rubber-stamping a product/UX/business override (i.e., applying `technical-override` to a non-technical finding) is a contract violation; the rationale field is auditable, and a non-technical rationale is grounds for reversal during slice review.

#### Phase B.6 — Apply routing rules

The routing sequence is:

```text
preferred implementer
  -> fallback implementer on implementation-dispatch failure
  -> halt with implementer-unavailable only if both fail
```

**Failure triggers fallback** (any one of these from the preferred dispatch):

1. Codex `codex exec` exits non-zero (read from status file `exit_code`) — for `transport: codex-background-bash`.
2. Codex background task exceeds `codex_dispatch.max_runtime_ms` — orchestrator kills + halts `codex-background-timeout`.
3. Codex background task lost — orchestrator crashed and there's no status file evidence; halts `codex-background-task-lost`.
4. Sonnet subagent dispatch error (the `Task` tool call itself failed) — for `transport: claude-subagent`.
5. Zero commits produced (`commit_count == 0`).
6. Non-conforming commits emitted (`non_conforming_subjects` non-empty).
7. Missing or malformed final-message JSON (Sonnet path only), when there is no clear blocker signal.

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

#### Phase B.6.5 — Failure cascade halt (v0.7.3)

When ANY slice in the autopilot run reaches a `failed-halted` outcome (preferred + fallback both failed, or `BLOCKED`/`NEEDS_CONTEXT` halt without recovery), the orchestrator MUST halt the entire autopilot run with `dependency-cascade-halt`.

```js
import { enumerateDescendants } from '<plugin>/lib/codex-bridge/dependency-graph.js';
const blockedDescendants = enumerateDescendants(dag, failedSliceId);
```

The halt diagnostic includes:

- `failed_slice_id` — the slice that failed
- `failure_reason` — the underlying halt reason (`implementer-unavailable`, `codex-blocked`, etc.)
- `blocked_descendants` — array of slice ids transitively depending on the failed slice
- `shipped_so_far` — array of slice ids already shipped (preserved on integration branch)

Why halt the whole run rather than continuing with non-descendants? Because:
- The user needs visibility: silently continuing would land partial work without surfacing the failure.
- DAG correctness assumes deps shipped successfully; a failed slice invalidates that assumption for descendants.
- Resume after user-side investigation is preferable to hidden state divergence.

On resume after the user fixes the failed slice (or instructs autopilot to skip it), the next session's Phase B.PRE re-validates the DAG digest. If the plan changed during investigation → halt `plan-changed-during-autopilot` (catches user edits during recovery). Otherwise resume normally; the failed slice's state in sidecar is reset to `pending` by the user/skill before relaunch.

For parallel batches with multiple failures: enumerate descendants once for each failed slice; the union is the blocked set.

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

- **At codex dispatch time** (transport=codex-background-bash, v0.7.2), append an in-progress entry IMMEDIATELY after issuing the background Bash, BEFORE the task completes:
  ```bash
  cli sidecar-append-implement-dispatch --specPath <spec> --sliceId <slice-N> --dispatch '{
    "slice_id":"<slice-N>",
    "agent":"codex",
    "transport":"codex-background-bash",
    "task_id":"<Bash task id from run_in_background>",
    "output_file":"<absolute path to .log>",
    "status_file":"<absolute path to .status.json>",
    "dispatched_at":"<ISO>",
    "worktree":"<absolute worktree path>",
    "outcome":"in-progress"
  }'
  ```
  This is durable evidence — if the orchestrator crashes between dispatch and completion, the next session reads `status_file` to determine codex's terminal state.

- **At codex completion** (after the Bash task notification arrives + you've read the status file + run reconciler), promote the in-progress entry to its terminal outcome via `finalizeImplementDispatch`:
  ```js
  import { finalizeImplementDispatch } from '<plugin>/lib/codex-bridge/sidecar.js';
  finalizeImplementDispatch(specPath, sliceId, taskId, {
    outcome: 'shipped' | 'failed-fallback-pending' | 'failed-halted',
    head_sha: reconciler.head_sha,
    commit_count: reconciler.commit_count,
    completed_at: <ISO now>,
    concerns: [...]  // optional
  });
  ```
  This mutates the in-progress record in place by `task_id` match. Throws if no matching in-progress entry found.

- **At sonnet reconcile** (transport=claude-subagent, synchronous), append a terminal dispatch record directly:
  ```bash
  cli sidecar-append-implement-dispatch --specPath <spec> --sliceId <slice-N> --dispatch '{
    "slice_id":"<slice-N>",
    "agent":"sonnet",
    "transport":"claude-subagent",
    "thread_id":null,
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

## Troubleshooting setup errors

If autopilot fails to start, or any phase fails with errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. The doctor diagnoses the install and prints the exact commands to fix each issue. Resume autopilot after the doctor reports all checks green.
