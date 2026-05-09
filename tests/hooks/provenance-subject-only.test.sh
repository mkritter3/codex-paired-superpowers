#!/usr/bin/env bash
# Subject-only provenance hook tests (v0.7.0 spec §16).
#
# These tests cover the post-trailer-drop behavior: the hook checks ONLY the
# commit subject pattern. Trailer presence is allowed but not required.
#
# Test cases (per plan slice 7):
#   1. No active anchor                                    -> exit 0
#   2. Active anchor + conforming subject WITH trailer     -> exit 0 (back-compat)
#   3. Active anchor + conforming subject WITHOUT trailer  -> exit 0 (new behavior)
#   4. Active anchor + wrong slice number subject          -> exit 2
#   5. Active anchor + arbitrary manual subject            -> exit 2
#   6. Subdirectory commit resolves repo root via git      -> exit 0
#   7. Stdin filter: Bash git commit -> evaluates;
#                    Bash git status / Bash git log / Edit -> exit 0
set -eu

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/check-commit-provenance.sh"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

pass=0
fail=0

# Track all temp dirs for trap cleanup. Set + array to be safe under set -u.
TMP_DIRS=""
cleanup() {
  if [ -n "$TMP_DIRS" ]; then
    for d in $TMP_DIRS; do
      [ -d "$d" ] && rm -rf "$d"
    done
  fi
}
trap cleanup EXIT INT TERM

# --- helpers ---------------------------------------------------------------

# Initialize a fresh temp git repo. Echoes path to stdout.
make_repo() {
  local repo
  repo=$(mktemp -d)
  TMP_DIRS="$TMP_DIRS $repo"
  (
    cd "$repo"
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
  )
  printf '%s\n' "$repo"
}

# Set up active autopilot anchor + sidecar in repo at $1 with current_slice $2.
activate_autopilot() {
  local repo="$1"
  local slice="$2"
  (
    cd "$repo"
    mkdir -p .codex-paired docs/specs
    printf '# s\n' > docs/specs/spec.md
    node "$CLI" sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
    node "$CLI" sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" \
      --block "{\"current_slice\":\"$slice\",\"current_phase\":\"implement\"}"
    node "$CLI" anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  )
}

# Record outcome of a single assertion.
record() {
  local name="$1"
  local got="$2"
  local want="$3"
  if [ "$got" -eq "$want" ]; then
    pass=$((pass+1))
    printf 'PASS: %s\n' "$name"
  else
    fail=$((fail+1))
    printf 'FAIL: %s (got rc=%s, expected %s)\n' "$name" "$got" "$want"
  fi
}

# Run hook against a repo using the CPS_HOOK_FORCE bypass (skips stdin filter).
# Args: name repo expected_rc
run_force_case() {
  local name="$1"
  local repo="$2"
  local want="$3"
  set +e
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CPS_HOOK_FORCE=1 "$HOOK"
  local rc=$?
  set -e
  record "$name" "$rc" "$want"
}

# Run hook with a JSON stdin payload (exercises the stdin tool-name filter).
# Args: name repo stdin_json expected_rc
run_stdin_case() {
  local name="$1"
  local repo="$2"
  local stdin_json="$3"
  local want="$4"
  set +e
  printf '%s' "$stdin_json" | CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$HOOK"
  local rc=$?
  set -e
  record "$name" "$rc" "$want"
}

# --- case 1: no active anchor ---------------------------------------------

case_no_anchor() {
  local repo
  repo=$(make_repo)
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "anything goes — no slice prefix, no trailer"
  )
  run_force_case "1. no anchor: allow arbitrary commit" "$repo" 0
}

# --- case 2: anchor + conforming subject WITH old trailer (back-compat) ----

case_conforming_with_trailer() {
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "feat(slice:3): adds a

Co-Authored-By: Claude <noreply@anthropic.com>"
  )
  run_force_case "2. anchor + conforming subject + old trailer: allow (back-compat)" "$repo" 0
}

# --- case 3: anchor + conforming subject WITHOUT trailer (new behavior) ----

case_conforming_without_trailer() {
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "feat(slice:3): adds a"
  )
  run_force_case "3. anchor + conforming subject + no trailer: allow (new behavior)" "$repo" 0
}

# --- case 4: anchor + wrong slice number ----------------------------------

case_wrong_slice() {
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "feat(slice:9): wrong slice number"
  )
  set +e
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CPS_HOOK_FORCE=1 \
    "$HOOK" 2>/tmp/cps-slice7-stderr.$$
  local rc=$?
  set -e
  record "4. anchor + wrong slice subject: block" "$rc" 2
  if [ "$rc" -eq 2 ] && grep -q "slice:3 prefix" /tmp/cps-slice7-stderr.$$; then
    pass=$((pass+1))
    printf 'PASS: 4b. wrong slice stderr mentions expected slice\n'
  else
    fail=$((fail+1))
    printf 'FAIL: 4b. wrong slice stderr did not mention expected slice (stderr was: %s)\n' \
      "$(cat /tmp/cps-slice7-stderr.$$ 2>/dev/null || true)"
  fi
  rm -f /tmp/cps-slice7-stderr.$$
}

# --- case 5: anchor + arbitrary manual subject (no slice marker) ----------

case_arbitrary_manual() {
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "manual hand-commit with no slice marker"
  )
  run_force_case "5. anchor + arbitrary manual subject: block" "$repo" 2
}

# --- case 6: subdirectory commit ------------------------------------------

case_subdirectory() {
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    mkdir -p lib/foo
    cd lib/foo
    printf 'x\n' > a && git add a
    git commit -qm "feat(slice:3): added from subdir"
  )
  # Invoke hook from inside the subdirectory; do NOT set CLAUDE_PROJECT_DIR
  # so the hook must resolve repo root via `git rev-parse --show-toplevel`.
  set +e
  (
    cd "$repo/lib/foo"
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CPS_HOOK_FORCE=1 "$HOOK"
  )
  local rc=$?
  set -e
  record "6. subdirectory commit: resolves repo root via git rev-parse" "$rc" 0
}

# --- case 7: stdin filter (Bash git commit fires; everything else short-circuits)

case_stdin_filter() {
  # Set up an active autopilot with a NON-conforming commit on HEAD so that
  # if the filter passes through, the hook would block (rc=2). If the filter
  # short-circuits (non-git Bash, non-Bash tool), we should see rc=0.
  local repo
  repo=$(make_repo)
  activate_autopilot "$repo" "3"
  (
    cd "$repo"
    printf 'x\n' > a && git add a
    git commit -qm "external nope, no slice marker"
  )

  # 7a. Bash git commit -> filter passes through, hook signals 2.
  run_stdin_case "7a. stdin Bash git commit: filter passes through (rc=2)" \
    "$repo" \
    '{"tool_name":"Bash","tool_input":{"command":"git commit -m foo"}}' \
    2

  # 7b. Bash git status -> filter short-circuits, rc=0.
  run_stdin_case "7b. stdin Bash git status: filter short-circuits (rc=0)" \
    "$repo" \
    '{"tool_name":"Bash","tool_input":{"command":"git status"}}' \
    0

  # 7c. Bash git log -> filter short-circuits, rc=0.
  run_stdin_case "7c. stdin Bash git log: filter short-circuits (rc=0)" \
    "$repo" \
    '{"tool_name":"Bash","tool_input":{"command":"git log --oneline -3"}}' \
    0

  # 7d. Non-Bash tool (Edit) -> filter short-circuits, rc=0.
  run_stdin_case "7d. stdin Edit tool: filter short-circuits (rc=0)" \
    "$repo" \
    '{"tool_name":"Edit","tool_input":{"file_path":"foo.md"}}' \
    0
}

# --- run all cases --------------------------------------------------------

case_no_anchor
case_conforming_with_trailer
case_conforming_without_trailer
case_wrong_slice
case_arbitrary_manual
case_subdirectory
case_stdin_filter

printf -- '---\n'
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
