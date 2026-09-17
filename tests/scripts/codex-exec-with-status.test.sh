#!/usr/bin/env bash
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$PLUGIN_ROOT/scripts/codex-exec-with-status.sh"
PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }
mktmp() { mktemp -d -t cps-wrapper-test-XXXXXX; }
read_field() {
  if [ ! -f "$1" ]; then echo ""; return; fi
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o[process.argv[2]]))' "$1" "$2"
}
assert_fields() {
  local file="$1"; shift
  while [ "$#" -gt 0 ]; do
    local key="$1" expected="$2"; shift 2
    if [ "$(read_field "$file" "$key")" != "$expected" ]; then return 1; fi
  done
}
make_fake_codex() {
  local root="$1"
  mkdir -p "$root/bin"
  cat > "$root/bin/codex" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE_ARGS_FILE:-}" ]; then printf '%s\n' "$@" > "$FAKE_ARGS_FILE"; fi
if [ -n "${FAKE_WAIT_FILE:-}" ]; then
  cp "$FAKE_STATUS_FILE" "$FAKE_SEEN_STATUS"
  while [ ! -e "$FAKE_WAIT_FILE" ]; do sleep 0.05; done
fi
exit 0
EOF
  chmod +x "$root/bin/codex"
}

echo "[1] model role inserts frozen flags and writes terminal snapshot"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- \
  codex exec --skip-git-repo-check -s workspace-write -C "$TMP" p
RC=$?
EXPECTED=$(printf '%s\n' exec -m gpt-5.6-sol -c model_reasoning_effort=high --skip-git-repo-check -s workspace-write -C "$TMP" p)
if [ "$RC" -eq 0 ] && [ "$(cat "$ARGS")" = "$EXPECTED" ] && \
   assert_fields "$STATUS" state exited exit_code 0 model_role implement model gpt-5.6-sol effort high; then
  pass "model-role flags and terminal snapshot"
else fail "model-role success case failed"; fi
rm -rf "$TMP"

echo "[2] unknown role fails before codex runs"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role bogus -- codex exec p >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && assert_fields "$STATUS" state exited exit_code 78 error model-role-resolution-failed model_role bogus; then
  pass "unknown role is EX_CONFIG and codex did not run"
else fail "unknown role handling failed"; fi
rm -rf "$TMP"

echo "[3] conflicting model flags fail before codex runs"
for conflict in short long effort; do
  TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
  case "$conflict" in
    short) EXTRA=(-m gpt-5.5 p) ;;
    long) EXTRA=(--model x p) ;;
    effort) EXTRA=(-c model_reasoning_effort=low p) ;;
  esac
  PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec "${EXTRA[@]}" >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && assert_fields "$STATUS" exit_code 78 error model-role-conflicting-args; then
    pass "$conflict conflict rejected"
  else fail "$conflict conflict was not rejected"; fi
  rm -rf "$TMP"
done

echo "[4] child sees started status before execution; final preserves snapshot"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"; WAIT="$TMP/wait"; SEEN="$TMP/seen.json"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" FAKE_WAIT_FILE="$WAIT" FAKE_STATUS_FILE="$STATUS" FAKE_SEEN_STATUS="$SEEN" \
  "$WRAPPER" "$STATUS" --model-role implement -- codex exec p &
WPID=$!
for _ in $(seq 1 100); do [ -f "$SEEN" ] && break; sleep 0.02; done
if assert_fields "$SEEN" state started exit_code null completed_at null model_role implement model gpt-5.6-sol effort high; then
  pass "initial lifecycle status is complete and nonterminal"
else fail "initial lifecycle status missing or malformed"; fi
touch "$WAIT"; wait "$WPID"; RC=$?
if [ "$RC" -eq 0 ] && assert_fields "$STATUS" state exited exit_code 0 model_role implement model gpt-5.6-sol effort high; then
  pass "terminal lifecycle status preserves snapshot"
else fail "terminal lifecycle status did not preserve snapshot"; fi
rm -rf "$TMP"

echo "[5] no model role remains backward compatible"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" -- codex exec -m custom p
if [ "$?" -eq 0 ] && [ "$(read_field "$STATUS" model_role)" = "undefined" ] && grep -qx custom "$ARGS"; then
  pass "legacy caller model flag allowed without snapshot"
else fail "legacy caller behavior changed"; fi
rm -rf "$TMP"

echo "[6] repo-root project override reaches argv"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"model":"gpt-5.6-terra"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- codex exec p
if [ "$?" -eq 0 ] && grep -qx gpt-5.6-terra "$ARGS" && assert_fields "$STATUS" model gpt-5.6-terra effort high; then
  pass "project override resolved from repo root"
else fail "project override did not reach argv/status"; fi
rm -rf "$TMP"

echo "[7] SIGTERM terminal status preserves snapshot"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; WAIT="$TMP/wait"; SEEN="$TMP/seen.json"
PATH="$TMP/bin:$PATH" FAKE_WAIT_FILE="$WAIT" FAKE_STATUS_FILE="$STATUS" FAKE_SEEN_STATUS="$SEEN" \
  "$WRAPPER" "$STATUS" --model-role implement -- codex exec p >/dev/null &
WPID=$!
for _ in $(seq 1 100); do [ -f "$SEEN" ] && break; sleep 0.02; done
kill -TERM "$WPID"; wait "$WPID" 2>/dev/null; RC=$?
if [ "$RC" -eq 143 ] && assert_fields "$STATUS" state exited exit_code 143 signal SIGTERM model_role implement model gpt-5.6-sol effort high; then
  pass "SIGTERM status retains snapshot"
else fail "SIGTERM status incorrect (wrapper-exit=$RC)"; fi
rm -rf "$TMP"

echo "[8] non-codex-exec shape is rejected when role is requested"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex resume p >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && assert_fields "$STATUS" error model-role-conflicting-args; then
  pass "non-exec invocation rejected"
else fail "non-exec invocation was not rejected"; fi
rm -rf "$TMP"

echo "[9] legacy generic command exit and usage behavior"
TMP=$(mktmp); STATUS="$TMP/status.json"
"$WRAPPER" "$STATUS" -- bash -c 'exit 7' >/dev/null; RC=$?
if [ "$RC" -eq 7 ] && assert_fields "$STATUS" state exited exit_code 7 signal null; then pass "generic exit captured"; else fail "generic exit failed"; fi
"$WRAPPER" >/dev/null 2>&1; RC=$?
if [ "$RC" -eq 64 ]; then pass "usage error remains 64"; else fail "usage error was $RC"; fi
rm -rf "$TMP"

echo
echo "================================================================="
echo "$PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
