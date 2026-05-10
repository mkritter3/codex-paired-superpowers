#!/usr/bin/env bash
# v0.7.3.1 smoke — exercises the PostToolUse mailbox-inject hook end-to-end
# via the bash wrapper. Proves that:
#   1. The wrapper invokes the Node module with stdin passed through.
#   2. The Node module reads slice-1's mailbox and emits hookSpecificOutput.
#   3. Messages are marked read after the stdout flush.
#   4. A second hook fire in the same worktree finds no unread (idempotent).
#   5. Cases that should be no-ops (no agent_id, cwd not in worktree) emit
#      nothing.
#
# Real production wrapper (no env-var instrumentation): identity flows through
# stdin's `cwd` + `agent_id` per spec §5.1.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/mailbox-inject.sh"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

# macOS mktemp signature differs from GNU; this works on both
TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cps-hook-smoke)"
TMP_ROOT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP_ROOT" 2>/dev/null || echo "$TMP_ROOT")"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/.codex-paired"
SLICE_WT="$TMP_ROOT/.git-worktrees/slice-1"
mkdir -p "$SLICE_WT"

# Seed 2 messages for slice-1 via the production CLI.
ID1=$(node "$CLI" mailbox-write --to slice-1 --from orchestrator --text "first message" --repoRoot "$TMP_ROOT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
ID2=$(node "$CLI" mailbox-write --to slice-1 --from orchestrator --text "second message" --repoRoot "$TMP_ROOT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

if [ -z "$ID1" ] || [ -z "$ID2" ]; then
  echo "FAIL: could not seed messages" >&2
  exit 1
fi

mkfixture() {
  local cwd="$1"
  local agent_id="${2-fixture-agent}"
  if [ -z "$agent_id" ]; then
    printf '{"session_id":"s","transcript_path":"/tmp/t","cwd":"%s","permission_mode":"default","agent_type":"general-purpose","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo"},"tool_response":{"exit_code":0,"stdout":"","stderr":""}}' "$cwd"
  else
    printf '{"session_id":"s","transcript_path":"/tmp/t","cwd":"%s","permission_mode":"default","agent_id":"%s","agent_type":"general-purpose","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"echo"},"tool_response":{"exit_code":0,"stdout":"","stderr":""}}' "$cwd" "$agent_id"
  fi
}

# Case 1: happy path
OUT=$(mkfixture "$SLICE_WT" | "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then
  echo "FAIL case 1: hook produced no stdout" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q "$ID1"; then
  echo "FAIL case 1: hook output missing id1=$ID1" >&2
  echo "  out: $OUT" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q "$ID2"; then
  echo "FAIL case 1: hook output missing id2=$ID2" >&2
  exit 1
fi
if ! echo "$OUT" | grep -q '"hookEventName":"PostToolUse"'; then
  echo "FAIL case 1: hook output missing hookEventName" >&2
  exit 1
fi
echo "PASS case 1: happy path (both ids in additionalContext)"

# Verify messages now marked read
REMAINING=$(node "$CLI" mailbox-read --for slice-1 --actor slice-1 --unread --repoRoot "$TMP_ROOT")
if [ "$REMAINING" != "[]" ]; then
  echo "FAIL case 1 cleanup: expected no unread after hook fire; got $REMAINING" >&2
  exit 1
fi
echo "PASS case 1: messages marked read"

# Case 2: second fire in same worktree - already read - no output
OUT2=$(mkfixture "$SLICE_WT" | "$HOOK" 2>/dev/null || true)
if [ -n "$OUT2" ]; then
  echo "FAIL case 2: expected no output on second fire; got: $OUT2" >&2
  exit 1
fi
echo "PASS case 2: second fire is a no-op"

# Case 3: no agent_id (main-thread fire)
OUT3=$(mkfixture "$SLICE_WT" "" | "$HOOK" 2>/dev/null || true)
if [ -n "$OUT3" ]; then
  echo "FAIL case 3: expected no output without agent_id; got: $OUT3" >&2
  exit 1
fi
echo "PASS case 3: no agent_id is a no-op"

# Case 4: cwd outside worktree
OUT4=$(mkfixture "$TMP_ROOT/elsewhere" | "$HOOK" 2>/dev/null || true)
if [ -n "$OUT4" ]; then
  echo "FAIL case 4: expected no output for non-worktree cwd; got: $OUT4" >&2
  exit 1
fi
echo "PASS case 4: cwd outside worktree is a no-op"

# Case 5: malformed stdin (non-JSON)
OUT5=$(echo "not json at all" | "$HOOK" 2>/dev/null || true)
if [ -n "$OUT5" ]; then
  echo "FAIL case 5: expected no output for malformed stdin; got: $OUT5" >&2
  exit 1
fi
echo "PASS case 5: malformed stdin is a no-op"

# Case 6: re-seed and verify delivery again in a fresh slice context
ID3=$(node "$CLI" mailbox-write --to slice-1 --from orchestrator --text "third message" --repoRoot "$TMP_ROOT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
OUT6=$(mkfixture "$SLICE_WT" | "$HOOK" 2>/dev/null || true)
if ! echo "$OUT6" | grep -q "$ID3"; then
  echo "FAIL case 6: third delivery failed" >&2
  exit 1
fi
echo "PASS case 6: re-delivery of newly-arrived message"

echo
echo "ALL SMOKE CASES PASSED ($(basename "$0"))"
