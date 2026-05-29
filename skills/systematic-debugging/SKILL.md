---
name: systematic-debugging
description: Use when a bug is non-trivial. Claude forms hypothesis → Codex critiques → 7-round loop on root cause → fix → slice review on the fix.
---

# Systematic Debugging (Codex-paired)

## What this changes vs. upstream
After Claude forms a root-cause hypothesis, Codex reviews the hypothesis (not just the fix). The hypothesis itself is the artifact under the 7-round loop. Once the hypothesis is double-SHIP'd, the fix follows the standard slice-review flow.

## When to invoke
Trivial bugs (typos, obvious off-by-one) skip this — just fix. Use this for: intermittent failures, multi-system interactions, behavior that contradicts your mental model, "shouldn't be possible" bugs.

## Honest-reporting activation (v0.8.1, do this first)
Before Phase 0, write the honest-reporting marker:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill systematic-debugging
```

The marker has an 8-hour TTL and auto-expires; no cleanup needed. This keeps debug claims ("ROOT CAUSE IDENTIFIED", "FIX VERIFIED") sourced to actual tool output.

## Phase 0 — Reproduce
Standard upstream discipline: minimal reproduction, deterministic, captured as a failing test if possible. Don't move on until you can reproduce on demand.

## Phase 1 — Form hypothesis (Claude)
Write a 1-paragraph hypothesis: WHAT is wrong, WHERE in the code, WHY this manifests as the symptom. Cite specific files/lines. Predict an experiment that would falsify it.

## Phase 2 — Codex hypothesis review (counted, max 7 rounds)
Open or resume a session for this feature/bug. Send:

```
Phase: debug-hypothesis
Round: N

## Symptom
{{SYMPTOM}}

## Reproduction
{{REPRO_STEPS}}

## My hypothesis
{{HYPOTHESIS}}

## Falsification experiment
{{EXPERIMENT}}

## Your job
- Is this the simplest explanation?
- What did I miss? Other plausible root causes I should rule out first?
- Does the falsification experiment actually rule it out?
- End with the required verdict block.
```

Codex's critiques are typically: "you're assuming X but Y could also cause this", "your experiment doesn't actually falsify", "simpler explanation is Z".

Round loop runs as before. Sidecar phase is `debug:<short-bug-id>`.

**If a `codex-reply` returns `isError: true` with `Session not found for thread_id:`** (the MCP server restarted mid-session — threads are process-local), recover instead of halting: build replay context (`node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-replay-context --specPath "<spec-path>"`), open a NEW thread via the initial `codex` tool seeded with that replay + the pending hypothesis prompt, then persist the rotation (`sidecar-rotate-thread-id --specPath "<spec-path>" --oldThreadId <old> --newThreadId <new> --reason session-not-found`). Surface one line ("Codex thread was lost; opened a new thread and replayed the sidecar context") and continue. Do not discard prior hypothesis history.

## Composer-picked hypothesis review (v0.9.0)

After Phase 2's first Codex round produces a critique, the orchestrator MAY (and for high-stakes bugs SHOULD) fan out **composer-selected experts** to critique the hypothesis from domain-specific angles. Usually 1–2 experts based on bug signals (per spec § 3 table).

### Step 1 — Compose experts from bug-domain signals

```js
const { composeExperts } = await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-composer.js');

const signals = {
  specHas:    [/* hypothesis text keywords */],
  filePaths:  [/* files implicated in the hypothesis */],
  domains:    [bugDomain],     // 'ui' → expert-ui; 'security' → expert-security; etc.
  fanOutRationale: undefined,  // hypothesis review usually narrow; rarely >2 experts
};
const result = composeExperts({
  phase: 'hypothesis-review',
  signals,
  repoRoot,
});
// result.selected: ExpertIdentity[]    (typically 1–2 for bug review)
```

Typical mappings:
- UI bug (visual glitch, layout regression) → `expert-ui`
- Backend/data bug (concurrency, ordering, persistence) → `expert-backend`
- Security-relevant bug (auth bypass, secret leak, escalation) → `expert-security`
- Cross-domain "shouldn't be possible" bug → `expert-architecture`

### Step 2 — Single-mode dispatch (default)

```js
const { runTurnWithDeps, assembleSpawnPrompt } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/expert-turn.js');
const { readUnreadMessages } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/mailbox.js');

const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');
const { RoleRoutingError } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/errors.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

for (const identity of result.selected) {
  let resolved;
  try {
    // Resolver is keyed by identity.id ("expert-architecture"), not identity.role.
    resolved = resolveAdapter(identity.id, availableCLIs, /* userRouting */ null);
  } catch (err) {
    if (err instanceof RoleRoutingError) continue;  // hypothesis review is advisory
    throw err;
  }
  const adapter = resolved.cli === 'claude'
    ? 'claude-task'
    : `cli-harness:${resolved.cli}`;
  const request = {
    identity,
    repoRoot,
    specPath,                       // bug-thread spec path
    specSnippet:            hypothesisText,
    phase:                  'hypothesis-review',
    sliceId:                bugId,  // debug:<bug-id> sidecar phase
    adapter,                        // audit field must match the transport
    sidecarParticipantState: <prior turn summaries>,
    task:                    'Critique the root-cause hypothesis. Is this the ' +
                             'simplest explanation? What did Claude miss?',
  };
  // ... orchestrator dispatches via resolved.cli, captures responseText ...
  const turnResult = await runTurnWithDeps(request, {
    agentDispatch: async () => responseText,
  });
}
```

### Step 3 — Panel mode for high-stakes / security-relevant bugs

If the bug is **security-relevant** (auth/credential/escalation) OR the user explicitly requests cross-model consensus, upgrade to **panel mode** via `dispatchPanel` (slice 6). Build the `dispatchFns` map per the same pattern as `writing-plans` TDD review:

```js
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

const panelOutcome = await dispatchPanel(identity.id, request, dispatchFns, {
  panel_min_size: 2,
  panel_max_size: 3,
});
```

Apply the same panel-outcome rules: `panel-SHIP` proceeds; `panel-REVISE` revises the hypothesis; `panel-disagreement` halts; `panel-quorum-lost` / `panel-quorum-unavailable` halt with the corresponding code.

### Step 4 — Aggregate critique into hypothesis revision

Concatenate each expert's `blocking_findings[]` + `nonblocking_findings[]` into the Round-(N+1) Codex prompt under `## Expert findings from hypothesis-review`. Codex incorporates the experts' angles into its own critique. The 7-round Codex loop continues with the augmented context.

If any expert returns a blocking finding that contradicts the hypothesis (e.g., "this hypothesis is testing the symptom not the cause"), the orchestrator MUST surface the contradiction and revise — Claude does NOT silently override hypothesis-review blockers.

## Phase 3 — Run the falsification experiment
Only after the hypothesis is double-SHIP'd. The experiment confirms or kills the hypothesis. If killed, restart at Phase 1 with new hypothesis (new round count).

## Phase 4 — Implement the fix
Standard TDD: write the failing regression test that the hypothesis predicts, implement the minimal fix, verify the test passes and the symptom is gone.

## Phase 5 — Slice-review the fix
The fix is a slice (even a one-task slice). Run it through `subagent-driven-development`'s per-slice review.

## Failure modes
- **Multiple hypotheses double-SHIP'd, all falsified:** the bug is in your reproduction, not your hypothesis. Go back to Phase 0.
- **7-round deadlock on hypothesis:** halt; bring to user with both positions and the symptom.

## Sidecar usage
If this debug session belongs to an in-flight feature, reuse that feature's sidecar (its threadId is the same Codex thread that drafted the spec and approved the plan — Codex remembers all prior context). If the bug is standalone, create a new spec stub at `docs/superpowers/specs/YYYY-MM-DD-debug-<bug-id>.md`, open a fresh Codex thread by invoking `mcp__plugin_codex-paired-superpowers_codex__codex` (with the L11 rubric + verdict-format prompts prepended), and persist the threadId via `sidecar-init`. Either way, all hypothesis rounds get logged in the sidecar.

**Model handling.** When opening a fresh codex thread for a standalone bug, do NOT pass a per-call `model` — as of v0.13.0 it is pinned to `gpt-5.5` by the MCP server config (`.claude-plugin/plugin.json`). Pass only `config: { model_reasoning_effort: "high" }`. The codex MCP tool's schema description shows `gpt-5.2`/`gpt-5.2-codex` as stale upstream examples; those must NOT be passed (a per-call model overrides the server pin). See `skills/brainstorming/codex-pairing.md` for the canonical invocation form.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
