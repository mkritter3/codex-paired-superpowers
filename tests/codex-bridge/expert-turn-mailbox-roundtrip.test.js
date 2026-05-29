// v0.9.1 hardening — real mailbox disk round-trip across adapters.
//
// The populate-gate-sidecar harness fakes the receiver's inbox via injected
// readUnreadMessages. That doesn't exercise the actual cross-process file
// round-trip. This test uses the REAL mailbox functions: sender's
// runTurnWithDeps writes peer DMs via writeToMailbox; receiver's
// runTurnWithDeps reads via readUnreadMessages from the real inbox file.
//
// The sender + receiver run under DIFFERENT adapters (cli-harness:codex vs
// claude-task) so this also pins the cross-adapter delivery contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTurnWithDeps } from '../../lib/codex-bridge/expert-turn.js';
import {
  initSidecar,
  loadSidecar,
} from '../../lib/codex-bridge/sidecar.js';
import {
  writeToMailbox,
  readUnreadMessages,
  markManyAsRead,
} from '../../lib/codex-bridge/mailbox.js';

function setupHarness() {
  const root = mkdtempSync(join(tmpdir(), 'cps-mailbox-rt-'));
  const specDir = join(root, 'docs', 'specs');
  mkdirSync(specDir, { recursive: true });
  const specPath = join(specDir, 'spec.md');
  writeFileSync(specPath, '# spec\n\nA tiny spec for the mailbox round-trip test.');
  initSidecar(specPath, {
    feature: 'mailbox-rt',
    codexSession: 's',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });

  // Role-prompt files (frontmatter required so runTurnWithDeps's
  // readRolePromptAudit succeeds).
  const promptDir = join(root, '.codex-paired', 'role-prompts');
  mkdirSync(promptDir, { recursive: true });
  function makePrompt(id) {
    const p = join(promptDir, `${id}.md`);
    writeFileSync(p, `---\nversion: v0.9.1-rt\nrole_id: ${id}\n---\nYou are ${id}.`);
    return p;
  }
  return {
    root,
    specPath,
    promptArch: makePrompt('expert-architecture'),
    promptUI: makePrompt('expert-ui'),
  };
}

function validMachineResult(expertId, peerTargets = []) {
  return [
    '## Findings',
    'Looks OK.',
    '',
    '## Machine Result',
    '```json',
    JSON.stringify({
      expert_id: expertId,
      phase: 'spec-review',
      status: 'SHIP',
      scope: 'roundtrip',
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: peerTargets.map((t) => ({
        to: t,
        body: `from ${expertId}: please review the auth flow assumptions`,
        summary: 'auth-flow followup',
      })),
      questions_for_orchestrator: [],
    }),
    '```',
  ].join('\n');
}

test('real mailbox round-trip: sender DM lands in recipient inbox; receiver reads + sidecar records it', async () => {
  const { root, specPath, promptArch, promptUI } = setupHarness();
  try {
    // ── Sender turn: expert-architecture@cli-harness:codex enqueues a DM
    // to expert-ui via the REAL writeToMailbox (no injected mailbox here).
    const senderResult = await runTurnWithDeps(
      {
        identity: {
          id: 'expert-architecture',
          role: 'architecture',
          promptPath: promptArch,
          source: 'builtin',
        },
        repoRoot: root,
        specPath,
        specSnippet: '# spec',
        phase: 'spec-review',
        sliceId: null,
        adapter: 'cli-harness:codex',
        sidecarParticipantState: '',
        task: 'Review the architecture',
        suppressPeerMessages: false,
      },
      {
        agentDispatch: async () =>
          validMachineResult('expert-architecture', ['expert-ui']),
        // Real writeToMailbox: do NOT inject this — let the production
        // path execute. readUnreadMessages is empty for the sender.
        readUnreadMessages: async () => [],
        markMessagesRead: async () => {},
        writeBreadcrumb: async () => {},
      },
    );
    assert.ok(senderResult.ok, `sender turn must succeed; got ${JSON.stringify(senderResult)}`);

    // ── Verify: the DM is actually on disk in the recipient's inbox.
    const inboxMsgs = await readUnreadMessages(root, 'expert-ui');
    assert.equal(inboxMsgs.length, 1, `expected exactly 1 unread message in expert-ui inbox; got ${inboxMsgs.length}`);
    const dm = inboxMsgs[0];
    assert.equal(dm.from, 'expert-architecture');
    // The mailbox stores the message body sent by writeToMailbox; the
    // expert-turn pipeline writes the body or summary.
    assert.ok(
      typeof dm.text === 'string' && dm.text.length > 0,
      `dm.text must be a non-empty string; got ${JSON.stringify(dm)}`
    );
    const dmId = dm.id;

    // ── Receiver turn: expert-ui@claude-task. This time we do NOT inject
    // readUnreadMessages — the production code path will read the real
    // inbox. The dispatcher should re-read after parse and the turn record
    // should reflect the injected message IDs.
    const receiverResult = await runTurnWithDeps(
      {
        identity: {
          id: 'expert-ui',
          role: 'ui',
          promptPath: promptUI,
          source: 'builtin',
        },
        repoRoot: root,
        specPath,
        specSnippet: '# spec',
        phase: 'spec-review',
        sliceId: null,
        adapter: 'claude-task',
        sidecarParticipantState: '',
        task: 'Review UX',
        suppressPeerMessages: false,
      },
      {
        agentDispatch: async () => validMachineResult('expert-ui', []),
        // Use the REAL readUnreadMessages — no inject. Same for
        // markMessagesRead (real production behavior on success).
        readUnreadMessages,
        markMessagesRead: markManyAsRead,
        writeBreadcrumb: async () => {},
      },
    );
    assert.ok(
      receiverResult.ok,
      `receiver turn must succeed; got ${JSON.stringify(receiverResult)}`
    );

    // ── Verify sidecar: receiver turn shows mailbox_message_ids[] referencing
    // the actual DM id from the sender's enqueued message.
    const sc = loadSidecar(specPath);
    const turns = sc.reviewer_teammates.turns;
    assert.equal(turns.length, 2, `expected 2 turns; got ${turns.length}`);
    const senderTurn = turns.find((t) => t.expert_id === 'expert-architecture');
    const receiverTurn = turns.find((t) => t.expert_id === 'expert-ui');
    assert.ok(senderTurn && receiverTurn, 'both sender + receiver turns must persist');

    // Sender turn: peer_messages_enqueued must reference the same dmId.
    assert.ok(
      Array.isArray(senderTurn.peer_messages_enqueued) &&
        senderTurn.peer_messages_enqueued.some((e) => e.message_id === dmId && e.to === 'expert-ui'),
      `sender turn must record the DM it sent (id=${dmId})`
    );

    // Receiver turn: mailbox_message_ids must include the DM id (post-read).
    assert.ok(
      Array.isArray(receiverTurn.mailbox_message_ids) &&
        receiverTurn.mailbox_message_ids.includes(dmId),
      `receiver turn must record the DM it consumed; mailbox_message_ids: ${JSON.stringify(receiverTurn.mailbox_message_ids)}`
    );

    // Cross-adapter contract: sender and receiver MUST have different adapters.
    assert.notEqual(
      senderTurn.adapter,
      receiverTurn.adapter,
      'cross-adapter round-trip: sender and receiver must run on different adapters'
    );

    // ── The DM should now be marked read on disk (markManyAsRead ran).
    const unreadAfter = await readUnreadMessages(root, 'expert-ui');
    assert.equal(
      unreadAfter.length,
      0,
      `after receiver turn, DM must be marked read; ${unreadAfter.length} still unread`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
