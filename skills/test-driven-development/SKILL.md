---
name: test-driven-development
description: Use before writing any non-trivial test suite. Claude drafts the test list; Codex reviews coverage, edge cases, and mock/integration trade-offs in a 7-round loop. Then standard red-green-refactor proceeds.
---

# Test-Driven Development (Codex-paired)

## What this changes vs. upstream
Before red-green-refactor, the **test list** itself is reviewed by Codex. Catches: missing edge cases, redundant tests, wrong test boundaries, mock-vs-integration mistakes — before any test code is written.

## When to invoke
Any slice with non-trivial test design. Skip for one-test-one-function slices where the design is obvious.

## Honest-reporting activation (v0.8.1, do this first)
Before Phase 0, write the honest-reporting marker:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill test-driven-development
```

The marker has an 8-hour TTL and auto-expires; no cleanup needed.

## Phase 0 — Draft the test list (Claude)
Write a numbered list of test cases. Each entry:
1. What invariant or behavior it pins.
2. Inputs / preconditions.
3. Expected outcome.
4. Mocks/integration choice + justification.

## Phase 1 — Codex test-list review (counted, max 7 rounds)
Resume the session for this feature. Send:

```
Phase: tdd-review
Round: N

## Slice context
{{SLICE_NAME}} — {{SLICE_GOAL}}

## Test list under review
{{TEST_LIST}}

## Your job
- Missing edge cases? (zero, negative, null, off-by-one, concurrent, large input, …)
- Redundant tests testing the same path?
- Wrong boundary? (testing implementation when behavior is what matters, or vice versa)
- Mock/integration: are mocks hiding real failure modes?
- Pinning the right invariants?
- End with the required verdict block.
```

Sidecar phase is `tdd:<slice-id>`.

## tdd-review (panel mode) (v0.9.0)

By default, the `tdd-review` phase routes `expert-test` through **panel mode** for cross-model consensus on test design. Test design is foundational; single-model bias here can hide structurally wrong test boundaries. Per spec § 4 table, `expert-test` in `tdd-review` is always panel mode.

### Default: panel mode

Preference ladder is `[codex, claude]`. Defaults: `panel_min_size: 2`, `panel_max_size: 3`. Build `dispatchFns` and dispatch via `dispatchPanel`:

```js
const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');
const { runTurnWithDeps } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/expert-turn.js');
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

const dispatchFns = new Map();
for (const cli of ['codex', 'claude']) {     // expert-test ladder (cli names, not adapters)
  if (!availableCLIs.has(cli)) continue;
  // Sidecar 'adapter' audit field MUST match the actual transport. Inject it
  // into the request before calling runTurnWithDeps — otherwise slice-5b's
  // default ('claude-task') silently mislabels codex panelists.
  const adapter = cli === 'claude' ? 'claude-task' : `cli-harness:${cli}`;
  dispatchFns.set(`expert-test@${cli}`, {
    fn: async (req) => {
      const responseText = await /* adapter dispatch */;
      return runTurnWithDeps({ ...req, adapter }, { agentDispatch: async () => responseText });
    },
    runtime_kind: cli === 'claude' ? 'claude-task' : 'cli-harness',
  });
}

const outcome = await dispatchPanel('expert-test', request, dispatchFns, {
  panel_min_size: 2,
  panel_max_size: 3,
});
```

Apply the panel outcome the same way `writing-plans` does (`panel-SHIP` → proceed; `panel-REVISE` → revise test list and re-dispatch; `panel-disagreement` → user arbitrates; `panel-quorum-lost` / `panel-quorum-unavailable` → halt).

### Override: `--single` for non-panel dispatch

Skill arg `--single` skips panel mode and runs **single dispatch** via `runTurnWithDeps`. Use only when:

- The slice is trivially small and panel cost is unwarranted.
- Only one CLI is available and `panel-quorum-unavailable` would block progress.

```js
// Single dispatch (override path). Resolve cli, then derive adapter and
// inject it before calling runTurnWithDeps so the sidecar audit field
// matches the actual transport.
const resolved = resolveAdapter('expert-test', availableCLIs, /* userRouting */ null);
const adapter = resolved.cli === 'claude' ? 'claude-task' : `cli-harness:${resolved.cli}`;
const request = { identity: expertTest, repoRoot, specPath, specSnippet,
                  phase: 'tdd-review', sliceId, adapter, task: '...' };
const result = await runTurnWithDeps(request, {
  agentDispatch: async () => responseText,
});
// result: { ok: true, result: parsed } | { ok: false, reason }
```

Single mode loses the cross-model consensus guarantee. Document the override decision in the sidecar so a future replay can see why panel was bypassed.

### Composer augmentation

For security-critical surfaces, the composer (`composeExperts`) MAY add `expert-security` to the `tdd-review` phase. The added expert runs in single mode by default (panel-mode escalation is opt-in via the plan's `high_stakes` frontmatter, not auto-applied here).

## Phase 2 — Implement red-green-refactor
After double-SHIP, write the failing tests in the agreed order. Standard TDD discipline applies — see upstream `superpowers:test-driven-development` for the red/green/refactor cadence; this fork adds only the up-front review.

## Phase 3 — Slice-review the test suite + implementation
At slice review time, the test suite is part of the diff. Codex's slice review will catch any divergence from the agreed test list (and may push for more, which is in-scope critique).

## Required upstream sub-skill
- `superpowers:test-driven-development` for the red-green-refactor mechanics. This forked skill ADDS the up-front test-list review.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
