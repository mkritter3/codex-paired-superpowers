#!/usr/bin/env bash
# v0.7.3.1 RELEASE-BLOCKING live verification scaffolding.
#
# This script sets up the fixture and prints the steps the maintainer must
# perform inside a real Claude Code session. It cannot run the verification
# end-to-end on its own — the load-bearing claim is that the PostToolUse
# `mailbox-inject` hook fires INSIDE Task-tool subagents and `cwd` reflects
# the subagent's working directory, which only a real Claude Code runtime
# can demonstrate.
#
# Usage:
#   1. Run this script. It will:
#      - create a temp repo with .codex-paired/ and .git-worktrees/slice-99/
#      - seed 2 messages into slice-99's mailbox via the production CLI
#      - print the Task tool invocation you must issue from a Claude Code
#        session (subagent prompt + cwd parameter)
#      - print the post-dispatch assertion commands
#   2. Open Claude Code in the printed worktree directory.
#   3. Run the printed Task tool invocation. Observe the subagent's
#      transcript.
#   4. Run the post-dispatch assertion commands.
#   5. Record the result + transcript excerpt in
#      `docs/verification/v0.7.3.1-hook-fires.md`.
#
# Release gate: v0.7.3.1 ships only when steps 3-5 pass.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cps-hook-live)"
TMP_ROOT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP_ROOT" 2>/dev/null || echo "$TMP_ROOT")"

mkdir -p "$TMP_ROOT/.codex-paired"
SLICE_WT="$TMP_ROOT/.git-worktrees/slice-99"
mkdir -p "$SLICE_WT"

# Initialize as a fake git worktree (Task subagent cwd should still resolve;
# Claude Code does not require a real git repo to dispatch).
( cd "$TMP_ROOT" && git init -q && git commit --allow-empty -q -m "init" 2>/dev/null || true )

# Seed 2 messages for slice-99 via production CLI.
ID1=$(node "$CLI" mailbox-write --to slice-99 --from orchestrator \
  --text "v0.7.3.1 release-gate test message ONE" \
  --repoRoot "$TMP_ROOT" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")
ID2=$(node "$CLI" mailbox-write --to slice-99 --from orchestrator \
  --text "v0.7.3.1 release-gate test message TWO" \
  --repoRoot "$TMP_ROOT" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id))")

cat <<EOF

═══════════════════════════════════════════════════════════════════
v0.7.3.1 HOOK-FIRES-IN-TASK-SUBAGENT LIVE VERIFICATION
═══════════════════════════════════════════════════════════════════

Fixture set up at:
  REPO_ROOT:    $TMP_ROOT
  WORKTREE:     $SLICE_WT
  PRE-SEEDED:   $ID1
                $ID2

Both messages currently UNREAD in slice-99's inbox.

──────────────────────────────────────────────────────────────────
STEP 1 — In a Claude Code session loaded with this plugin, issue
this Task tool call. The cwd parameter is LOAD-BEARING — prose
asking the subagent to "cd" into the worktree is NOT a substitute;
production dispatch passes cwd via the Task parameter and the hook
stdin reflects that value (not the orchestrator's cwd).
──────────────────────────────────────────────────────────────────

Use the Task tool with EXACTLY these parameters:
  subagent_type: slice-implementer-sonnet  (preferred — production type)
                 OR: general-purpose       (acceptable fallback if your
                                            session lacks the plugin's
                                            subagent definition; both
                                            exercise the same hook
                                            plumbing)
  cwd: $SLICE_WT
  prompt: |
    Run this single Bash command and report what you see:
    \`echo "verify"\`.
    After running it, repeat back EXACTLY any text you see in the
    surrounding context that starts with "<codex-paired-pending-messages".
    Then end your response.

Notes:
  - DO NOT include "cd $SLICE_WT" in the prompt — the Task cwd
    parameter is what gates the hook stdin cwd. A prose "cd" would
    only affect the subagent's bash subshell, not the hook's view.
  - If your local Task tool surface does not expose a cwd parameter
    (some Claude Code versions may not), record that limitation in
    the verification doc and treat the result as inconclusive
    rather than a pass/fail.

The subagent's transcript MUST contain a system-injected block of the form:
  <codex-paired-pending-messages recipient="slice-99">
    <pending-message id="$ID1" ...>
    <pending-message id="$ID2" ...>
  </codex-paired-pending-messages>

──────────────────────────────────────────────────────────────────
STEP 2 — After the subagent completes, run these assertion commands:
──────────────────────────────────────────────────────────────────

# Assert: messages are now marked read in the mailbox
node "$CLI" mailbox-read --for slice-99 --actor orchestrator --unread --repoRoot "$TMP_ROOT"
  # Expected output: []

node "$CLI" mailbox-read --for slice-99 --actor orchestrator --repoRoot "$TMP_ROOT"
  # Expected output: array with 2 entries, both with non-null read_at

──────────────────────────────────────────────────────────────────
STEP 3 — Dispatch a SECOND Task subagent with the same cwd ($SLICE_WT)
and a trivial Bash command. The transcript MUST NOT contain a
<codex-paired-pending-messages> block (already-read → no re-delivery).
──────────────────────────────────────────────────────────────────

──────────────────────────────────────────────────────────────────
STEP 4 — Record the result:
──────────────────────────────────────────────────────────────────

Save the transcript excerpt (just the relevant injected-context portion
+ the surrounding system-reminder framing) to:
  $PLUGIN_ROOT/docs/verification/v0.7.3.1-hook-fires.md

Update the verification status section to PASS or FAIL with date + notes.

──────────────────────────────────────────────────────────────────
CLEANUP — after recording results:
──────────────────────────────────────────────────────────────────

rm -rf "$TMP_ROOT"

═══════════════════════════════════════════════════════════════════
RELEASE GATE: v0.7.3.1 ships only when steps 1-3 pass.
If hook does NOT fire inside Task subagents:
  - Revert §5 hook architecture entirely
  - Ship pre-injection (§4 + sidecar) only as v0.7.3.1
  - Document the hook approach as a v0.7.3.2 R&D item
═══════════════════════════════════════════════════════════════════
EOF
