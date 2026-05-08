#!/usr/bin/env bash
# Provenance hook: PostToolUse on `git commit`. Fires AFTER the commit lands;
# does NOT un-do it. Exits non-zero to signal the orchestrator that the
# commit was non-conforming so autopilot can halt and the user can decide
# (e.g., `git reset`).
# Reads <repo-root>/.codex-paired/active.json. If autopilot is running,
# verifies the most recent commit conforms to Commit Conventions §:
#   subject:  (feat|test|fix|docs|refactor|chore)\(slice:<current_slice>\):
#   trailer:  Co-Authored-By: Claude
# Both must be present. If either is missing, exit 1 (signal non-conforming).
# If no anchor exists (autopilot not running), exit 0 (no-op).
set -euo pipefail

# Filter: PostToolUse fires on every Bash call. We only care about `git commit`.
# Read the JSON payload Claude Code passes on stdin and check tool_input.command.
# If stdin has no JSON (direct invocation, e.g., from tests), the test harness
# must opt in via CPS_HOOK_FORCE=1.
if [ -z "${CPS_HOOK_FORCE:-}" ]; then
  STDIN_JSON=$(cat 2>/dev/null || echo '')
  if [ -z "$STDIN_JSON" ]; then
    exit 0  # no stdin context, nothing to check
  fi
  CMD=$(echo "$STDIN_JSON" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ try { const o=JSON.parse(d); const t=o.tool_name||''; const c=(o.tool_input && o.tool_input.command) || ''; if (t!=='Bash') process.exit(0); console.log(c); } catch(e) { process.exit(0); } })")
  if [ -z "$CMD" ]; then
    exit 0  # not Bash, or no command
  fi
  if ! echo "$CMD" | grep -Eq '(^|[^a-zA-Z])git[[:space:]]+commit([[:space:]]|$)'; then
    exit 0  # Bash call wasn't a git commit
  fi
fi

# Resolve repo root. Priority:
#   1. CLAUDE_PROJECT_DIR (set by Claude Code; the authoritative project root)
#   2. `git rev-parse --show-toplevel` from cwd (handles subdirectory commits)
#   3. $PWD as last fallback
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
fi
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"

# CLAUDE_PLUGIN_ROOT must be set for us to call the bridge CLI.
if [ -z "$PLUGIN_ROOT" ]; then
  # Try to locate it relative to this script.
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

ANCHOR_PATH="$REPO_ROOT/.codex-paired/active.json"
if [ ! -f "$ANCHOR_PATH" ]; then
  exit 0  # autopilot not running, allow everything
fi

# Read the spec path from the anchor.
SPEC_PATH=$(node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" anchor-read --repoRoot "$REPO_ROOT" 2>/dev/null \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ if(!d) process.exit(0); console.log(JSON.parse(d).specPath); })")

if [ -z "$SPEC_PATH" ]; then
  exit 0  # anchor empty/malformed → don't block
fi

# Read the autopilot block from the sidecar.
AP=$(node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" sidecar-get-autopilot --specPath "$SPEC_PATH" 2>/dev/null)
if [ -z "$AP" ]; then
  exit 0  # no autopilot block → not actually running
fi

CURRENT_SLICE=$(echo "$AP" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const o=JSON.parse(d); console.log(o.current_slice ?? ''); })")

if [ -z "$CURRENT_SLICE" ]; then
  exit 0  # autopilot block has no current_slice → not actually running
fi

# Read the most recent commit.
cd "$REPO_ROOT"
SUBJECT=$(git log -1 --format=%s)
BODY=$(git log -1 --format=%B)

# Check subject pattern.
SUBJECT_RX="^(feat|test|fix|docs|refactor|chore)\\(slice:${CURRENT_SLICE}\\):"
if ! echo "$SUBJECT" | grep -Eq "$SUBJECT_RX"; then
  echo "[provenance hook] NON-CONFORMING: most recent commit subject doesn't match expected slice:$CURRENT_SLICE prefix (commit already landed; signaling autopilot to halt)" >&2
  echo "  subject: $SUBJECT" >&2
  echo "  expected pattern: $SUBJECT_RX" >&2
  exit 1
fi

# Check Co-Authored-By trailer.
if ! echo "$BODY" | grep -Eq '^Co-Authored-By: Claude'; then
  echo "[provenance hook] NON-CONFORMING: commit missing 'Co-Authored-By: Claude' trailer (commit already landed; signaling autopilot to halt)" >&2
  echo "  subject: $SUBJECT" >&2
  exit 1
fi

exit 0
