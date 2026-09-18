#!/usr/bin/env bash
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE="$PLUGIN_ROOT/scripts/fresh-clone-smoke.mjs"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

run_smoke() {
  local label="$1"
  shift
  local output="$TEST_ROOT/$label.out"
  CPS_FRESH_CLONE_TRACE_TMP=1 node "$SMOKE" "$@" >"$output" 2>&1
  local status=$?
  printf '%s|%s' "$status" "$output"
}

assert_removed() {
  local output="$1" label="$2"
  local temp_dir
  temp_dir=$(sed -n 's/^fresh-clone temp: //p' "$output" | tail -1)
  if [ -z "$temp_dir" ]; then
    echo "FAIL: $label did not report its temp directory" >&2
    return 1
  fi
  if [ -e "$temp_dir" ]; then
    echo "FAIL: $label left temp directory $temp_dir" >&2
    return 1
  fi
}

echo "Fresh-clone smoke self-test"

happy_result=$(run_smoke happy)
happy_status=${happy_result%%|*}
happy_output=${happy_result#*|}
if [ "$happy_status" -ne 0 ]; then
  cat "$happy_output" >&2
  exit 1
fi
grep -q '^PASS fresh-clone smoke' "$happy_output" || { cat "$happy_output" >&2; exit 1; }
echo "  PASS: happy path passes"

outer_node=$(node --version)
grep -q "node $outer_node" "$happy_output" || { cat "$happy_output" >&2; exit 1; }
echo "  PASS: isolated node version matches outer node"

assert_removed "$happy_output" "happy path" || exit 1
echo "  PASS: happy-path temp directory removed"

stale_result=$(run_smoke stale --sha stale)
stale_status=${stale_result%%|*}
stale_output=${stale_result#*|}
if [ "$stale_status" -eq 0 ]; then
  cat "$stale_output" >&2
  exit 1
fi
grep -q 'FAIL step 6 reviewer' "$stale_output" || { cat "$stale_output" >&2; exit 1; }
assert_removed "$stale_output" "stale-sha path" || exit 1
echo "  PASS: stale --sha fails at reviewer step and cleans up"

aliased_result=$(CPS_FRESH_CLONE_FAKE_RECORD_CWD=project run_smoke aliased)
aliased_status=${aliased_result%%|*}
aliased_output=${aliased_result#*|}
if [ "$aliased_status" -eq 0 ]; then
  cat "$aliased_output" >&2
  exit 1
fi
grep -q 'FAIL step 6 reviewer.*throwaway checkout' "$aliased_output" || {
  cat "$aliased_output" >&2
  exit 1
}
assert_removed "$aliased_output" "aliased-project path" || exit 1
echo "  PASS: aliased project cwd fails the throwaway-checkout assertion and cleans up"

echo "All 5 fresh-clone smoke checks passed."
