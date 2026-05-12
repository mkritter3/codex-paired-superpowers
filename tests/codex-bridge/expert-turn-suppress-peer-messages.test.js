// v0.9.0 slice 5b — `runTurnWithDeps({suppressPeerMessages: true})` tests.
//
// In panel mode (slice 6), `peer_messages_requested` MUST NOT be enqueued.
// Instead, each draft is recorded as `panel_peer_messages_suppressed`
// {to, body_hash, summary_hash?} for audit. Also: sidecar validator accepts
// the new field shape and rejects invalid shapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { runTurnWithDeps } from '../../lib/codex-bridge/expert-turn.js';
import { initSidecar, loadSidecar, appendExpertTurn } from '../../lib/codex-bridge/sidecar.js';

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'cps-suppress-'));
}

function makeSpec() {
  const dir = makeTmp();
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

function makeIdentity(dir) {
  const promptPath = join(dir, 'test-expert-ui.md');
  writeFileSync(promptPath, '<expert prompt body>');
  return { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
}

function validMachineResultWithPeers(peerMessages) {
  return `## Findings\nlooks fine.\n\n## Machine Result\n\`\`\`json\n${JSON.stringify({
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: peerMessages,
    questions_for_orchestrator: [],
  })}\n\`\`\`\n`;
}

function depsWithDispatch(dispatchOutput) {
  const calls = {
    writeToMailbox: [],
    appendTurn: [],
    markRead: [],
  };
  const deps = {
    readUnreadMessages: async () => [],
    markManyAsRead: async (root, id, ids) => {
      calls.markRead.push({ root, id, ids });
      return { marked: ids, skipped: [] };
    },
    writeToMailbox: async (root, recipient, message) => {
      calls.writeToMailbox.push({ root, recipient, message });
      return { id: 'msg-stub' };
    },
    parseExpertOutput: (raw) => {
      try {
        const m = raw.match(/```json\n([\s\S]+?)\n```/);
        return { ok: true, result: JSON.parse(m[1]) };
      } catch (e) {
        return { ok: false, reason: 'parse' };
      }
    },
    buildRepairPrompt: () => 'REPAIR',
    agentDispatch: async () => dispatchOutput,
    appendExpertTurn: async (specPath, turn) => {
      calls.appendTurn.push(turn);
    },
    writeBreadcrumb: () => {},
  };
  return { deps, calls };
}

function baseRequest(dir, identity, spec, overrides = {}) {
  return {
    identity,
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'snip',
    phase: 'spec-review',
    sliceId: null,
    sidecarParticipantState: '',
    task: 'do the review',
    ...overrides,
  };
}

// ── default (no suppress) enqueues normally ─────────────────────────────────

test('runTurnWithDeps: suppressPeerMessages=false (default) enqueues peer DMs normally', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const peers = [
    { to: 'expert-ux', body: 'hi ux', summary: 'hi' },
  ];
  const { deps, calls } = depsWithDispatch(validMachineResultWithPeers(peers));
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(calls.writeToMailbox.length, 1, 'should enqueue normally when suppressPeerMessages is false');
  assert.equal(result.peer_dm_summary.enqueued, 1);
  assert.equal(result.peer_dm_summary.failed, 0);
  assert.equal(result.peer_dm_summary.suppressed, undefined);
  assert.equal(calls.appendTurn[0].panel_peer_messages_suppressed, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ── suppressPeerMessages=true skips writeToMailbox entirely ─────────────────

test('runTurnWithDeps: suppressPeerMessages=true does NOT call writeToMailbox', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const peers = [
    { to: 'expert-ux', body: 'hi ux', summary: 'hi' },
    { to: 'expert-architecture', body: 'arch q', summary: 's' },
  ];
  const { deps, calls } = depsWithDispatch(validMachineResultWithPeers(peers));
  const result = await runTurnWithDeps(
    baseRequest(dir, identity, spec, { suppressPeerMessages: true }),
    deps
  );
  assert.equal(result.ok, true);
  assert.equal(calls.writeToMailbox.length, 0, 'must NOT call writeToMailbox in panel mode');
  rmSync(dir, { recursive: true, force: true });
});

// ── records panel_peer_messages_suppressed entries with sha256 body_hash ──

test('runTurnWithDeps: suppressPeerMessages=true records N panel_peer_messages_suppressed entries with body_hash sha256:<hex>', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const peers = [
    { to: 'expert-ux', body: 'body-1', summary: 'sum-1' },
    { to: 'expert-architecture', body: 'body-2' },
    { to: 'expert-test', body: 'body-3', summary: 'sum-3' },
  ];
  const { deps, calls } = depsWithDispatch(validMachineResultWithPeers(peers));
  const result = await runTurnWithDeps(
    baseRequest(dir, identity, spec, { suppressPeerMessages: true }),
    deps
  );
  assert.equal(result.ok, true);
  const appended = calls.appendTurn[0];
  assert.ok(Array.isArray(appended.panel_peer_messages_suppressed));
  assert.equal(appended.panel_peer_messages_suppressed.length, 3);

  // Per-entry shape: to + body_hash sha256:<64-hex>; summary_hash only when summary present.
  const HEX = /^sha256:[a-f0-9]{64}$/;
  const e0 = appended.panel_peer_messages_suppressed[0];
  assert.equal(e0.to, 'expert-ux');
  assert.equal(e0.body_hash, `sha256:${sha256Hex('body-1')}`);
  assert.match(e0.body_hash, HEX);
  assert.equal(e0.summary_hash, `sha256:${sha256Hex('sum-1')}`);

  const e1 = appended.panel_peer_messages_suppressed[1];
  assert.equal(e1.to, 'expert-architecture');
  assert.equal(e1.body_hash, `sha256:${sha256Hex('body-2')}`);
  assert.equal(e1.summary_hash, undefined, 'no summary → no summary_hash');

  const e2 = appended.panel_peer_messages_suppressed[2];
  assert.equal(e2.to, 'expert-test');
  assert.equal(e2.body_hash, `sha256:${sha256Hex('body-3')}`);
  assert.equal(e2.summary_hash, `sha256:${sha256Hex('sum-3')}`);

  // No outbound peer_messages_enqueued/failed when suppressed.
  assert.equal(appended.peer_messages_enqueued, undefined);
  assert.equal(appended.peer_messages_failed, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// ── peer_dm_summary in suppress mode ─────────────────────────────────────────

test('runTurnWithDeps: suppressPeerMessages=true → peer_dm_summary = {enqueued:0, failed:0, suppressed:3}', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const peers = [
    { to: 'expert-ux', body: 'a' },
    { to: 'expert-architecture', body: 'b' },
    { to: 'expert-test', body: 'c' },
  ];
  const { deps } = depsWithDispatch(validMachineResultWithPeers(peers));
  const result = await runTurnWithDeps(
    baseRequest(dir, identity, spec, { suppressPeerMessages: true }),
    deps
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.peer_dm_summary, { enqueued: 0, failed: 0, suppressed: 3 });
  rmSync(dir, { recursive: true, force: true });
});

// ── sidecar validator accepts / rejects panel_peer_messages_suppressed shape ─

test('appendExpertTurn validator accepts panel_peer_messages_suppressed with valid shape; rejects invalid shape', () => {
  const { dir, spec } = makeSpec();
  const baseTurn = {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    mailbox_message_ids_injected: [],
    started_at: '2026-05-11T00:00:00.000Z',
    completed_at: '2026-05-11T00:00:01.000Z',
    result_summary: 'SHIP',
    verdict: 'SHIP',
    failure_reason: null,
  };
  // Valid shape: to: string|null, body_hash sha256:<64hex>; optional summary_hash.
  const validEntry = {
    to: 'expert-ux',
    body_hash: `sha256:${'a'.repeat(64)}`,
    summary_hash: `sha256:${'b'.repeat(64)}`,
  };
  assert.doesNotThrow(() =>
    appendExpertTurn(spec, {
      ...baseTurn,
      panel_peer_messages_suppressed: [validEntry, { to: null, body_hash: `sha256:${'c'.repeat(64)}` }],
    })
  );
  const sc = loadSidecar(spec);
  const last = sc.expert_teammates.turns[sc.expert_teammates.turns.length - 1];
  assert.equal(last.panel_peer_messages_suppressed.length, 2);
  assert.equal(last.panel_peer_messages_suppressed[1].to, null);

  // Invalid: not an array
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: 'nope' }), /panel_peer_messages_suppressed/);
  // Invalid: element not an object
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: [42] }), /panel_peer_messages_suppressed/);
  // Invalid: missing body_hash
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: [{ to: 'expert-ux' }] }), /body_hash/);
  // Invalid: bad body_hash format
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: [{ to: 'expert-ux', body_hash: 'not-a-hash' }] }), /body_hash/);
  // Invalid: bad to (number)
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: [{ to: 42, body_hash: `sha256:${'a'.repeat(64)}` }] }), /panel_peer_messages_suppressed/i);
  // Invalid: bad summary_hash format
  assert.throws(() => appendExpertTurn(spec, { ...baseTurn, panel_peer_messages_suppressed: [{ to: 'expert-ux', body_hash: `sha256:${'a'.repeat(64)}`, summary_hash: 'nope' }] }), /summary_hash/);

  rmSync(dir, { recursive: true, force: true });
});
