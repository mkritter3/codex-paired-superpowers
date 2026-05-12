// v0.9.0 slice 6 — consensus-round tests.
//
// Round-1 fix (Codex slice-6 critical-tier REVISE):
//   - dispatch_fn now returns the runTurnWithDeps shape directly:
//     {ok: true, result: parsed} on success. The consensus-round does
//     NOT call parseExpertOutput itself; it reads `result` straight
//     from the dispatch_fn return value.
//   - Each member's request now carries panel metadata (panelId,
//     panelMemberIndex, panelSize) plus suppressPeerMessages: true so
//     runTurnWithDeps records them under the slice-5b whitelist.
//   - Machine Result's `expert_id` field is the ROLE (e.g.
//     "expert-test"), not the dispatcher's adapter-specific member_id
//     ("expert-test@codex"). The dispatcher's member_id is a Map-key
//     handle only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runConsensusRound,
  buildConsensusContext,
} from '../../../lib/codex-bridge/panel/consensus-round.js';

const ROLE = 'expert-test';

function makeMember(memberIdSuffix, verdict) {
  const memberId = `${ROLE}@${memberIdSuffix}`;
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const parsed = {
      expert_id: ROLE,           // ROLE — NOT memberId
      phase: 'spec-review',
      status: verdict,
      scope: ROLE,
      blocking_findings: verdict === 'REVISE' ? [{ message: `b-${memberIdSuffix}` }] : [],
      nonblocking_findings: [],
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    };
    // runTurnWithDeps-shaped result.
    return { ok: true, result: parsed, peer_dm_summary: { enqueued: 0, failed: 0 } };
  };
  return { member: { member_id: memberId, dispatch_fn: fn, runtime_kind: 'claude-task' }, calls };
}

const baseRequest = {
  repoRoot: '/tmp/x',
  specPath: '/tmp/x/spec.md',
  specSnippet: 's',
  phase: 'spec-review',
  sliceId: 'slice-1',
  sidecarParticipantState: '',
  task: 'review',
  // dispatchPanel injects these before calling runConsensusRound; tests
  // simulate the dispatcher's pre-call augmentation.
  suppressPeerMessages: true,
  panelId: 'panel-fixture',
  panelSize: 3,
};

// ── 1. Receives mixed first-round results; assembles consensus context ────

test('runConsensusRound: passes consensus context (each panelist sees others findings) to dispatch_fn', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'SHIP');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    {
      member_id: `${ROLE}@a`,
      parsed_result: {
        status: 'SHIP',
        blocking_findings: [],
        nonblocking_findings: [{ message: 'nb-a' }],
      },
    },
    {
      member_id: `${ROLE}@b`,
      parsed_result: {
        status: 'SHIP',
        blocking_findings: [],
        nonblocking_findings: [],
      },
    },
    {
      member_id: `${ROLE}@c`,
      parsed_result: {
        status: 'REVISE',
        blocking_findings: [{ message: 'must fix X' }],
        nonblocking_findings: [],
      },
    },
  ];

  await runConsensusRound(ROLE, baseRequest, members, firstRound, {});

  // Each panelist must have seen the OTHER panelists' findings in its
  // augmented task / consensusContext.
  const aReq = a.calls[0];
  assert.ok(aReq.consensusContext.includes(`### ${ROLE}@b`));
  assert.ok(aReq.consensusContext.includes(`### ${ROLE}@c`));
  assert.ok(aReq.consensusContext.includes('must fix X'));
  assert.ok(!aReq.consensusContext.includes(`### ${ROLE}@a`));
  // suppressPeerMessages always true.
  assert.equal(aReq.suppressPeerMessages, true);
  // Panel metadata propagated.
  assert.equal(aReq.panelId, 'panel-fixture');
  assert.equal(aReq.panelMemberIndex, 0);
  assert.equal(aReq.panelSize, 3);
});

// ── 2. Re-dispatches SAME members (referential equality) ──────────────────

test('runConsensusRound: re-dispatches the SAME member dispatch_fn objects (no re-resolve)', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'SHIP');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    { member_id: `${ROLE}@a`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@b`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@c`, parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  await runConsensusRound(ROLE, baseRequest, members, firstRound, {});
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(c.calls.length, 1);
});

// ── 3. All converge to SHIP after consensus → panel-SHIP ──────────────────

test('runConsensusRound: all converge to SHIP → final_outcome panel-SHIP', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'SHIP');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    { member_id: `${ROLE}@a`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@b`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@c`, parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  const result = await runConsensusRound(ROLE, baseRequest, members, firstRound, {});
  assert.equal(result.final_outcome, 'panel-SHIP');
  assert.equal(result.aggregate.ship_count, 3);
});

// ── 4. Still mixed after consensus → panel-disagreement (NO 2nd loop) ─────

test('runConsensusRound: still mixed after consensus → panel-disagreement (no second loop)', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'REVISE');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    { member_id: `${ROLE}@a`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@b`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@c`, parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  const result = await runConsensusRound(ROLE, baseRequest, members, firstRound, {});
  // Aggregator returns mixed-needs-consensus (2 SHIP + 1 REVISE on N=3),
  // consensus-round MUST escalate to panel-disagreement.
  assert.equal(result.final_outcome, 'panel-disagreement');
  // Each member dispatched exactly once during this round.
  assert.equal(a.calls.length, 1);
  assert.equal(c.calls.length, 1);
});

// ── 5. buildConsensusContext excludes the for-member's own findings ───────

test('buildConsensusContext: excludes the for-member from the context block', () => {
  const ctx = buildConsensusContext(`${ROLE}@a`, [
    { member_id: `${ROLE}@a`, parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: `${ROLE}@b`, parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'fix b' }], nonblocking_findings: [] } },
  ]);
  assert.ok(!ctx.includes(`### ${ROLE}@a`));
  assert.ok(ctx.includes(`### ${ROLE}@b`));
  assert.ok(ctx.includes('fix b'));
});
