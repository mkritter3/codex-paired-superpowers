// Plan 3 slice 6 — sidecar reviewer_teammates fields + dual-read + migrate-on-load.
//
// Spec authority: §"Sidecar migration".
//   Canonical fields: reviewer_teammates.{selected,turns,fan_out_rationales}[];
//   dispatch records use reviewers_selected / reviewer_turn_ids / reviewer_blockers.
//   On load, a sidecar containing only expert_teammates is exposed through the
//   reviewer API and a single migration record is appended (idempotent).
//   New writes use reviewer field names; appendExpert* delegate to the reviewer
//   block so old callers converge on canonical storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initSidecar,
  loadSidecar,
  sidecarPathFor,
  appendImplementDispatch,
  appendReviewerSelection,
  appendReviewerTurn,
  appendReviewerTurnLocked,
  readReviewerTurns,
  appendFanOutRationale,
  getTeammatesBlock,
  appendExpertSelection,
  appendExpertTurn,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-reviewer-teammates-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

function validTurn(overrides = {}) {
  return {
    expert_id: 'reviewer-ui',
    phase: 'spec-review',
    mailbox_message_ids_injected: ['msg-1'],
    started_at: '2026-05-29T12:00:00.000Z',
    completed_at: '2026-05-29T12:00:45.000Z',
    result_summary: 'SHIP',
    verdict: 'SHIP',
    failure_reason: null,
    ...overrides,
  };
}

// Read+rewrite the raw sidecar JSON on disk (bypasses loadSidecar's migration).
function rawSidecar(spec) {
  return JSON.parse(readFileSync(sidecarPathFor(spec), 'utf8'));
}
function writeRawSidecar(spec, data) {
  writeFileSync(sidecarPathFor(spec), JSON.stringify(data, null, 2));
}

// ── Test 1: new writes use reviewer_teammates ───────────────────────────────

test('appendReviewerSelection writes under reviewer_teammates.selected[]', () => {
  const { dir, spec } = makeSpec();
  appendReviewerSelection(spec, {
    id: 'reviewer-ui',
    role: 'ui',
    source: 'builtin',
    phase: 'spec-review',
    selectionReason: 'UI signals from spec',
  });
  const sc = loadSidecar(spec);
  assert.ok(sc.reviewer_teammates, 'reviewer_teammates block must exist');
  assert.equal(sc.reviewer_teammates.selected.length, 1);
  assert.equal(sc.reviewer_teammates.selected[0].id, 'reviewer-ui');
  assert.equal(sc.reviewer_teammates.selected[0].status, 'active');
  assert.equal('expert_teammates' in sc, false, 'new writes must NOT create expert_teammates');
  rmSync(dir, { recursive: true, force: true });
});

test('appendReviewerTurn writes under reviewer_teammates.turns[]', () => {
  const { dir, spec } = makeSpec();
  appendReviewerTurn(spec, validTurn());
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns.length, 1);
  assert.equal(sc.reviewer_teammates.turns[0].expert_id, 'reviewer-ui');
  assert.equal(sc.reviewer_teammates.turns[0].verdict, 'SHIP');
  rmSync(dir, { recursive: true, force: true });
});

test('appendReviewerTurnLocked writes under reviewer_teammates.turns[]', async () => {
  const { dir, spec } = makeSpec();
  await appendReviewerTurnLocked(spec, validTurn());
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns.length, 1);
  assert.equal(sc.reviewer_teammates.turns[0].expert_id, 'reviewer-ui');
  rmSync(dir, { recursive: true, force: true });
});

test('appendFanOutRationale writes under reviewer_teammates.fan_out_rationales[]', () => {
  const { dir, spec } = makeSpec();
  appendFanOutRationale(spec, { phase: 'spec-review', selected_count: 6, rationale: 'broad' });
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.fan_out_rationales.length, 1);
  assert.equal(sc.reviewer_teammates.fan_out_rationales[0].selected_count, 6);
  rmSync(dir, { recursive: true, force: true });
});

test('readReviewerTurns returns turns written via the reviewer API, filtered by phase', () => {
  const { dir, spec } = makeSpec();
  appendReviewerTurn(spec, validTurn({ phase: 'spec-review' }));
  appendReviewerTurn(spec, validTurn({ phase: 'pre-dispatch' }));
  const got = readReviewerTurns(spec, { phase: 'spec-review' });
  assert.equal(got.length, 1);
  assert.equal(got[0].phase, 'spec-review');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test: dispatch records use reviewer field names ─────────────────────────

test('appendImplementDispatch accepts reviewers_selected / reviewer_turn_ids / reviewer_blockers', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-29T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
    reviewers_selected: ['reviewer-ui', 'reviewer-ux'],
    reviewer_turn_ids: ['t1', 't2'],
    reviewer_blockers: [
      { reviewer_id: 'reviewer-ui', finding_id: 'ui-1', summary: 's', location: 'l', disposition: 'open' },
    ],
  });
  const d = loadSidecar(spec).slice_reviews['slice-3'].phases.implement.dispatches[0];
  assert.deepEqual(d.reviewers_selected, ['reviewer-ui', 'reviewer-ux']);
  assert.deepEqual(d.reviewer_turn_ids, ['t1', 't2']);
  assert.equal(d.reviewer_blockers.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch rejects non-array reviewers_selected', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() =>
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'sonnet',
      dispatched_at: '2026-05-29T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
      reviewers_selected: 'reviewer-ui',
    })
  , /reviewers_selected/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch rejects reviewer_blockers element missing required field', () => {
  const { dir, spec } = makeSpec();
  for (const missing of ['reviewer_id', 'finding_id', 'summary', 'location', 'disposition']) {
    const blocker = { reviewer_id: 'r', finding_id: 'f', summary: 's', location: 'l', disposition: 'open' };
    delete blocker[missing];
    assert.throws(() =>
      appendImplementDispatch(spec, `slice-${missing}`, {
        slice_id: `slice-${missing}`,
        agent: 'sonnet',
        dispatched_at: '2026-05-29T12:00:00.000Z',
        worktree: '/w',
        outcome: 'shipped',
        reviewer_blockers: [blocker],
      })
    , new RegExp(missing));
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 2: migrate-on-load (expert_teammates-only → reviewer_teammates) ─────

test('loading an expert_teammates-only sidecar migrates to reviewer_teammates + appends exactly one record', () => {
  const { dir, spec } = makeSpec();
  // Inject an old-shape sidecar containing ONLY expert_teammates.
  const raw = rawSidecar(spec);
  delete raw.reviewer_teammates;
  raw.expert_teammates = {
    selected: [{ id: 'expert-ui', role: 'ui', source: 'builtin', selected_at_phase: 'spec-review', selection_reason: 'r', status: 'active' }],
    turns: [{ expert_id: 'expert-ui', phase: 'spec-review', slice_id: null, mailbox_message_ids_injected: ['m1'], started_at: 'a', completed_at: 'b', result_summary: 'SHIP', verdict: 'SHIP', failure_reason: null }],
    fan_out_rationales: [],
  };
  writeRawSidecar(spec, raw);

  const sc = loadSidecar(spec);
  assert.ok(sc.reviewer_teammates, 'reviewer_teammates must be created on load');
  // Copied block deep-equals the original expert_teammates.
  assert.deepEqual(sc.reviewer_teammates, raw.expert_teammates);
  // expert_teammates is preserved (one migration window).
  assert.ok(sc.expert_teammates, 'expert_teammates preserved during migration window');

  const recs = sc.migrations.filter((m) => m.to_schema === 'reviewer_teammates');
  assert.equal(recs.length, 1, 'exactly one reviewer_teammates migration record');
  assert.equal(recs[0].from_schema, 'expert_teammates');
  assert.equal(recs[0].to_schema, 'reviewer_teammates');
  assert.equal(recs[0].action, 'expert_teammates → reviewer_teammates');
  assert.equal(typeof recs[0].migrated_at, 'string');
  rmSync(dir, { recursive: true, force: true });
});

test('migration is idempotent — re-loading an already-migrated sidecar appends NO second record', () => {
  const { dir, spec } = makeSpec();
  const raw = rawSidecar(spec);
  delete raw.reviewer_teammates;
  raw.expert_teammates = { selected: [], turns: [], fan_out_rationales: [] };
  writeRawSidecar(spec, raw);

  loadSidecar(spec); // first load migrates + persists
  const sc = loadSidecar(spec); // second load must not add a record
  const recs = sc.migrations.filter((m) => m.to_schema === 'reviewer_teammates');
  assert.equal(recs.length, 1, 'still exactly one migration record after re-load');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 3: dual-read precedence when both blocks exist ─────────────────────

test('both blocks present → no migration; getTeammatesBlock returns reviewer_teammates', () => {
  const { dir, spec } = makeSpec();
  const raw = rawSidecar(spec);
  raw.expert_teammates = { selected: [{ id: 'expert-ui' }], turns: [], fan_out_rationales: [] };
  raw.reviewer_teammates = { selected: [{ id: 'reviewer-ui' }], turns: [], fan_out_rationales: [] };
  writeRawSidecar(spec, raw);

  const sc = loadSidecar(spec);
  const recs = (sc.migrations || []).filter((m) => m.to_schema === 'reviewer_teammates');
  assert.equal(recs.length, 0, 'guard expert_teammates && !reviewer_teammates is false → no migration');
  const block = getTeammatesBlock(sc);
  assert.equal(block.selected[0].id, 'reviewer-ui', 'reviewer block wins precedence');
  rmSync(dir, { recursive: true, force: true });
});

// ── Test 4: getTeammatesBlock is a pure read ────────────────────────────────

test('getTeammatesBlock on an expert_teammates-only object does NOT append a record', () => {
  const obj = {
    expert_teammates: { selected: [], turns: [], fan_out_rationales: [] },
  };
  const block = getTeammatesBlock(obj);
  assert.equal(block, obj.expert_teammates, 'returns the expert block when no reviewer block');
  assert.equal('migrations' in obj, false, 'pure read must not append a migration record');
});

test('getTeammatesBlock returns reviewer_teammates when present', () => {
  const obj = {
    reviewer_teammates: { selected: [{ id: 'reviewer-ui' }], turns: [], fan_out_rationales: [] },
    expert_teammates: { selected: [{ id: 'expert-ui' }], turns: [], fan_out_rationales: [] },
  };
  assert.equal(getTeammatesBlock(obj), obj.reviewer_teammates);
});

// ── Test 5: appendExpert* delegate to the reviewer block ─────────────────────

test('appendExpertTurn delegates — writes into reviewer_teammates (old callers converge)', () => {
  const { dir, spec } = makeSpec();
  appendExpertTurn(spec, validTurn({ expert_id: 'expert-ui' }));
  const sc = loadSidecar(spec);
  assert.ok(sc.reviewer_teammates, 'reviewer_teammates created by delegating appendExpertTurn');
  assert.equal(sc.reviewer_teammates.turns.length, 1);
  assert.equal(sc.reviewer_teammates.turns[0].expert_id, 'expert-ui');
  assert.equal('expert_teammates' in sc, false, 'appendExpertTurn must not create expert_teammates');
  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertSelection delegates — writes into reviewer_teammates', () => {
  const { dir, spec } = makeSpec();
  appendExpertSelection(spec, { id: 'expert-ui', role: 'ui', source: 'builtin', phase: 'spec-review', selectionReason: 'r' });
  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.selected.length, 1);
  assert.equal(sc.reviewer_teammates.selected[0].id, 'expert-ui');
  rmSync(dir, { recursive: true, force: true });
});
