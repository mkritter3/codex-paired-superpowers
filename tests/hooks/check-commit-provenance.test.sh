#!/usr/bin/env bash
# Test harness for hooks/check-commit-provenance.sh.
# Builds throwaway git repos, simulates the hook env, asserts exit codes.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/check-commit-provenance.sh"

pass=0
fail=0

run_case() {
  local name="$1"
  local setup="$2"
  local expected="$3"  # 0 = allow, 1 = block

  local repo
  repo=$(mktemp -d)
  (
    cd "$repo"
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
    eval "$setup"
  )
  set +e
  # Existing cases bypass the stdin tool-name filter via CPS_HOOK_FORCE=1.
  # Two cases below ("git commit stdin" / "non-git Bash stdin") exercise
  # the filter itself by NOT setting CPS_HOOK_FORCE.
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CPS_HOOK_FORCE=1 "$HOOK"
  local rc=$?
  set -e
  rm -rf "$repo"
  if [ "$rc" -eq "$expected" ]; then
    pass=$((pass+1))
    echo "PASS: $name"
  else
    fail=$((fail+1))
    echo "FAIL: $name (got rc=$rc, expected $expected)"
  fi
}

# --- cases ---

run_case "no anchor file: allow everything" '
  echo "x" > a && git add a
  git commit -qm "anything goes"
' 0

run_case "anchor + conforming commit (correct slice + trailer): allow" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): add a

Co-Authored-By: Claude <noreply@anthropic.com>"
' 0

run_case "anchor + non-conforming subject (wrong slice number): block" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:9): wrong slice

Co-Authored-By: Claude <noreply@anthropic.com>"
' 2

run_case "anchor + missing trailer (subject-only validation): allow" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): no trailer here"
' 0

run_case "anchor + arbitrary external subject: block" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "manual hand-commit

Co-Authored-By: Claude <noreply@anthropic.com>"
' 2

run_case "anchor + non-conforming commit from subdirectory: signal nonzero" '
  mkdir -p .codex-paired docs/specs sub/dir
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  cd sub/dir
  echo "x" > a && git add a
  # Hook MUST resolve repo root to the parent (where the anchor lives), not cwd.
  git commit -qm "external from subdir"
' 2

run_case "anchor + conforming commit from subdirectory: pass" '
  mkdir -p .codex-paired docs/specs sub/dir
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  cd sub/dir
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): add a from subdir

Co-Authored-By: Claude <noreply@anthropic.com>"
' 0

# --- stdin-filter tests (NOT using run_case; these test the filter itself) ---

run_filter_case() {
  local name="$1"
  local stdin_json="$2"
  local expected="$3"

  local repo
  repo=$(mktemp -d)
  (cd "$repo" && git init -q -b main && git config user.email t@t.test && git config user.name t)
  # Set up an active autopilot so the filter has somewhere to fall through TO.
  (
    cd "$repo"
    mkdir -p .codex-paired docs/specs
    echo "# s" > docs/specs/spec.md
    node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
    node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block '{"current_slice":"3","current_phase":"implement"}'
    node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
    # Land a NON-conforming commit so if the filter passes through, the hook would block.
    echo "x" > a && git add a
    git commit -qm "external nope"
  )
  set +e
  echo "$stdin_json" | CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$HOOK"
  local rc=$?
  set -e
  rm -rf "$repo"
  if [ "$rc" -eq "$expected" ]; then
    pass=$((pass+1))
    echo "PASS: $name"
  else
    fail=$((fail+1))
    echo "FAIL: $name (got rc=$rc, expected $expected)"
  fi
}

# Filter SHOULD pass through (no CPS_HOOK_FORCE) and the hook SHOULD signal
# rc=2 (PostToolUse blocking error — Claude Code surfaces stderr to Claude)
# because we set up a non-conforming commit + active autopilot.
run_filter_case "stdin git commit -> filter passes through, hook signals" \
  '{"tool_name":"Bash","tool_input":{"command":"git commit -m foo"}}' \
  2

# Filter SHOULD short-circuit (non-git Bash) and exit 0 even though the
# repo state would otherwise trigger a block.
run_filter_case "stdin non-git Bash -> filter exits 0" \
  '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' \
  0

# Filter SHOULD short-circuit (wrong tool_name) and exit 0.
run_filter_case "stdin Edit tool -> filter exits 0" \
  '{"tool_name":"Edit","tool_input":{"file_path":"foo.md"}}' \
  0

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
