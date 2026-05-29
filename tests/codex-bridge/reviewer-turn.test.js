// Plan 3 (reviewer naming migration) — reviewer-turn canonical module.
//
// Smoke + one-window-compat + the round-3 mailbox-contract finding: a reviewer-*
// peer DM must be accepted by BOTH PEER_RECIPIENT_RE (turn module) and
// RECIPIENT_RE (mailbox) so reviewer peer DMs are not recorded as invalid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runTurnWithDeps,
  assembleSpawnPrompt,
  runTurn,
} from '../../lib/codex-bridge/reviewer-turn.js';
import * as expertShim from '../../lib/codex-bridge/expert-turn.js';
import { initSidecar } from '../../lib/codex-bridge/sidecar.js';
import { readUnreadMessages } from '../../lib/codex-bridge/mailbox.js';

test('reviewer-turn exposes the canonical API', () => {
  assert.equal(typeof runTurnWithDeps, 'function');
  assert.equal(typeof assembleSpawnPrompt, 'function');
  assert.equal(typeof runTurn, 'function');
});

test('expert-turn shim re-exports the identical reviewer-turn references', () => {
  assert.equal(expertShim.runTurnWithDeps, runTurnWithDeps);
  assert.equal(expertShim.assembleSpawnPrompt, assembleSpawnPrompt);
  assert.equal(expertShim.runTurn, runTurn);
});

function validMachineResult(reviewerId, peerTargets = []) {
  return [
    '## Machine Result',
    '```json',
    JSON.stringify({
      expert_id: reviewerId,
      phase: 'spec-review',
      status: 'SHIP',
      scope: 'roundtrip',
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: peerTargets.map((t) => ({
        to: t,
        body: `from ${reviewerId}: please review the auth flow`,
        summary: 'auth-flow followup',
      })),
      questions_for_orchestrator: [],
    }),
    '```',
  ].join('\n');
}

test('reviewer peer DM to a reviewer-* recipient enqueues + lands in the inbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cps-reviewer-turn-rt-'));
  try {
    const specDir = join(root, 'docs', 'specs');
    mkdirSync(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    writeFileSync(specPath, '# spec\n\nReviewer peer-DM round-trip.');
    initSidecar(specPath, {
      feature: 'reviewer-rt',
      codexSession: 's',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    });

    const promptDir = join(root, '.codex-paired', 'role-prompts');
    mkdirSync(promptDir, { recursive: true });
    const promptArch = join(promptDir, 'reviewer-architecture.md');
    writeFileSync(promptArch, '---\nversion: v1\nrole_id: reviewer-architecture\n---\nYou are reviewer-architecture.');

    const senderResult = await runTurnWithDeps(
      {
        identity: {
          id: 'reviewer-architecture',
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
          validMachineResult('reviewer-architecture', ['reviewer-ui']),
        readUnreadMessages: async () => [],
        writeBreadcrumb: async () => {},
      }
    );
    assert.ok(senderResult.ok, `sender turn must succeed; got ${JSON.stringify(senderResult)}`);
    // No enqueue failures — proves PEER_RECIPIENT_RE accepted reviewer-ui.
    assert.equal(senderResult.peer_dm_summary.failed, 0, JSON.stringify(senderResult.peer_dm_summary));
    assert.equal(senderResult.peer_dm_summary.enqueued, 1);

    // The DM is actually on disk — proves mailbox RECIPIENT_RE accepted reviewer-ui.
    const inbox = await readUnreadMessages(root, 'reviewer-ui');
    assert.equal(inbox.length, 1, `expected 1 unread for reviewer-ui; got ${inbox.length}`);
    assert.equal(inbox[0].from, 'reviewer-architecture');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
