#!/usr/bin/env bash
# v0.8.0 RELEASE-GATE smoke — end-to-end domain-experts runtime verification.
#
# Exercises every load-bearing piece of the runTurn pipeline EXCEPT the
# Agent-tool dispatch itself (which Claude Code does not expose via Node
# API in current versions). Agent dispatch is mocked via the DI seam
# (deps.agentDispatch) returning a canned valid `## Machine Result` block —
# letting us verify the rest of the pipeline end-to-end:
#   1. Mailbox identity (slice 1 RECIPIENT_RE accepts expert-*).
#   2. Identity resolution (slice 2 resolveIdentity via builtin prompts).
#   3. Spawn-prompt assembly (slice 4 assembleSpawnPrompt embedding system
#      rubric + expert prompt + unread messages + spec snippet + sidecar
#      participant state + Machine Result schema).
#   4. Output parsing (slice 3 parseExpertOutput).
#   5. Mark-read after parse success (slice 1+4 mailbox + runTurn ordering).
#   6. Sidecar turn append with mailbox_message_ids_injected populated
#      (slice 4 appendExpertTurn with the correct field name).
#
# Agent-tool dispatch is a documented external dependency. The companion
# manual procedure in docs/verification/v0.8.0-domain-experts.md exercises
# the live Agent path inside a Claude Code session.
set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$PLUGIN_ROOT/lib/codex-bridge/cli.js"

TMP_ROOT="$(mktemp -d 2>/dev/null || mktemp -d -t cps-v080-e2e)"
TMP_ROOT="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP_ROOT" 2>/dev/null || echo "$TMP_ROOT")"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/.codex-paired"
SPEC_PATH="$TMP_ROOT/spec.md"
printf '# Test spec\n\nTEST_SPEC_SNIPPET_CONTENT\n' > "$SPEC_PATH"

node "$CLI" sidecar-init --specPath "$SPEC_PATH" --feature "v0.8.0-e2e-smoke" --threadId "smoke-fixture-thread-id" >/dev/null

ID1=$(node "$CLI" mailbox-write --to expert-ui --from orchestrator --text "RELEASE GATE: review the state-boundary for the visual editor" --repoRoot "$TMP_ROOT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
ID2=$(node "$CLI" mailbox-write --to expert-ui --from expert-ux --text "RELEASE GATE: peer concern about review-panel workflow" --repoRoot "$TMP_ROOT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

[ -z "$ID1" ] || [ -z "$ID2" ] && { echo "FAIL: could not seed messages" >&2; exit 1; }

ENTRY="$TMP_ROOT/run-expert-turn.mjs"
cat > "$ENTRY" << ENTRY_EOF
import { resolveIdentity } from '$PLUGIN_ROOT/lib/codex-bridge/expert-resolver.js';
import { runTurnWithDeps } from '$PLUGIN_ROOT/lib/codex-bridge/expert-turn.js';
import { readUnreadMessages } from '$PLUGIN_ROOT/lib/codex-bridge/mailbox.js';
import { loadSidecar } from '$PLUGIN_ROOT/lib/codex-bridge/sidecar.js';

const REPO_ROOT = '$TMP_ROOT';
const SPEC_PATH = '$SPEC_PATH';
const ID1 = '$ID1';
const ID2 = '$ID2';

const identity = resolveIdentity('ui', REPO_ROOT);

const cannedMachineResult = [
  '## Findings',
  '',
  'Free-form findings.',
  '',
  '## Machine Result',
  '',
  '\`\`\`json',
  JSON.stringify({
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'REVISE',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [
      { id: 'ui-1', summary: 'State-boundary unclear', location: 'spec.md', recommendation: 'Add ownership note' },
    ],
    peer_messages_sent: [],
    questions_for_orchestrator: [],
  }, null, 2),
  '\`\`\`',
].join('\\n');

let dispatchCalls = 0;
const mockAgentDispatch = async (prompt, ident, phase) => {
  dispatchCalls++;
  if (!prompt.includes('L11 Engineering Partner')) throw new Error('FAIL: prompt missing L11 rubric');
  if (!prompt.includes('RELEASE GATE: review the state-boundary')) throw new Error('FAIL: prompt missing msg1 body');
  if (!prompt.includes('RELEASE GATE: peer concern about review-panel')) throw new Error('FAIL: prompt missing msg2 body');
  if (!prompt.includes('TEST_SPEC_SNIPPET_CONTENT')) throw new Error('FAIL: prompt missing spec snippet');
  if (!prompt.includes(ident.id)) throw new Error('FAIL: prompt missing expert identity');
  return cannedMachineResult;
};

const result = await runTurnWithDeps(
  {
    identity, repoRoot: REPO_ROOT, specPath: SPEC_PATH,
    specSnippet: 'TEST_SPEC_SNIPPET_CONTENT', phase: 'spec-review',
    sliceId: null, sidecarParticipantState: 'first turn',
    task: 'Release-gate smoke',
  },
  { agentDispatch: mockAgentDispatch }
);

if (!result.ok) { console.error('FAIL: runTurn ok=false', JSON.stringify(result)); process.exit(1); }
if (dispatchCalls !== 1) { console.error('FAIL: dispatchCalls=' + dispatchCalls); process.exit(1); }

const stillUnread = await readUnreadMessages(REPO_ROOT, identity.id);
if (stillUnread.length !== 0) { console.error('FAIL: unread after runTurn=' + stillUnread.length); process.exit(1); }

const sc = loadSidecar(SPEC_PATH);
const turns = sc.expert_teammates?.turns || [];
if (turns.length !== 1) { console.error('FAIL: turns=' + turns.length); process.exit(1); }
const turn = turns[0];
if (turn.expert_id !== 'expert-ui') { console.error('FAIL: expert_id=' + turn.expert_id); process.exit(1); }
if (turn.verdict !== 'REVISE') { console.error('FAIL: verdict=' + turn.verdict); process.exit(1); }
if (turn.failure_reason !== null) { console.error('FAIL: failure_reason=' + turn.failure_reason); process.exit(1); }
const injected = turn.mailbox_message_ids_injected;
if (!Array.isArray(injected) || injected.length !== 2) { console.error('FAIL: injected=' + JSON.stringify(injected)); process.exit(1); }
if (!injected.includes(ID1) || !injected.includes(ID2)) { console.error('FAIL: missing seeded ids in injected=' + JSON.stringify(injected)); process.exit(1); }

console.log('PASS: runTurn end-to-end (mailbox read → spawn prompt → mocked Agent → parse → mark read → sidecar turn append)');
console.log('  dispatchCalls=' + dispatchCalls);
console.log('  stillUnread=' + stillUnread.length);
console.log('  turn.verdict=' + turn.verdict);
console.log('  turn.mailbox_message_ids_injected=' + JSON.stringify(injected));
ENTRY_EOF

echo "v0.8.0 domain-experts end-to-end smoke"
echo "Fixture: $TMP_ROOT  ID1=$ID1  ID2=$ID2"
echo ""
if ! node "$ENTRY"; then
  echo "FAIL: domain-experts end-to-end smoke failed" >&2
  exit 1
fi
echo ""
echo "DOMAIN-EXPERTS END-TO-END SMOKE PASSED"
echo ""
echo "(Live Agent dispatch is a separate manual procedure per"
echo " docs/verification/v0.8.0-domain-experts.md.)"
