#!/usr/bin/env bash
# Run the shell-only suites that node --test does not collect.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_BIN="${CPS_SHELL:-bash}"

DEFAULT_SUITES='tests/scripts/codex-exec-with-status.test.sh
tests/scripts/doctor-models-check.test.sh
tests/scripts/migrate-sidecars.test.sh
tests/scripts/fresh-clone-smoke.test.sh'

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) PROBE_EXPECTED=0 ;;
  *) PROBE_EXPECTED=1 ;;
esac
DEFAULT_PROBES="tests/scripts/computer-use-availability.test.sh|$PROBE_EXPECTED"

if [ "${CPS_SHELL_SUITES+x}" = x ]; then
  SUITES="$CPS_SHELL_SUITES"
else
  SUITES="$DEFAULT_SUITES"
fi
if [ "${CPS_SHELL_PROBES+x}" = x ]; then
  PROBES="$CPS_SHELL_PROBES"
else
  PROBES="$DEFAULT_PROBES"
fi

FAILURES=0
SUITES_EXECUTED=0

resolve_test_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$REPO_ROOT" "$1" ;;
  esac
}

ORIGINAL_IFS=$IFS
set -f
IFS=$'\n'
for suite in $SUITES; do
  [ -n "$suite" ] || continue
  SUITES_EXECUTED=$((SUITES_EXECUTED + 1))
  suite_path=$(resolve_test_path "$suite")
  if "$SHELL_BIN" "$suite_path"; then
    echo "PASS suite $suite"
  else
    status=$?
    echo "FAIL suite $suite (exit $status)" >&2
    FAILURES=$((FAILURES + 1))
  fi
done

for probe in $PROBES; do
  [ -n "$probe" ] || continue
  probe_path=${probe%|*}
  expected=${probe##*|}
  resolved_probe=$(resolve_test_path "$probe_path")
  "$SHELL_BIN" "$resolved_probe"
  actual=$?
  if [ "$actual" -eq "$expected" ] 2>/dev/null; then
    echo "PASS probe $probe_path (exit $actual)"
  else
    echo "FAIL probe $probe_path: expected $expected, got $actual" >&2
    FAILURES=$((FAILURES + 1))
  fi
done
IFS=$ORIGINAL_IFS
set +f

if [ -n "$SUITES" ] && [ "$SUITES_EXECUTED" -eq 0 ]; then
  echo "FAIL: no suites executed" >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES shell test failure(s)" >&2
  exit 1
fi

echo "All shell suites and probes matched expected outcomes."
