---
name: subagent-driven-development
description: Use when executing a Codex-paired plan. After each slice's subagent reports done, runs a scoped Codex review on that slice's diff (max 7 rounds). Codex must respect slice boundaries — out-of-slice issues go to a Deferred list, not blockers.
---

# Subagent-Driven Development (Codex-paired)

## What this changes vs. upstream
After each slice's implementing subagent reports completion, Claude runs a **scoped Codex review** before moving to the next slice. The review is locked to the slice's tasks; out-of-scope issues are noted but cannot block.

## Honest-reporting activation (v0.8.1, do this first)
Before the per-slice flow starts, write the honest-reporting marker so the Stop/PreToolUse hook keeps claims sourced across the implementation session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill subagent-driven-development
```

The marker has an 8-hour TTL and auto-expires; no cleanup needed.

## Per-slice flow

### Step A: dispatch implementing subagent
Same as upstream — dispatch a subagent for slice N with the slice's tasks. Wait for completion + tests passing.

### Step B: capture slice artifacts
Collect:
- Slice scope: the exact task list from the plan for slice N (literal markdown, the bullet list).
- Diff: `git diff <slice-start-sha>..HEAD -- <files-this-slice-was-meant-to-touch>`
- Test output: pasted verbatim from the subagent's last test run.

### Step C: open Codex slice review
Resume the session. Build the prompt from `slice-review-prompt.md` (in this skill folder), substituting `{{SLICE_ID}}`, `{{ROUND}}`, `{{SLICE_TASKS}}`, `{{SLICE_DIFF}}`, `{{TEST_OUTPUT}}`, and (rounds 2+) `{{PRIOR_CRITIQUES}}`.

The prompt explicitly states:
> Review only what is in this slice's scope. Out-of-slice issues = note for later in `## Deferred`, do not block on them. If you find an out-of-slice critical bug, name it in `## Deferred` with severity, but ship the slice.

Look up the threadId and send the prompt via the bundled MCP `codex-reply` tool:

```bash
THREAD_ID=$(node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-thread-id --specPath "<spec-path>")
```

Invoke **`mcp__plugin_codex-paired-superpowers_codex__codex-reply`** with `{ threadId: "<THREAD_ID>", prompt: "<filled slice-review prompt>" }`. The response's `content` is Codex's review + verdict block.

For slice-review specifically, you may pass `config: { model_reasoning_effort: "medium" }` to speed up small-diff reviews; reserve `high` for slices that touch core architecture.

### Step D: 7-round loop
Same as brainstorming. Both must SHIP. Sidecar phase is `slice:<slice-id>` (e.g., `slice:2`). On double-SHIP, mark slice shipped:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-slice \
  --specPath "<spec-path>" \
  --sliceId "<slice-id>" \
  --state '{"rounds":[...],"shipped":true,"deferred":[...]}'
```

### Step E: surface deferred items
If the slice review produced any `## Deferred` items, show them to the user before starting the next slice. They might warrant a new task in a future slice or a separate plan.

### Step F: proceed to next slice
Only after slice N is shipped and any user-arbitrated deferreds are decided.

## Per-slice expert review (v0.9.0)

After the implementing subagent reports completion (Step A) and the slice's diff + tests are captured (Step B), but BEFORE Step C's Codex slice review, the orchestrator MUST run **composer-selected experts** on the slice. This mirrors autopilot's Phase B.5.5 pattern but applies to inline (non-autopilot) execution: every slice gets domain-expert review before it's allowed to ship.

This is the inline analog of autopilot's `post-implementation-review` phase — same composer, same dispatch primitives, same blocking-finding contract.

### Step 1 — Compose experts from slice signals

```js
const { composeExperts } = await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-composer.js');

const signals = {
  specHas:    [/* keywords from slice plan section */],
  filePaths:  [/* slice **Files:** block */],
  domains:    [sliceDomain],
  explicitDirective: sliceFrontmatter.experts,  // optional **Experts:** directive
  fanOutRationale: anticipatesFanOut ? '<concrete justification>' : undefined,
};
const result = composeExperts({
  phase: 'post-implementation-review',
  signals,
  repoRoot,
});
// result.selected: ExpertIdentity[]
```

The composer throws `role-composer-fan-out-unjustified` for >5 selections without rationale.

### Step 2 — Resolve each expert to an adapter

```js
const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

for (const identity of result.selected) {
  const resolved = resolveAdapter(identity.role, availableCLIs, /* userRouting */ null);
  // resolved.adapter ∈ {'claude-task', 'codex', 'ollama', 'gemini', ...}
}
```

If `resolveAdapter` returns `null` for a selected expert (no available CLI in the ladder + no override), halt with `cli-dispatch-failed` for that slice — fail-closed (per spec § 5).

### Step 3 — Dispatch each expert via `runTurnWithDeps`

Each expert runs **independently in single mode** (panel mode is opt-in via plan frontmatter `high_stakes: true`, handled by `writing-plans`, not here). Use `runTurnWithDeps` with the two-step orchestration pattern (Claude dispatches Task/harness; runtime drives parse + sidecar persistence):

```js
const { runTurnWithDeps, assembleSpawnPrompt } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/expert-turn.js');
const { readUnreadMessages } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/mailbox.js');

for (const identity of result.selected) {
  const request = {
    identity,
    repoRoot,
    specPath,
    specSnippet:            sliceDiffSnippet,
    phase:                  'post-implementation-review',
    sliceId,
    sidecarParticipantState: <prior turn summaries>,
    task:                    'Review the slice diff. Surface blocking findings + DMs.',
  };
  const unreadMessages = await readUnreadMessages(repoRoot, identity.id);
  const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
  // ... orchestrator dispatches Task/harness, captures responseText ...
  const turnResult = await runTurnWithDeps(request, {
    agentDispatch: async () => responseText,
  });
  // turnResult: { ok: true, result } | { ok: false, reason }
}
```

Dispatch experts in parallel (single assistant turn, multiple tool calls).

### Step 4 — Aggregate blocking findings

For each expert turn:
- `result.blocking_findings[]` non-empty → slice is BLOCKED; halt before Step C (Codex review). Surface findings to user OR apply technical-override via `updateDispatchExpertBlocker` (rules match autopilot's B.5.5 Blocking-Finding Override Authority).
- `result.nonblocking_findings[]` → record in sidecar; surface to user during Step E deferred-items review.

### Step 5 — Proceed to Step C (Codex slice review) only on clean expert pass

Codex slice review (Step C) runs AFTER experts have shipped (or after their blockers have been resolved). Codex sees the same diff plus a `## Expert findings from post-implementation-review` block in its prompt — cross-model L11 critique stacked on Codex's structural review.

## Anti-scope-creep enforcement
If Codex emits a critique that targets code outside the slice's scope, Claude pushes back: "this is out of slice; either move to Deferred or justify why it must be fixed inside this slice." This is a structural disagreement Codex must justify with concrete reasoning (e.g., "the slice introduces a public API I'm critiquing", which is in-scope).

## Stalled-slice escape
If a slice can't reach double-SHIP in 7 rounds, halt the implementation. Surface the deadlock to the user with both positions. Don't silently downgrade or skip.

## Required upstream sub-skills
- `superpowers:subagent-driven-development` — for the implementer + spec-reviewer + code-quality-reviewer pattern. This forked skill ADDS the Codex slice review on top.
- `pr-review-toolkit:silent-failure-hunter` — recommended for the code-quality reviewer in slices that touch error-handling.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
