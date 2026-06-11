---
name: subagent-driven-development
description: Use when executing a Codex-paired plan. After each slice's subagent reports done, runs a scoped Codex review on that slice's diff (max 7 rounds). Codex must respect slice boundaries — out-of-slice issues go to a Deferred list, not blockers.
---

# Subagent-Driven Development (Codex-paired)

This is the **interactive driver implementation** reached through
`codex-paired-superpowers:execution` (`driver: interactive`). Users invoke `execution`; this skill is
the per-slice engine it delegates to.

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

**Commit-parity preflight (v0.15.0).** Before capturing the diff — on round 1 AND on every
re-review after a fix — run `git status --porcelain` in the slice's working directory. If any
slice-touched file shows uncommitted or unstaged changes, STOP and commit them first. Sidecar
replay found two features that each burned a full review round because the fix existed in the
working tree but not in the committed state the reviewer saw ("staged index still has the old
regex"). The diff sent to review must be the committed diff, and the tree must be clean.

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

**If the reply returns `isError: true` with `Session not found for thread_id:`** (the MCP server restarted mid-feature — threads are process-local), recover instead of halting: build replay context (`node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-replay-context --specPath "<spec-path>"`), open a NEW thread via the initial `codex` tool seeded with that replay + the slice-review prompt that failed, then persist the rotation (`node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-rotate-thread-id --specPath "<spec-path>" --oldThreadId <old> --newThreadId <new> --reason session-not-found`). Tell the user in one line ("Codex thread was lost; opened a new thread and replayed the sidecar context") and continue the round — do not discard prior review history.

For slice-review specifically, you may pass `config: { model_reasoning_effort: "medium" }` to speed up small-diff reviews; reserve `high` for slices that touch core architecture.

### Step D: 7-round loop
Same as brainstorming. Both must SHIP. Sidecar phase is `review-slice:<slice-id>` (e.g.,
`review-slice:slice-2`) — the spec-canonical code-bearing phase name as of v0.13.0 (replacing the
legacy `slice:<id>`).

**Code-bearing verification floor (v0.13.0, Goal 1).** Because `review-slice:<slice-id>` is a
code-bearing phase, a SHIP for either side is gated on an EXECUTED verification command, not just an
inspection audit. Record the slice's test/build run (captured in Step B) as a `verification` audit
entry before logging a SHIP round, e.g.:

```bash
printf '%s' '{
  "phase": "review-slice:<slice-id>",
  "round": N,
  "side": "<claude|codex>",
  "commands": [
    {"cmd": "npm test", "summary": "42 passed", "kind": "verification", "exit_code": 0}
  ],
  "verdict_basis": "<one-line: tests pass + review judgement>"
}' | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-audit --specPath "<spec-path>"
```

If the slice's tests were not executed (or did not pass with `exit_code: 0`), the gate refuses the
SHIP — run the tests and record the result, or emit REVISE.

**Faster verification via test-impact analysis (optional).** Instead of the full suite you MAY run
`npm run test:affected` (coverage-based selection — see `scripts/tia.mjs`). It writes a review-grade
record to `.tia-cache/last-run.json`; embed that record as the verification command's `selection` so
the audit is self-contained — Codex can see exactly what ran, against what change set, and why it was
sufficient:

```json
{"cmd": "npm run test:affected", "summary": "ran 6 of 110 affected tests, exit 0",
 "kind": "verification", "exit_code": 0,
 "selection": {"mode": "selected", "ran": 6, "fullyCovered": true, "uncovered": [],
               "exit": 0, "base": "HEAD (working tree)", "mapVersion": 2,
               "tests": ["tests/...test.js", "..."], "changed": ["lib/...js"]}}
```

Gate rules the audit enforces on a TIA `selection`:
- `"ran": 0` or `"mode": "none"` → **not** valid verification (running the empty affected set proves nothing).
- `"mode": "selected"` counts only when `"fullyCovered": true` and `"uncovered": []` (the subset covered every changed source).
- `"mode": "all"` with `ran > 0` is always valid (full run is the safe default).

Codex reviewing the SHIP can still challenge whether a `selected` subset was sufficient. On
double-SHIP, mark slice shipped:

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

**Refresh the test-impact map at the slice boundary (if using `test:affected`).** A shipped slice may
have changed which source files its tests load. Re-map only the tests the slice touched so the map
stays current for later slices (prevents drift without a full rebuild):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/tia.mjs refresh --base <slice_start_sha>
```

Use the slice's start SHA (the commit the slice branched from) as `--base` so the diff is exactly this
slice's changes.

## Edit discipline (v0.13.0, Goal 5)

Repeated failed edits waste turns. The orchestrator and every implementing subagent MUST follow this:

- **Read before editing** when read-state is uncertain — if another agent may have touched the file,
  or if your last read predates a failed edit, re-read the file in the current turn first.
- If an edit fails with **`File has not been read yet`**, immediately read the file and recompute the
  edit against its current contents.
- If an edit fails with **`String to replace not found`**, immediately re-read and inspect the target
  region; the file has changed or your `old_string` is stale.
- **Never retry the same** `(file, old_string, new_string)` tuple byte-for-byte after it just failed —
  a byte-identical retry is a procedural error, not a recovery. Recompute from a fresh read.
- For bulk edits, prefer a structured patch with enough surrounding context captured after the fresh read.

## Flake handling (v0.13.0, Goal: trustworthy verification in an automated loop)

A flaky test poisons the agentic loop: a flaky FAIL stalls the slice, a flaky PASS gives a false SHIP
through the verification floor. Handle flakes honestly rather than papering over them.

- **Same-SHA retry (mirrors `lib/codex-bridge/flake-retry.js`).** If a verification command fails,
  re-run it ONCE at the same commit without changing files. If it then passes, it is flaky — it did
  pass, so it satisfies the floor, but you MUST record the truth on the audit command:
  `{"cmd": "...", "kind": "verification", "exit_code": 0, "attempts": 2, "flaky": true}`. Never record
  a clean first-try pass for a result that needed a retry.
- **Cross-agent disagreement = a flake signal.** Claude and Codex each record their own verification
  audit. If the same test passes for one side and fails for the other at the same commit, treat it as
  flaky: do NOT SHIP on it — investigate and root-cause, or quarantine it explicitly.
- **The quarantine list.** `node ${CLAUDE_PLUGIN_ROOT}/scripts/tia.mjs flaky` lists tests that
  failed/errored when last mapped in isolation (the TIA `ok:false` set). These always re-run and are
  known flake candidates; a SHIP resting on one should be challenged.
- **Codex challenges flaky evidence.** At slice review, Codex SHOULD inspect `listFlakyVerifications`
  for the round and push back on a SHIP whose verification was flaky rather than clean. Prefer fixing
  the flake's root cause (e.g. a wall-clock or ordering race) over retrying around it.

## Per-slice reviewer review (v0.9.0)

After the implementing subagent reports completion (Step A) and the slice's diff + tests are captured (Step B), but BEFORE Step C's Codex slice review, the orchestrator MUST run **composer-selected experts** on the slice. This mirrors autopilot's Phase B.5.5 pattern but applies to inline (non-autopilot) execution: every slice gets domain-expert review before it's allowed to ship.

This is the inline analog of autopilot's `post-implementation-review` phase — same composer, same dispatch primitives, same blocking-finding contract.

### Step 1 — Compose experts from slice signals

```js
const { composeReviewers } = await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/reviewer-composer.js');

// Directive precedence: the canonical **Reviewers:** slice directive maps to
// `reviewersDirective`. The deprecated **Experts:** directive is still accepted
// on read and maps to `explicitDirective`. Prefer `sliceFrontmatter.reviewers`;
// fall back to `sliceFrontmatter.experts` only for legacy plans. If both are
// present, Reviewers wins and the composer returns a `directiveWarning`.
const signals = {
  specHas:    [/* keywords from slice plan section */],
  filePaths:  [/* slice **Files:** block */],
  domains:    [sliceDomain],
  reviewersDirective: sliceFrontmatter.reviewers, // canonical **Reviewers:** directive
  explicitDirective: sliceFrontmatter.experts,    // deprecated **Experts:** alias (accepted-on-read)
  fanOutRationale: anticipatesFanOut ? '<concrete justification>' : undefined,
};
const result = composeReviewers({
  phase: 'post-implementation-review',
  signals,
  repoRoot,
});
// result.selected: ReviewerIdentity[]
// result.directiveWarning: string|null (set when a legacy **Experts:** directive
//                          is read, or when both directives are present)
```

The composer throws `role-composer-fan-out-unjustified` for >5 selections without rationale.

### Step 2 — Resolve each expert to an adapter

```js
const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');

const { RoleRoutingError } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/errors.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

const resolutions = [];
for (const identity of result.selected) {
  let resolved;
  try {
    // Resolver is keyed by identity.id ("reviewer-architecture"), NOT identity.role ("architecture").
    resolved = resolveAdapter(identity.id, availableCLIs, /* userRouting */ null);
  } catch (err) {
    if (err instanceof RoleRoutingError) {
      // Per-slice expert review is gate-class — fail-closed.
      throw new Error(`cli-dispatch-failed: ${identity.id} (${err.code})`);
    }
    throw err;
  }
  // resolved.cli ∈ {'claude','codex','ollama','gemini','qwen'}; resolved.variant may be null.
  // Translate to the sidecar adapter value runTurnWithDeps records.
  const adapter = resolved.cli === 'claude'
    ? 'claude-task'
    : `cli-harness:${resolved.cli}`;
  resolutions.push({ identity, resolved, adapter });
}
```

`resolveAdapter` THROWS `RoleRoutingError` (codes: `no-supported-cli-for-role`, `override-cli-unavailable`, `override-variant-unknown`) — it does not return `null`. For per-slice review, all three codes halt with `cli-dispatch-failed` — fail-closed (per spec § 5).

### Step 3 — Dispatch each expert via `runTurnWithDeps`

Each expert runs **independently in single mode** (panel mode is opt-in via plan frontmatter `high_stakes: true`, handled by `writing-plans`, not here). Use `runTurnWithDeps` with the two-step orchestration pattern (Claude dispatches Task/harness; runtime drives parse + sidecar persistence):

```js
const { runTurnWithDeps, assembleSpawnPrompt } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/reviewer-turn.js');
const { readUnreadMessages } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/mailbox.js');

for (const { identity, resolved, adapter } of resolutions) {
  const request = {
    identity,
    repoRoot,
    specPath,
    specSnippet:            sliceDiffSnippet,
    phase:                  'post-implementation-review',
    sliceId,
    adapter,                                // sidecar audit field; must match the actual transport.
    sidecarParticipantState: <prior turn summaries>,
    task:                    'Review the slice diff. Surface blocking findings + DMs.',
  };
  const unreadMessages = await readUnreadMessages(repoRoot, identity.id);
  const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
  // ... orchestrator dispatches via resolved.cli (Task tool for 'claude'; cli-harness for others)
  //     and captures responseText ...
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
