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
if [ -n "${FAKE_CWD_FILE:-}" ]; then printf '%s\n' "$PWD" > "$FAKE_CWD_FILE"; fi
if [ -n "${FAKE_WAIT_FILE:-}" ]; then
  cp "$FAKE_STATUS_FILE" "$FAKE_SEEN_STATUS"
  while [ ! -e "$FAKE_WAIT_FILE" ]; do sleep 0.05; done
fi
if [ -n "${FAKE_BREAK_STATUS_DIR:-}" ]; then
  rm -rf "$FAKE_BREAK_STATUS_DIR"
  : > "$FAKE_BREAK_STATUS_DIR"
fi
exit "${FAKE_EXIT_CODE:-0}"
EOF
  chmod +x "$root/bin/codex"
}

make_fake_agy() {
  local root="$1"
  mkdir -p "$root/bin"
  cat > "$root/bin/agy" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE_ARGS_FILE:-}" ]; then printf '%s\n' "$@" > "$FAKE_ARGS_FILE"; fi
if [ -n "${FAKE_CWD_FILE:-}" ]; then printf '%s\n' "$PWD" > "$FAKE_CWD_FILE"; fi
if [ -n "${FAKE_WAIT_FILE:-}" ]; then
  cp "$FAKE_STATUS_FILE" "$FAKE_SEEN_STATUS"
  while [ ! -e "$FAKE_WAIT_FILE" ]; do sleep 0.05; done
fi
if [ -n "${FAKE_BREAK_STATUS_DIR:-}" ]; then
  rm -rf "$FAKE_BREAK_STATUS_DIR"
  : > "$FAKE_BREAK_STATUS_DIR"
fi
exit "${FAKE_EXIT_CODE:-0}"
EOF
  chmod +x "$root/bin/agy"
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

echo "[10] prompt text mentioning model_reasoning_effort= is NOT a conflicting flag (Claude review of slice 2)"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec --skip-git-repo-check "Implement per the plan: the wrapper inserts -c model_reasoning_effort=<effort> after exec" >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ] && [ -e "$ARGS" ] && grep -q "model_reasoning_effort=high" "$ARGS"; then
  pass "prompt text is not scanned as a flag"
else fail "prompt text was misread as a conflicting flag (rc=$RC)"; fi
rm -rf "$TMP"

echo "[11] real -c model_reasoning_effort and --config= forms are still rejected"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec -c model_reasoning_effort=low p >/dev/null 2>&1
RC1=$?
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec --config=model_reasoning_effort=low p >/dev/null 2>&1
RC2=$?
if [ "$RC1" -eq 78 ] && [ "$RC2" -eq 78 ] && [ ! -e "$ARGS" ]; then
  pass "explicit effort overrides rejected"
else fail "explicit effort override not rejected (rc1=$RC1 rc2=$RC2)"; fi
rm -rf "$TMP"

echo "[12] attached short model and effort overrides are rejected"
for attached in -mgpt-5.5 -cmodel_reasoning_effort=low; do
  TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
  PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec "$attached" p >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && assert_fields "$STATUS" exit_code 78 error model-role-conflicting-args; then
    pass "attached override $attached rejected"
  else fail "attached override $attached was not rejected (rc=$RC)"; fi
  rm -rf "$TMP"
done

echo "[13] conflict scanning stops at the wrapped command option terminator"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec -- -m model_reasoning_effort=quoted >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ] && [ -e "$ARGS" ] && grep -qx -- '-m' "$ARGS" && grep -qx 'model_reasoning_effort=quoted' "$ARGS"; then
  pass "positional flag-shaped prompt arguments after -- are not conflicts"
else fail "wrapped command option terminator did not stop conflict scanning (rc=$RC)"; fi
rm -rf "$TMP"

echo "[14] impossible status path prevents launch with EX_IOERR"
TMP=$(mktmp); make_fake_codex "$TMP"; BLOCKER="$TMP/not-a-directory"; STATUS="$BLOCKER/status.json"; ARGS="$TMP/args"; ERR="$TMP/stderr"
: > "$BLOCKER"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- codex exec p >/dev/null 2>"$ERR"
RC=$?
if [ "$RC" -eq 74 ] && [ ! -e "$ARGS" ] && grep -qi 'status' "$ERR"; then
  pass "failed pre-launch publication prevents child launch"
else fail "failed pre-launch publication did not return 74 without launch (rc=$RC)"; fi
rm -rf "$TMP"

echo "[15] terminal status publication failure overrides child success/failure with EX_IOERR"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS_DIR="$TMP/status-dir"; mkdir -p "$STATUS_DIR"; STATUS="$STATUS_DIR/status.json"; ARGS="$TMP/args"; ERR="$TMP/stderr"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" FAKE_BREAK_STATUS_DIR="$STATUS_DIR" FAKE_EXIT_CODE=7 \
  "$WRAPPER" "$STATUS" --model-role implement -- codex exec p >/dev/null 2>"$ERR"
RC=$?
if [ "$RC" -eq 74 ] && [ -e "$ARGS" ] && grep -q 'child exit code: 7' "$ERR"; then
  pass "terminal publication failure returns 74 and reports child exit"
else fail "terminal publication failure was hidden (rc=$RC)"; fi
rm -rf "$TMP"

echo "[16] agy model role inserts frozen flags and writes terminal snapshot"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  agy -p "prompt" --sandbox --output-format json
RC=$?
EXPECTED=$(printf '%s\n' --model gemini-3.8-flash-high -p prompt --sandbox --output-format json)
if [ "$RC" -eq 0 ] && [ "$(cat "$ARGS")" = "$EXPECTED" ] && \
   assert_fields "$STATUS" state exited exit_code 0 model_role implement model gemini-3.8-flash-high effort high cli agy; then
  pass "agy model-role flags and terminal snapshot"
else fail "agy model-role success case failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[17] --cwd changes directory and writes cwd to status file"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"; CWD_FILE="$TMP/cwd"
TARGET_CWD="$TMP/subworktree"
mkdir -p "$TARGET_CWD"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" FAKE_CWD_FILE="$CWD_FILE" \
  "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" --cwd "$TARGET_CWD" -- \
  agy -p "prompt" --sandbox --output-format json
RC=$?
if [ "$RC" -eq 0 ] && [ -f "$CWD_FILE" ] && [ "$(cat "$CWD_FILE")" = "$TARGET_CWD" ] && \
   assert_fields "$STATUS" state exited exit_code 0 cwd "$TARGET_CWD" cli agy; then
  pass "--cwd changes directory and records in status"
else fail "--cwd handling failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[18] --cwd with relative status file path preserves status location"
TMP=$(mktmp); make_fake_agy "$TMP"; CWD_FILE="$TMP/cwd"
TARGET_CWD="$TMP/subworktree"
mkdir -p "$TARGET_CWD"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
(
  cd "$TMP"
  PATH="$TMP/bin:$PATH" FAKE_CWD_FILE="$CWD_FILE" \
    "$WRAPPER" "rel-status.json" --model-role implement --repo-root "$TMP" --cwd "$TARGET_CWD" -- \
    agy -p "prompt" --sandbox --output-format json
)
RC=$?
if [ "$RC" -eq 0 ] && [ -f "$TMP/rel-status.json" ] && [ ! -f "$TARGET_CWD/rel-status.json" ] && \
   assert_fields "$TMP/rel-status.json" state exited exit_code 0 cwd "$TARGET_CWD" cli agy; then
  pass "--cwd with relative status file writes to caller directory"
else fail "--cwd with relative status file failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[19] full path to agy matches command token"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  "$TMP/bin/agy" -p "prompt" --sandbox --output-format json
RC=$?
EXPECTED=$(printf '%s\n' --model gemini-3.8-flash-high -p prompt --sandbox --output-format json)
if [ "$RC" -eq 0 ] && [ "$(cat "$ARGS")" = "$EXPECTED" ]; then
  pass "full path to agy matches command"
else fail "full path to agy failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[20] env prefix skips to agy command token"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  env FOO=1 agy -p "prompt" --sandbox --output-format json
RC=$?
EXPECTED=$(printf '%s\n' --model gemini-3.8-flash-high -p prompt --sandbox --output-format json)
if [ "$RC" -eq 0 ] && [ "$(cat "$ARGS")" = "$EXPECTED" ]; then
  pass "env prefix skips to agy command"
else fail "env prefix to agy failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[21] codex exec under agy role is rejected with mismatch detail"
TMP=$(mktmp); make_fake_codex "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"; ERR="$TMP/stderr"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  codex exec p >/dev/null 2>"$ERR"
RC=$?
if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && \
   assert_fields "$STATUS" state exited exit_code 78 error model-role-conflicting-args cli agy && \
   grep -q "config says agy, command runs codex" "$ERR"; then
  pass "mismatch between agy config and codex command rejected with detail"
else fail "mismatch rejection failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[22] agy under codex role is rejected with mismatch detail"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"; ERR="$TMP/stderr"
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement -- \
  agy -p prompt >/dev/null 2>"$ERR"
RC=$?
if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && \
   assert_fields "$STATUS" state exited exit_code 78 error model-role-conflicting-args cli codex && \
   grep -q "config says codex, command runs agy" "$ERR"; then
  pass "mismatch between codex config and agy command rejected with detail"
else fail "reverse mismatch rejection failed (rc=$RC)"; fi
rm -rf "$TMP"

echo "[23] agy conflicting model and effort flags are rejected"
for conflict in model_space model_eq effort_space effort_eq; do
  TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
  mkdir -p "$TMP/.codex-paired"
  cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
  case "$conflict" in
    model_space) EXTRA=(--model gemini-1.5-pro) ;;
    model_eq) EXTRA=(--model=gemini-1.5-pro) ;;
    effort_space) EXTRA=(--effort low) ;;
    effort_eq) EXTRA=(--effort=low) ;;
  esac
  PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
    agy "${EXTRA[@]}" -p prompt >/dev/null 2>&1
  RC=$?
  if [ "$RC" -eq 78 ] && [ ! -e "$ARGS" ] && assert_fields "$STATUS" exit_code 78 error model-role-conflicting-args; then
    pass "agy $conflict conflict rejected"
  else fail "agy $conflict conflict was not rejected (rc=$RC)"; fi
  rm -rf "$TMP"
done

echo "[24] prompt text containing --model inside -p value is NOT a conflict"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  agy -p "Implement --model handling in agy and --effort too" --sandbox --output-format json >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ] && [ -e "$ARGS" ] && grep -q -- "--model" "$ARGS"; then
  pass "prompt text containing --model inside -p value is not a conflict"
else fail "prompt text inside -p value was misread as a conflict (rc=$RC)"; fi
rm -rf "$TMP"

echo "[25] agy conflict scan stops at option terminator --"
TMP=$(mktmp); make_fake_agy "$TMP"; STATUS="$TMP/status.json"; ARGS="$TMP/args"
mkdir -p "$TMP/.codex-paired"
cat > "$TMP/.codex-paired/project.json" <<'EOF'
{"version":1,"app":{"type":"library"},"live_verification":{"default":"skip","skip_reason":"test"},"models":{"implement":{"cli":"agy","model":"gemini-3.8-flash-high"}}}
EOF
PATH="$TMP/bin:$PATH" FAKE_ARGS_FILE="$ARGS" "$WRAPPER" "$STATUS" --model-role implement --repo-root "$TMP" -- \
  agy -p prompt --sandbox -- --model --effort >/dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ] && [ -e "$ARGS" ] && grep -qx -- '--' "$ARGS"; then
  pass "agy conflict scan stops at --"
else fail "agy conflict scan did not stop at -- (rc=$RC)"; fi
rm -rf "$TMP"

echo
echo "================================================================="
echo "$PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
