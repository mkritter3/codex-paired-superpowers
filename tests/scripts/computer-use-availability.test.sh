#!/usr/bin/env bash
# Detects whether /computer-use is reachable in the current environment.
# Halts cleanly with helpful message on failure. Run by autopilot's
# Phase E ralph re-check.
set -euo pipefail

# macOS check
if [ "$(uname)" != "Darwin" ]; then
  echo "live-verification-computer-use-unavailable: not macOS (uname=$(uname))" >&2
  exit 1
fi

# Claude Code version check (best-effort; version may not be in PATH for
# some install methods)
if command -v claude >/dev/null 2>&1; then
  CC_VERSION=$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo "unknown")
  echo "Claude Code version: $CC_VERSION"
fi

# Note: Pro/Max plan and /computer-use mode availability cannot be
# checked from outside Claude Code. Phase E in autopilot SKILL.md
# documents that the orchestrator must verify availability per ralph
# tick by attempting a no-op /computer-use action.

echo "live-verification-computer-use: macOS detected; in-session /computer-use availability must be verified by orchestrator"
exit 0
