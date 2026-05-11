#!/usr/bin/env bash
# v0.7.3.1 PostToolUse mailbox auto-injection hook.
#
# Thin wrapper: passes the Claude Code hook stdin (BaseHookInputSchema JSON)
# to the Node module. All validation, identity inference, mailbox I/O, and
# stdout emission live in lib/codex-bridge/hook-mailbox-inject.js where they
# are unit-tested. This script intentionally does nothing else.
#
# Exit 0 always (per spec §5.4 — non-zero exits inject as hook_*_error
# attachments into the subagent context).
#
# Debug: set CPS_HOOK_DEBUG=1 in your Claude Code environment to surface
# wrapper-level failures (node missing, module missing, syntax error in the
# Node module) to stderr. Claude Code logs hook stderr to its diagnostics
# stream without injecting it into the subagent context. This is the only
# supported way to debug a silently-failing hook — the production path
# intentionally swallows all output to keep worker prompts clean.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_MODULE="$PLUGIN_ROOT/lib/codex-bridge/hook-mailbox-inject.js"

if [ -n "${CPS_HOOK_DEBUG:-}" ]; then
  # Verbose mode: surface what the wrapper sees + any node failure to stderr.
  echo "[cps-hook-debug] PLUGIN_ROOT=$PLUGIN_ROOT" >&2
  echo "[cps-hook-debug] NODE_MODULE=$NODE_MODULE" >&2
  if ! command -v node >/dev/null 2>&1; then
    echo "[cps-hook-debug] FATAL: \`node\` not on PATH" >&2
    exit 0
  fi
  if [ ! -f "$NODE_MODULE" ]; then
    echo "[cps-hook-debug] FATAL: module file missing at $NODE_MODULE" >&2
    exit 0
  fi
  # Run without swallowing — stderr surfaces; exit code logged but we still exit 0.
  node "$NODE_MODULE"
  NODE_EXIT=$?
  echo "[cps-hook-debug] node exit code: $NODE_EXIT" >&2
  exit 0
fi

# Production path: swallow everything so the worker prompt stays clean.
node "$NODE_MODULE" 2>/dev/null || true
exit 0
