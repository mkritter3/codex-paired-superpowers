// v0.8.0 slice 4 — sidecar expert_teammates schema additions.
//
// Covers the 6 new exports + extended appendImplementDispatch validation
// in lib/codex-bridge/sidecar.js per spec §Rehydration State and the
// slice 4 plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  appendImplementDispatch,
  appendExpertSelection,
  appendExpertTurn,
  updateExpertStatus,
  appendFanOutRationale,
  readExpertTurns,
  updateDispatchExpertBlocker,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-experts-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

// ── appendExpertSelection ──────────────────────────────────────────────────

test('appendExpertSelection: valid input round-trips into expert_teammates.selected[]', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, {
    id: 'expert-ui',
    role: 'ui',
    source: 'builtin',
    phase: 'spec-review',
    selectionReason: 'UI signals from spec',
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.selected.length, 1);
  assert.equal(sc.reviewer_teammates.selected[0].id, 'expert-ui');
  assert.equal(sc.reviewer_teammates.selected[0].role, 'ui');
  assert.equal(sc.reviewer_teammates.selected[0].source, 'builtin');
  assert.equal(sc.reviewer_teammates.selected[0].selected_at_phase, 'spec-review');
  assert.equal(sc.reviewer_teammates.selected[0].selection_reason, 'UI signals from spec');
  assert.equal(sc.reviewer_teammates.selected[0].status, 'active');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: rejects empty id', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendExpertSelection(spec, { id: '', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' })
  , /id/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: rejects empty role', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendExpertSelection(spec, { id: 'expert-ui', role: '', source: 'builtin', phase: 'spec-review', selectionReason: 'r' })
  , /role/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: rejects source not in {builtin, repo-override}', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'bogus', phase: 'spec-review', selectionReason: 'r' })
  , /source/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: accepts source "repo-override"', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'repo-override', phase: 'spec-review', selectionReason: 'r' });
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.selected[0].source, 'repo-override');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: back-compat — loading sidecar without expert_teammates works; first call creates field', () => {
  const { dir, spec } = makeSpec();
  const before = loadSidecar(spec);
  assert.equal('expert_teammates' in before, false);
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  const after = loadSidecar(spec);
  assert.ok(after.reviewer_teammates);
  assert.ok(Array.isArray(after.reviewer_teammates.selected));
  rmSync(dir, { recursive: true, force: true });
});

// ── appendExpertTurn ───────────────────────────────────────────────────────

function validTurn(overrides = {}) {
  return {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    mailbox_message_ids_injected: ['msg-1'],
    started_at: '2026-05-11T12:00:00.000Z',
    completed_at: '2026-05-11T12:00:45.000Z',
    result_summary: 'SHIP',
    verdict: 'SHIP',
    failure_reason: null,
    ...overrides,
  };
}

test('appendExpertTurn: valid turn round-trips', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn());
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns.length, 1);
  assert.equal(sc.reviewer_teammates.turns[0].expert_id, 'expert-ui');
  assert.equal(sc.reviewer_teammates.turns[0].verdict, 'SHIP');
  assert.equal(sc.reviewer_teammates.turns[0].failure_reason, null);
  assert.equal(sc.reviewer_teammates.turns[0].slice_id, null);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects non-array mailbox_message_ids_injected', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ mailbox_message_ids_injected: 'msg-1' })), /mailbox_message_ids_injected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects array containing non-string element', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ mailbox_message_ids_injected: ['msg-1', 42] })), /mailbox_message_ids_injected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects array containing empty string', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ mailbox_message_ids_injected: ['msg-1', ''] })), /mailbox_message_ids_injected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects verdict not in {SHIP, REVISE}', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ verdict: 'OK' })), /verdict/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: accepts verdict REVISE', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ verdict: 'REVISE', failure_reason: 'unparseable-output' }));
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns[0].verdict, 'REVISE');
  assert.equal(sc.reviewer_teammates.turns[0].failure_reason, 'unparseable-output');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects non-string-and-non-null failure_reason', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ failure_reason: 42 })), /failure_reason/i);
  assert.throws(() => appendExpertTurn(spec, validTurn({ failure_reason: '' })), /failure_reason/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: slice_id "slice-3" round-trips', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ slice_id: 'slice-3' }));
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns[0].slice_id, 'slice-3');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: slice_id absent persists as null', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn()); // no slice_id key
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns[0].slice_id, null);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects non-string slice_id', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendExpertTurn(spec, validTurn({ slice_id: 3 })), /slice_id/i);
  assert.throws(() => appendExpertTurn(spec, validTurn({ slice_id: '' })), /slice_id/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: back-compat — first append creates expert_teammates field', () => {
  const { dir, spec } = makeSpec();
  const before = loadSidecar(spec);
  assert.equal('expert_teammates' in before, false);
  appendExpertTurn(spec, validTurn());
  const after = loadSidecar(spec);
  assert.ok(after.reviewer_teammates);
  assert.equal(after.reviewer_teammates.turns.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── updateExpertStatus ─────────────────────────────────────────────────────

test('updateExpertStatus: valid transition mutates correctly', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  updateExpertStatus(spec, 'expert-ui', 'done');
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.selected[0].status, 'done');
  rmSync(dir, { recursive: true, force: true });
});

test('updateExpertStatus: rejects unknown status enum', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  assert.throws(() => updateExpertStatus(spec, 'expert-ui', 'bogus'), /status/i);
  rmSync(dir, { recursive: true, force: true });
});

test('updateExpertStatus: throws when expert not in selected[]', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  assert.throws(() => updateExpertStatus(spec, 'expert-missing', 'done'), /expert-missing/);
  rmSync(dir, { recursive: true, force: true });
});

test('updateExpertStatus: accepts all valid statuses', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  for (const s of ['active', 'waiting', 'done', 'failed', 'archived']) {
    updateExpertStatus(spec, 'expert-ui', s);
    const sc = loadSidecar(spec);
    assert.equal(sc.reviewer_teammates.selected[0].status, s);
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── appendFanOutRationale ──────────────────────────────────────────────────

test('appendFanOutRationale: rejects selected_count <= 5', () => {
  const { dir, spec } = makeSpec();
  for (const n of [0, 1, 5]) {
    assert.throws(() =>
      appendFanOutRationale(spec, { phase: 'spec-review', selected_count: n, rationale: 'r' })
    , /selected_count/i);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('appendFanOutRationale: accepts selected_count >= 6', () => {
  const { dir, spec } = makeSpec();
  appendFanOutRationale(spec, { phase: 'spec-review', selected_count: 6, rationale: 'broad context' });
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.fan_out_rationales.length, 1);
  assert.equal(sc.reviewer_teammates.fan_out_rationales[0].selected_count, 6);
  assert.equal(sc.reviewer_teammates.fan_out_rationales[0].rationale, 'broad context');
  rmSync(dir, { recursive: true, force: true });
});

test('appendFanOutRationale: rejects empty rationale', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendFanOutRationale(spec, { phase: 'spec-review', selected_count: 6, rationale: '' })
  , /rationale/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendFanOutRationale: back-compat — creates expert_teammates on first call', () => {
  const { dir, spec } = makeSpec();
  appendFanOutRationale(spec, { phase: 'spec-review', selected_count: 6, rationale: 'wide' });
  const sc = loadSidecar(spec);
  assert.ok(sc.reviewer_teammates);
  assert.ok(Array.isArray(sc.reviewer_teammates.fan_out_rationales));
  rmSync(dir, { recursive: true, force: true });
});

// ── readExpertTurns ────────────────────────────────────────────────────────

test('readExpertTurns: returns [] for old sidecar without expert_teammates', () => {
  const { dir, spec } = makeSpec();
  assert.deepEqual(readExpertTurns(spec, { phase: 'spec-review' }), []);
  rmSync(dir, { recursive: true, force: true });
});

test('readExpertTurns: filters by phase', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ phase: 'spec-review' }));
  appendExpertTurn(spec, validTurn({ phase: 'pre-dispatch' }));
  const got = readExpertTurns(spec, { phase: 'spec-review' });
  assert.equal(got.length, 1);
  assert.equal(got[0].phase, 'spec-review');
  rmSync(dir, { recursive: true, force: true });
});

test('readExpertTurns: filters by sliceId when provided', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ phase: 'post-implementation-review', slice_id: 'slice-3' }));
  appendExpertTurn(spec, validTurn({ phase: 'post-implementation-review', slice_id: 'slice-4' }));
  const got = readExpertTurns(spec, { phase: 'post-implementation-review', sliceId: 'slice-4' });
  assert.equal(got.length, 1);
  assert.equal(got[0].slice_id, 'slice-4');
  rmSync(dir, { recursive: true, force: true });
});

test('readExpertTurns: phase match required (no result when phase differs)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ phase: 'spec-review' }));
  assert.deepEqual(readExpertTurns(spec, { phase: 'pre-dispatch' }), []);
  rmSync(dir, { recursive: true, force: true });
});

// ── updateDispatchExpertBlocker ────────────────────────────────────────────

function seedDispatchWithBlocker(spec) {
  const dispatchedAt = '2026-05-11T13:00:00.000Z';
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: dispatchedAt,
    worktree: '/w',
    outcome: 'shipped',
    experts_selected: ['expert-ui'],
    expert_turn_ids: ['turn-1'],
    expert_blockers: [
      {
        expert_id: 'expert-ui',
        finding_id: 'ui-1',
        summary: 'leak',
        location: 'panel.tsx',
        disposition: 'open',
      },
    ],
  });
  return { dispatchedAt };
}

test('updateDispatchExpertBlocker: throws when dispatch not found', () => {
  const { dir, spec } = makeSpec();
  seedDispatchWithBlocker(spec);
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: '2099-01-01T00:00:00.000Z' },
      'ui-1',
      { disposition: 'resolved' }
    )
  , /dispatch/i);
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: throws when finding not found', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-missing',
      { disposition: 'resolved' }
    )
  , /finding/i);
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: throws on unknown disposition', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'maybe' }
    )
  , /disposition/i);
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: technical-override requires rationale AND evidence', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  // missing rationale
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'technical-override', evidence: ['link1'] }
    )
  , /rationale/i);
  // missing evidence
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'technical-override', rationale: 'because' }
    )
  , /evidence/i);
  // empty rationale
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'technical-override', rationale: '', evidence: ['e'] }
    )
  , /rationale/i);
  // empty evidence array
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'technical-override', rationale: 'because', evidence: [] }
    )
  , /evidence/i);
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: technical-override with both rationale and evidence succeeds, mutates in place', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  updateDispatchExpertBlocker(
    spec,
    { sliceId: 'slice-3', dispatched_at: dispatchedAt },
    'ui-1',
    { disposition: 'technical-override', rationale: 'investigated, false positive', evidence: ['link-to-pr', 'link-to-issue'] }
  );
  const sc = loadSidecar(spec);
  const blocker = sc.slice_reviews['slice-3'].phases.implement.dispatches[0].expert_blockers[0];
  assert.equal(blocker.disposition, 'technical-override');
  assert.equal(blocker.rationale, 'investigated, false positive');
  assert.deepEqual(blocker.evidence, ['link-to-pr', 'link-to-issue']);
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: needs-user requires non-empty rationale', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'needs-user' }
    )
  , /rationale/i);
  updateDispatchExpertBlocker(
    spec,
    { sliceId: 'slice-3', dispatched_at: dispatchedAt },
    'ui-1',
    { disposition: 'needs-user', rationale: 'product question' }
  );
  const sc = loadSidecar(spec);
  const blocker = sc.slice_reviews['slice-3'].phases.implement.dispatches[0].expert_blockers[0];
  assert.equal(blocker.disposition, 'needs-user');
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: deferred requires non-empty rationale', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  assert.throws(() =>
    updateDispatchExpertBlocker(
      spec,
      { sliceId: 'slice-3', dispatched_at: dispatchedAt },
      'ui-1',
      { disposition: 'deferred' }
    )
  , /rationale/i);
  updateDispatchExpertBlocker(
    spec,
    { sliceId: 'slice-3', dispatched_at: dispatchedAt },
    'ui-1',
    { disposition: 'deferred', rationale: 'punt to slice 5' }
  );
  rmSync(dir, { recursive: true, force: true });
});

test('updateDispatchExpertBlocker: resolved requires nothing extra', () => {
  const { dir, spec } = makeSpec();
  const { dispatchedAt } = seedDispatchWithBlocker(spec);
  updateDispatchExpertBlocker(
    spec,
    { sliceId: 'slice-3', dispatched_at: dispatchedAt },
    'ui-1',
    { disposition: 'resolved' }
  );
  const sc = loadSidecar(spec);
  const blocker = sc.slice_reviews['slice-3'].phases.implement.dispatches[0].expert_blockers[0];
  assert.equal(blocker.disposition, 'resolved');
  rmSync(dir, { recursive: true, force: true });
});

// ── appendImplementDispatch extension (experts fields) ─────────────────────

test('appendImplementDispatch: accepts experts_selected + expert_turn_ids + expert_blockers when valid', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-11T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
    experts_selected: ['expert-ui', 'expert-ux'],
    expert_turn_ids: ['t1', 't2'],
    expert_blockers: [
      { expert_id: 'expert-ui', finding_id: 'ui-1', summary: 's', location: 'l', disposition: 'open' },
    ],
  });
  const d = loadSidecar(spec).slice_reviews['slice-3'].phases.implement.dispatches[0];
  assert.deepEqual(d.experts_selected, ['expert-ui', 'expert-ux']);
  assert.deepEqual(d.expert_turn_ids, ['t1', 't2']);
  assert.equal(d.expert_blockers.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: empty experts arrays allowed', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-11T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
    experts_selected: [],
    expert_turn_ids: [],
    expert_blockers: [],
  });
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: experts fields absent/null preserved as before (back-compat)', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-11T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
    experts_selected: null,
    expert_turn_ids: undefined,
  });
  const d = loadSidecar(spec).slice_reviews['slice-3'].phases.implement.dispatches[0];
  assert.equal('experts_selected' in d, true); // null stored as-is? no — null/undef treated as absent
  // We treat null/undefined as absent. Acceptable: serialized may keep null.
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: rejects non-array experts_selected', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'sonnet',
      dispatched_at: '2026-05-11T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
      experts_selected: 'expert-ui',
    })
  , /experts_selected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: rejects non-array expert_turn_ids', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'sonnet',
      dispatched_at: '2026-05-11T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
      expert_turn_ids: 't1',
    })
  , /expert_turn_ids/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: rejects blocker missing required field', () => {
  const { dir, spec } = makeSpec();
  for (const missing of ['expert_id', 'finding_id', 'summary', 'location', 'disposition']) {
    const blocker = { expert_id: 'e', finding_id: 'f', summary: 's', location: 'l', disposition: 'open' };
    delete blocker[missing];
    assert.throws(() =>
      appendImplementDispatch(spec, `slice-${missing}`, {
        slice_id: `slice-${missing}`,
        agent: 'sonnet',
        dispatched_at: '2026-05-11T12:00:00.000Z',
        worktree: '/w',
        outcome: 'shipped',
        expert_blockers: [blocker],
      })
    , new RegExp(missing));
  }
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch: rejects blocker initial disposition not "open"', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'sonnet',
      dispatched_at: '2026-05-11T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
      expert_blockers: [
        { expert_id: 'e', finding_id: 'f', summary: 's', location: 'l', disposition: 'resolved' },
      ],
    })
  , /disposition/i);
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.8.1 appendExpertTurn peer-DM audit fields ──────────────────────────

test('appendExpertTurn v0.8.1: accepts peer_messages_enqueued + peer_messages_failed (round-trip)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    peer_messages_enqueued: [
      { to: 'expert-ux', message_id: 'msg-1', summary: 's' },
      { to: 'expert-architecture', message_id: 'msg-2' },
    ],
    peer_messages_failed: [
      { to: 'expert-FOO!!', reason: 'invalid-recipient', code: 'mailbox-recipient-malformed' },
      { to: null, reason: 'malformed-item', code: 'malformed-item' },
    ],
  }));
  const sc = loadSidecar(spec);
  const t = sc.reviewer_teammates.turns[0];
  assert.equal(t.peer_messages_enqueued.length, 2);
  assert.equal(t.peer_messages_enqueued[0].to, 'expert-ux');
  assert.equal(t.peer_messages_enqueued[0].message_id, 'msg-1');
  assert.equal(t.peer_messages_failed.length, 2);
  assert.equal(t.peer_messages_failed[0].code, 'mailbox-recipient-malformed');
  assert.equal(t.peer_messages_failed[1].to, null, 'null to allowed for malformed-item');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1: peer fields absent (back-compat with pre-0.8.1)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn()); // no peer_messages_* fields
  const sc = loadSidecar(spec);
  const t = sc.reviewer_teammates.turns[0];
  assert.equal('peer_messages_enqueued' in t, false);
  assert.equal('peer_messages_failed' in t, false);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1: rejects non-array peer_messages_enqueued', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ peer_messages_enqueued: { x: 1 } })),
    /peer_messages_enqueued/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1: rejects peer_messages_enqueued element missing message_id', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ peer_messages_enqueued: [{ to: 'expert-ux' }] })),
    /message_id/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1: rejects peer_messages_failed element missing reason', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ peer_messages_failed: [{ to: 'expert-ux' }] })),
    /reason/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.8.1.1 overflow-audit optional fields ────────────────────────────

test('appendExpertTurn v0.8.1.1: accepts count-cap-exceeded entry with overflow audit fields', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    peer_messages_failed: [
      {
        to: null,
        reason: 'count-cap-exceeded',
        code: 'count-cap-exceeded',
        overflow_count: 97,
        max_allowed: 3,
        sample_to: ['expert-ux', 'expert-architecture', 'expert-backend'],
      },
    ],
  }));
  const sc = loadSidecar(spec);
  const failed = sc.reviewer_teammates.turns[0].peer_messages_failed[0];
  assert.equal(failed.overflow_count, 97);
  assert.equal(failed.max_allowed, 3);
  assert.deepEqual(failed.sample_to, ['expert-ux', 'expert-architecture', 'expert-backend']);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1.1: rejects negative overflow_count', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      peer_messages_failed: [{ to: null, reason: 'count-cap-exceeded', overflow_count: -1 }],
    })),
    /overflow_count/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1.1: rejects non-finite max_allowed', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      peer_messages_failed: [{ to: null, reason: 'count-cap-exceeded', max_allowed: Infinity }],
    })),
    /max_allowed/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1.1: rejects non-array sample_to', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      peer_messages_failed: [{ to: null, reason: 'count-cap-exceeded', sample_to: 'not-an-array' }],
    })),
    /sample_to/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1.1: rejects sample_to with empty-string element', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      peer_messages_failed: [{ to: null, reason: 'count-cap-exceeded', sample_to: ['expert-ux', ''] }],
    })),
    /sample_to/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn v0.8.1.1: regular per-item failure (no overflow fields) still accepted', () => {
  // Back-compat: an entry without overflow fields (regular invalid-recipient,
  // self-dm, etc.) must still parse cleanly.
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    peer_messages_failed: [
      { to: 'expert-FOO!!', reason: 'invalid-recipient', code: 'mailbox-recipient-malformed' },
    ],
  }));
  const sc = loadSidecar(spec);
  const failed = sc.reviewer_teammates.turns[0].peer_messages_failed[0];
  assert.equal(failed.reason, 'invalid-recipient');
  assert.equal('overflow_count' in failed, false);
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.9.0 slice 5b round-1 fix: replay/response audit field persistence ────
//
// These tests pin the PERSIST → LOAD → REPLAY/READ cycle. Before this fix,
// appendExpertTurn whitelisted a fixed set of fields and silently dropped any
// replay or response-audit fields supplied by the caller — so storeResponse(),
// readResponse() and replayTurn() couldn't be exercised against real persisted
// turns.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeResponse, readResponse, computeInputsHash } from '../../lib/codex-bridge/sidecar.js';
import { replayTurn } from '../../lib/codex-bridge/replay.js';

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

test('appendExpertTurn → loadSidecar: inline response preserved + readResponse retrieves it', () => {
  const { dir, spec } = makeSpec();
  const responseText = 'Looks fine. SHIP.';
  const responseHash = `sha256:${sha256Hex(responseText)}`;
  appendExpertTurn(spec, validTurn({
    response_text_inline: responseText,
    response_hash: responseHash,
  }));
  const sc = loadSidecar(spec);
  const turn = sc.reviewer_teammates.turns[0];
  assert.equal(turn.response_text_inline, responseText);
  assert.equal(turn.response_hash, responseHash);
  assert.equal(readResponse(dir, turn), responseText);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn → loadSidecar: overflow response_ref preserved + readResponse retrieves from disk', () => {
  const { dir, spec } = makeSpec();
  // Force overflow: store at maxInlineBytes=1 so the bytes go to disk.
  const big = 'X'.repeat(100);
  const stored = storeResponse(dir, big, { maxInlineBytes: 1 });
  assert.ok(stored.response_ref, 'precondition: overflow path used');
  appendExpertTurn(spec, validTurn({
    response_ref: stored.response_ref,
    response_hash: stored.response_hash,
  }));
  const sc = loadSidecar(spec);
  const turn = sc.reviewer_teammates.turns[0];
  assert.equal(turn.response_ref, stored.response_ref);
  assert.equal(turn.response_hash, stored.response_hash);
  assert.equal(turn.response_text_inline, undefined);
  assert.equal(readResponse(dir, turn), big);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn → loadSidecar → replayTurn: full replay reconstruction works on persisted turn', () => {
  const { dir, spec } = makeSpec();
  const rolePromptBody = 'You are the expert-architecture reviewer.';
  const rolePromptFile = `---\nversion: v0.9.0-r1\nrole_id: expert-architecture\n---\n${rolePromptBody}`;
  const rolePromptHashHex = sha256Hex(rolePromptFile);
  const specSnippet = 'spec snippet';
  const specSnippetHashHex = sha256Hex(specSnippet);
  const mailboxIds = ['msg-1', 'msg-2'];
  const phase = 'spec-review';
  const task = 'review architecture';
  const roleId = 'expert-architecture';
  const responseText = 'OK SHIP';
  const stored = storeResponse(dir, responseText);
  const inputsHash = computeInputsHash({
    rolePromptHash: rolePromptHashHex,
    specSnippetHash: specSnippetHashHex,
    mailboxMessageIds: mailboxIds,
    phase,
    task,
    roleId,
  });

  appendExpertTurn(spec, validTurn({
    expert_id: roleId,
    phase,
    mailbox_message_ids_injected: mailboxIds,
    mailbox_message_ids: mailboxIds,
    role_prompt_hash: `sha256:${rolePromptHashHex}`,
    role_prompt_version: 'v0.9.0-r1',
    spec_path: '/abs/spec.md',
    spec_snippet_hash: `sha256:${specSnippetHashHex}`,
    inputs_hash: inputsHash,
    response_text_inline: stored.response_text_inline,
    response_hash: stored.response_hash,
    adapter: 'codex',
    requested_role: roleId,
    task,
  }));

  const sc = loadSidecar(spec);
  const turn = sc.reviewer_teammates.turns[0];
  // All replay fields preserved.
  assert.equal(turn.role_prompt_hash, `sha256:${rolePromptHashHex}`);
  assert.equal(turn.role_prompt_version, 'v0.9.0-r1');
  assert.equal(turn.spec_path, '/abs/spec.md');
  assert.equal(turn.spec_snippet_hash, `sha256:${specSnippetHashHex}`);
  assert.equal(turn.inputs_hash, inputsHash);
  assert.equal(turn.adapter, 'codex');
  assert.equal(turn.requested_role, roleId);
  assert.equal(turn.task, task);
  assert.deepEqual(turn.mailbox_message_ids, mailboxIds);

  // Replay the loaded turn.
  const result = replayTurn(turn, {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHashHex, version: 'v0.9.0-r1' }),
    readMailboxMessages: (_root, ids) =>
      ids.map((id, i) => ({ id, from: 'orchestrator', text: `body-${i}`, timestamp: '2026-05-11T00:00:00.000Z' })),
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'codex',
  });
  assert.equal(result.inputsHashMatches, true, 'inputs_hash must match after persist→load round-trip');
  assert.equal(result.responseHashMatches, true, 'response_hash must match');
  assert.deepEqual(result.warnings, [], `no warnings expected (got: ${JSON.stringify(result.warnings)})`);
  assert.ok(result.assembledPrompt.includes(rolePromptBody));
  assert.ok(result.assembledPrompt.includes(specSnippet));
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects when both response_text_inline AND response_ref supplied (mutually exclusive)', () => {
  const { dir, spec } = makeSpec();
  const text = 'inline';
  const hash = `sha256:${sha256Hex(text)}`;
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_text_inline: text,
      response_ref: `responses/sha256-${'a'.repeat(64)}.txt`,
      response_hash: hash,
    })),
    /response_text_inline.*response_ref|mutually exclusive/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: validates response_hash format (sha256:<64hex>)', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_text_inline: 'x',
      response_hash: 'not-a-valid-hash',
    })),
    /response_hash/i,
  );
  // Wrong prefix
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_text_inline: 'x',
      response_hash: `md5:${'a'.repeat(64)}`,
    })),
    /response_hash/i,
  );
  // Wrong hex length
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_text_inline: 'x',
      response_hash: `sha256:${'a'.repeat(63)}`,
    })),
    /response_hash/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: validates response_ref format (responses/sha256-<64hex>.txt)', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_ref: 'not/a/valid/ref.txt',
      response_hash: `sha256:${'b'.repeat(64)}`,
    })),
    /response_ref/i,
  );
  // Wrong directory
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_ref: `other/sha256-${'b'.repeat(64)}.txt`,
      response_hash: `sha256:${'b'.repeat(64)}`,
    })),
    /response_ref/i,
  );
  // Wrong hex length
  assert.throws(
    () => appendExpertTurn(spec, validTurn({
      response_ref: `responses/sha256-${'b'.repeat(63)}.txt`,
      response_hash: `sha256:${'b'.repeat(64)}`,
    })),
    /response_ref/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: validates inputs_hash + role_prompt_hash + spec_snippet_hash formats', () => {
  const { dir, spec } = makeSpec();
  for (const field of ['inputs_hash', 'role_prompt_hash', 'spec_snippet_hash']) {
    assert.throws(
      () => appendExpertTurn(spec, validTurn({ [field]: 'sha1:short' })),
      new RegExp(field, 'i'),
    );
  }
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: validates mailbox_message_ids when present (array of non-empty strings)', () => {
  const { dir, spec } = makeSpec();
  // wrong type
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ mailbox_message_ids: 'not-an-array' })),
    /mailbox_message_ids/i,
  );
  // empty string in array
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ mailbox_message_ids: ['ok', ''] })),
    /mailbox_message_ids/i,
  );
  // valid round-trip
  appendExpertTurn(spec, validTurn({ mailbox_message_ids: ['m-a', 'm-b'] }));
  const sc = loadSidecar(spec);
  assert.deepEqual(sc.reviewer_teammates.turns[0].mailbox_message_ids, ['m-a', 'm-b']);
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.9.0 slice 8 follow-up: resolution-audit fields per spec § 7 Tier 1 ──

test('appendExpertTurn: persists full resolution-audit block when present', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    resolved_cli: 'codex',
    resolution_source: 'recommendation',
    preference_index: 0,
    preference_ladder: ['codex', 'claude'],
    unavailable_candidates: [],
    fallback_reason: null,
  }));
  const t = loadSidecar(spec).reviewer_teammates.turns[0];
  assert.equal(t.resolved_cli, 'codex');
  assert.equal(t.resolution_source, 'recommendation');
  assert.equal(t.preference_index, 0);
  assert.deepEqual(t.preference_ladder, ['codex', 'claude']);
  assert.deepEqual(t.unavailable_candidates, []);
  // fallback_reason must be persisted as null explicitly (not absent), so
  // gate criterion 3's `f in t` presence check passes when no fallback.
  assert.ok('fallback_reason' in t, 'fallback_reason field must be present in the turn record');
  assert.equal(t.fallback_reason, null);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: preference_index accepts -1 (override path)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    resolved_cli: 'codex',
    resolution_source: 'override',
    preference_index: -1,
    preference_ladder: ['codex', 'claude'],
    unavailable_candidates: [],
    fallback_reason: null,
  }));
  const t = loadSidecar(spec).reviewer_teammates.turns[0];
  assert.equal(t.preference_index, -1);
  assert.equal(t.resolution_source, 'override');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: fallback_reason as non-empty string round-trips', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({
    resolved_cli: 'claude',
    resolution_source: 'recommendation',
    preference_index: 1,
    preference_ladder: ['codex', 'claude'],
    unavailable_candidates: ['codex'],
    fallback_reason: 'Preferred codex unavailable; fell back to claude.',
  }));
  const t = loadSidecar(spec).reviewer_teammates.turns[0];
  assert.equal(t.fallback_reason, 'Preferred codex unavailable; fell back to claude.');
  assert.deepEqual(t.unavailable_candidates, ['codex']);
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects non-integer preference_index', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ preference_index: 1.5 })),
    /preference_index/i,
  );
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ preference_index: '0' })),
    /preference_index/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects preference_ladder with empty-string entries', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ preference_ladder: ['codex', ''] })),
    /preference_ladder/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: rejects fallback_reason as empty string', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendExpertTurn(spec, validTurn({ fallback_reason: '' })),
    /fallback_reason/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: resolution-audit fields are optional (omit → not persisted)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn());  // no resolution fields
  const t = loadSidecar(spec).reviewer_teammates.turns[0];
  assert.ok(!('resolved_cli' in t));
  assert.ok(!('resolution_source' in t));
  assert.ok(!('preference_index' in t));
  assert.ok(!('preference_ladder' in t));
  assert.ok(!('unavailable_candidates' in t));
  assert.ok(!('fallback_reason' in t));
  rmSync(dir, { recursive: true, force: true });
});
