# Codex-Pairing Bridge Protocol (reference)

## CLI subcommands available to skills

All commands run via:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> --<flag> <value> ...
```

| Subcommand | Stdin | Effect |
|---|---|---|
| `session-start --specPath <p> --feature <name>` | prompt text | spawns codex, captures session UUID, writes sidecar at `<p>.codex.json`, prints `{sessionId, reply}` JSON |
| `session-resume --specPath <p>` | prompt text | resumes session from sidecar, prints `{sessionId, reply}` JSON |
| `sidecar-show --specPath <p>` | — | prints sidecar JSON |
| `sidecar-append-round --specPath <p> --round <json>` | — | appends a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | — | records slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | — | appends open contention |

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

## L11 rubric (sent in every Codex prompt)

See `lib/codex-bridge/prompts/system-rubric.md` for the canonical text. Both Claude and Codex advocate for:
1. Simple over clever
2. Small over big
3. DRY but not premature
4. Optimal locally
5. Honest about scope
6. Tests at the failure boundary
