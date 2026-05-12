#!/bin/bash
# v0.9.0 slice 2 — fake ollama CLI for unit tests.
#
# Mimics `ollama run MODEL [PROMPT]` one-shot stateless inference:
# plain-text stdout (no JSON event stream, unlike codex --json), plus
# stderr passthrough for Ollama Cloud auth / rate-limit notices.
#
# Behavior controlled via environment variables so tests can pin the
# subprocess to a deterministic outcome without depending on a real
# `ollama` binary or live cloud session.
#
#   FAKE_CLI_EXIT           exit code (default 0)
#   FAKE_CLI_OUTPUT         literal stdout to emit (plain text)
#   FAKE_CLI_STDERR         stderr line(s) to emit before exiting
#   FAKE_CLI_DELAY_MS       sleep before producing output (milliseconds)
#   FAKE_CLI_HANG           if set, sleep effectively forever (1 hour)
#                           so the parent can test AbortController kills
#   OLLAMA_FAKE_ARGS_FILE   if set, write the literal argv (one arg per
#                           line) to this path so tests can assert which
#                           model name the adapter invoked us with
#                           (proves variant→model resolution worked).
#
# Stdin is drained but ignored (the real `ollama run MODEL` reads the
# prompt from stdin when no PROMPT argument is supplied; tests don't
# need to echo it back).

set -u

# Record argv for variant-resolution assertions BEFORE any drain/sleep
# logic — we want the args captured even if we hang for a timeout test.
if [ -n "${OLLAMA_FAKE_ARGS_FILE:-}" ]; then
  : > "$OLLAMA_FAKE_ARGS_FILE" || true
  for a in "$@"; do
    printf '%s\n' "$a" >> "$OLLAMA_FAKE_ARGS_FILE"
  done
fi

# Drain stdin in a non-blocking way to avoid SIGPIPE on the writer side
# while not hanging if the test harness keeps stdin open. (Same pattern
# as codex.sh.)
dd if=/dev/stdin of=/dev/null bs=65536 count=64 status=none 2>/dev/null || true

if [ "${FAKE_CLI_HANG:-}" != "" ]; then
  # Sleep until killed. `exec` so SIGTERM from the test harness kills
  # sleep directly instead of bash (which wouldn't forward signals to
  # its child during a blocking `sleep`).
  exec sleep 3600
fi

if [ "${FAKE_CLI_DELAY_MS:-0}" != "0" ]; then
  awk -v ms="$FAKE_CLI_DELAY_MS" 'BEGIN { printf "%f\n", ms/1000 }' \
    | xargs sleep
fi

if [ -n "${FAKE_CLI_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_CLI_STDERR" >&2
fi

if [ -n "${FAKE_CLI_OUTPUT:-}" ]; then
  printf '%s' "$FAKE_CLI_OUTPUT"
fi

exit "${FAKE_CLI_EXIT:-0}"
