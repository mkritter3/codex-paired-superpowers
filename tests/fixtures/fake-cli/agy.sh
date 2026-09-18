#!/usr/bin/env bash
# v0.17.0 slice 3 — fake agy CLI for unit tests.
#
# Environment variables:
#   FAKE_AGY_RESPONSE       response text in JSON (default "ok")
#   FAKE_AGY_STATUS         status in JSON (default "SUCCESS")
#   FAKE_AGY_CONVERSATION   conversation_id in JSON (default "fake-agy-conversation-123")
#   FAKE_AGY_DENIED         comma-separated list of denied actions (default empty)
#   FAKE_AGY_EXIT           process exit code (default 0)
#   FAKE_CLI_HANG           if set, sleep 3600 until killed
#   FAKE_CLI_DELAY_MS       sleep before output (milliseconds)
#   FAKE_CLI_STDERR         stderr content to emit
#   FAKE_CLI_OUTPUT         raw stdout to emit (overrides JSON output)
#   FAKE_AGY_ARGS_FILE      path to write argv ($@)
#   FAKE_AGY_CWD_FILE       path to write $PWD
#   FAKE_AGY_MODELS_OUTPUT  custom output for `agy models`
set -u

if [ -n "${FAKE_AGY_RECORD:-}" ]; then
  FAKE_AGY_HEAD=$(git rev-parse HEAD 2>/dev/null || printf '%s' unknown)
  if [ -f impl.txt ]; then
    FAKE_AGY_IMPL_PRESENT=true
  else
    FAKE_AGY_IMPL_PRESENT=false
  fi
  if ! node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      cwd: process.argv[2],
      head: process.argv[3],
      impl_txt_present: process.argv[4] === "true",
    }) + "\n");
  ' "$FAKE_AGY_RECORD" "$PWD" "$FAKE_AGY_HEAD" "$FAKE_AGY_IMPL_PRESENT"; then
    exit 1
  fi
fi

if [ -n "${FAKE_AGY_ARGS_FILE:-}" ]; then
  printf '%s\n' "$@" > "$FAKE_AGY_ARGS_FILE"
fi

if [ -n "${FAKE_AGY_CWD_FILE:-}" ]; then
  printf '%s\n' "$PWD" > "$FAKE_AGY_CWD_FILE"
fi

if [ "${FAKE_CLI_HANG:-}" != "" ]; then
  exec sleep 3600
fi

if [ "${FAKE_CLI_DELAY_MS:-0}" != "0" ]; then
  awk -v ms="$FAKE_CLI_DELAY_MS" 'BEGIN { printf "%f\n", ms/1000 }' \
    | xargs sleep
fi

if [ -n "${FAKE_CLI_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_CLI_STDERR" >&2
fi

if [ "${1:-}" = "models" ]; then
  if [ -n "${FAKE_AGY_MODELS_OUTPUT:-}" ]; then
    printf '%s\n' "$FAKE_AGY_MODELS_OUTPUT"
  else
    printf '%s\n' \
      "gemini-3.8-flash-high     Gemini 3.8 Flash (High)" \
      "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)" \
      "gemini-3.8-flash-low      Gemini 3.8 Flash (Low)" \
      "gemini-3.1-pro-high       Gemini 3.1 Pro (High)" \
      "gemini-3.1-pro-low        Gemini 3.1 Pro (Low)"
  fi
  exit "${FAKE_AGY_EXIT:-0}"
fi

if [ -n "${FAKE_CLI_OUTPUT:-}" ]; then
  printf '%s' "$FAKE_CLI_OUTPUT"
else
  node -e '
    const conversation_id = process.env.FAKE_AGY_CONVERSATION || "fake-agy-conversation-123";
    const status = process.env.FAKE_AGY_STATUS || "SUCCESS";
    const response = process.env.FAKE_AGY_RESPONSE !== undefined ? process.env.FAKE_AGY_RESPONSE : "ok";
    const deniedStr = process.env.FAKE_AGY_DENIED || "";
    const denied_actions = deniedStr ? deniedStr.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const output = {
      conversation_id,
      status,
      response,
      duration_seconds: 1.23,
      num_turns: 1,
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      },
      denied_actions,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
  '
fi

exit "${FAKE_AGY_EXIT:-0}"
