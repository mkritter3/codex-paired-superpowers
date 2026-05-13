// v0.9.0 slice 6 — panel dispatcher tests.
//
// Round-1 fix (Codex slice-6 critical-tier REVISE):
//   - The dispatcher does NOT persist sidecar turns directly. Each
//     dispatch_fn wraps runTurnWithDeps which owns persistence
//     (response_hash, inputs_hash, role_prompt_hash, spec_path,
//     spec_snippet_hash, mailbox_message_ids, adapter, panel_id,
//     panel_member_index, panel_size).
//   - The Machine Result's `expert_id` field carries the ROLE id
//     (e.g. "expert-test"), NOT the dispatcher's internal Map-key
//     `member_id` (e.g. "expert-test@codex"). All panelists in a
//     panel share the same role; they differ in adapter + panel
//     member index.
//   - Each member's request includes panelId/panelMemberIndex/
//     panelSize/suppressPeerMessages: true so runTurnWithDeps records
//     them under the slice-5b whitelist.

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
import { runTurnWithDeps } from '../../../lib/codex-bridge/expert-turn.js';

// ── helpers ────────────────────────────────────────────────────────────────

const ROLE = 'expert-test';

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
  // Promptfile shared across panelists — role id matches identity.id.
  const promptPath = join(dir, `${ROLE}.md`);
  writeFileSync(
    promptPath,
    `---\nid: ${ROLE}\nrole: ${ROLE}\nversion: 1\n---\n# ${ROLE} prompt body\n`,
  );
  return { dir, spec, promptPath };
}

function buildMachineResultText(role, status, blocking = [], nonblocking = []) {
  const body = {
    expert_id: role,                  // ROLE — same across panelists
    phase: 'spec-review',
    status,
    scope: role,
    blocking_findings: blocking,
    nonblocking_findings: nonblocking,
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

/**
 * Build a dispatch_fn that wraps `runTurnWithDeps` with a stubbed
 * agentDispatch. This is the production-shaped dispatch_fn: it owns
 * sidecar persistence (slice-5b replay fields) via runTurnWithDeps.
 *
 * `memberId` is the dispatcher's internal Map-key (e.g. "expert-test@codex").
 * The wrapper records the request received from the dispatcher so tests can
 * assert panel metadata propagation.
 *
 * Returns { fn, calls, identity }.
 */
function makeWrappedDispatchFn({
  memberId,
  role,
  promptPath,
  adapter,
  verdict,
  blocking = [],
  nonblocking = [],
  capturedTurns,
}) {
  const calls = [];
  const identity = { id: role, role, promptPath, source: 'builtin' };
  const fn = async (request) => {
    calls.push(request);
    // The dispatch_fn binds identity (role-bound) + adapter-specific
    // agentDispatch. It MUST set `request.adapter` so the sidecar's
    // adapter field reflects the runtime kind for this panelist.
    const deps = {
      readUnreadMessages: async () => [],
      markManyAsRead: async () => ({ marked: [], skipped: [] }),
      writeToMailbox: async () => ({ id: 'msg-stub' }),
      // parseExpertOutput / buildRepairPrompt / appendExpertTurn /
      // storeResponse / writeBreadcrumb default to the real impls.
      agentDispatch: async () => buildMachineResultText(role, verdict, blocking, nonblocking),
      // Intercept appendExpertTurn so tests can assert what was persisted.
      appendExpertTurn: async (specPath, turn) => {
        capturedTurns.push({ memberId, turn });
        // Also delegate to the real sidecar append so loadSidecar reflects it.
        const { appendExpertTurn } = await import('../../../lib/codex-bridge/sidecar.js');
        return appendExpertTurn(specPath, turn);
      },
    };
    return runTurnWithDeps({ ...request, identity, adapter }, deps);
  };
  return { fn, calls, identity };
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

// ── 1. Happy path N=2: parsed_result.expert_id is the ROLE, not member_id ──

test('dispatchPanel: N=2 both SHIP → panel-SHIP; parsed_result.expert_id matches ROLE (not member_id); 2 turns persisted with panel metadata', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@claude-task`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@claude-task`, bWrap.fn],
  ]);

  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);

  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.consensus_round_ran, false);
  assert.match(result.panel_id, /^panel-\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.member_results.length, 2);

  // KEY FIX 1: parsed_result.expert_id is the ROLE, NOT the member_id.
  for (const mr of result.member_results) {
    assert.equal(mr.parsed_result.expert_id, ROLE,
      'parsed_result.expert_id must equal the ROLE id, not the adapter-specific member_id');
    assert.notEqual(mr.parsed_result.expert_id, mr.member_id,
      'role id and adapter-specific member_id must be distinct in panels');
  }

  // Sidecar persistence (via runTurnWithDeps, NOT the dispatcher).
  const sc = loadSidecar(spec);
  const turns = sc.expert_teammates.turns;
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    // Turn's expert_id is the ROLE (because runTurnWithDeps uses identity.id).
    assert.equal(turn.expert_id, ROLE);
    assert.equal(turn.panel_id, result.panel_id);
    assert.equal(turn.panel_size, 2);
    assert.equal(turn.verdict, 'SHIP');
    assert.ok(typeof turn.panel_member_index === 'number');
  }
  // Indices 0 and 1 both present (order in turns may vary because dispatches
  // are parallel).
  const indices = turns.map((t) => t.panel_member_index).sort();
  assert.deepEqual(indices, [0, 1]);
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. panel_min_size hard halt ───────────────────────────────────────────

test('dispatchPanel: dispatchFns.size=1 with panel_min_size=2 → throws PanelDispatchError code panel-quorum-unavailable', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([[`${ROLE}@codex`, aWrap.fn]]);
  await assert.rejects(
    () => dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns),
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
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const memberIds = ['m1', 'm2', 'm3', 'm4', 'm5'].map((s) => `${ROLE}@${s}`);
  const entries = memberIds.map((memberId, i) => {
    const wrap = makeWrappedDispatchFn({
      memberId,
      role: ROLE,
      promptPath,
      adapter: `cli-harness:m${i + 1}`,
      verdict: 'SHIP',
      capturedTurns,
    });
    return [memberId, wrap.fn];
  });
  const dispatchFns = new Map(entries);

  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.member_results.length, 3);
  assert.deepEqual(result.skipped_candidates, [memberIds[3], memberIds[4]]);
  rmSync(dir, { recursive: true, force: true });
});

// ── 4. Members snapshot ONCE across consensus round ──────────────────────

test('dispatchPanel: same dispatch_fn objects passed to runConsensusRound (snapshot members ONCE)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const wraps = ['a', 'b', 'c'].map((s) =>
    makeWrappedDispatchFn({
      memberId: `${ROLE}@${s}`,
      role: ROLE,
      promptPath,
      adapter: `cli-harness:${s}`,
      verdict: s === 'c' ? 'REVISE' : 'SHIP',
      capturedTurns,
    }),
  );
  const dispatchFns = new Map(wraps.map((w, i) => [`${ROLE}@${'abc'[i]}`, w.fn]));

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

  await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });

  assert.equal(consensusMembersCaptured.length, 3);
  assert.strictEqual(consensusMembersCaptured[0].dispatch_fn, wraps[0].fn);
  assert.strictEqual(consensusMembersCaptured[1].dispatch_fn, wraps[1].fn);
  assert.strictEqual(consensusMembersCaptured[2].dispatch_fn, wraps[2].fn);
  rmSync(dir, { recursive: true, force: true });
});

// ── 5. panel metadata propagation to each member's request ────────────────

test('dispatchPanel: each member request has suppressPeerMessages, panelId, panelMemberIndex, panelSize', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@claude-task`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@claude-task`, bWrap.fn],
  ]);

  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);

  // a is index 0; b is index 1 (Map iteration order = insertion order).
  assert.equal(aWrap.calls.length, 1);
  assert.equal(aWrap.calls[0].suppressPeerMessages, true);
  assert.equal(aWrap.calls[0].panelId, result.panel_id);
  assert.equal(aWrap.calls[0].panelMemberIndex, 0);
  assert.equal(aWrap.calls[0].panelSize, 2);

  assert.equal(bWrap.calls.length, 1);
  assert.equal(bWrap.calls[0].suppressPeerMessages, true);
  assert.equal(bWrap.calls[0].panelId, result.panel_id);
  assert.equal(bWrap.calls[0].panelMemberIndex, 1);
  assert.equal(bWrap.calls[0].panelSize, 2);
  rmSync(dir, { recursive: true, force: true });
});

// ── 6. Dispatcher does NOT call appendExpertTurn directly ─────────────────

test('dispatchPanel: dispatcher does NOT call appendExpertTurn itself — persistence is owned by dispatch_fn via runTurnWithDeps', async () => {
  const { dir, spec, promptPath } = makeSpec();
  let dispatcherSeamAppendCalls = 0;
  const dispatcherAppendSeam = async () => {
    dispatcherSeamAppendCalls += 1;
  };
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@claude-task`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@claude-task`, bWrap.fn],
  ]);
  // Pass a dispatcher-level appendExpertTurn that should NEVER be called by
  // the dispatcher under the Option-A contract.
  await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, {
    appendExpertTurn: dispatcherAppendSeam,
  });
  assert.equal(dispatcherSeamAppendCalls, 0,
    'dispatcher must not call its own appendExpertTurn — persistence belongs to dispatch_fn (runTurnWithDeps)');
  // But the runTurnWithDeps wrappers still appended via their own deps.
  assert.equal(capturedTurns.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

// ── 7. Persisted turns include slice-5b replay fields (full stack) ───────

test('dispatchPanel: sidecar turns persisted by runTurnWithDeps include slice-5b replay fields (response_hash, inputs_hash, role_prompt_hash, spec_path, spec_snippet_hash, mailbox_message_ids, adapter)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@claude-task`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@claude-task`, bWrap.fn],
  ]);

  await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);

  const sc = loadSidecar(spec);
  const turns = sc.expert_teammates.turns;
  assert.equal(turns.length, 2);
  for (const turn of turns) {
    assert.ok(typeof turn.response_hash === 'string' && turn.response_hash.startsWith('sha256:'),
      `turn must have response_hash; got ${JSON.stringify(turn.response_hash)}`);
    assert.ok(typeof turn.inputs_hash === 'string' && turn.inputs_hash.length > 0,
      'turn must have inputs_hash');
    assert.ok(typeof turn.role_prompt_hash === 'string' && turn.role_prompt_hash.startsWith('sha256:'),
      'turn must have role_prompt_hash');
    assert.equal(turn.spec_path, spec);
    assert.ok(typeof turn.spec_snippet_hash === 'string' && turn.spec_snippet_hash.startsWith('sha256:'),
      'turn must have spec_snippet_hash');
    assert.ok(Array.isArray(turn.mailbox_message_ids),
      'turn must have mailbox_message_ids');
    assert.ok(typeof turn.adapter === 'string' && turn.adapter.length > 0,
      'turn must have adapter');
    assert.ok(typeof turn.panel_id === 'string' && turn.panel_id.startsWith('panel-'),
      'turn must have panel_id');
    assert.ok(typeof turn.panel_member_index === 'number',
      'turn must have panel_member_index');
    assert.equal(turn.panel_size, 2);
  }
  // adapter values differ per panelist (the orchestrator bound them).
  const adapters = turns.map((t) => t.adapter).sort();
  assert.deepEqual(adapters, ['claude-task', 'cli-harness:codex']);
  rmSync(dir, { recursive: true, force: true });
});

// ── 8. Sidecar preserves each panelist's blocking + nonblocking findings ──

test('dispatchPanel: sidecar persistence preserves each panelist findings verbatim (via runTurnWithDeps)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aBlocking = [{ message: 'blk-a-1' }, { message: 'blk-a-2' }];
  const aNonblocking = [{ message: 'nb-a-1' }];
  const bBlocking = [{ message: 'blk-b-1' }];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'REVISE',
    blocking: aBlocking,
    nonblocking: aNonblocking,
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@claude-task`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'REVISE',
    blocking: bBlocking,
    nonblocking: [],
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@claude-task`, bWrap.fn],
  ]);
  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  assert.equal(result.outcome, 'panel-REVISE');
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.turns.length, 2);
  // Find turns by panel_member_index since parallel dispatch order isn't fixed.
  const byIdx = new Map(sc.expert_teammates.turns.map((t) => [t.panel_member_index, t]));
  assert.deepEqual(byIdx.get(0).blocking_findings, aBlocking);
  assert.deepEqual(byIdx.get(0).nonblocking_findings, aNonblocking);
  assert.deepEqual(byIdx.get(1).blocking_findings, bBlocking);
  rmSync(dir, { recursive: true, force: true });
});

// ── 9. Mixed N=3 triggers consensus round ─────────────────────────────────

test('dispatchPanel: mixed N=3 triggers consensus round (called once)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
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
  const wraps = ['a', 'b', 'c'].map((s) =>
    makeWrappedDispatchFn({
      memberId: `${ROLE}@${s}`,
      role: ROLE,
      promptPath,
      adapter: `cli-harness:${s}`,
      verdict: s === 'c' ? 'REVISE' : 'SHIP',
      capturedTurns,
    }),
  );
  const dispatchFns = new Map(wraps.map((w, i) => [`${ROLE}@${'abc'[i]}`, w.fn]));
  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });
  assert.equal(consensusCalls, 1);
  assert.equal(result.consensus_round_ran, true);
  assert.equal(result.outcome, 'panel-SHIP');
  rmSync(dir, { recursive: true, force: true });
});

// ── 10. Mixed N=2 does NOT trigger consensus ──────────────────────────────

test('dispatchPanel: mixed N=2 → panel-disagreement (no consensus round)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  let consensusCalls = 0;
  const fakeConsensus = async () => {
    consensusCalls += 1;
    return {
      aggregate: {},
      panelResults: [],
      final_outcome: 'panel-SHIP',
    };
  };
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@a`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:a',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@b`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:b',
    verdict: 'REVISE',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@a`, aWrap.fn],
    [`${ROLE}@b`, bWrap.fn],
  ]);
  const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, {
    runConsensusRound: fakeConsensus,
  });
  assert.equal(consensusCalls, 0);
  assert.equal(result.consensus_round_ran, false);
  assert.equal(result.outcome, 'panel-disagreement');
  rmSync(dir, { recursive: true, force: true });
});

// ── 11. Adapter propagation ───────────────────────────────────────────────

// ── 12-16. Hard-floor enforcement (slice-6 round-2 fix) ───────────────────
//
// The hard floor is 2: a "panel" with <2 actual dispatched members violates
// spec § 4. Any combination of panel_min_size / panel_max_size overrides
// that would produce a panel <2 must be rejected at config-time BEFORE any
// dispatch_fn is called.

test('panel: panel_min_size=1 is rejected (hard floor 2)', async () => {
  // 3 dispatchFns, panel_min_size override of 1 — the override is silently
  // clamped to the hard floor (2), so 3 dispatchFns succeed; what we're
  // really asserting here is that panel_min_size=1 with only ONE dispatchFn
  // does NOT bypass the floor: it throws quorum-unavailable against
  // effectiveMin=2 (not 1).
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([[`${ROLE}@codex`, aWrap.fn]]);
  await assert.rejects(
    () => dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, { panel_min_size: 1 }),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-quorum-unavailable',
        'panel_min_size=1 must NOT bypass the hard floor of 2');
      // The error message must reflect the EFFECTIVE floor (2), not the
      // user's override (1).
      assert.match(err.message, /at least 2/);
      assert.equal(aWrap.calls.length, 0,
        'dispatch_fn must NOT be called when quorum is unavailable');
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('panel: panel_max_size=1 is rejected when hard floor is 2', async () => {
  // 3 dispatchFns, panel_max_size: 1 (panel_min_size defaults to 2).
  // effectiveMax=1 < effectiveMin=2 → throws panel-config-invalid BEFORE
  // any dispatch_fn is called. Pre-fix this would have run the quorum
  // check (3 >= 2 ✓), then capped to 1 member, then dispatched a
  // single-member "panel" and only later reported panel-quorum-lost.
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const wraps = ['a', 'b', 'c'].map((s) =>
    makeWrappedDispatchFn({
      memberId: `${ROLE}@${s}`,
      role: ROLE,
      promptPath,
      adapter: `cli-harness:${s}`,
      verdict: 'SHIP',
      capturedTurns,
    }),
  );
  const dispatchFns = new Map(wraps.map((w, i) => [`${ROLE}@${'abc'[i]}`, w.fn]));
  await assert.rejects(
    () => dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, { panel_max_size: 1 }),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-config-invalid',
        'panel_max_size=1 with hard floor 2 must throw panel-config-invalid');
      return true;
    },
  );
  // CRITICAL: no dispatch_fn must have been called. Pre-fix one member was
  // dispatched before quorum-lost was reported.
  for (const w of wraps) {
    assert.equal(w.calls.length, 0,
      'no dispatch_fn must be called when config is invalid');
  }
  assert.equal(capturedTurns.length, 0,
    'no turns must be persisted when config is invalid');
  rmSync(dir, { recursive: true, force: true });
});

test('panel: panel_min_size=3 + panel_max_size=2 → throws panel-config-invalid', async () => {
  // Contradictory config — min > max. Must reject at config-time, even
  // with enough dispatchFns to satisfy min in isolation.
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const wraps = ['a', 'b', 'c'].map((s) =>
    makeWrappedDispatchFn({
      memberId: `${ROLE}@${s}`,
      role: ROLE,
      promptPath,
      adapter: `cli-harness:${s}`,
      verdict: 'SHIP',
      capturedTurns,
    }),
  );
  const dispatchFns = new Map(wraps.map((w, i) => [`${ROLE}@${'abc'[i]}`, w.fn]));
  await assert.rejects(
    () =>
      dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, {
        panel_min_size: 3,
        panel_max_size: 2,
      }),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-config-invalid');
      assert.equal(err.details.effectiveMin, 3);
      assert.equal(err.details.effectiveMax, 2);
      return true;
    },
  );
  for (const w of wraps) {
    assert.equal(w.calls.length, 0, 'no dispatch_fn must be called');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('panel: defaults (min=2, max=3) accept 2-3 dispatchFns; reject 1; reject 1 even with explicit panel_min_size=2 override', async () => {
  // 2 dispatchFns + defaults → succeeds.
  {
    const { dir, spec, promptPath } = makeSpec();
    const capturedTurns = [];
    const dispatchFns = new Map(
      ['a', 'b'].map((s) => {
        const w = makeWrappedDispatchFn({
          memberId: `${ROLE}@${s}`,
          role: ROLE,
          promptPath,
          adapter: `cli-harness:${s}`,
          verdict: 'SHIP',
          capturedTurns,
        });
        return [`${ROLE}@${s}`, w.fn];
      }),
    );
    const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
    assert.equal(result.outcome, 'panel-SHIP');
    assert.equal(result.member_results.length, 2);
    assert.deepEqual(result.skipped_candidates, []);
    rmSync(dir, { recursive: true, force: true });
  }
  // 3 dispatchFns + defaults → succeeds (uses all 3).
  {
    const { dir, spec, promptPath } = makeSpec();
    const capturedTurns = [];
    const dispatchFns = new Map(
      ['a', 'b', 'c'].map((s) => {
        const w = makeWrappedDispatchFn({
          memberId: `${ROLE}@${s}`,
          role: ROLE,
          promptPath,
          adapter: `cli-harness:${s}`,
          verdict: 'SHIP',
          capturedTurns,
        });
        return [`${ROLE}@${s}`, w.fn];
      }),
    );
    const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
    assert.equal(result.outcome, 'panel-SHIP');
    assert.equal(result.member_results.length, 3);
    assert.deepEqual(result.skipped_candidates, []);
    rmSync(dir, { recursive: true, force: true });
  }
  // 5 dispatchFns + defaults → uses first 3; skipped lists other 2.
  {
    const { dir, spec, promptPath } = makeSpec();
    const capturedTurns = [];
    const ids = ['a', 'b', 'c', 'd', 'e'].map((s) => `${ROLE}@${s}`);
    const dispatchFns = new Map(
      ids.map((memberId, i) => {
        const w = makeWrappedDispatchFn({
          memberId,
          role: ROLE,
          promptPath,
          adapter: `cli-harness:m${i}`,
          verdict: 'SHIP',
          capturedTurns,
        });
        return [memberId, w.fn];
      }),
    );
    const result = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
    assert.equal(result.outcome, 'panel-SHIP');
    assert.equal(result.member_results.length, 3);
    assert.deepEqual(result.skipped_candidates, [ids[3], ids[4]]);
    rmSync(dir, { recursive: true, force: true });
  }
  // 1 dispatchFn + explicit panel_min_size=2 → throws panel-quorum-unavailable.
  // Regression guard: hard floor still applies even when override exactly
  // matches the floor.
  {
    const { dir, spec, promptPath } = makeSpec();
    const capturedTurns = [];
    const aWrap = makeWrappedDispatchFn({
      memberId: `${ROLE}@codex`,
      role: ROLE,
      promptPath,
      adapter: 'cli-harness:codex',
      verdict: 'SHIP',
      capturedTurns,
    });
    const dispatchFns = new Map([[`${ROLE}@codex`, aWrap.fn]]);
    await assert.rejects(
      () => dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, { panel_min_size: 2 }),
      (err) => {
        assert.ok(err instanceof PanelDispatchError);
        assert.equal(err.code, 'panel-quorum-unavailable');
        return true;
      },
    );
    assert.equal(aWrap.calls.length, 0);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('panel: effective floor is max(2, panel_min_size) regardless of override', async () => {
  // panel_min_size: 1 with 1 dispatchFn → effective floor 2 → rejected.
  for (const overrideMin of [1, 0, undefined]) {
    const { dir, spec, promptPath } = makeSpec();
    const capturedTurns = [];
    const aWrap = makeWrappedDispatchFn({
      memberId: `${ROLE}@codex`,
      role: ROLE,
      promptPath,
      adapter: 'cli-harness:codex',
      verdict: 'SHIP',
      capturedTurns,
    });
    const dispatchFns = new Map([[`${ROLE}@codex`, aWrap.fn]]);
    const deps = overrideMin === undefined ? undefined : { panel_min_size: overrideMin };
    await assert.rejects(
      () => dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns, deps),
      (err) => {
        assert.ok(err instanceof PanelDispatchError);
        // Either panel-config-invalid OR panel-quorum-unavailable is
        // acceptable here per the spec; what matters is the dispatch
        // never ran. For our validation order (config-invalid check
        // requires effectiveMax < effectiveMin which is NOT the case
        // when only min is lowered with default max=3), this should be
        // panel-quorum-unavailable.
        assert.ok(
          err.code === 'panel-quorum-unavailable' || err.code === 'panel-config-invalid',
          `unexpected error code ${err.code} for override ${overrideMin}`,
        );
        return true;
      },
    );
    assert.equal(aWrap.calls.length, 0,
      `dispatch_fn must not run for override panel_min_size=${overrideMin}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── (existing) 17. Adapter propagation ───────────────────────────────────

test('dispatchPanel: adapter set by dispatch_fn (binding adapter into the request) propagates to sidecar turn.adapter', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'claude-task',
    verdict: 'SHIP',
    capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@cli`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const dispatchFns = new Map([
    [`${ROLE}@codex`, aWrap.fn],
    [`${ROLE}@cli`, bWrap.fn],
  ]);
  await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  const sc = loadSidecar(spec);
  const byIdx = new Map(sc.expert_teammates.turns.map((t) => [t.panel_member_index, t]));
  assert.equal(byIdx.get(0).adapter, 'claude-task');
  assert.equal(byIdx.get(1).adapter, 'cli-harness:codex');
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.9.1 hardening: panel failure matrix (Codex round-1 review) ──────────
//
// Production dispatch_fns can fail in five distinct ways. The dispatcher must
// emit deterministic outcomes so ralph-loop / orchestrator can decide what to
// do next without guessing. These tests pin each failure mode separately AND
// in combination with a healthy member (degraded-quorum behavior).

// Round-1 critique: these tests asserted "some allowed outcome" instead
// of pinning the SPECIFIC parse_failure_reason recorded per failed member.
// Now they assert the exact failure reason on member_results[].

test('panel failure matrix: dispatch_fn throws synchronously → member_results records the thrown message', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const okWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const throwingFn = (_req) => {
    throw new Error('dispatch_fn exploded synchronously');
  };
  const dispatchFns = new Map([
    [`${ROLE}@codex`, okWrap.fn],
    [`${ROLE}@throws`, throwingFn],
  ]);
  const outcome = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  assert.ok(
    ['panel-SHIP', 'panel-REVISE', 'panel-disagreement', 'panel-quorum-lost'].includes(outcome.outcome),
    `outcome must be one of the documented values; got ${outcome.outcome}`
  );
  // The throwing member's result must carry the thrown error message.
  const throwingMember = outcome.member_results.find((r) => r.member_id === `${ROLE}@throws`);
  assert.ok(throwingMember, 'throwing member must appear in member_results');
  assert.equal(
    throwingMember.parse_failure_reason,
    'dispatch_fn exploded synchronously',
    `parse_failure_reason must be the thrown message verbatim; got: ${JSON.stringify(throwingMember.parse_failure_reason)}`
  );
  assert.equal(throwingMember.parsed_result, null, 'throwing member must have null parsed_result');
  // Healthy member must still have a parsed result.
  const okMember = outcome.member_results.find((r) => r.member_id === `${ROLE}@codex`);
  assert.ok(okMember && okMember.parsed_result, 'healthy member must carry parsed_result');
  rmSync(dir, { recursive: true, force: true });
});

test('panel failure matrix: dispatch_fn returns rejected Promise → member_results records the rejection reason', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const okWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  const rejectingFn = async (_req) => {
    throw new Error('async rejection: network unreachable');
  };
  const dispatchFns = new Map([
    [`${ROLE}@codex`, okWrap.fn],
    [`${ROLE}@rejects`, rejectingFn],
  ]);
  const outcome = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  assert.ok(
    ['panel-SHIP', 'panel-REVISE', 'panel-disagreement', 'panel-quorum-lost'].includes(outcome.outcome),
    `async rejection must not crash the panel; got ${outcome.outcome}`
  );
  const rejMember = outcome.member_results.find((r) => r.member_id === `${ROLE}@rejects`);
  assert.ok(rejMember, 'rejecting member must appear in member_results');
  assert.equal(
    rejMember.parse_failure_reason,
    'async rejection: network unreachable',
    `parse_failure_reason must be the rejection message; got: ${JSON.stringify(rejMember.parse_failure_reason)}`
  );
  assert.equal(rejMember.parsed_result, null);
  rmSync(dir, { recursive: true, force: true });
});

test('panel failure matrix: dispatch_fn returns bad shape → member_results.parse_failure_reason === "dispatch-fn-bad-shape"', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const okWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@codex`,
    role: ROLE,
    promptPath,
    adapter: 'cli-harness:codex',
    verdict: 'SHIP',
    capturedTurns,
  });
  // Returns a string instead of {ok:..., result:...}: bad shape.
  const badShapeFn = async (_req) => 'not-a-runTurnWithDeps-result';
  const dispatchFns = new Map([
    [`${ROLE}@codex`, okWrap.fn],
    [`${ROLE}@bad`, badShapeFn],
  ]);
  const outcome = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  assert.ok(
    ['panel-SHIP', 'panel-REVISE', 'panel-disagreement', 'panel-quorum-lost'].includes(outcome.outcome),
    `bad-shape dispatch_fn must not crash the panel; got ${outcome.outcome}`
  );
  const badMember = outcome.member_results.find((r) => r.member_id === `${ROLE}@bad`);
  assert.ok(badMember, 'bad-shape member must appear in member_results');
  // The dispatcher's exact sentinel for "dispatch_fn returned wrong shape".
  assert.equal(
    badMember.parse_failure_reason,
    'dispatch-fn-bad-shape',
    `parse_failure_reason must be the documented sentinel 'dispatch-fn-bad-shape'; ` +
      `got: ${JSON.stringify(badMember.parse_failure_reason)}`
  );
  assert.equal(badMember.parsed_result, null);
  rmSync(dir, { recursive: true, force: true });
});

test('panel failure matrix: all members fail → outcome is panel-quorum-lost (no healthy members)', async () => {
  const { dir, spec, promptPath: _ } = makeSpec();
  const failingA = async (_req) => { throw new Error('a failed'); };
  const failingB = async (_req) => { throw new Error('b failed'); };
  const dispatchFns = new Map([
    [`${ROLE}@a`, failingA],
    [`${ROLE}@b`, failingB],
  ]);
  const outcome = await dispatchPanel(ROLE, baseRequest(spec, dir), dispatchFns);
  // When NO member returns a parseable result, there's no quorum.
  assert.equal(
    outcome.outcome,
    'panel-quorum-lost',
    `all-failing panel must report panel-quorum-lost; got ${outcome.outcome}\n` +
      `member results: ${JSON.stringify(outcome.member_results, null, 2)}`
  );
  rmSync(dir, { recursive: true, force: true });
});

test('panel failure matrix: 2/3 succeed + 1 throws → outcome respects 2-of-3 quorum (degraded)', async () => {
  const { dir, spec, promptPath } = makeSpec();
  const capturedTurns = [];
  const aWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@a`, role: ROLE, promptPath,
    adapter: 'cli-harness:codex', verdict: 'SHIP', capturedTurns,
  });
  const bWrap = makeWrappedDispatchFn({
    memberId: `${ROLE}@b`, role: ROLE, promptPath,
    adapter: 'claude-task', verdict: 'SHIP', capturedTurns,
  });
  const failingC = async (_req) => { throw new Error('c failed mid-flight'); };
  const dispatchFns = new Map([
    [`${ROLE}@a`, aWrap.fn],
    [`${ROLE}@b`, bWrap.fn],
    [`${ROLE}@c`, failingC],
  ]);
  const outcome = await dispatchPanel(
    ROLE, baseRequest(spec, dir), dispatchFns,
    { panel_min_size: 2, panel_max_size: 3 }
  );
  // With panel_min_size=2 and 2 healthy SHIP members, the panel should
  // proceed (NOT panel-quorum-lost). Degraded but consensus-reached.
  assert.notEqual(
    outcome.outcome,
    'panel-quorum-lost',
    `2 healthy + 1 failing should still meet quorum; got panel-quorum-lost.\n` +
      `member_results: ${JSON.stringify(outcome.member_results, null, 2)}`
  );
  rmSync(dir, { recursive: true, force: true });
});
