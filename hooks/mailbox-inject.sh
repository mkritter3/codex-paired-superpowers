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
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
node "$PLUGIN_ROOT/lib/codex-bridge/hook-mailbox-inject.js" || true
exit 0
