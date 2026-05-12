#!/bin/bash
# v0.9.0 slice 1 — fake codex CLI for unit tests.
#
# Behavior controlled via environment variables so tests can pin the
# subprocess to a deterministic outcome without depending on a real
# `codex` binary.
#
#   FAKE_CLI_EXIT                 exit code (default 0)
#   FAKE_CLI_OUTPUT               literal stdout to emit (overrides JSON path)
#   FAKE_CLI_OUTPUT_JSON_EVENTS   newline-delimited `--json` event stream;
#                                 emitted line-by-line when set
#   FAKE_CLI_STDERR               stderr line(s) to emit before exiting
#   FAKE_CLI_DELAY_MS             sleep before producing output (milliseconds)
#   FAKE_CLI_HANG                 if set, sleep effectively forever (1 hour)
#                                 so the parent can test AbortController kills
#
# Stdin is consumed but ignored (codex's real one-shot invocation reads
# the prompt from stdin; tests don't care about echoing).

set -u

# Drain stdin in a non-blocking way to avoid SIGPIPE on the writer side
# while not hanging if the test harness keeps stdin open. Using `dd` with
# a tight count avoids the macOS-bash `cat` quirk where `bash -c 'cat'`
# can fail to receive piped stdin under some sandboxes.
dd if=/dev/stdin of=/dev/null bs=65536 count=64 status=none 2>/dev/null || true

if [ "${FAKE_CLI_HANG:-}" != "" ]; then
  # Sleep until killed. `exec` so SIGTERM from the test harness kills
  # sleep directly instead of bash (which wouldn't forward signals to
  # its child during a blocking `sleep`).
  exec sleep 3600
fi

if [ "${FAKE_CLI_DELAY_MS:-0}" != "0" ]; then
  # bash `sleep` takes seconds (with fractional support on macOS/BSD/GNU).
  awk -v ms="$FAKE_CLI_DELAY_MS" 'BEGIN { printf "%f\n", ms/1000 }' \
    | xargs sleep
fi

if [ -n "${FAKE_CLI_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_CLI_STDERR" >&2
fi

if [ -n "${FAKE_CLI_OUTPUT_JSON_EVENTS:-}" ]; then
  # The variable holds a literal newline-delimited stream. Emit verbatim.
  printf '%s\n' "$FAKE_CLI_OUTPUT_JSON_EVENTS"
elif [ -n "${FAKE_CLI_OUTPUT:-}" ]; then
  printf '%s' "$FAKE_CLI_OUTPUT"
fi

exit "${FAKE_CLI_EXIT:-0}"
