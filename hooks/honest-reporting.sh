#!/usr/bin/env bash
# v0.8.1 Stop + PreToolUse honest-reporting hook.
#
# Thin wrapper: passes Claude Code hook stdin (BaseHookInputSchema JSON) to
# the Node module, which scans the relevant assistant turn(s) for high-
# precision claim vocabulary without nearby evidence and exits 2 (block +
# show stderr to Claude) on detection.
#
# Args:
#   $1 — mode: "stop" | "pretooluse"
#
# Activation: ONLY fires when <repo-root>/.codex-paired/honest-reporting-active.json
# exists and its expiresAt is in the future. See honest-reporting-marker.js.
#
# Debug: set CPS_HONEST_REPORTING_DEBUG=1 to surface wrapper-level failures
# (node missing, module missing, syntax error) to stderr.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_MODULE="$PLUGIN_ROOT/lib/codex-bridge/hook-honest-reporting.js"
MODE="${1:-stop}"

if [ -n "${CPS_HONEST_REPORTING_DEBUG:-}" ]; then
  echo "[cps-honest-reporting] PLUGIN_ROOT=$PLUGIN_ROOT" >&2
  echo "[cps-honest-reporting] NODE_MODULE=$NODE_MODULE" >&2
  echo "[cps-honest-reporting] MODE=$MODE" >&2
  if ! command -v node >/dev/null 2>&1; then
    echo "[cps-honest-reporting] FATAL: \`node\` not on PATH" >&2
    exit 0
  fi
  if [ ! -f "$NODE_MODULE" ]; then
    echo "[cps-honest-reporting] FATAL: module file missing at $NODE_MODULE" >&2
    exit 0
  fi
  node "$NODE_MODULE" "$MODE"
  exit $?
fi

# Production path: only propagate exit 2 (the contract that surfaces a
# block-message to Claude). Every other failure — node missing, module
# missing, import/syntax error, runtime exception inside the scanner —
# must fail-open with exit 0 so the hook never inserts noise into the
# user's flow. (Codex round-1 review caught the prior `exec node` which
# leaked all of those failure modes as nonzero exits + raw stderr.)
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi
if [ ! -f "$NODE_MODULE" ]; then
  exit 0
fi

# Capture stderr; only propagate it (and exit 2) if the node module
# emitted both signals together. Anything else → exit 0, drop stderr.
TMP_STDERR=$(mktemp -t cps-honest-reporting-stderr.XXXXXX)
trap 'rm -f "$TMP_STDERR"' EXIT
node "$NODE_MODULE" "$MODE" 2>"$TMP_STDERR"
NODE_EXIT=$?

if [ "$NODE_EXIT" = "2" ]; then
  # Propagate the block message to Claude on stderr (the contract).
  cat "$TMP_STDERR" >&2
  exit 2
fi

# Any other exit code (including node crashes) → fail-open.
exit 0
