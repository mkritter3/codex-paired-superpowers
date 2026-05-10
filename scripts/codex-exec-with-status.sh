#!/usr/bin/env bash
# v0.7.2 — codex exec wrapper with durable status file.
#
# Wraps a `codex exec` invocation. Captures the exit code, completion
# timestamp, and signal (if killed) in a JSON status file. The status file
# survives the orchestrator's session, providing durable evidence of dispatch
# outcome for crash recovery.
#
# Usage:
#   scripts/codex-exec-with-status.sh <status-file-path> -- <codex-cmd> [args...]
#
# Example:
#   scripts/codex-exec-with-status.sh /tmp/cps/slice-3.status.json -- \
#     codex exec --skip-git-repo-check -s workspace-write -C /repo/.git-worktrees/slice-3 \
#     -m gpt-5.5 -c model_reasoning_effort=high "<prompt>" </dev/null
#
# Status file shape:
#   { "exit_code": 0, "started_at": "2026-05-09T...", "completed_at": "2026-05-09T...", "signal": null }
#   or on signal:
#   { "exit_code": 143, "started_at": "...", "completed_at": "...", "signal": "SIGTERM" }
#
# Exit codes:
#   - The wrapper exits with the same exit code as the wrapped codex command.
#   - If signal-killed: exit 128 + signal-number per POSIX convention.
#
# Crash safety:
#   - Status file is written atomically via temp + mv to prevent partial reads
#     from interleaving with orchestrator polls.
#   - On wrapper-self-kill (SIGTERM, SIGINT), trap captures the signal and
#     writes a status before propagating the exit.

set -uo pipefail

if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: $(basename "$0") <status-file-path> -- <codex-cmd> [args...]" >&2
  exit 64
fi

STATUS_FILE="$1"
shift 2  # drop status file + the "--" separator

STATUS_DIR=$(dirname "$STATUS_FILE")
mkdir -p "$STATUS_DIR"

iso_now() {
  # POSIX-portable ISO 8601 with milliseconds. macOS date doesn't support %N,
  # so we approximate with %S then append .000Z. Resolution is seconds; that's
  # sufficient for orchestration timestamps (slice runs are O(seconds-minutes)).
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

write_status() {
  local exit_code="$1"
  local signal="${2:-null}"
  local completed_at
  completed_at=$(iso_now)
  # Atomic write: temp + mv. If the orchestrator polls mid-write, it sees
  # either the old contents (none) or the new contents — never a partial JSON.
  local tmp="$STATUS_FILE.tmp.$$"
  if [ "$signal" = "null" ]; then
    cat > "$tmp" <<EOF
{
  "exit_code": $exit_code,
  "started_at": "$STARTED_AT",
  "completed_at": "$completed_at",
  "signal": null
}
EOF
  else
    cat > "$tmp" <<EOF
{
  "exit_code": $exit_code,
  "started_at": "$STARTED_AT",
  "completed_at": "$completed_at",
  "signal": "$signal"
}
EOF
  fi
  mv "$tmp" "$STATUS_FILE"
}

# Trap interrupts so we record cause-of-death durably before the wrapper exits.
on_signal() {
  local sig="$1"
  local code
  case "$sig" in
    INT)  code=130 ;;
    TERM) code=143 ;;
    HUP)  code=129 ;;
    *)    code=1   ;;
  esac
  # Best-effort: kill the codex child if it's still running.
  if [ -n "${CODEX_PID:-}" ] && kill -0 "$CODEX_PID" 2>/dev/null; then
    kill -TERM "$CODEX_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$CODEX_PID" 2>/dev/null || true
  fi
  write_status "$code" "SIG${sig}"
  exit "$code"
}

trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

STARTED_AT=$(iso_now)

# Run codex in the background so we can capture its PID for signal forwarding.
"$@" &
CODEX_PID=$!

# Wait for codex to exit. `wait` returns codex's exit code.
wait "$CODEX_PID"
EXIT_CODE=$?

write_status "$EXIT_CODE" "null"
exit "$EXIT_CODE"
