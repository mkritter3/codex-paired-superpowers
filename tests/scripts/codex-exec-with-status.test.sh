#!/usr/bin/env bash
# Tests for v0.7.2 codex exec wrapper with status file.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$PLUGIN_ROOT/scripts/codex-exec-with-status.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# --- Test fixture helpers ---

mktmp() {
  mktemp -d -t cps-wrapper-test-XXXXXX
}

read_field() {
  # $1 = JSON file path, $2 = field name (top-level key).
  # Returns the field value, or empty if not found / file missing.
  if [ ! -f "$1" ]; then echo ""; return; fi
  node -e "
    const j = require('fs').readFileSync('$1','utf8');
    try { const o = JSON.parse(j); process.stdout.write(String(o['$2']));} catch(e) { process.stdout.write('PARSE_ERROR'); }
  "
}

# --- Test 1: success path writes exit_code=0 ---

echo "[1] success path"
TMP=$(mktmp)
STATUS="$TMP/s.json"
"$WRAPPER" "$STATUS" -- bash -c 'echo hello && exit 0' >/dev/null
if [ "$?" -eq 0 ] && [ "$(read_field "$STATUS" exit_code)" = "0" ] && [ "$(read_field "$STATUS" signal)" = "null" ]; then
  pass "exit_code=0, signal=null when codex exits cleanly"
else
  fail "expected exit_code=0 signal=null; got exit_code=$(read_field "$STATUS" exit_code) signal=$(read_field "$STATUS" signal)"
fi
rm -rf "$TMP"

# --- Test 2: failure path captures non-zero exit ---

echo "[2] failure path"
TMP=$(mktmp)
STATUS="$TMP/s.json"
"$WRAPPER" "$STATUS" -- bash -c 'exit 7' >/dev/null
if [ "$?" -eq 7 ] && [ "$(read_field "$STATUS" exit_code)" = "7" ] && [ "$(read_field "$STATUS" signal)" = "null" ]; then
  pass "exit_code=7 captured for failed command"
else
  fail "expected exit_code=7 signal=null; got exit_code=$(read_field "$STATUS" exit_code) signal=$(read_field "$STATUS" signal)"
fi
rm -rf "$TMP"

# --- Test 3: status file contains both timestamps ---

echo "[3] timestamps"
TMP=$(mktmp)
STATUS="$TMP/s.json"
"$WRAPPER" "$STATUS" -- bash -c 'sleep 1 && exit 0' >/dev/null
STARTED=$(read_field "$STATUS" started_at)
COMPLETED=$(read_field "$STATUS" completed_at)
if [ -n "$STARTED" ] && [ -n "$COMPLETED" ] && [ "$STARTED" != "undefined" ]; then
  pass "started_at and completed_at both present (started=$STARTED completed=$COMPLETED)"
else
  fail "timestamps missing or invalid (started=$STARTED completed=$COMPLETED)"
fi
rm -rf "$TMP"

# --- Test 4: SIGTERM handling writes interrupted status ---

echo "[4] SIGTERM handling"
TMP=$(mktmp)
STATUS="$TMP/s.json"
"$WRAPPER" "$STATUS" -- bash -c 'sleep 30' >/dev/null &
WPID=$!
sleep 0.5
kill -TERM "$WPID"
wait "$WPID" 2>/dev/null
EXITC=$?
SIGNAL=$(read_field "$STATUS" signal)
EXIT_RECORDED=$(read_field "$STATUS" exit_code)
# Either the wrapper recorded SIGTERM gracefully, or it was killed mid-write.
# The ideal case: signal=SIGTERM, exit_code=143.
if [ "$SIGNAL" = "SIGTERM" ] && [ "$EXIT_RECORDED" = "143" ]; then
  pass "SIGTERM captured: signal=SIGTERM, exit_code=143"
else
  fail "SIGTERM not recorded as expected (signal=$SIGNAL exit_code=$EXIT_RECORDED wrapper-exit=$EXITC)"
fi
rm -rf "$TMP"

# --- Test 5: usage error when called wrong ---

echo "[5] usage error"
TMP=$(mktmp)
"$WRAPPER" 2>/dev/null
RC=$?
if [ "$RC" -eq 64 ]; then
  pass "no args → exit 64"
else
  fail "expected exit 64 on no-args; got $RC"
fi

"$WRAPPER" "$TMP/s.json" 2>/dev/null
RC=$?
if [ "$RC" -eq 64 ]; then
  pass "missing -- separator → exit 64"
else
  fail "expected exit 64 when -- separator missing; got $RC"
fi

"$WRAPPER" "$TMP/s.json" -- 2>/dev/null
RC=$?
if [ "$RC" -eq 64 ]; then
  pass "no command after -- → exit 64"
else
  fail "expected exit 64 when no command after --; got $RC"
fi
rm -rf "$TMP"

# --- Test 6: atomic write — no partial JSON visible mid-run ---

echo "[6] atomic write"
TMP=$(mktmp)
STATUS="$TMP/s.json"
# Start a long-running wrapper, poll for status file during run, verify it's
# either absent or fully-formed JSON (never partial).
"$WRAPPER" "$STATUS" -- bash -c 'sleep 2 && exit 0' >/dev/null &
WPID=$!
PARTIAL_SEEN=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if [ -f "$STATUS" ]; then
    # Try to parse — atomic write means it's always complete.
    if ! node -e "JSON.parse(require('fs').readFileSync('$STATUS','utf8'))" 2>/dev/null; then
      PARTIAL_SEEN=1
      break
    fi
  fi
  sleep 0.2
done
wait "$WPID" 2>/dev/null
if [ "$PARTIAL_SEEN" -eq 0 ]; then
  pass "no partial JSON observed during run (atomic write OK)"
else
  fail "partial JSON detected during wrapper run (atomic write broken)"
fi
rm -rf "$TMP"

# --- Test 7: status dir auto-created if missing ---

echo "[7] status dir auto-create"
TMP=$(mktmp)
STATUS="$TMP/nested/path/that/does/not/exist/s.json"
"$WRAPPER" "$STATUS" -- true >/dev/null
if [ -f "$STATUS" ] && [ "$(read_field "$STATUS" exit_code)" = "0" ]; then
  pass "wrapper auto-creates status dir"
else
  fail "wrapper did not create nested status dir"
fi
rm -rf "$TMP"

# --- Summary ---

echo
echo "================================================================="
echo "$PASS_COUNT passed, $FAIL_COUNT failed"
if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
