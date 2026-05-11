# Codex-Pairing Bridge Protocol (reference)

## Codex transport: bundled MCP server

This plugin bundles `codex mcp-server` as an MCP server (registered in `plugin.json`). When the plugin is loaded, two tools become available to Claude:

| Tool | Args | Returns |
|---|---|---|
| `mcp__plugin_codex-paired-superpowers_codex__codex` | `{ prompt, model, cwd?, sandbox?, config?, ... }` | `{ threadId, content }` |
| `mcp__plugin_codex-paired-superpowers_codex__codex-reply` | `{ threadId, prompt }` | `{ threadId, content }` |

### ⚠️ MODEL INVARIANT — read before every `__codex` call

**On EVERY initial `mcp__plugin_codex-paired-superpowers_codex__codex` call you MUST pass `model: "gpt-5.5"` explicitly.** The tool schema's description field shows `gpt-5.2` and `gpt-5.2-codex` as *examples*. Those are stale references from the upstream codex CLI's docstring — they are NOT the model this plugin is built for. If you pass either of those, the resulting thread runs on the wrong model and every subsequent `codex-reply` inherits the wrong model. Empirically verified failure mode (2026-05-10): Claude silently used `gpt-5.2-codex` from the schema example, the user noticed via the tool-call card. The thread cannot be model-changed after creation; it has to be re-started.

**For reasoning effort, pass `config: { model_reasoning_effort: "high" }`** for spec / plan / debug phases. For slice review and TDD review, `medium` is acceptable (and faster).

**For `codex-reply` calls there is no model parameter** — the model is locked at thread-creation time and inherited.

The first call (`codex`) opens a thread; capture `threadId` and persist it via `sidecar-init`. Every subsequent call in the same feature uses `codex-reply` with that same threadId — that's how the conversation continues across all phases (brainstorm -> plan -> slice reviews) on one Codex thread.

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
