---
name: brainstorming
description: Use when starting any creative work — features, components, behavior changes. Pairs Claude with Codex (GPT-5.5 high) to draft and harden a spec through a 7-round revision loop. Product questions go to the user; technical questions go to Codex.
---

# Brainstorming with Codex (paired)

## What this changes vs. upstream
This skill forks `superpowers:brainstorming`. The user-facing question loop is replaced by a Codex-paired drafting loop. The user is consulted only for **product/UX/business** questions. **All technical questions** (libraries, schema, edge cases, idiomaticity) are routed to Codex, who also drafts the spec. Claude and Codex then revise the spec for up to 7 rounds; both must emit `SHIP` to advance.

## Hard gate
Do NOT invoke any implementation skill, write production code, or scaffold a project until the spec is double-SHIP'd and the user has approved it. Trivially small projects still go through this flow; the rounds may resolve in 1.

## Honest-reporting activation (v0.8.1, do this first)
Before Phase 0, write the honest-reporting marker so the Stop/PreToolUse hook can keep claims sourced for this session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill brainstorming
```

The marker has an 8-hour TTL and auto-expires; no cleanup needed. See `skills/honest-reporting/SKILL.md` for the VERIFIED / ASSUMED / UNTESTED vocabulary the hook expects.

## Phase 0 — User intent (uncounted)
Ask the **user** a small number of multiple-choice questions to establish: what to build, who it's for, what "done" looks like, scope boundaries. Each question is one message. Never ask the user a technical question.

## Phase 1 — Codebase exploration (uncounted)
Read relevant files. Build a short context note: existing patterns, conventions, file organization, prior art. This becomes context for Codex.

## Phase 2 — Open Codex session (uncounted)
Pick a spec path: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (or user override).

Compose the initial Codex prompt by concatenating, in order:
1. Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/system-rubric.md`
2. Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/verdict-format.md`
3. `Phase: spec-draft. Here is the user intent (verbatim) and the codebase context. Draft a complete L11-grade spec. End with the required verdict block.`
4. The user intent + codebase context.

Then invoke the bundled Codex MCP tool **`mcp__plugin_codex-paired-superpowers_codex__codex`** with these EXACT parameters (do NOT substitute schema-description example values like `gpt-5.2-codex` — those are stale references from the upstream codex CLI, NOT what this plugin runs on):

```json
{
  "prompt": "<the composed prompt>",
  "model": "gpt-5.5",
  "config": { "model_reasoning_effort": "high" }
}
```

**Critical — model invariant.** The `model` field is load-bearing. If you pass anything other than `"gpt-5.5"`, the thread runs on the wrong model and the entire feature's review loop is invalidated (and `codex-reply` calls inherit the wrong model — you'd need to re-create the thread to recover). The MCP tool's schema docstring mentions `gpt-5.2` and `gpt-5.2-codex` as examples; those are NOT defaults for this plugin. Always pass `"gpt-5.5"` literally. See `codex-pairing.md` for the canonical invocation form.

The response is `{ threadId, content }`. `content` is Codex's draft + its verdict block. Capture both fields.

Then create the spec file (write the draft into it) and initialize the sidecar:

```bash
mkdir -p $(dirname "<spec-path>")
# Write Codex's content to the spec file (use Edit/Write tool, not bash):
#   <spec-path> ← Codex content (strip the verdict block from the spec body
#                 if you don't want it in the doc)
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-init \
  --specPath "<spec-path>" \
  --feature "<feature-name>" \
  --threadId "<threadId from MCP response>"
```

The bridge stores the sidecar in `.superpowers-codex-paired/`; you don't need to compute the path — the CLI auto-discovers it from `--specPath`. The sidecar records the threadId, model, and reasoning effort.

## Phase 3 — Revision loop (counted, max 7 rounds)

### Round semantics (read this once, then never confuse it again)
**One round = one Codex artifact + one Claude verdict on it.**

- Phase 2's initial draft IS round 1's Codex turn. The first MCP call (`codex`) produced Codex's draft + Codex's verdict. Round 1 is therefore not a fresh Codex call — round 1's Codex side is already in hand.
- Round N (N ≥ 2) means: send Claude's critique back via `codex-reply` → Codex returns a revised draft + new verdict → Claude verdicts on the revision. Both verdicts logged together as round N.
- The loop exits when **both** verdicts within the same round are `SHIP`.

### Per-round procedure

For each round N starting at 1:

1. **Form Claude's verdict** on the current Codex draft. Apply the L11 rubric independently. Verify any specific claim against actual code/files before accepting.

2. **Append the round to the sidecar** with both verdicts:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round \
     --specPath "<spec-path>" \
     --round '{"phase":"spec","round":N,"claude":"SHIP|REVISE: ...","codex":"SHIP|REVISE: ..."}'
   ```

3. **If both shipped, exit.** Move to Phase 4.

4. **Otherwise, send round N+1 to Codex.** Build the prompt: phase header, round number, the current draft (or a reference to it), `## Critique from previous round` listing Claude's REVISE items and Codex's REVISE items (whichever were non-SHIP), and instruction to revise.

   Read the threadId from the sidecar:

   ```bash
   THREAD_ID=$(node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-thread-id --specPath "<spec-path>")
   ```

   Invoke **`mcp__plugin_codex-paired-superpowers_codex__codex-reply`** with:

   ```json
   {
     "threadId": "<THREAD_ID>",
     "prompt": "<round-(N+1)-prompt>"
   }
   ```

   The response's `content` is Codex's new draft + new verdict. Goto step 1 with N := N+1.

(See `codex-pairing.md` in this skill folder for full bridge protocol.)

### Worked example (2-round flow)
Codex's initial draft from Phase 2 SHIP'd. Claude evaluates and finds two real gaps (language + test runner unspecified).

```
sidecar.rounds = [
  {"phase": "spec", "round": 1, "claude": "REVISE: language unspecified; test runner unspecified", "codex": "SHIP"}
]
```

Round 1 does not exit (Claude REVISE, Codex SHIP — not double-SHIP). Claude sends critique via `session-resume`. Codex returns a revision pinning POSIX sh + bash smoke test, with a new SHIP verdict. Claude evaluates the revision and genuinely SHIPs.

```
sidecar.rounds = [
  {"phase": "spec", "round": 1, "claude": "REVISE: language unspecified; test runner unspecified", "codex": "SHIP"},
  {"phase": "spec", "round": 2, "claude": "SHIP", "codex": "SHIP"}
]
```

Round 2 is double-SHIP. Loop exits. `result.rounds === 2`.

Loop exits when **both** Claude and Codex emit SHIP in the same round, OR after round 7.

### Anti-yes-man rules
- Never accept Codex's revision without independent verification.
- If you disagree, say so explicitly with file/line references.
- Performative agreement is failure. Performative disagreement is also failure.
- See `superpowers:receiving-code-review` (forked version in this plugin once shipped).

### Open contentions
If a critique survives 2 rounds (both sides keep restating opposing views without converging), record it under `## Open Contentions` in the spec AND in the sidecar via `sidecar-add-contention`. Bring it to the user.

## Composer-selected expert spec-review (v0.9.0)

After each Codex round in Phase 3 produces a revised draft, the orchestrator MAY (and at high-stakes phases SHOULD) fan out **composer-selected experts in parallel** to critique that draft before Claude forms its own round verdict. This adds cross-model L11 critique without changing the double-SHIP exit gate.

This phase is **optional per round** but **strongly recommended after rounds 1 and N (the round just before SHIP)**. Skipping it on every round defeats the purpose; running it on every round is N× expensive.

### Step 1 — Compose the expert set

Call the v0.8.0 composer with the spec's signals:

```js
const { composeExperts } = await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-composer.js');
const result = composeExperts({
  phase: 'spec-review',
  signals: {
    specHas:    [/* spec keywords */],
    filePaths:  [/* files this spec touches */],
    domains:    [/* inferred domain tags */],
    fanOutRationale: anticipatesBroadSelection ? '<concrete justification>' : undefined,
  },
  repoRoot,
});
// result.selected: ExpertIdentity[]   (2–4 typical; >5 requires fanOutRationale)
```

The composer throws `role-composer-fan-out-unjustified` if it selects >5 experts without a `fanOutRationale`. Pre-compute the rationale up front when broad selection is anticipated.

### Step 2 — Route each expert to an adapter

For each selected expert, walk the preference ladder via `resolveAdapter`. The ladder is recommendation-only — the project's `.codex-paired/role-routing.json` may override.

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

If `resolveAdapter` returns `null` (no available CLI in the ladder), the orchestrator MAY halt with `cli-dispatch-failed` for that role OR proceed without that expert (configurable per skill — for spec-review, prefer "proceed without" since spec-review is advisory).

### Step 3 — Dispatch per expert (single mode default)

For each expert, build the request and dispatch via `runTurnWithDeps` (v0.9.0 — adds replay-field persistence + `suppressPeerMessages`). The orchestrator (Claude) is responsible for the underlying transport:

- `claude-task` → dispatch the Task tool yourself; pass response text through `agentDispatch`.
- `cli-harness` (`codex`, `ollama{<variant>}`, `gemini`) → wrap `harness.dispatch` in `agentDispatch`.

```js
const { runTurnWithDeps, assembleSpawnPrompt } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/expert-turn.js');
const { readUnreadMessages } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/mailbox.js');

const request = {
  identity,
  repoRoot,
  specPath,
  specSnippet:            currentCodexDraft,
  phase:                  'spec-review',
  sliceId:                null,            // spec-phase is not slice-scoped
  sidecarParticipantState: <prior turn summaries for this expert, if any>,
  task:                   'Critique the spec draft. Surface blocking concerns; emit verdict.',
};
const unreadMessages = await readUnreadMessages(repoRoot, identity.id);
const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
// ... orchestrator dispatches Task or harness, captures responseText ...
const turnResult = await runTurnWithDeps(request, {
  agentDispatch: async () => responseText,
});
```

Dispatch all selected experts in parallel — Claude's single-turn parallel-tool-call mechanism (multiple tool calls in one assistant response) is the load-bearing primitive here.

### Step 4 — Panel mode for high-stakes spec phases (optional)

If the composer flags the phase as high-stakes (e.g., security-sensitive spec, foundational architectural decision), upgrade `expert-security` or `expert-architecture` to **panel mode** via `dispatchPanel` (slice 6 contract). Build a `dispatchFns: Map<member_id, fn>` where each entry wraps `runTurnWithDeps` with an adapter-specific identity:

```js
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

const dispatchFns = new Map();
for (const adapter of ['codex', 'claude-task']) {
  dispatchFns.set(`${identity.role}@${adapter}`, async (req) => {
    // adapter-specific: claude-task → Task tool; cli-harness → harness.dispatch
    const responseText = await /* adapter dispatch */;
    return runTurnWithDeps(req, { agentDispatch: async () => responseText });
  });
}

const panelOutcome = await dispatchPanel(identity.role, request, dispatchFns, {
  panel_min_size: 2,
  panel_max_size: 3,
});
// panelOutcome.outcome ∈ {'panel-SHIP', 'panel-REVISE',
//                         'panel-disagreement', 'panel-quorum-lost'}
```

Panel-mode peer DMs are **suppressed** (slice 6). The dispatcher applies `suppressPeerMessages: true` per panelist; panelists' `peer_messages_requested[]` are recorded under `panel_peer_messages_suppressed[]` for audit but not delivered.

### Step 5 — Aggregate into the next Codex round

Concatenate each expert's `blocking_findings[]` + `nonblocking_findings[]` (verbatim, no semantic dedup) into the Round-(N+1) Codex prompt under a new `## Expert findings from spec-review` block. Codex sees the same panel of critiques Claude saw and incorporates them into its revision. This is how cross-model L11 critique pressures the spec without removing Codex from the loop.

## Phase 4 — User sign-off (uncounted)
Show the user the final spec path. Quote the goal + open contentions if any. Wait for explicit "yes" or revisions. If the user requests changes, re-enter the loop at round 1 with the user's input as additional critique.

## Phase 5 — Hand off
Invoke `superpowers:writing-plans` (or this plugin's forked version once shipped). Pass the spec path. The plan-writing skill resumes the same Codex session via the sidecar.

## Failure modes
- **Codex unreachable:** retry once, then surface to user with option to abort or skip the round.
- **Round-7 deadlock:** annotate spec with both positions; user arbitrates; arbitration recorded in sidecar.
- **User overrides Codex:** allowed; recorded under `open_contentions`.
- **Sidecar corruption:** treat as data loss; restart with new session, surface to user.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern while running this skill, invoke `/codex-paired-superpowers:doctor` first. The doctor diagnoses the install and prints the exact commands to fix each issue. Resume this skill after the doctor reports all checks green.
