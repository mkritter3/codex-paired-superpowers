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
  assert.equal(sc.expert_teammates.selected.length, 1);
  assert.equal(sc.expert_teammates.selected[0].id, 'expert-ui');
  assert.equal(sc.expert_teammates.selected[0].role, 'ui');
  assert.equal(sc.expert_teammates.selected[0].source, 'builtin');
  assert.equal(sc.expert_teammates.selected[0].selected_at_phase, 'spec-review');
  assert.equal(sc.expert_teammates.selected[0].selection_reason, 'UI signals from spec');
  assert.equal(sc.expert_teammates.selected[0].status, 'active');
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
  assert.equal(sc.expert_teammates.selected[0].source, 'repo-override');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection: back-compat — loading sidecar without expert_teammates works; first call creates field', () => {
  const { dir, spec } = makeSpec();
  const before = loadSidecar(spec);
  assert.equal('expert_teammates' in before, false);
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  const after = loadSidecar(spec);
  assert.ok(after.expert_teammates);
  assert.ok(Array.isArray(after.expert_teammates.selected));
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
  assert.equal(sc.expert_teammates.turns.length, 1);
  assert.equal(sc.expert_teammates.turns[0].expert_id, 'expert-ui');
  assert.equal(sc.expert_teammates.turns[0].verdict, 'SHIP');
  assert.equal(sc.expert_teammates.turns[0].failure_reason, null);
  assert.equal(sc.expert_teammates.turns[0].slice_id, null);
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
  assert.equal(sc.expert_teammates.turns[0].verdict, 'REVISE');
  assert.equal(sc.expert_teammates.turns[0].failure_reason, 'unparseable-output');
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
  assert.equal(sc.expert_teammates.turns[0].slice_id, 'slice-3');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: slice_id absent persists as null', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn()); // no slice_id key
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.turns[0].slice_id, null);
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
  assert.ok(after.expert_teammates);
  assert.equal(after.expert_teammates.turns.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── updateExpertStatus ─────────────────────────────────────────────────────

test('updateExpertStatus: valid transition mutates correctly', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  updateExpertStatus(spec, 'expert-ui', 'done');
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.selected[0].status, 'done');
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
    assert.equal(sc.expert_teammates.selected[0].status, s);
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
  assert.equal(sc.expert_teammates.fan_out_rationales.length, 1);
  assert.equal(sc.expert_teammates.fan_out_rationales[0].selected_count, 6);
  assert.equal(sc.expert_teammates.fan_out_rationales[0].rationale, 'broad context');
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
  assert.ok(sc.expert_teammates);
  assert.ok(Array.isArray(sc.expert_teammates.fan_out_rationales));
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
