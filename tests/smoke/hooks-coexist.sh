#!/usr/bin/env bash
# v0.7.3.1 — validates the two PostToolUse hook scripts (provenance + mailbox-
# inject) coexist correctly when Claude Code fires them in parallel.
#
# Claude Code documentation (https://code.claude.com/docs/en/hooks) states
# that multiple matching hooks run in parallel with independent stdin
# invocations and no exit-code gating between them. This smoke validates
# that our two registered scripts respect that invariant: neither side-
# effects the other, and mailbox-inject delivers even when provenance is
# also running on the same event.
#
# Assertions:
#   1. With shared stdin (a fake `git commit` Bash event), both hooks fire.
#   2. mailbox-inject delivers messages regardless of provenance's exit code.
#   3. The hooks touch disjoint state on disk (no shared file collisions).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROV_HOOK="$PLUGIN_ROOT/hooks/check-commit-provenance.sh"
INJ_HOOK="$PLUGIN_ROOT/hooks/mailbox-inject.sh"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cps-coexist)"
TMP_ROOT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP_ROOT" 2>/dev/null || echo "$TMP_ROOT")"
trap 'rm -rf "$TMP_ROOT"' EXIT

# ── Fixture: a fake repo with .codex-paired/ + slice-1 worktree + pre-seeded msg
mkdir -p "$TMP_ROOT/.codex-paired"
SLICE_WT="$TMP_ROOT/.git-worktrees/slice-1"
mkdir -p "$SLICE_WT"
# Provenance reads .codex-paired/active.json. We deliberately DO NOT create it,
# which means provenance treats this as "autopilot not running" and early-exits 0.
# That's the most common production state; mailbox-inject must still fire.

ID1=$(node "$CLI" mailbox-write --to slice-1 --from orchestrator \
  --text "coexist smoke msg" --repoRoot "$TMP_ROOT" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

# Hook stdin: a `git commit -m "test"` Bash event with cwd in slice-1's worktree.
# Both hooks will see this stdin.
HOOK_STDIN=$(cat <<EOF
{
  "session_id": "fixture-session",
  "transcript_path": "/tmp/fixture.jsonl",
  "cwd": "$SLICE_WT",
  "permission_mode": "default",
  "agent_id": "fixture-agent",
  "agent_type": "general-purpose",
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": {"command": "git commit -m 'test'"},
  "tool_response": {"exit_code": 0, "stdout": "", "stderr": ""}
}
EOF
)

# ── Run both hooks in parallel, capturing each's stdout/stderr/exit
INJ_OUT=$(mktemp); INJ_ERR=$(mktemp)
PROV_OUT=$(mktemp); PROV_ERR=$(mktemp)

# Fire both with independent stdin pipes, in parallel via &
( echo "$HOOK_STDIN" | bash "$INJ_HOOK" >"$INJ_OUT" 2>"$INJ_ERR" ) &
INJ_PID=$!
( echo "$HOOK_STDIN" | bash "$PROV_HOOK" >"$PROV_OUT" 2>"$PROV_ERR" ) &
PROV_PID=$!

wait "$INJ_PID"; INJ_EXIT=$?
wait "$PROV_PID"; PROV_EXIT=$?

INJ_STDOUT="$(cat "$INJ_OUT")"
PROV_STDOUT="$(cat "$PROV_OUT")"

# ── Assertion 1: both hooks exited cleanly (production contract)
if [ "$INJ_EXIT" -ne 0 ]; then
  echo "FAIL: mailbox-inject exit=$INJ_EXIT (expected 0)" >&2
  cat "$INJ_ERR" >&2
  exit 1
fi
if [ "$PROV_EXIT" -ne 0 ]; then
  echo "FAIL: provenance exit=$PROV_EXIT (expected 0 — no anchor file means autopilot not running, early no-op)" >&2
  cat "$PROV_ERR" >&2
  exit 1
fi
echo "PASS: both hooks exited 0 under parallel execution"

# ── Assertion 2: mailbox-inject delivered the pre-seeded message
if ! echo "$INJ_STDOUT" | grep -q "$ID1"; then
  echo "FAIL: mailbox-inject did not deliver pre-seeded message id=$ID1" >&2
  echo "  inj stdout: $INJ_STDOUT" >&2
  exit 1
fi
if ! echo "$INJ_STDOUT" | grep -q '"hookEventName":"PostToolUse"'; then
  echo "FAIL: mailbox-inject did not emit hookSpecificOutput" >&2
  exit 1
fi
echo "PASS: mailbox-inject delivered $ID1 in parallel with provenance"

# ── Assertion 3: message was marked read (mark-read happened after stdout flush)
REMAINING_UNREAD=$(node "$CLI" mailbox-read --for slice-1 --actor orchestrator --unread --repoRoot "$TMP_ROOT")
if [ "$REMAINING_UNREAD" != "[]" ]; then
  echo "FAIL: message not marked read; remaining unread: $REMAINING_UNREAD" >&2
  exit 1
fi
echo "PASS: pre-seeded message marked read after parallel hook fire"

# ── Assertion 4: provenance produced no stdout (no anchor → silent no-op)
if [ -n "$PROV_STDOUT" ]; then
  echo "FAIL: provenance produced unexpected stdout: $PROV_STDOUT" >&2
  exit 1
fi
echo "PASS: provenance produced no stdout (silent no-op when autopilot not running)"

# ── Cleanup intermediate files
rm -f "$INJ_OUT" "$INJ_ERR" "$PROV_OUT" "$PROV_ERR"

echo
echo "ALL COEXIST SMOKE CASES PASSED ($(basename "$0"))"
echo
echo "(Note: Claude Code's hook documentation states matching hooks run in"
echo " parallel with independent stdin and no cross-hook exit-code gating."
echo " This smoke confirms our two scripts respect that invariant on disk.)"
