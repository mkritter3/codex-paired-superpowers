// v0.11.0 — CLI subcommands for app-state (app-autopilot multi-plan rollout).
//
// Exercises the CLI surface end-to-end as the app-autopilot skill calls it:
// init via stdin JSON, get, set-plan (started + shipped), mark-goal-shipped
// (incl. idempotency + unknown-goal error), and next-plan-context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'cli.js');

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-app-state-cli-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  // Init the base sidecar first (existing CLI).
  execFileSync('node', [CLI, 'sidecar-init', '--specPath', spec, '--feature', 'app-cli-demo', '--threadId', 'tid'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { dir, spec };
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      status: e.status ?? 1,
    };
  }
}

const GOALS_JSON = JSON.stringify([
  { id: 'goal-signup', text: 'After this ships, a user can sign up.' },
  { id: 'goal-login',  text: 'After this ships, a user can log in.' },
  { id: 'goal-reset',  text: 'After this ships, a user can reset their password.' },
]);

test('app-state-init reads goals from stdin and persists', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.equal(result.goals.length, 3);
  assert.equal(result.active_plan, null);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-init rejects empty stdin', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-init', '--specPath', spec], { input: '' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--goals JSON or stdin required/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-init rejects invalid JSON', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-init', '--specPath', spec], { input: 'not json' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-init rejects non-array JSON', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-init', '--specPath', spec], { input: '{"not":"array"}' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /goals must be a JSON array/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-get emits empty string when never initialized', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-get', '--specPath', spec]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(r.stdout, '');
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-get emits JSON block after init', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  const r = runCli(['app-state-get', '--specPath', spec]);
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(s.goals.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-set-plan --started records active_plan', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  const r = runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.active_plan, 'p1.md');
  assert.equal(s.plans.length, 1);
  assert.equal(s.plans[0].shipped, false);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-set-plan --shipped marks plan complete and clears active_plan', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  const r = runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--shipped']);
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(s.active_plan, null);
  assert.equal(s.plans[0].shipped, true);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-set-plan requires --planPath', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  const r = runCli(['app-state-set-plan', '--specPath', spec, '--started']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--planPath required/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-mark-goal-shipped flips audited_shipped + mirrors to plan', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  const r = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-signup', '--planPath', 'p1.md']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const s = JSON.parse(r.stdout);
  const g = s.goals.find((x) => x.id === 'goal-signup');
  assert.equal(g.audited_shipped, true);
  assert.equal(g.shipped_by_plan, 'p1.md');
  const planRec = s.plans.find((p) => p.path === 'p1.md');
  assert.deepEqual(planRec.audited_goals, ['goal-signup']);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-mark-goal-shipped is idempotent', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  const first = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-signup', '--planPath', 'p1.md']);
  const r = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-signup', '--planPath', 'p1.md']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // shipped_at should not advance.
  const firstAt = JSON.parse(first.stdout).goals.find((x) => x.id === 'goal-signup').shipped_at;
  const secondAt = JSON.parse(r.stdout).goals.find((x) => x.id === 'goal-signup').shipped_at;
  assert.equal(secondAt, firstAt);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-mark-goal-shipped fails on unknown goal', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  const r = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-bogus', '--planPath', 'p1.md']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown goalId "goal-bogus"/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-mark-goal-shipped requires --goalId and --planPath', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  let r = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--planPath', 'p1.md']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--goalId required/);
  r = runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'g']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--planPath required/);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-next-plan-context emits unshipped/shipped split after one plan ships', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-signup', '--planPath', 'p1.md']);
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--shipped']);

  const r = runCli(['app-state-next-plan-context', '--specPath', spec]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.total_goals, 3);
  assert.equal(ctx.goals_shipped_count, 1);
  assert.equal(ctx.unshipped_goals.length, 2);
  assert.equal(ctx.shipped_goals.length, 1);
  assert.equal(ctx.shipped_goals[0].id, 'goal-signup');
  assert.equal(ctx.shipped_goals[0].by_plan, 'p1.md');
  assert.equal(ctx.shipped_plans.length, 1);
  assert.equal(ctx.shipped_plans[0].path, 'p1.md');
  assert.deepEqual(ctx.shipped_plans[0].audited_goals, ['goal-signup']);
  assert.equal(ctx.active_plan, null);
  rmSync(dir, { recursive: true, force: true });
});

test('app-state-next-plan-context fails when app_state not initialized', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['app-state-next-plan-context', '--specPath', spec]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /app_state not initialized/);
  rmSync(dir, { recursive: true, force: true });
});

test('full multi-plan rollout: 3 goals → 2 plans → Goals shipped: 3/3', () => {
  const { dir, spec } = makeSpec();
  runCli(['app-state-init', '--specPath', spec], { input: GOALS_JSON });

  // Plan 1 ships goal-signup + goal-login.
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--started']);
  runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-signup', '--planPath', 'p1.md']);
  runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-login',  '--planPath', 'p1.md']);
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p1.md', '--shipped']);

  // Plan 2 ships goal-reset.
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p2.md', '--started']);
  runCli(['app-state-mark-goal-shipped', '--specPath', spec, '--goalId', 'goal-reset', '--planPath', 'p2.md']);
  runCli(['app-state-set-plan', '--specPath', spec, '--planPath', 'p2.md', '--shipped']);

  const r = runCli(['app-state-next-plan-context', '--specPath', spec]);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.total_goals, 3);
  assert.equal(ctx.goals_shipped_count, 3);
  assert.equal(ctx.unshipped_goals.length, 0);
  assert.equal(ctx.shipped_plans.length, 2);
  rmSync(dir, { recursive: true, force: true });
});
