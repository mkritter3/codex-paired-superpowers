// v0.9.0 slice 6 — panel dispatcher tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dispatchPanel,
  PanelDispatchError,
} from '../../../lib/codex-bridge/panel/dispatcher.js';
import { initSidecar, loadSidecar } from '../../../lib/codex-bridge/sidecar.js';

// ── helpers ────────────────────────────────────────────────────────────────

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-panel-disp-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'panel-feature',
    codexSession: 's',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  return { dir, spec };
}

function shipDispatchResult(id, blocking = [], nonblocking = []) {
  const body = {
    expert_id: id,
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'test',
    blocking_findings: blocking,
    nonblocking_findings: nonblocking,
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return {
    responseText: `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`,
    exit: 0,
    warnings: [],
    sessionId: null,
    adapterMeta: {},
    duration_ms: 1,
  };
}

function reviseDispatchResult(id, blocking = [{ message: `b-${id}` }], nonblocking = []) {
  const body = {
    expert_id: id,
    phase: 'spec-review',
    status: 'REVISE',
    scope: 'test',
    blocking_findings: blocking,
    nonblocking_findings: nonblocking,
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return {
    responseText: `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`,
    exit: 0,
    warnings: [],
    sessionId: null,
    adapterMeta: {},
    duration_ms: 1,
  };
}

function makeStubFn(verdict, id, opts = {}) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    if (verdict === 'SHIP') return shipDispatchResult(id, opts.blocking || [], opts.nonblocking || []);
    if (verdict === 'REVISE') return reviseDispatchResult(id, opts.blocking, opts.nonblocking);
    throw new Error(`unknown verdict ${verdict}`);
  };
  return { fn, calls };
}

function baseRequest(spec, dir) {
  return {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'snip',
    phase: 'spec-review',
    sliceId: 'slice-1',
    sidecarParticipantState: '',
    task: 'review the slice',
  };
}

// ── 1. Happy path N=2 ─────────────────────────────────────────────────────

test('dispatchPanel: N=2 both SHIP → outcome panel-SHIP, persists 2 turns with panel_id + panel_member_index + panel_size: 2', async () => {
  const { dir, spec } = makeSpec();
  const aStub = makeStubFn('SHIP', 'expert-codex');
  const bStub = makeStubFn('SHIP', 'expert-claude');
  const dispatchFns = new Map([
    ['expert-codex', aStub.fn],
    ['expert-claude', bStub.fn],
  ]);

  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);

  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.consensus_round_ran, false);
  assert.match(result.panel_id, /^panel-\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.member_results.length, 2);

  // Sidecar persistence: 2 turns, each with panel_id + index + size.
  const sc = loadSidecar(spec);
  const turns = sc.expert_teammates.turns;
  assert.equal(turns.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(turns[i].panel_id, result.panel_id);
    assert.equal(turns[i].panel_member_index, i);
    assert.equal(turns[i].panel_size, 2);
    assert.equal(turns[i].verdict, 'SHIP');
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. panel_min_size hard halt ───────────────────────────────────────────

test('dispatchPanel: dispatchFns.size=1 with panel_min_size=2 → throws PanelDispatchError code panel-quorum-unavailable', async () => {
  const { dir, spec } = makeSpec();
  const dispatchFns = new Map([['solo', makeStubFn('SHIP', 'solo').fn]]);
  await assert.rejects(
    () => dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-quorum-unavailable');
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── 3. panel_max_size enforcement ─────────────────────────────────────────

test('dispatchPanel: dispatchFns.size=5 with panel_max_size=3 → uses first 3, skipped_candidates lists the other 2', async () => {
  const { dir, spec } = makeSpec();
  const stubs = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => [id, makeStubFn('SHIP', id).fn]);
  const dispatchFns = new Map(stubs);

  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.member_results.length, 3);
  assert.deepEqual(result.skipped_candidates, ['m4', 'm5']);
  rmSync(dir, { recursive: true, force: true });
});

// ── 4. Members snapshot ONCE across consensus round ──────────────────────

test('dispatchPanel: same dispatch_fn objects passed to runConsensusRound (snapshot members ONCE)', async () => {
  const { dir, spec } = makeSpec();
  const aStub = makeStubFn('SHIP', 'a');
  const bStub = makeStubFn('SHIP', 'b');
  const cStub = makeStubFn('REVISE', 'c');
  const dispatchFns = new Map([
    ['a', aStub.fn],
    ['b', bStub.fn],
    ['c', cStub.fn],
  ]);

  let consensusMembersCaptured = null;
  const fakeConsensus = async (role, req, members, _firstRoundResults, _deps) => {
    consensusMembersCaptured = members;
    return {
      aggregate: {
        outcome: 'panel-SHIP',
        ship_count: 3,
        revise_count: 0,
        parse_failure_count: 0,
        quorum_size: 2,
        has_quorum: true,
        findings_by_member: [],
      },
      panelResults: members.map((m) => ({
        member_id: m.member_id,
        parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] },
      })),
      final_outcome: 'panel-SHIP',
    };
  };

  await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });

  assert.equal(consensusMembersCaptured.length, 3);
  // Referential equality on the dispatch_fn objects.
  assert.strictEqual(consensusMembersCaptured[0].dispatch_fn, aStub.fn);
  assert.strictEqual(consensusMembersCaptured[1].dispatch_fn, bStub.fn);
  assert.strictEqual(consensusMembersCaptured[2].dispatch_fn, cStub.fn);
  rmSync(dir, { recursive: true, force: true });
});

// ── 5. suppressPeerMessages: true is set ──────────────────────────────────

test('dispatchPanel: suppressPeerMessages=true is added to each member request', async () => {
  const { dir, spec } = makeSpec();
  const aStub = makeStubFn('SHIP', 'a');
  const bStub = makeStubFn('SHIP', 'b');
  const dispatchFns = new Map([['a', aStub.fn], ['b', bStub.fn]]);

  await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);
  assert.equal(aStub.calls.length, 1);
  assert.equal(aStub.calls[0].suppressPeerMessages, true);
  assert.equal(bStub.calls[0].suppressPeerMessages, true);
  rmSync(dir, { recursive: true, force: true });
});

// ── 6. panel_id generated + persisted ─────────────────────────────────────

test('dispatchPanel: panel_id is generated and persisted on each turn', async () => {
  const { dir, spec } = makeSpec();
  const dispatchFns = new Map([
    ['a', makeStubFn('SHIP', 'a').fn],
    ['b', makeStubFn('SHIP', 'b').fn],
  ]);
  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);
  assert.match(result.panel_id, /^panel-/);
  const sc = loadSidecar(spec);
  for (const turn of sc.expert_teammates.turns) {
    assert.equal(turn.panel_id, result.panel_id);
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── 7. Sidecar preserves each panelist's blocking + nonblocking ───────────

test('dispatchPanel: sidecar persistence preserves each panelist findings verbatim', async () => {
  const { dir, spec } = makeSpec();
  const aBlocking = [{ message: 'blk-a-1' }, { message: 'blk-a-2' }];
  const aNonblocking = [{ message: 'nb-a-1' }];
  const bBlocking = [{ message: 'blk-b-1' }];
  const aFn = makeStubFn('REVISE', 'a', { blocking: aBlocking, nonblocking: aNonblocking }).fn;
  const bFn = makeStubFn('REVISE', 'b', { blocking: bBlocking, nonblocking: [] }).fn;
  const dispatchFns = new Map([['a', aFn], ['b', bFn]]);
  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);
  assert.equal(result.outcome, 'panel-REVISE');
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.turns.length, 2);
  assert.deepEqual(sc.expert_teammates.turns[0].blocking_findings, aBlocking);
  assert.deepEqual(sc.expert_teammates.turns[0].nonblocking_findings, aNonblocking);
  assert.deepEqual(sc.expert_teammates.turns[1].blocking_findings, bBlocking);
  rmSync(dir, { recursive: true, force: true });
});

// ── 8. Mixed N=3 triggers consensus round ─────────────────────────────────

test('dispatchPanel: mixed N=3 triggers consensus round (called once)', async () => {
  const { dir, spec } = makeSpec();
  let consensusCalls = 0;
  const fakeConsensus = async (role, req, members, _round1) => {
    consensusCalls += 1;
    return {
      aggregate: {
        outcome: 'panel-SHIP',
        ship_count: 3,
        revise_count: 0,
        parse_failure_count: 0,
        quorum_size: 2,
        has_quorum: true,
        findings_by_member: [],
      },
      panelResults: members.map((m) => ({
        member_id: m.member_id,
        parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] },
      })),
      final_outcome: 'panel-SHIP',
    };
  };
  const dispatchFns = new Map([
    ['a', makeStubFn('SHIP', 'a').fn],
    ['b', makeStubFn('SHIP', 'b').fn],
    ['c', makeStubFn('REVISE', 'c').fn],
  ]);
  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });
  assert.equal(consensusCalls, 1);
  assert.equal(result.consensus_round_ran, true);
  assert.equal(result.outcome, 'panel-SHIP');
  rmSync(dir, { recursive: true, force: true });
});

// ── 9. Mixed N=2 does NOT trigger consensus ───────────────────────────────

test('dispatchPanel: mixed N=2 → panel-disagreement (no consensus round)', async () => {
  const { dir, spec } = makeSpec();
  let consensusCalls = 0;
  const fakeConsensus = async () => {
    consensusCalls += 1;
    return {
      aggregate: {},
      panelResults: [],
      final_outcome: 'panel-SHIP',
    };
  };
  const dispatchFns = new Map([
    ['a', makeStubFn('SHIP', 'a').fn],
    ['b', makeStubFn('REVISE', 'b').fn],
  ]);
  const result = await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });
  assert.equal(consensusCalls, 0);
  assert.equal(result.consensus_round_ran, false);
  assert.equal(result.outcome, 'panel-disagreement');
  rmSync(dir, { recursive: true, force: true });
});

// ── 10. runtime_kind propagated to sidecar turn record ────────────────────

test('dispatchPanel: runtime_kind in member metadata propagates to sidecar turn.adapter', async () => {
  const { dir, spec } = makeSpec();
  const dispatchFns = new Map([
    ['a', { fn: makeStubFn('SHIP', 'a').fn, runtime_kind: 'claude-task' }],
    ['b', { fn: makeStubFn('SHIP', 'b').fn, runtime_kind: 'cli-harness:codex' }],
  ]);
  await dispatchPanel('expert-test', baseRequest(spec, dir), dispatchFns);
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.turns[0].adapter, 'claude-task');
  assert.equal(sc.expert_teammates.turns[1].adapter, 'cli-harness:codex');
  rmSync(dir, { recursive: true, force: true });
});
