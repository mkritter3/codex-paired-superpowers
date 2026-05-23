// v0.11.0 — app_state block tests.
//
// app_state powers app-autopilot's multi-plan rollout: it tracks which of a
// spec's goals have been audited as shipped (by which plan) and which plans
// have shipped. The /goal-driven outer loop reads this on every turn to
// decide whether to run the existing autopilot, draft the next plan, or
// terminate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  initAppState,
  getAppState,
  markGoalShipped,
  setAppPlan,
  loadSidecar,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-app-state-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'app-state-demo', codexSession: 'tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const GOALS = [
  { id: 'goal-signup', text: 'After this ships, a user can sign up.' },
  { id: 'goal-login',  text: 'After this ships, a user can log in.' },
  { id: 'goal-reset',  text: 'After this ships, a user can reset their password.' },
];

test('initAppState persists goals + initialized_at + empty plans/active_plan', () => {
  const { dir, spec } = makeSpec();
  const result = initAppState(spec, { goals: GOALS });
  assert.equal(result.goals.length, 3);
  for (let i = 0; i < GOALS.length; i++) {
    assert.equal(result.goals[i].id, GOALS[i].id);
    assert.equal(result.goals[i].text, GOALS[i].text);
    assert.equal(result.goals[i].audited_shipped, false);
    assert.equal(result.goals[i].shipped_by_plan, null);
    assert.equal(result.goals[i].shipped_at, null);
  }
  assert.deepEqual(result.plans, []);
  assert.equal(result.active_plan, null);
  assert.match(result.initialized_at, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(dir, { recursive: true, force: true });
});

test('initAppState rejects empty goals array', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => initAppState(spec, { goals: [] }), /goals must be a non-empty array/);
  rmSync(dir, { recursive: true, force: true });
});

test('initAppState rejects goals with missing id', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => initAppState(spec, { goals: [{ text: 'no id here' }] }),
    /goals\[0\]\.id must be a non-empty string/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('initAppState rejects goals with missing text', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => initAppState(spec, { goals: [{ id: 'g1' }] }),
    /goals\[0\]\.text must be a non-empty string/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('getAppState returns null when never initialized', () => {
  const { dir, spec } = makeSpec();
  assert.equal(getAppState(spec), null);
  rmSync(dir, { recursive: true, force: true });
});

test('getAppState returns the block after init', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  const got = getAppState(spec);
  assert.ok(got);
  assert.equal(got.goals.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('setAppPlan creates a plan record when started', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  const result = setAppPlan(spec, { planPath: 'docs/superpowers/plans/p1.md', started: true });
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].path, 'docs/superpowers/plans/p1.md');
  assert.equal(result.plans[0].shipped, false);
  assert.deepEqual(result.plans[0].audited_goals, []);
  assert.equal(result.active_plan, 'docs/superpowers/plans/p1.md');
  rmSync(dir, { recursive: true, force: true });
});

test('setAppPlan marks plan shipped and clears active_plan when shipped on same call', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  setAppPlan(spec, { planPath: 'docs/superpowers/plans/p1.md', started: true });
  const result = setAppPlan(spec, { planPath: 'docs/superpowers/plans/p1.md', shipped: true });
  assert.equal(result.plans[0].shipped, true);
  assert.match(result.plans[0].shipped_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.active_plan, null);
  rmSync(dir, { recursive: true, force: true });
});

test('setAppPlan throws when app_state not initialized', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => setAppPlan(spec, { planPath: 'p1.md', started: true }),
    /app_state not initialized/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('markGoalShipped updates goal record + mirrors onto plan.audited_goals', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  setAppPlan(spec, { planPath: 'docs/superpowers/plans/p1.md', started: true });
  const result = markGoalShipped(spec, { goalId: 'goal-signup', planPath: 'docs/superpowers/plans/p1.md' });
  const g = result.goals.find((x) => x.id === 'goal-signup');
  assert.equal(g.audited_shipped, true);
  assert.equal(g.shipped_by_plan, 'docs/superpowers/plans/p1.md');
  assert.match(g.shipped_at, /^\d{4}-\d{2}-\d{2}T/);
  const planRec = result.plans.find((p) => p.path === 'docs/superpowers/plans/p1.md');
  assert.deepEqual(planRec.audited_goals, ['goal-signup']);
  rmSync(dir, { recursive: true, force: true });
});

test('markGoalShipped is idempotent on same (goalId, planPath)', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  setAppPlan(spec, { planPath: 'p1.md', started: true });
  const first = markGoalShipped(spec, { goalId: 'goal-signup', planPath: 'p1.md' });
  const firstAt = first.goals.find((x) => x.id === 'goal-signup').shipped_at;
  const second = markGoalShipped(spec, { goalId: 'goal-signup', planPath: 'p1.md' });
  // Idempotent: shipped_at must NOT advance on repeat call.
  assert.equal(second.goals.find((x) => x.id === 'goal-signup').shipped_at, firstAt);
  // And plan.audited_goals must not contain duplicates.
  assert.deepEqual(second.plans.find((p) => p.path === 'p1.md').audited_goals, ['goal-signup']);
});

test('markGoalShipped throws on unknown goalId', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  setAppPlan(spec, { planPath: 'p1.md', started: true });
  assert.throws(
    () => markGoalShipped(spec, { goalId: 'goal-bogus', planPath: 'p1.md' }),
    /unknown goalId "goal-bogus"/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('markGoalShipped throws when app_state not initialized', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => markGoalShipped(spec, { goalId: 'g1', planPath: 'p1.md' }),
    /app_state not initialized/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('multi-plan rollout: 3 goals across 2 plans', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  // Plan 1 ships signup + login.
  setAppPlan(spec, { planPath: 'p1.md', started: true });
  markGoalShipped(spec, { goalId: 'goal-signup', planPath: 'p1.md' });
  markGoalShipped(spec, { goalId: 'goal-login', planPath: 'p1.md' });
  setAppPlan(spec, { planPath: 'p1.md', shipped: true });
  // Plan 2 ships reset.
  setAppPlan(spec, { planPath: 'p2.md', started: true });
  markGoalShipped(spec, { goalId: 'goal-reset', planPath: 'p2.md' });
  setAppPlan(spec, { planPath: 'p2.md', shipped: true });

  const s = getAppState(spec);
  const shippedCount = s.goals.filter((g) => g.audited_shipped).length;
  assert.equal(shippedCount, 3, 'all 3 goals should be audited-shipped');
  assert.equal(s.active_plan, null, 'no active plan after both ship');
  assert.equal(s.plans.length, 2);
  assert.deepEqual(
    s.plans.find((p) => p.path === 'p1.md').audited_goals.sort(),
    ['goal-login', 'goal-signup'],
  );
  assert.deepEqual(
    s.plans.find((p) => p.path === 'p2.md').audited_goals,
    ['goal-reset'],
  );
  rmSync(dir, { recursive: true, force: true });
});

test('backward compat: sidecar without app_state still loads, get returns null', () => {
  const { dir, spec } = makeSpec();
  // Don't init app_state — simulate a legacy v0.10.x sidecar.
  const sc = loadSidecar(spec);
  assert.ok(sc, 'sidecar loads');
  assert.equal(sc.app_state, undefined, 'no app_state block present');
  assert.equal(getAppState(spec), null);
  rmSync(dir, { recursive: true, force: true });
});

test('app_state.plans does not duplicate when setAppPlan called twice on same plan', () => {
  const { dir, spec } = makeSpec();
  initAppState(spec, { goals: GOALS });
  setAppPlan(spec, { planPath: 'p1.md', started: true });
  setAppPlan(spec, { planPath: 'p1.md', started: true }); // re-call
  const s = getAppState(spec);
  assert.equal(s.plans.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
