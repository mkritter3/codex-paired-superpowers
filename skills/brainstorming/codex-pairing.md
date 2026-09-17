# Codex-Pairing Bridge Protocol (reference)

## Codex transport: bundled MCP server

This plugin bundles `codex mcp-server` as an MCP server (registered in `plugin.json`). When the plugin is loaded, two tools become available to Claude:

| Tool | Args | Returns |
|---|---|---|
| `mcp__plugin_codex-paired-superpowers_codex__codex` | `{ prompt, model, cwd?, sandbox?, config?, ... }` | `{ threadId, content }` |
| `mcp__plugin_codex-paired-superpowers_codex__codex-reply` | `{ threadId, prompt }` | `{ threadId, content }` |

### ⚠️ Model handling — read before every `__codex` call (v0.16.0)

Models and reasoning efforts come from **model roles**, never from literals. Resolve the role
for the thread you are opening with the bridge CLI and spread the result into the call:

```bash
# planning thread (brainstorming, writing-plans, plan-slice review, debugging, TDD review)
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role planning --format mcp --repoRoot "$REPO_ROOT"
#  → {"model":"gpt-6-astra","config":{"model_reasoning_effort":"xhigh"}}

# execution thread (slice reviews, docs-update)
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format mcp --repoRoot "$REPO_ROOT"
```

Pass **exactly** that object's `model` and `config` on the `codex` (thread-opening) call. Rules:

- **Never type a model id by hand.** The tool schema's description still lists `gpt-5.2` /
  `gpt-5.2-codex` as *examples* — those are stale upstream references and must NOT be passed
  (empirically, 2026-05-10, a thread once ran on the wrong model that way and had to be re-created).
- **If `model-role` fails (exit 2), stop and report** the error to the user. Never open a thread
  with a guessed model. A failure means `.codex-paired/project.json` `models` or a `CODEX_PAIRED_*`
  env value is invalid.
- The MCP server itself is pinned to the `planning` defaults (`gpt-6-astra`, `xhigh`) in
  `.claude-plugin/plugin.json` as a safety default only; passing the resolved role is what makes a
  project or env override actually reach the thread.
- **`codex-reply` has no model or config parameter** — a thread's model and effort are fixed when it
  is created. That is why there are two threads per feature (below), not one thread at two efforts.
- Overrides: `.codex-paired/project.json` `{"models": {"planning": {"effort": "max"}}}` or env
  `CODEX_PAIRED_MODEL_PLANNING=...` / `CODEX_PAIRED_REASONING_REVIEW=...` (global
  `CODEX_PAIRED_MODEL` / `CODEX_PAIRED_REASONING` apply to every role).

### Reviewer transports (v0.17.0): Codex over MCP, Gemini over `agy`

The role decides the transport. Resolve it first:

```bash
ROLE=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role planning --format json --repoRoot "$REPO_ROOT")
#  → {"role":"planning","cli":"codex"|"agy","model":...,"effort":...,...}
```

| `cli` | Open a thread | Continue a thread | Thread id stored as |
|---|---|---|---|
| `codex` | MCP tool `codex` with `model` + `config` from `model-role --format mcp` | MCP tool `codex-reply` with `threadId` | `role_sessions[key]` (Codex thread id) |
| `agy` | `node cli.js reviewer-thread-open --role <planning\|review> --specPath <spec> --repoRoot <repo> [--planPath <plan>] --prompt-stdin` | `node cli.js reviewer-thread-reply … --prompt-stdin` | `role_sessions[key]` (agy conversation id) |

Both paths print/return the same `{ threadId, content }` shape, so round logging, audits,
`--headSha` and verdict parsing are identical. `model-role --format mcp` exits 2 for an agy role —
that is the signal to use the `reviewer-thread-*` verbs instead. Gemini reviewer turns run in a
throwaway detached checkout of the reviewed commit (the spec/plan under review are overlaid into
it, so path audits work) and can never modify your working tree. `thread_config[key].cli` records
which CLI owns each thread; recovery of a lost thread follows the recorded CLI.

The agy verbs also report `ok`, `exit`, `status` and `warnings` and exit **1** when the turn
failed (non-`SUCCESS` status, timeout, lost conversation) — never treat an empty `content` as a
reply. On exit 1 whose warnings mention a missing conversation, rotate the thread
(`thread-recovery` → `recoverStaleThread`, which re-opens on agy) and resend the prompt once;
exit **2** is a usage/config error (wrong flags, codex role, missing spec) and is terminal.

### Two threads per feature (v0.16.0)

| `role_sessions` key | Model role | Opened by | Used by |
|---|---|---|---|
| `paired-reviewer` | `planning` | brainstorming Phase 2 | spec rounds, plan review, autopilot Phase A, debugging, TDD review |
| `execution-reviewer` | `review` | first execution-phase turn (`execution` skill hand-off / autopilot run start / SDD entry) | slice reviews (Phase C / Step C), docs-update (Phase D), post-merge Codex member |

The sidecar records what each thread actually runs in `thread_config[key] = { role, model, effort, opened_at }`.
Opening the execution thread (once per feature; skip if the key already exists):

```bash
REPLAY=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-replay-context --specPath "<spec-path>")
MCP=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format mcp --repoRoot "$REPO_ROOT")
# seed prompt: composeSeedPrompt(replay, { reason: 'execution-thread', specPath, planPath, pendingPrompt })
#   from lib/codex-bridge/thread-recovery.js — it tells Codex to READ the spec and plan from disk first.
# Prepend system-rubric.md + verdict-format.md, call `codex` with MCP's model + config, then:
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-rotate-thread-id --specPath "<spec-path>" \
  --role execution-reviewer --newThreadId "<threadId>" --reason execution-thread --phase execution \
  --threadConfig '{"role":"review","model":"<model>","effort":"<effort>"}'
```

Thread loss ("Session not found") on either thread re-seeds at the **lost thread's** recorded
`thread_config` (the one exception to "resolve the current role"), so the same context is judged at
the same depth. See `lib/codex-bridge/thread-recovery.js` `recoverStaleThread`.

The first call (`codex`) opens a thread; capture `threadId` and persist it via `sidecar-init`. Every subsequent call in the same phase uses `codex-reply` with that same threadId.

### Empty replies and slow turns (v0.15.0)

Two silent failure modes observed in Codex session logs — neither produces an error:

- **Empty reply:** the tool returns ~1s after the prompt with empty/whitespace `content` and
  unchanged token usage. This is a swallowed API/stream failure, NOT a verdict. Re-send the SAME
  prompt once after ~30s; if still empty, once more after ~5min (observed outage windows were
  ≤10min). Three consecutive empties → surface to the user. Never log a round from an empty reply.
- **Slow turn:** healthy review turns run median ~1.5min, p99 ~7min, max observed 10.3min. Past
  15 minutes, treat the call as stalled and surface it — don't wait silently.

(`Session not found` thread loss is a third, loud failure — handled by the thread-recovery
protocol; see `lib/codex-bridge/thread-recovery.js`.)

## Bridge CLI subcommands (sidecar only)

```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> --<flag> <value> ...
```

| Subcommand | Effect |
|---|---|
| `sidecar-init --specPath <p> --feature <name> --threadId <id>` | write the sidecar with the `planning` role's model/effort (overridable via `--model`, `--reasoning`) and `thread_config["paired-reviewer"]` |
| `model-role --role <r> [--format json\|flags\|mcp] [--repoRoot <r>]` | resolve one model role (v0.16.0) |
| `model-roles [--repoRoot <r>]` | all roles + sources + `validated_cli_version` |
| `sidecar-show --specPath <p>` | print full sidecar JSON |
| `sidecar-thread-id --specPath <p>` | print just the threadId (for shell `$(...)` capture) |
| `sidecar-path --specPath <p>` | print the sidecar file path |
| `sidecar-append-round --specPath <p> --round <json>` | append a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | record slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | append open contention |

The CLI does NOT spawn codex anymore (v0.2.0+). All codex traffic goes through the MCP tools above.

## Verdict block format

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one sentence>
<<<END>>>
```

Parser is permissive on whitespace, strict on `status` value (`SHIP` or `REVISE` only). Missing or malformed -> synthetic REVISE returned.

## L11 rubric (sent in every initial Codex prompt)

See `lib/codex-bridge/prompts/system-rubric.md` for the canonical text. Both Claude and Codex advocate for:
1. Simple over clever
2. Small over big
3. DRY but not premature
4. Optimal locally
5. Honest about scope
6. Tests at the failure boundary

The rubric is sent **once** in the initial prompt (Phase 2). It persists in the Codex thread; do not re-prepend it in `codex-reply` calls.
