#!/usr/bin/env bash
# Test harness for scripts/migrate-sidecars-to-hidden-dir.sh.
# Each test creates a throwaway git repo, seeds fixture state,
# runs the migration script, and asserts the outcome.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/scripts/migrate-sidecars-to-hidden-dir.sh"

pass=0
fail=0

run_case() {
  local name="$1"
  local action="$2"   # 'dry-run' or 'real'
  local setup_fn="$3"
  local check_fn="$4"

  local repo
  repo=$(mktemp -d)
  (
    cd "$repo"
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
    eval "$setup_fn"
  )

  local output rc
  set +e
  if [ "$action" = "dry-run" ]; then
    output=$(cd "$repo" && bash "$SCRIPT" --dry-run 2>&1)
  else
    output=$(cd "$repo" && bash "$SCRIPT" 2>&1)
  fi
  rc=$?
  set -e

  if "$check_fn" "$repo" "$output" "$rc"; then
    echo "PASS: $name"
    pass=$((pass + 1))
  else
    echo "FAIL: $name"
    echo "  output: $output"
    echo "  rc: $rc"
    fail=$((fail + 1))
  fi

  rm -rf "$repo"
}

# ---------------------------------------------------------------------------
# Case 1: migrate-tracked classification
# Setup: one tracked legacy sidecar (committed). Run --dry-run.
# Assert: stdout contains "migrate-tracked" and the filename; exit 0; file still exists.
# ---------------------------------------------------------------------------
setup_case1() {
  mkdir -p docs/specs
  printf "spec content\n" > docs/specs/foo.md
  printf '{"feature":"f","rounds":[]}\n' > docs/specs/foo.md.codex.json
  git add docs/specs/foo.md docs/specs/foo.md.codex.json
  git commit -qm "initial"
}

check_case1() {
  local repo="$1" output="$2" rc="$3"
  [ "$rc" -eq 0 ] || { echo "  expected exit 0, got $rc"; return 1; }
  echo "$output" | grep -q "migrate-tracked" || { echo "  'migrate-tracked' not found in output"; return 1; }
  echo "$output" | grep -q "foo.md.codex.json" || { echo "  filename not found in output"; return 1; }
  [ -f "$repo/docs/specs/foo.md.codex.json" ] || { echo "  legacy file was moved (should not be in dry-run)"; return 1; }
  return 0
}

run_case "migrate-tracked classification (dry-run)" "dry-run" "setup_case1" "check_case1"

# ---------------------------------------------------------------------------
# Case 2: migrate-untracked classification
# Setup: legacy sidecar exists but NOT committed. Run --dry-run.
# Assert: stdout contains "migrate-untracked"; exit 0; file still exists.
# ---------------------------------------------------------------------------
setup_case2() {
  mkdir -p docs/specs
  printf "spec content\n" > docs/specs/bar.md
  printf '{"feature":"f","rounds":[]}\n' > docs/specs/bar.md.codex.json
  # Do NOT git add or commit; leave it untracked.
}

check_case2() {
  local repo="$1" output="$2" rc="$3"
  [ "$rc" -eq 0 ] || { echo "  expected exit 0, got $rc"; return 1; }
  echo "$output" | grep -q "migrate-untracked" || { echo "  'migrate-untracked' not found in output"; return 1; }
  [ -f "$repo/docs/specs/bar.md.codex.json" ] || { echo "  legacy file was moved (should not be in dry-run)"; return 1; }
  return 0
}

run_case "migrate-untracked classification (dry-run)" "dry-run" "setup_case2" "check_case2"

# ---------------------------------------------------------------------------
# Case 3: Ambiguous state — exits nonzero, mutates nothing
# Setup: BOTH legacy <spec>.codex.json AND hidden .superpowers-codex-paired/<spec>.json exist.
# Run REAL mode (no --dry-run).
# Assert: exit nonzero; BOTH files still exist.
# ---------------------------------------------------------------------------
setup_case3() {
  mkdir -p docs/specs
  mkdir -p .superpowers-codex-paired/docs/specs
  printf "spec content\n" > docs/specs/baz.md
  printf '{"feature":"legacy","rounds":[]}\n' > docs/specs/baz.md.codex.json
  printf '{"feature":"hidden","rounds":[]}\n' > .superpowers-codex-paired/docs/specs/baz.md.json
  # Not committing either; both are untracked to keep setup simple.
}

check_case3() {
  local repo="$1" output="$2" rc="$3"
  [ "$rc" -ne 0 ] || { echo "  expected exit nonzero, got $rc (should have aborted)"; return 1; }
  [ -f "$repo/docs/specs/baz.md.codex.json" ] || { echo "  legacy file was removed (should NOT be — Phase 1 should have aborted)"; return 1; }
  [ -f "$repo/.superpowers-codex-paired/docs/specs/baz.md.json" ] || { echo "  hidden file was removed (should NOT be)"; return 1; }
  return 0
}

run_case "ambiguous state halts, mutates nothing (real mode)" "real" "setup_case3" "check_case3"

# ---------------------------------------------------------------------------
# Case 4: already-migrated — only hidden sidecar present (no legacy)
# The find command won't return anything because there are no *.codex.json files.
# Script should print "no legacy sidecars found; nothing to migrate" and exit 0.
# ---------------------------------------------------------------------------
setup_case4() {
  mkdir -p .superpowers-codex-paired/docs/specs
  printf '{"feature":"f","rounds":[]}\n' > .superpowers-codex-paired/docs/specs/qux.md.json
  # No legacy *.codex.json anywhere.
}

check_case4() {
  local repo="$1" output="$2" rc="$3"
  [ "$rc" -eq 0 ] || { echo "  expected exit 0, got $rc"; return 1; }
  echo "$output" | grep -qiE "(no legacy|nothing to migrate|already-migrated)" || {
    echo "  expected 'no legacy sidecars' or similar message"
    return 1
  }
  return 0
}

run_case "already-migrated (no legacy, dry-run)" "dry-run" "setup_case4" "check_case4"

# ---------------------------------------------------------------------------
# Case 5: Idempotent rerun
# Setup: one tracked legacy sidecar. Run real mode → verify migration.
# Run real mode AGAIN → assert second run reports nothing to migrate; exit 0.
# ---------------------------------------------------------------------------
setup_case5() {
  mkdir -p docs/specs
  printf "spec content\n" > docs/specs/idem.md
  printf '{"feature":"f","rounds":[]}\n' > docs/specs/idem.md.codex.json
  git add docs/specs/idem.md docs/specs/idem.md.codex.json
  git commit -qm "initial"
}

check_case5() {
  local repo="$1" first_output="$2" first_rc="$3"
  # First run output and rc come from run_case (action="real").
  if [ "$first_rc" -ne 0 ]; then
    echo "  first run failed with rc=$first_rc; output: $first_output"
    return 1
  fi
  # Legacy should be gone after first run.
  if [ -f "$repo/docs/specs/idem.md.codex.json" ]; then
    echo "  legacy still exists after first migration"
    return 1
  fi
  # Hidden should exist.
  if [ ! -f "$repo/.superpowers-codex-paired/docs/specs/idem.md.json" ]; then
    echo "  hidden sidecar not created by first migration"
    return 1
  fi

  # Second run: should report nothing to do and exit 0.
  local second_output second_rc
  second_output="$(cd "$repo" && bash "$SCRIPT" 2>&1)"
  second_rc=$?
  if [ "$second_rc" -ne 0 ]; then
    echo "  second run failed with rc=$second_rc; output: $second_output"
    return 1
  fi
  echo "$second_output" | grep -qiE "(no legacy|nothing to migrate|already-migrated)" || {
    echo "  second run output unexpected: $second_output"
    return 1
  }
  return 0
}

run_case "idempotent rerun (real mode x2)" "real" "setup_case5" "check_case5"

# ---------------------------------------------------------------------------
echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
