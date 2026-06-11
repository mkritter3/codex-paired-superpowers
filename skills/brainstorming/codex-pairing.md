# Codex-Pairing Bridge Protocol (reference)

## Codex transport: bundled MCP server

This plugin bundles `codex mcp-server` as an MCP server (registered in `plugin.json`). When the plugin is loaded, two tools become available to Claude:

| Tool | Args | Returns |
|---|---|---|
| `mcp__plugin_codex-paired-superpowers_codex__codex` | `{ prompt, model, cwd?, sandbox?, config?, ... }` | `{ threadId, content }` |
| `mcp__plugin_codex-paired-superpowers_codex__codex-reply` | `{ threadId, prompt }` | `{ threadId, content }` |

### ⚠️ Model handling — read before every `__codex` call

**Do NOT pass a per-call `model` to the codex MCP tool.** As of v0.13.0 the model is pinned to `gpt-5.5` by the plugin's MCP server config (`.claude-plugin/plugin.json` launches `codex mcp-server` with `-c model="gpt-5.5"`), and a thread inherits it automatically. The tool schema's description field still shows `gpt-5.2` and `gpt-5.2-codex` as *examples* — those are stale upstream-CLI references and must NOT be passed. A per-call `model` overrides the server pin: empirically (2026-05-10) Claude once silently used `gpt-5.2-codex` from the schema example and the thread ran on the wrong model (the thread cannot be model-changed after creation; it has to be re-started). Omitting the field entirely is what guarantees the pinned `gpt-5.5`.

**For reasoning effort, pass `config: { model_reasoning_effort: "high" }`** for spec / plan / debug phases. For slice review and TDD review, `medium` is acceptable (and faster). Reasoning effort is not the model id and remains a per-call field.

**For `codex-reply` calls there is no model parameter** — the model is locked at thread-creation time and inherited.

The first call (`codex`) opens a thread; capture `threadId` and persist it via `sidecar-init`. Every subsequent call in the same feature uses `codex-reply` with that same threadId — that's how the conversation continues across all phases (brainstorm -> plan -> slice reviews) on one Codex thread.

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
| `sidecar-init --specPath <p> --feature <name> --threadId <id>` | write sidecar at `<p>.codex.json` with model gpt-5.5, reasoning high (overridable via `--model`, `--reasoning`) |
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
