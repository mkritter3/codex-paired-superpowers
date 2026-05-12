// v0.9.0 slice 6 — panel verdict aggregator tests.
//
// Deterministic rules per docs/architecture/2026-05-11-v0.9.0-destination.md § 4.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateVerdicts,
  computeQuorumSize,
} from '../../../lib/codex-bridge/panel/verdict-aggregator.js';

function ship(id, blocking = [], nonblocking = []) {
  return {
    member_id: id,
    parsed_result: {
      expert_id: id,
      phase: 'spec-review',
      status: 'SHIP',
      scope: 'test',
      blocking_findings: blocking,
      nonblocking_findings: nonblocking,
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    },
  };
}

function revise(id, blocking = [{ message: `b-${id}` }], nonblocking = []) {
  return {
    member_id: id,
    parsed_result: {
      expert_id: id,
      phase: 'spec-review',
      status: 'REVISE',
      scope: 'test',
      blocking_findings: blocking,
      nonblocking_findings: nonblocking,
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    },
  };
}

function parseFailure(id) {
  return {
    member_id: id,
    parsed_result: null,
    parse_failure_reason: 'invalid-json',
  };
}

// ── 1. Quorum size table ──────────────────────────────────────────────────

test('computeQuorumSize: spec table — max(2, floor(N/2)+1)', () => {
  assert.equal(computeQuorumSize(1), 2); // can't form quorum, but rule holds
  assert.equal(computeQuorumSize(2), 2);
  assert.equal(computeQuorumSize(3), 2);
  assert.equal(computeQuorumSize(4), 3);
  assert.equal(computeQuorumSize(5), 3);
});

// ── 2. All-SHIP cases ──────────────────────────────────────────────────────

test('aggregateVerdicts: all-SHIP (N=2) → panel-SHIP with preserved findings', () => {
  const result = aggregateVerdicts([
    ship('expert-codex', [], [{ message: 'nb1' }]),
    ship('expert-claude'),
  ]);
  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.ship_count, 2);
  assert.equal(result.revise_count, 0);
  assert.equal(result.parse_failure_count, 0);
  assert.equal(result.quorum_size, 2);
  assert.equal(result.has_quorum, true);
  assert.equal(result.findings_by_member.length, 2);
  assert.equal(result.findings_by_member[0].member_id, 'expert-codex');
  assert.deepEqual(result.findings_by_member[0].nonblocking_findings, [{ message: 'nb1' }]);
});

test('aggregateVerdicts: all-SHIP (N=3) → panel-SHIP', () => {
  const result = aggregateVerdicts([ship('a'), ship('b'), ship('c')]);
  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.ship_count, 3);
  assert.equal(result.quorum_size, 2); // floor(3/2)+1 = 2
});

// ── 3. All-REVISE cases (findings preserved verbatim) ─────────────────────

test('aggregateVerdicts: all-REVISE (N=2) → panel-REVISE; findings_by_member preserves all blocking_findings verbatim', () => {
  const r1Blocking = [
    { message: 'missing test case X', severity: 'high' },
    { message: 'flaky assertion in test Y' },
  ];
  const r2Blocking = [
    { message: 'integration boundary undertested' },
  ];
  const result = aggregateVerdicts([
    revise('expert-codex', r1Blocking, [{ message: 'doc gap' }]),
    revise('expert-claude', r2Blocking, []),
  ]);
  assert.equal(result.outcome, 'panel-REVISE');
  assert.equal(result.revise_count, 2);
  assert.equal(result.ship_count, 0);
  assert.equal(result.findings_by_member.length, 2);
  // Verbatim preservation (no dedup, no merge).
  assert.deepEqual(result.findings_by_member[0].blocking_findings, r1Blocking);
  assert.deepEqual(result.findings_by_member[0].nonblocking_findings, [{ message: 'doc gap' }]);
  assert.deepEqual(result.findings_by_member[1].blocking_findings, r2Blocking);
});

// ── 4. Mixed N=2 → panel-disagreement ──────────────────────────────────────

test('aggregateVerdicts: mixed N=2 (1 SHIP, 1 REVISE) → panel-disagreement (no consensus for N<3)', () => {
  const result = aggregateVerdicts([ship('a'), revise('b')]);
  assert.equal(result.outcome, 'panel-disagreement');
  assert.equal(result.ship_count, 1);
  assert.equal(result.revise_count, 1);
  assert.equal(result.has_quorum, true);
});

// ── 5. Mixed N=3 (2 SHIP, 1 REVISE) → mixed-needs-consensus ───────────────

test('aggregateVerdicts: mixed N=3 (2 SHIP, 1 REVISE) → mixed-needs-consensus', () => {
  const result = aggregateVerdicts([ship('a'), ship('b'), revise('c')]);
  assert.equal(result.outcome, 'mixed-needs-consensus');
  assert.equal(result.ship_count, 2);
  assert.equal(result.revise_count, 1);
});

// ── 6. Mixed N=3 (1 SHIP, 2 REVISE) → mixed-needs-consensus ───────────────

test('aggregateVerdicts: mixed N=3 (1 SHIP, 2 REVISE) → mixed-needs-consensus', () => {
  const result = aggregateVerdicts([ship('a'), revise('b'), revise('c')]);
  assert.equal(result.outcome, 'mixed-needs-consensus');
  assert.equal(result.ship_count, 1);
  assert.equal(result.revise_count, 2);
});

// ── 7. Parse failures with quorum met → degraded-N-proceeds ───────────────

test('aggregateVerdicts: N=3 with 1 parse-failure, surviving 2 SHIP → degraded-N-proceeds (quorum met)', () => {
  const result = aggregateVerdicts([
    ship('a'),
    ship('b'),
    parseFailure('c'),
  ]);
  assert.equal(result.outcome, 'degraded-N-proceeds');
  assert.equal(result.degraded_core_outcome, 'panel-SHIP');
  assert.equal(result.parse_failure_count, 1);
  assert.equal(result.has_quorum, true); // 2 >= max(2, 2) = 2
  assert.equal(result.quorum_size, 2);
  // findings_by_member only includes successful parses.
  assert.equal(result.findings_by_member.length, 2);
  assert.equal(result.findings_by_member[0].member_id, 'a');
  assert.equal(result.findings_by_member[1].member_id, 'b');
});

// ── 8. Parse failures with quorum lost → panel-quorum-lost ────────────────

test('aggregateVerdicts: N=3 with 2 parse-failures, 1 surviving SHIP → panel-quorum-lost', () => {
  const result = aggregateVerdicts([
    ship('a'),
    parseFailure('b'),
    parseFailure('c'),
  ]);
  assert.equal(result.outcome, 'panel-quorum-lost');
  assert.equal(result.parse_failure_count, 2);
  assert.equal(result.has_quorum, false);
  assert.equal(result.quorum_size, 2);
  assert.equal(result.ship_count, 1);
});
