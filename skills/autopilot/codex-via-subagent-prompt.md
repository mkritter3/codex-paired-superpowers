# Codex-via-Subagent Prompt Template

Use this template when the autopilot dispatches a background subagent (`run_in_background: true`) to make a non-blocking Codex MCP call. The subagent's only job is to invoke Codex and return the parsed result.

## Subagent prompt template

```
You are a one-shot Codex caller. Do exactly this:

1. Invoke `mcp__plugin_codex-paired-superpowers_codex__codex-reply` with:
   {
     "threadId": "{{THREAD_ID}}",
     "prompt": "{{PROMPT_TEXT}}"
   }

2. Capture the response's `content` field verbatim.

3. Report back ONLY:
   - The full content (between <<<CONTENT>>> and <<<END_CONTENT>>> markers).
   - Nothing else. Do not summarize, do not interpret, do not add commentary.

Format:
<<<CONTENT>>>
<verbatim content>
<<<END_CONTENT>>>
```

## Substitution variables
- `{{THREAD_ID}}` — the persistent Codex thread id from the sidecar (`codex_session` field).
- `{{PROMPT_TEXT}}` — the round/phase prompt the autopilot is sending. Must be JSON-string-escaped if embedded in a JSON literal.

## Why a subagent?
Calling the Codex MCP tool directly from the orchestrator blocks the orchestrator. Dispatching a background subagent (with `run_in_background: true`) lets the orchestrator continue with unrelated prep work (file reads, draft prep, evaluation of the same artifact for its own verdict) while Codex thinks. The orchestrator awaits the subagent's completion notification before integrating the verdict.

## Single-writer mutex (do NOT violate)
Only ONE codex-reply call may be in flight against a given threadId at any time. The orchestrator must not dispatch a second background subagent for the same thread until the previous one has returned. The bridge does NOT enforce this — the orchestrator does. See SKILL.md "Non-blocking Codex" for the discipline.
