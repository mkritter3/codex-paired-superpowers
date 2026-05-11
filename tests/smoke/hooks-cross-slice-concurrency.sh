#!/usr/bin/env bash
# v0.7.3.1 — cross-slice hook-process concurrency smoke.
#
# Validates that two Sonnet subagents running in parallel (each in its own
# worktree, each with pending mailbox messages) can fire the PostToolUse
# `mailbox-inject` hook simultaneously without:
#   (a) corrupting each other's inbox
#   (b) cross-delivering messages to the wrong slice
#   (c) deadlocking on the lockfile
#
# This complements the unit-level concurrent-write tests (which cover one
# Node process and one mailbox file). The cross-process invariant relies on
# proper-lockfile's stale/retry contract working across separate node
# invocations against DIFFERENT inbox files.
#
# Stress: N parallel hook fires across N slices.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/mailbox-inject.sh"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cps-xslice)"
TMP_ROOT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP_ROOT" 2>/dev/null || echo "$TMP_ROOT")"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/.codex-paired"

N=5  # number of parallel slices
declare -a SLICE_IDS=()
declare -a SLICE_WTS=()
declare -a EXPECTED_IDS=()

# ── Setup: N slices, each with 2 pre-seeded messages
for i in $(seq 1 "$N"); do
  SLICE_ID="slice-$i"
  SLICE_WT="$TMP_ROOT/.git-worktrees/$SLICE_ID"
  mkdir -p "$SLICE_WT"
  SLICE_IDS+=("$SLICE_ID")
  SLICE_WTS+=("$SLICE_WT")

  ID_A=$(node "$CLI" mailbox-write --to "$SLICE_ID" --from orchestrator \
    --text "cross-slice smoke msg A for $SLICE_ID" --repoRoot "$TMP_ROOT" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
  ID_B=$(node "$CLI" mailbox-write --to "$SLICE_ID" --from orchestrator \
    --text "cross-slice smoke msg B for $SLICE_ID" --repoRoot "$TMP_ROOT" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
  EXPECTED_IDS+=("$ID_A,$ID_B")
done

echo "Set up $N slices with 2 messages each."

# Per-slice fixture stdin
mkfixture() {
  local cwd="$1"
  printf '{"session_id":"s","transcript_path":"/tmp/t","cwd":"%s","permission_mode":"default","agent_id":"a","agent_type":"general-purpose","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo"},"tool_response":{"exit_code":0,"stdout":"","stderr":""}}' "$cwd"
}

# ── Stage: fire all N hooks in parallel, capture each's stdout
declare -a OUT_FILES=()
declare -a PIDS=()
T_START=$(node -e 'console.log(Date.now())')
for i in $(seq 0 $((N - 1))); do
  OUT=$(mktemp); OUT_FILES+=("$OUT")
  ( mkfixture "${SLICE_WTS[$i]}" | bash "$HOOK" > "$OUT" 2>/dev/null ) &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do
  wait "$pid" || { echo "FAIL: hook process $pid exited non-zero" >&2; exit 1; }
done
T_END=$(node -e 'console.log(Date.now())')
echo "PASS: all $N hook processes exited 0 (took $((T_END - T_START))ms wall-clock)"

# ── Assertion 1: each slice received ONLY its own messages
for i in $(seq 0 $((N - 1))); do
  SLICE_ID="${SLICE_IDS[$i]}"
  EXPECTED="${EXPECTED_IDS[$i]}"
  OUT_CONTENT=$(cat "${OUT_FILES[$i]}")
  for ID in ${EXPECTED//,/ }; do
    if ! echo "$OUT_CONTENT" | grep -q "$ID"; then
      echo "FAIL: $SLICE_ID output missing expected id=$ID" >&2
      echo "  out: $OUT_CONTENT" >&2
      exit 1
    fi
  done
  # And confirm no cross-talk: this slice's output must not mention any
  # other slice's message ids.
  for j in $(seq 0 $((N - 1))); do
    if [ "$j" = "$i" ]; then continue; fi
    OTHER_IDS="${EXPECTED_IDS[$j]}"
    for ID in ${OTHER_IDS//,/ }; do
      if echo "$OUT_CONTENT" | grep -q "$ID"; then
        echo "FAIL: $SLICE_ID output contains $ID from slice-$((j+1)) — CROSS-TALK" >&2
        exit 1
      fi
    done
  done
done
echo "PASS: each slice delivered ONLY its own messages (no cross-talk across $N slices)"

# ── Assertion 2: every message is now marked read in its own inbox
for SLICE_ID in "${SLICE_IDS[@]}"; do
  UNREAD=$(node "$CLI" mailbox-read --for "$SLICE_ID" --actor orchestrator --unread --repoRoot "$TMP_ROOT")
  if [ "$UNREAD" != "[]" ]; then
    echo "FAIL: $SLICE_ID has unread after parallel hook fire: $UNREAD" >&2
    exit 1
  fi
done
echo "PASS: all $N inboxes empty of unread after concurrent hook fire"

# ── Assertion 3: no breadcrumb errors (no lock-contention or read failures)
DIAG="$TMP_ROOT/.codex-paired/diagnostics/hook-failures.jsonl"
if [ -f "$DIAG" ] && [ -s "$DIAG" ]; then
  echo "FAIL: breadcrumb file unexpectedly contains entries — concurrent hooks hit a failure path:" >&2
  cat "$DIAG" >&2
  exit 1
fi
echo "PASS: no breadcrumb entries written (no lock-contention failures)"

# ── Stress phase: fire 3 hooks against the SAME slice in parallel.
#
# Spec §5.4 explicitly accepts duplicate delivery as a non-bug
# ("Message stays unread → duplicate-delivered next fire. Acceptable.").
# The hook's read → emit → mark-read sequence releases the lockfile
# between read and mark, so racing hook fires can each read the same
# unread message before any of them commit mark-read. Idempotent
# markManyAsRead means only one read_at transition occurs, but multiple
# hooks may have already emitted by then.
#
# Production architecture mostly precludes this race: each slice runs in
# its own worktree with one subagent at a time, so same-slice concurrent
# hook fires require an orchestrator misuse pattern (re-dispatching a slice
# while the previous is still in-flight). The cross-slice case (the common
# one, tested above with N=5) is race-free because each slice has its own
# inbox file.
#
# Assertions for the same-slice race:
#   - At least one hook delivers (no message loss)
#   - No inbox corruption: final state is exactly "marked read once"
#   - All hooks exit 0 (no deadlock or breadcrumb)
SAME_SLICE_WT="${SLICE_WTS[0]}"
SAME_SLICE_ID="${SLICE_IDS[0]}"
# Pre-seed a new message to slice-1 (its inbox is currently empty after step 2)
ID_NEW=$(node "$CLI" mailbox-write --to "$SAME_SLICE_ID" --from orchestrator \
  --text "stress msg" --repoRoot "$TMP_ROOT" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

declare -a STRESS_OUTS=()
declare -a STRESS_PIDS=()
for i in 1 2 3; do
  OUT=$(mktemp); STRESS_OUTS+=("$OUT")
  ( mkfixture "$SAME_SLICE_WT" | bash "$HOOK" > "$OUT" 2>/dev/null ) &
  STRESS_PIDS+=($!)
done
for pid in "${STRESS_PIDS[@]}"; do
  wait "$pid" || { echo "FAIL: stress hook $pid exited non-zero" >&2; exit 1; }
done

# At least one delivery (no message loss).
DELIVERED_COUNT=0
for OUT in "${STRESS_OUTS[@]}"; do
  if grep -q "$ID_NEW" "$OUT" 2>/dev/null; then
    DELIVERED_COUNT=$((DELIVERED_COUNT + 1))
  fi
done

if [ "$DELIVERED_COUNT" -lt 1 ]; then
  echo "FAIL: same-slice concurrent hooks delivered $DELIVERED_COUNT times (expected at least 1, no message loss)" >&2
  exit 1
fi
echo "PASS: same-slice concurrent hooks: $DELIVERED_COUNT of 3 delivered (>=1 required; spec §5.4 accepts duplicate as non-bug)"

# Final inbox state: every message is now marked read; no unread, no
# duplicate-msg-id corruption. (The inbox accumulates the prior phase's
# msgs + this phase's new msg; we don't assert a specific count, just
# that all messages have non-null read_at and there is no unread.)
NEW_MSG_READ=$(node "$CLI" mailbox-read --for "$SAME_SLICE_ID" --actor orchestrator --repoRoot "$TMP_ROOT" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d).find(x=>x.id==='$ID_NEW');process.stdout.write(m?(m.read_at!==null?'yes':'no'):'missing');})")
if [ "$NEW_MSG_READ" != "yes" ]; then
  echo "FAIL: new msg's read_at state after same-slice race: $NEW_MSG_READ (expected 'yes')" >&2
  exit 1
fi
UNREAD_AFTER=$(node "$CLI" mailbox-read --for "$SAME_SLICE_ID" --actor orchestrator --unread --repoRoot "$TMP_ROOT")
if [ "$UNREAD_AFTER" != "[]" ]; then
  echo "FAIL: unread left after same-slice race: $UNREAD_AFTER" >&2
  exit 1
fi
echo "PASS: same-slice race inbox state intact (new msg marked read, no unread; idempotent markManyAsRead held the line)"

# ── Cleanup intermediate files
for f in "${OUT_FILES[@]}" "${STRESS_OUTS[@]}"; do rm -f "$f"; done

echo
echo "ALL CROSS-SLICE CONCURRENCY ASSERTIONS PASSED ($(basename "$0"))"
