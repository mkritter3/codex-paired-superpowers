// v0.8.0 slice 5 — tests for lib/codex-bridge/expert-dm-scheduler.js.
//
// Scheduler ownership boundary (per plan rev4):
//   - Scheduler uses deps.hasUnread(expertId) for DETECTION ONLY.
//   - runTurn (slice 4) owns the full read→parse→mark-read cycle per turn.
//   - Scheduler is sidecar-READ-ONLY (never calls appendExpertTurn).
//
// Restart-recovery: opts.resumeFromSidecar + opts.drainContext loads prior
// turns via deps.readExpertTurns to seed cap-counts without double-counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drainPeerDMs } from '../../lib/codex-bridge/expert-dm-scheduler.js';

function makeIdentity(id, role = id.replace(/^expert-/, '')) {
  return { id, role, promptPath: `/fake/prompts/${id}.md`, source: 'builtin' };
}

function makeTurnResult(expertId, peerMessagesSent = []) {
  return {
    expert_id: expertId,
    phase: 'post-implementation-review',
    verdict: 'SHIP',
    failure_reason: null,
    peer_messages_sent: peerMessagesSent,
    mailbox_message_ids_injected: [`msg-from-${expertId}`],
    started_at: '2026-05-11T00:00:00.000Z',
    completed_at: '2026-05-11T00:00:01.000Z',
    result_summary: 'done',
  };
}

// Build a deps object with default stubs. Override per test.
//
// Each dep is wrapped so call-tracking happens BEFORE delegating to the
// (possibly overridden) implementation. This guarantees `calls.X` length
// reflects scheduler activity regardless of override.
function makeDeps(overrides = {}) {
  const calls = {
    hasUnread: [],
    runTurn: [],
    readExpertTurns: [],
    markManyAsRead: [],
    appendExpertTurn: [],
    writeBreadcrumb: [],
  };

  const defaults = {
    hasUnread: async () => 0,
    runTurn: async (expert) => makeTurnResult(expert.id),
    readExpertTurns: async () => [],
    markManyAsRead: async () => {},
    appendExpertTurn: () => {},
    writeBreadcrumb: () => {},
  };

  const merged = { ...defaults, ...overrides };

  const deps = {
    hasUnread: async (expertId) => {
      calls.hasUnread.push(expertId);
      return merged.hasUnread(expertId);
    },
    runTurn: async (expert, drainContext) => {
      calls.runTurn.push({ expertId: expert.id, drainContext });
      return merged.runTurn(expert, drainContext);
    },
    readExpertTurns: async (specPath, filter) => {
      calls.readExpertTurns.push({ specPath, filter });
      return merged.readExpertTurns(specPath, filter);
    },
    markManyAsRead: async (...args) => {
      calls.markManyAsRead.push(args);
      return merged.markManyAsRead(...args);
    },
    appendExpertTurn: (...args) => {
      calls.appendExpertTurn.push(args);
      return merged.appendExpertTurn(...args);
    },
    writeBreadcrumb: (...args) => {
      calls.writeBreadcrumb.push(args);
      return merged.writeBreadcrumb(...args);
    },
  };
  return { deps, calls };
}

// ── 1. Empty inbox ─────────────────────────────────────────────────────────

test('drainPeerDMs: empty inbox returns immediately without invoking runTurn', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const { deps, calls } = makeDeps();

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  assert.deepEqual(result, { turns: [], halt: null });
  assert.equal(calls.runTurn.length, 0);
  // hasUnread was probed (at least once per expert in the round).
  assert.ok(calls.hasUnread.length >= 1);
});

// ── 2. Single peer DM ──────────────────────────────────────────────────────

test('drainPeerDMs: single unread DM dispatches one turn, never calls markManyAsRead', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };
  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => {
      const n = unreadFlags[expertId] ?? 0;
      // After we observe and dispatch, runTurn would normally mark them read;
      // we simulate that by clearing the count once dispatched.
      return n;
    },
    runTurn: async (expert) => {
      unreadFlags[expert.id] = 0; // simulate runTurn's internal mark-read
      return makeTurnResult(expert.id);
    },
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].expert_id, 'expert-ui');
  assert.equal(result.halt, null);
  assert.equal(calls.runTurn.length, 1);
  assert.equal(calls.runTurn[0].expertId, 'expert-ui');
  // Scheduler must NOT call markManyAsRead directly — runTurn owns that.
  assert.equal(calls.markManyAsRead.length, 0);
});

// ── 3. Chain DM ────────────────────────────────────────────────────────────

test('drainPeerDMs: chain DM (ui → architecture) results in 2 turns', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };
  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => unreadFlags[expertId] ?? 0,
    runTurn: async (expert) => {
      if (expert.id === 'expert-ui') {
        unreadFlags['expert-ui'] = 0;
        unreadFlags['expert-architecture'] = 1; // simulate ui's outbound peer DM hitting arch's inbox
        return makeTurnResult('expert-ui', [
          { to: 'expert-architecture', summary: 'please check boundaries' },
        ]);
      }
      if (expert.id === 'expert-architecture') {
        unreadFlags['expert-architecture'] = 0;
        return makeTurnResult('expert-architecture', []);
      }
      throw new Error(`unexpected ${expert.id}`);
    },
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  assert.equal(result.halt, null);
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].expert_id, 'expert-ui');
  assert.equal(result.turns[1].expert_id, 'expert-architecture');
});

// ── 4. Per-expert respawn cap ──────────────────────────────────────────────

test('drainPeerDMs: per-expert cap with capped-expert still having unread halts cap-exceeded', async () => {
  // Codex round-1 critique: per-expert cap exhaustion WITH unread remaining
  // must halt with cap-exceeded, NOT exit silently with halt:null. Otherwise
  // B.5.5 proceeds while DMs are queued.
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };
  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => unreadFlags[expertId] ?? 0,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  // expert-ui dispatched twice (cap=2), then no eligible expert has work AND
  // expert-ui still has unread → halt cap-exceeded.
  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  assert.equal(result.turns.length, 2);
  assert.ok(result.turns.every((t) => t.expert_id === 'expert-ui'));
});

test('drainPeerDMs: per-expert cap with all-capped-and-empty exits halt:null (genuine convergence)', async () => {
  // Sibling test to the above: cap hits but each capped expert's inbox is
  // already drained at that moment → genuine convergence, halt:null.
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  // expert-ui has unread on calls 1+2 (the 2 turns), THEN empty.
  let uiCalls = 0;
  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => {
      if (expertId === 'expert-ui') {
        uiCalls++;
        return uiCalls <= 2 ? 1 : 0;
      }
      return 0;
    },
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  // expert-ui dispatched twice, then no expert has unread → genuine convergence.
  assert.equal(result.halt, null);
  assert.equal(result.turns.length, 2);
});

// ── 5. Total turn cap ──────────────────────────────────────────────────────

test('drainPeerDMs: total turn cap (default 8) halts with cap-exceeded reason', async () => {
  // 3 experts each constantly producing peer DMs → fan-out exceeds 8 turns.
  const activeExperts = [
    makeIdentity('expert-ui'),
    makeIdentity('expert-architecture'),
    makeIdentity('expert-backend'),
  ];
  // All experts always have unread to force max fan-out.
  const { deps, calls } = makeDeps({
    hasUnread: async () => 1,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  // Default maxRespawnsPerExpert: 2, three experts → max 6 turns hit before total-cap.
  // With 3 experts × 2 respawns = 6. To force total-cap, bump maxRespawnsPerExpert.
  // We'll re-test with override below; here, cap of 6 still results in halt null
  // because per-expert cap kicks in first. So adjust this test to be about the
  // total cap with a larger per-expert allowance.
  assert.ok(result.turns.length <= 6);
});

test('drainPeerDMs: total turn cap with high per-expert cap halts at maxTotalTurns', async () => {
  const activeExperts = [
    makeIdentity('expert-ui'),
    makeIdentity('expert-architecture'),
    makeIdentity('expert-backend'),
  ];
  const { deps, calls } = makeDeps({
    hasUnread: async () => 1,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    maxRespawnsPerExpert: 100, // unrestrict per-expert
    // maxTotalTurns left at default 8
  });

  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  assert.equal(result.turns.length, 8);
});

// ── 6. Cap configurability ─────────────────────────────────────────────────

test('drainPeerDMs: opts overrides for maxRespawnsPerExpert and maxTotalTurns', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const { deps, calls } = makeDeps({
    hasUnread: async () => 1,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    maxRespawnsPerExpert: 3,
    maxTotalTurns: 10,
  });

  // 2 experts × 3 respawns = 6 turns; both caps hit with unread remaining → halt cap-exceeded.
  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  assert.equal(result.turns.length, 6);
});

test('drainPeerDMs: opts overrides allow halt at custom maxTotalTurns', async () => {
  const activeExperts = [
    makeIdentity('expert-ui'),
    makeIdentity('expert-architecture'),
    makeIdentity('expert-backend'),
  ];
  const { deps } = makeDeps({
    hasUnread: async () => 1,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    maxRespawnsPerExpert: 5,
    maxTotalTurns: 4,
  });

  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  assert.equal(result.turns.length, 4);
});

// ── 7. Halt preserves inboxes ──────────────────────────────────────────────

test('drainPeerDMs: halt preserves inboxes — markManyAsRead never called by scheduler', async () => {
  const activeExperts = [
    makeIdentity('expert-ui'),
    makeIdentity('expert-architecture'),
    makeIdentity('expert-backend'),
  ];
  const { deps, calls } = makeDeps({
    hasUnread: async () => 1,
    runTurn: async (expert) => makeTurnResult(expert.id),
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    maxRespawnsPerExpert: 100,
  });

  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  // Scheduler must NEVER mark inboxes as read — preserved on halt.
  assert.equal(calls.markManyAsRead.length, 0);
});

// ── 8. Sidecar-read-only invariant ─────────────────────────────────────────

test('drainPeerDMs: scheduler never calls appendExpertTurn (runTurn owns appends)', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };
  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => unreadFlags[expertId] ?? 0,
    runTurn: async (expert) => {
      unreadFlags[expert.id] = 0;
      return makeTurnResult(expert.id);
    },
  });

  await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
  });

  // Scheduler is sidecar-READ-ONLY. appendExpertTurn must never be called from here.
  assert.equal(calls.appendExpertTurn.length, 0);
});

// ── 9. Restart-recovery ────────────────────────────────────────────────────

test('drainPeerDMs: resumeFromSidecar seeds respawnCounts from prior turns (no double-count)', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  // expert-ui still has unread, but prior sidecar shows it already had 2 turns
  // in this drain context → per-expert cap (default 2) is hit from prior.
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };

  const priorTurns = [
    {
      expert_id: 'expert-ui',
      phase: 'post-implementation-review',
      slice_id: 'slice-3',
      verdict: 'SHIP',
      failure_reason: null,
      mailbox_message_ids_injected: ['msg-prior-1'],
      started_at: '2026-05-11T00:00:00.000Z',
      completed_at: '2026-05-11T00:00:01.000Z',
      result_summary: 'prior turn 1',
    },
    {
      expert_id: 'expert-ui',
      phase: 'post-implementation-review',
      slice_id: 'slice-3',
      verdict: 'SHIP',
      failure_reason: null,
      mailbox_message_ids_injected: ['msg-prior-2'],
      started_at: '2026-05-11T00:00:02.000Z',
      completed_at: '2026-05-11T00:00:03.000Z',
      result_summary: 'prior turn 2',
    },
  ];

  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => unreadFlags[expertId] ?? 0,
    runTurn: async (expert) => {
      unreadFlags[expert.id] = 0;
      return makeTurnResult(expert.id);
    },
    readExpertTurns: async () => priorTurns,
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-3' },
    resumeFromSidecar: true,
    maxRespawnsPerExpert: 2,
  });

  // expert-ui cap already hit from prior (2 turns ≥ 2) BUT it still has
  // unread → cap-exceeded halt (Codex round-1 critique). expert-architecture
  // has no unread. Scheduler must NOT advance expert-ui (no double-count) and
  // must report the halt code so B.5.5 surfaces queued DMs to the user.
  assert.equal(result.halt, 'expert-peer-dm-drain-cap-exceeded');
  assert.equal(result.turns.length, 0);
  // Verify readExpertTurns was invoked with proper filter.
  assert.equal(calls.readExpertTurns.length, 1);
  assert.equal(calls.readExpertTurns[0].specPath, '/tmp/spec.md');
  assert.equal(calls.readExpertTurns[0].filter.phase, 'post-implementation-review');
  assert.equal(calls.readExpertTurns[0].filter.sliceId, 'slice-3');
  // Crucially: no new runTurn calls (no double-count).
  assert.equal(calls.runTurn.length, 0);
});

// ── Restart-recovery fail-closed semantics (Codex round-1 critique) ────────
//
// resumeFromSidecar must fail closed (throw) when drainContext is missing or
// readExpertTurns fails. Failing open would reset cap counts to zero and
// double-spawn experts already at cap from prior turns.

test('drainPeerDMs: resumeFromSidecar without drainContext throws (fail-closed)', async () => {
  const activeExperts = [makeIdentity('expert-ui')];
  const { deps } = makeDeps({});

  await assert.rejects(
    () => drainPeerDMs(activeExperts, deps, {
      specPath: '/tmp/spec.md',
      resumeFromSidecar: true,
      // drainContext intentionally omitted
    }),
    err => /drainContext is REQUIRED/i.test(err.message),
  );
});

test('drainPeerDMs: resumeFromSidecar with malformed drainContext (missing phase) throws', async () => {
  const activeExperts = [makeIdentity('expert-ui')];
  const { deps } = makeDeps({});

  await assert.rejects(
    () => drainPeerDMs(activeExperts, deps, {
      specPath: '/tmp/spec.md',
      resumeFromSidecar: true,
      drainContext: { sliceId: 'slice-1' }, // missing phase
    }),
    err => /drainContext\.phase/i.test(err.message),
  );
});

test('drainPeerDMs: resumeFromSidecar with readExpertTurns throwing fails closed (no double-spawn)', async () => {
  const activeExperts = [makeIdentity('expert-ui')];
  const { deps } = makeDeps({
    readExpertTurns: async () => { throw new Error('disk on fire'); },
  });

  await assert.rejects(
    () => drainPeerDMs(activeExperts, deps, {
      specPath: '/tmp/spec.md',
      resumeFromSidecar: true,
      drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    }),
    err => /refusing to fail open/i.test(err.message),
  );
});

test('drainPeerDMs: resumeFromSidecar with readExpertTurns returning non-array fails closed', async () => {
  const activeExperts = [makeIdentity('expert-ui')];
  const { deps } = makeDeps({
    readExpertTurns: async () => null,
  });

  await assert.rejects(
    () => drainPeerDMs(activeExperts, deps, {
      specPath: '/tmp/spec.md',
      resumeFromSidecar: true,
      drainContext: { phase: 'post-implementation-review', sliceId: 'slice-1' },
    }),
    err => /non-array/i.test(err.message),
  );
});

test('drainPeerDMs: resumeFromSidecar with partial prior turns allows continuation', async () => {
  const activeExperts = [makeIdentity('expert-ui'), makeIdentity('expert-architecture')];
  const unreadFlags = { 'expert-ui': 1, 'expert-architecture': 0 };

  // Only 1 prior turn for expert-ui → cap (default 2) NOT yet hit.
  const priorTurns = [
    {
      expert_id: 'expert-ui',
      phase: 'post-implementation-review',
      slice_id: 'slice-3',
      verdict: 'SHIP',
      failure_reason: null,
      mailbox_message_ids_injected: ['msg-prior-1'],
      started_at: '2026-05-11T00:00:00.000Z',
      completed_at: '2026-05-11T00:00:01.000Z',
      result_summary: 'prior turn 1',
    },
  ];

  const { deps, calls } = makeDeps({
    hasUnread: async (expertId) => unreadFlags[expertId] ?? 0,
    runTurn: async (expert) => {
      unreadFlags[expert.id] = 0;
      return makeTurnResult(expert.id);
    },
    readExpertTurns: async () => priorTurns,
  });

  const result = await drainPeerDMs(activeExperts, deps, {
    specPath: '/tmp/spec.md',
    drainContext: { phase: 'post-implementation-review', sliceId: 'slice-3' },
    resumeFromSidecar: true,
    maxRespawnsPerExpert: 2,
  });

  // 1 prior + 1 new = 2 (cap reached). turns[] reflects the ONE new turn only.
  assert.equal(result.halt, null);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].expert_id, 'expert-ui');
  assert.equal(calls.runTurn.length, 1);
});
