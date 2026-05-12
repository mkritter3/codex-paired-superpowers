// v0.9.0 slice 6 — consensus-round tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runConsensusRound,
  buildConsensusContext,
} from '../../../lib/codex-bridge/panel/consensus-round.js';

function shipDispatchResult(id) {
  const body = {
    expert_id: id,
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'test',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return {
    responseText: `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`,
  };
}

function reviseDispatchResult(id) {
  const body = {
    expert_id: id,
    phase: 'spec-review',
    status: 'REVISE',
    scope: 'test',
    blocking_findings: [{ message: `b-${id}` }],
    nonblocking_findings: [],
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return {
    responseText: `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`,
  };
}

function makeMember(id, verdict) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return verdict === 'SHIP' ? shipDispatchResult(id) : reviseDispatchResult(id);
  };
  return { member: { member_id: id, dispatch_fn: fn, runtime_kind: 'claude-task' }, calls };
}

const baseRequest = {
  repoRoot: '/tmp/x',
  specPath: '/tmp/x/spec.md',
  specSnippet: 's',
  phase: 'spec-review',
  sliceId: 'slice-1',
  sidecarParticipantState: '',
  task: 'review',
};

// Stub parser that recognizes ## Machine Result blocks (uses real one).
import { parseExpertOutput } from '../../../lib/codex-bridge/expert-output-parser.js';

// ── 1. Receives mixed first-round results; assembles consensus context ────

test('runConsensusRound: passes consensus context (each panelist sees others findings) to dispatch_fn', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'SHIP');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    {
      member_id: 'a',
      parsed_result: {
        status: 'SHIP',
        blocking_findings: [],
        nonblocking_findings: [{ message: 'nb-a' }],
      },
    },
    {
      member_id: 'b',
      parsed_result: {
        status: 'SHIP',
        blocking_findings: [],
        nonblocking_findings: [],
      },
    },
    {
      member_id: 'c',
      parsed_result: {
        status: 'REVISE',
        blocking_findings: [{ message: 'must fix X' }],
        nonblocking_findings: [],
      },
    },
  ];

  await runConsensusRound('expert-test', baseRequest, members, firstRound, {
    parseExpertOutput,
  });

  // Each panelist must have seen the OTHER panelists' findings in its
  // augmented task / consensusContext.
  // `a` should see `b` (SHIP) + `c` (REVISE) findings.
  const aReq = a.calls[0];
  assert.ok(aReq.consensusContext.includes('### b'));
  assert.ok(aReq.consensusContext.includes('### c'));
  assert.ok(aReq.consensusContext.includes('must fix X'));
  assert.ok(!aReq.consensusContext.includes('### a'));
  // suppressPeerMessages always true.
  assert.equal(aReq.suppressPeerMessages, true);
});

// ── 2. Re-dispatches SAME members (referential equality) ──────────────────

test('runConsensusRound: re-dispatches the SAME member dispatch_fn objects (no re-resolve)', async () => {
  const a = makeMember('a', 'SHIP');
  const b = makeMember('b', 'SHIP');
  const c = makeMember('c', 'SHIP');
  const members = [a.member, b.member, c.member];
  const firstRound = [
    { member_id: 'a', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'b', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'c', parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  await runConsensusRound('expert-test', baseRequest, members, firstRound, {
    parseExpertOutput,
  });
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
    { member_id: 'a', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'b', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'c', parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  const result = await runConsensusRound('expert-test', baseRequest, members, firstRound, {
    parseExpertOutput,
  });
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
    { member_id: 'a', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'b', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'c', parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'x' }], nonblocking_findings: [] } },
  ];
  const result = await runConsensusRound('expert-test', baseRequest, members, firstRound, {
    parseExpertOutput,
  });
  // Aggregator returns mixed-needs-consensus (2 SHIP + 1 REVISE on N=3),
  // consensus-round MUST escalate to panel-disagreement.
  assert.equal(result.final_outcome, 'panel-disagreement');
  // Each member dispatched exactly once during this round — no second
  // consensus loop is triggered inside runConsensusRound.
  assert.equal(a.calls.length, 1);
  assert.equal(c.calls.length, 1);
});

// ── 5. buildConsensusContext excludes the for-member's own findings ───────

test('buildConsensusContext: excludes the for-member from the context block', () => {
  const ctx = buildConsensusContext('a', [
    { member_id: 'a', parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } },
    { member_id: 'b', parsed_result: { status: 'REVISE', blocking_findings: [{ message: 'fix b' }], nonblocking_findings: [] } },
  ]);
  assert.ok(!ctx.includes('### a'));
  assert.ok(ctx.includes('### b'));
  assert.ok(ctx.includes('fix b'));
});
