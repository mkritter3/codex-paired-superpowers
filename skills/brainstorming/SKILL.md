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

### Phase 0.5 — Spec scope (v0.11.0, refined in v0.12.0)

Before extracting goals, ask the user (in plain English) whether this spec is:

- **Feature-scoped** — one focused change, single plan, ships in one autopilot pass. The default for adjustments to an existing app.
- **App-scoped** — covers a multi-plan rollout (a whole new app, or a major chunk of an existing one). The user will run `writing-plans` + `autopilot` once per plan, with the same spec, until the goals are fully shipped. (Optionally, the user can opt into `app-autopilot` to drive this loop unattended via `/goal` — experimental.)

Phrase it conversationally: "Are we shaping one focused change here, or are we mapping out a whole app you want me to build end-to-end?" Record the choice in working memory; it gates the goals-tier check below and the Phase 5 handoff wording.

Default to feature-scoped if the user is ambiguous. App-scoped MUST have ≥ 3 goals (single-goal apps are feature-scoped by definition); enforce after goals extraction below.

## Phase 1 — Codebase exploration (uncounted)
Read relevant files. Build a short context note: existing patterns, conventions, file organization, prior art. This becomes context for Codex.

## Phase 2 — Open Codex session (uncounted)
Pick a spec path: `docs/specs/YYYY-MM-DD-<topic>-design.md` (or user override).

### Goal extraction (do this before composing the prompt)

Before handing off to Codex, extract a **goals block** from the user intent gathered in Phase 0 + relevant prior asks from session history.

1. Re-read the Phase 0 answers. Each "what does done look like" / "scope boundary" answer is a goal candidate. Rewrite each as a sentence of the form *"After this ships, the user can X"* or *"The system guarantees invariant Y."* Never include file paths, module names, or implementation choices in a goal.
2. Search archived conversations for prior asks on this topic:
   ```
   mcp__plugin_episodic-memory_episodic-memory__search query=["<feature-name>", "<related-concept-1>", "<related-concept-2>"]
   ```
   If the user has previously asked for an adjacent capability, include it as a goal (or explicitly defer it with rationale). The v0.10.0 retrospective lesson: the user had asked for inter-agent communication + dependency DAG "since v0.6" and the spec didn't surface those asks, so the spec optimized for the wrong target.
3. Search the codebase for primitives that might already satisfy the goal:
   ```
   grep -rn "<capability-keyword>" lib/ src/ skills/
   git log --all --oneline --grep="<keyword>"
   ```
   Record each command + result. If a goal is partially satisfied by existing code, write the goal as "extend X to also do Y" instead of "build new system Z."
4. Compose the goals block:
   ```
   <<<GOALS>>>
   - Goal 1: <observable user outcome, no implementation>
   - Goal 2: ...
   ## Existing primitives that may satisfy these goals
   - <path>:<line> — <one-line summary>
   ## Prior user asks (from session archive)
   - <date>: <summary> — covered by Goal N / explicitly deferred because <reason>
   <<<END_GOALS>>>
   ```
   This block is invariant across the revision loop — Codex critiques against it every round.

   **App-scope gate (v0.11.0).** If Phase 0.5 marked this spec app-scoped and the goals block has < 3 goals, halt and route back to Phase 0.5: either expand the goal set or downgrade to feature-scoped. App-scoped specs drive multi-plan rollouts; a single-goal "app" is just a feature.

Compose the initial Codex prompt by concatenating, in order:
1. Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/system-rubric.md`
2. Contents of `${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/prompts/verdict-format.md`
3. The `<<<GOALS>>>...<<<END_GOALS>>>` block from step 4 above.
4. `Phase: spec-draft.\n\nAbove is the goals block. Draft a complete L11-grade spec whose acceptance criteria map 1:1 to the goals.\n\nBefore drafting, run your own codebase audit (PART A from the system rubric): verify every primitive you intend to introduce is not already present in the repo, and verify every existing primitive listed under "Existing primitives that may satisfy these goals" is correctly characterized. Record audit commands + results in the spec under "## Codebase audit." If an existing primitive can satisfy a goal, the spec MUST extend it rather than build a parallel layer absent a written rationale.\n\nWrite the spec directly to <spec-path> using your file-write tools — the MCP server runs with workspace-write sandbox so you have write access. After the file is written, end your reply with the required verdict block AND a single line `Wrote spec to <spec-path>` so Claude can verify.`
5. The user intent + codebase context (Phase 0 + Phase 1 raw material).

> **v0.12.0 — codex has workspace-write.** The MCP server is now launched with `-c sandbox_mode=workspace-write`, so Codex can write the spec file itself. Don't ask Codex to return the spec body to Claude and then have Claude write it — that double-handling wasted tokens and lost detail. Instead, instruct Codex (as shown in step 4 above) to write `<spec-path>` directly, then Claude just verifies the file exists.

Then invoke the bundled Codex MCP tool **`mcp__plugin_codex-paired-superpowers_codex__codex`** with these EXACT parameters:

```json
{
  "prompt": "<the composed prompt>",
  "config": { "model_reasoning_effort": "high" }
}
```

**Critical — do NOT pass a per-call `model`.** As of v0.13.0 the model is pinned to `gpt-5.5` by the MCP server config (`.claude-plugin/plugin.json`), so omitting the field is what guarantees the correct model. A per-call `model` overrides that pin: the MCP tool's schema docstring shows `gpt-5.2`/`gpt-5.2-codex` as stale upstream examples and those must NOT be passed (the thread would run on the wrong model and `codex-reply` calls inherit it — you'd need to re-create the thread to recover). `config.model_reasoning_effort` is not the model id and remains allowed. See `codex-pairing.md` for the canonical invocation form.

The response is `{ threadId, content }`. `content` is Codex's reply (which includes the verdict block and the `Wrote spec to <spec-path>` confirmation line). The actual spec body lives on disk at `<spec-path>` — Codex wrote it directly via workspace-write.

Verify and initialize the sidecar:

```bash
# Confirm Codex actually wrote the file. If the file is missing, fall back to
# extracting the body from Codex's reply yourself — but treat that as a Codex
# defect and surface it (the workspace-write contract said it would write).
test -f "<spec-path>" || echo "WARN: Codex did not write <spec-path>; extracting from reply"

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

2. **Prepare both sides' audit payloads** (do NOT persist them separately on the happy path — you pass
   them to the atomic command in step 3). Extract the `## Codebase audit` section from Codex's draft +
   your own audit commands. An audit entry per side claiming SHIP is required by the honest-reporting
   gate. Each audit object has this shape:

   ```json
   {"phase": "spec", "round": N, "side": "claude|codex",
    "commands": [{"cmd": "<grep / find / git log command>", "summary": "<result>", "kind": "inspection"}],
    "verdict_basis": "<one-line: how the audit informed the verdict>"}
   ```

   Every command needs a `kind` (`inspection` | `verification` | `other`). For code-bearing phases
   (`implement:<slice>`, `review-slice:<slice>`, …) a SHIP additionally requires at least one executed
   `"kind": "verification"` command with `"exit_code": 0` — for example
   `{"cmd": "npm test", "summary": "42 passed", "kind": "verification", "exit_code": 0}`. Design phases
   (spec / plan) only need inspection evidence. For REVISE verdicts the audit is recommended but not
   required by the gate. For SHIP verdicts on either side, the audit is mandatory.

3. **Append the audits and the round in ONE atomic command** (v0.13.0). This replaces logging the
   round separately after step 2's audits — the atomic command validates every audit and the round's
   SHIP-backing under one lock and writes them together (or nothing), so the round can never be logged
   before its audits and the gate cannot trip mid-flow:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round-with-audits \
     --specPath "<spec-path>" \
     --payload '{
       "audits": [
         {"phase":"spec","round":N,"side":"claude","commands":[{"cmd":"...","summary":"...","kind":"inspection"}],"verdict_basis":"..."},
         {"phase":"spec","round":N,"side":"codex","commands":[{"cmd":"...","summary":"...","kind":"inspection"}],"verdict_basis":"..."}
       ],
       "round": {"phase":"spec","round":N,"claude":"SHIP|REVISE: ...","codex":"SHIP|REVISE: ..."}
     }'
   ```

   For REVISE rounds the `audits` array may be empty. If the command reports missing evidence, it is an
   expected, actionable step (not a crash): add the missing audit, or — if you genuinely did not audit —
   emit REVISE instead of fabricating one. `sidecar-append-audit` / `sidecar-append-round` remain for
   manual recovery.

### If the Codex thread is lost mid-feature

If a `codex-reply` returns `isError: true` with `Session not found for thread_id:` (the MCP server was
restarted — threads are process-local), recover rather than halt: build replay context with
`sidecar-replay-context`, open a NEW thread via the initial `codex` tool seeded with that replay + the
pending prompt, then persist the rotation with `sidecar-rotate-thread-id --reason session-not-found`.
Tell the user in one line ("Codex thread was lost; opened a new thread and replayed the sidecar
context") and continue. Do not discard prior review history.

4. **If both shipped, exit.** Move to Phase 4.

5. **Otherwise, send round N+1 to Codex.** Build the prompt: phase header, round number, the current draft (or a reference to it), `## Critique from previous round` listing Claude's REVISE items and Codex's REVISE items (whichever were non-SHIP), and instruction to revise.

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

## Composer-selected reviewer spec-review (v0.9.0)

After each Codex round in Phase 3 produces a revised draft, the orchestrator MAY (and at high-stakes phases SHOULD) fan out **composer-selected experts in parallel** to critique that draft before Claude forms its own round verdict. This adds cross-model L11 critique without changing the double-SHIP exit gate.

This phase is **optional per round** but **strongly recommended after rounds 1 and N (the round just before SHIP)**. Skipping it on every round defeats the purpose; running it on every round is N× expensive.

### Step 1 — Compose the expert set

Call the v0.8.0 composer with the spec's signals:

```js
const { composeReviewers } = await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/reviewer-composer.js');
const result = composeReviewers({
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

const { RoleRoutingError } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/errors.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

for (const identity of result.selected) {
  let resolved;
  try {
    // Resolver is keyed by the recommendation role id (e.g. "reviewer-architecture"),
    // which is identity.id — NOT identity.role (the short form "architecture").
    resolved = resolveAdapter(identity.id, availableCLIs, /* userRouting */ null);
  } catch (err) {
    if (err instanceof RoleRoutingError && err.code === 'no-supported-cli-for-role') {
      // Spec-review is advisory: proceed without this expert.
      continue;
    }
    throw err; // override-cli-unavailable / override-variant-unknown halt the flow.
  }
  // resolved.cli ∈ {'claude','codex','ollama','gemini','qwen'}; resolved.variant may be null.
  const adapter = resolved.cli === 'claude'
    ? 'claude-task'
    : `cli-harness:${resolved.cli}`;
}
```

`resolveAdapter` THROWS `RoleRoutingError` (it does not return `null`). Codes:
- `no-supported-cli-for-role` — full ladder walk found nothing. For spec-review (advisory), proceed without that expert; for review-gate phases, halt with `cli-dispatch-failed`.
- `override-cli-unavailable` / `override-variant-unknown` — explicit user override on a missing CLI/variant. Always halt; never silently degrade.

### Step 3 — Dispatch per expert (single mode default)

For each expert, build the request and dispatch via `runTurnWithDeps` (v0.9.0 — adds replay-field persistence + `suppressPeerMessages`). The orchestrator (Claude) is responsible for the underlying transport:

- `claude-task` → dispatch the Task tool yourself; pass response text through `agentDispatch`.
- `cli-harness` (`codex`, `ollama{<variant>}`, `gemini`) → wrap `harness.dispatch` in `agentDispatch`.

```js
const { runTurnWithDeps, assembleSpawnPrompt } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/reviewer-turn.js');
const { readUnreadMessages } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/mailbox.js');

const request = {
  identity,
  repoRoot,
  specPath,
  specSnippet:            currentCodexDraft,
  phase:                  'spec-review',
  sliceId:                null,            // spec-phase is not slice-scoped
  adapter,                                 // from Step 2: 'claude-task' | 'cli-harness:<cli>'
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

If the composer flags the phase as high-stakes (e.g., security-sensitive spec, foundational architectural decision), upgrade `reviewer-security` or `reviewer-architecture` to **panel mode** via `dispatchPanel` (slice 6 contract). Build a `dispatchFns: Map<member_id, fn>` where each entry wraps `runTurnWithDeps` with an adapter-specific identity:

```js
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

// member_id composite uses identity.id (the "expert-XXX" form recognized by
// the role resolver and Machine Result expert_id matching), NOT identity.role.
const dispatchFns = new Map();
for (const cli of ['codex', 'claude']) {
  if (!availableCLIs.has(cli)) continue;
  const adapter = cli === 'claude' ? 'claude-task' : `cli-harness:${cli}`;
  dispatchFns.set(`${identity.id}@${cli}`, {
    fn: async (req) => {
      // adapter-specific: claude → Task tool; cli-harness → harness.dispatch
      const responseText = await /* adapter dispatch */;
      return runTurnWithDeps({ ...req, adapter }, { agentDispatch: async () => responseText });
    },
    runtime_kind: cli === 'claude' ? 'claude-task' : 'cli-harness',
  });
}

const panelOutcome = await dispatchPanel(identity.id, request, dispatchFns, {
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

After the user accepts, clear the honest-reporting marker (`node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-clear` — v0.15.0). The next skill in the chain re-marks it on entry; clearing here keeps the scanner from policing whatever the user does between phases.

## Phase 5 — Hand off

**Default path (both feature-scoped and app-scoped specs):**
Invoke `codex-paired-superpowers:writing-plans`. Pass the spec path. The plan-writing skill resumes the same Codex session via the sidecar. Once the plan is double-SHIP'd, the user runs it through the single stable entry point — the `execution` skill — by choosing a `driver`: `interactive` (step-by-step, with the user in the loop) or `autopilot` (unattended; self-continuing — re-running `/autopilot` resumes from the sidecar across sessions, with built-in loop-prevention). `/autopilot` remains a compatibility alias for `execution` with `driver: autopilot`. See [docs/execution-model.md](../../docs/execution-model.md) for the driver/split/review mental model.

For **app-scoped specs**, mention to the user — in plain English — that the spec covers multiple goals and the work will likely span several plans. After the first plan ships through autopilot, the user can come back and run `writing-plans` again for the next chunk of work, using the same spec. Each round of `writing-plans` sees the prior plans + current repo state via the sidecar and can target the remaining goals.

**Why we default to autopilot instead of /goal:**
Autopilot has battle-tested loop-prevention: halt envelopes classify halts as terminal vs transient, panel-quorum-lost halts force exit (not retry), dirty-tree reconciliation runs on every resume, etc. (see `lib/codex-bridge/halt-envelope.js` and `tests/codex-bridge/halt-envelope-e2e.test.js`). It is self-continuing — re-running `/autopilot` resumes from the sidecar, and the halt-envelope contract decides whether resuming is safe (transient) or needs operator action first (terminal). Claude's `/goal` evaluator is transcript-only — it can re-trigger turns endlessly if the success sentinel isn't surfaced cleanly; autopilot's halt-classification guards against that, `/goal` does not.

**Opt-in: /goal-driven app-autopilot (experimental, v0.11.0):**
If the user explicitly asks for unattended multi-plan execution driven by Claude's `/goal` command, route to `codex-paired-superpowers:app-autopilot`. That skill walks through `app-state-init` → first plan → conversational handoff → fires `claude -p "/goal '...'"`. Read `skills/app-autopilot/SKILL.md` for the full flow and known limitations. Do NOT default to this path — only use it when the user opts in by name.

## Failure modes
- **Codex unreachable:** retry once, then surface to user with option to abort or skip the round.
- **Codex empty reply (v0.15.0):** a `codex`/`codex-reply` result that is empty/whitespace ~1s after
  the prompt is a swallowed API failure, not a verdict. Re-send the same prompt once after ~30s;
  still empty → once more after ~5min; three empties → surface to the user. Never log a round for
  an empty reply.
- **Codex slow (v0.15.0):** a review turn past 15 minutes is a stall, not patience — surface it to
  the user with the elapsed time rather than waiting silently.
- **Round-7 deadlock:** annotate spec with both positions; user arbitrates; arbitration recorded in sidecar.
- **User overrides Codex:** allowed; recorded under `open_contentions`.
- **Sidecar corruption:** treat as data loss; restart with new session, surface to user.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern while running this skill, invoke `/codex-paired-superpowers:doctor` first. The doctor diagnoses the install and prints the exact commands to fix each issue. Resume this skill after the doctor reports all checks green.
