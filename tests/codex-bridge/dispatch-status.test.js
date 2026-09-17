import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyImplementDecision,
  classifyStatusFile,
  decideImplementAction,
  isConfigErrorStatus,
} from '../../lib/codex-bridge/dispatch-status.js';
import { archive } from '../../lib/codex-bridge/reviewer-archive.js';
import { readMailbox, writeToMailbox } from '../../lib/codex-bridge/mailbox.js';

const HALTS = {
  timeout: 'codex-background-timeout',
  lost: 'codex-background-task-lost',
  failed: null,
};

const classify = (overrides = {}) => classifyStatusFile({
  statusFile: null,
  taskAlive: false,
  runtimeMs: 10,
  maxRuntimeMs: 1000,
  halts: HALTS,
  ...overrides,
});

test('classifyStatusFile follows the frozen ordered status rules', () => {
  const markerRows = [];
  for (const [status, state, reason] of [
    ['blocked', 'blocked', 'codex-blocked'],
    ['needs-context', 'needs-context', 'codex-needs-context'],
  ]) {
    for (const exit_code of [null, 0, 1]) {
      markerRows.push({ name: `${status}/${exit_code}`, statusFile: { status, exit_code }, state, reason, terminal: true });
    }
  }
  const rows = [
    { name: 'timeout overrides completed', over: { statusFile: { exit_code: 0 }, runtimeMs: 1001 }, state: 'timeout', reason: 'codex-background-timeout', terminal: true },
    ...markerRows.map((r) => ({ name: r.name, over: { statusFile: r.statusFile }, state: r.state, reason: r.reason, terminal: r.terminal })),
    { name: 'config error named', over: { statusFile: { exit_code: 78, error: 'model-role-conflicting-args' } }, state: 'config-error', reason: 'model-role-conflicting-args', terminal: true },
    { name: 'config error default', over: { statusFile: { exit_code: 78 } }, state: 'config-error', reason: 'model-role-resolution-failed', terminal: true },
    { name: 'transient before successful exit', over: { statusFile: { transient: true, exit_code: 0 } }, state: 'transient', reason: null, terminal: false },
    { name: 'wrapper success', over: { statusFile: { state: 'exited', exit_code: 0 } }, state: 'completed', reason: null, terminal: false },
    { name: 'legacy success', over: { statusFile: { status: 'completed', exit_code: 0 } }, state: 'completed', reason: null, terminal: false },
    { name: 'nonzero failed', over: { statusFile: { exit_code: 9 } }, state: 'failed', reason: null, terminal: true },
    { name: 'null exit alive', over: { statusFile: { state: 'started', exit_code: null }, taskAlive: true }, state: 'transient', reason: null, terminal: false },
    { name: 'null exit dead', over: { statusFile: { state: 'started', exit_code: null }, taskAlive: false }, state: 'lost', reason: 'codex-background-task-lost', terminal: true },
    { name: 'undefined exit alive', over: { statusFile: { state: 'started' }, taskAlive: true }, state: 'transient', reason: null, terminal: false },
    { name: 'undefined exit dead', over: { statusFile: { state: 'started' }, taskAlive: false }, state: 'lost', reason: 'codex-background-task-lost', terminal: true },
    { name: 'missing alive', over: { taskAlive: true }, state: 'transient', reason: null, terminal: false },
    { name: 'missing dead', over: {}, state: 'lost', reason: 'codex-background-task-lost', terminal: true },
    { name: 'custom blocked halt', over: { statusFile: { status: 'blocked', exit_code: 1 }, halts: { ...HALTS, blocked: 'custom-blocked' } }, state: 'blocked', reason: 'custom-blocked', terminal: true },
    { name: 'custom needs-context halt', over: { statusFile: { status: 'needs-context', exit_code: 1 }, halts: { ...HALTS, needsContext: 'custom-context' } }, state: 'needs-context', reason: 'custom-context', terminal: true },
  ];

  assert.ok(rows.length >= 18);
  for (const row of rows) {
    const got = classify(row.over);
    assert.equal(got.state, row.state, row.name);
    assert.equal(got.terminal, row.terminal, row.name);
    assert.equal(got.haltReason, row.reason, row.name);
    assert.equal(got.snapshot, null, row.name);
  }
});

test('classifies the actual wrapper initial and final JSON with its model snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cps-dispatch-status-'));
  const bin = join(root, 'bin');
  const statusPath = join(root, 'status.json');
  const initialPath = join(root, 'initial.json');
  await mkdir(bin);
  const fake = join(bin, 'codex');
  await writeFile(fake, '#!/usr/bin/env bash\ncp "$FAKE_STATUS_FILE" "$FAKE_INITIAL_FILE"\nexit 0\n');
  await chmod(fake, 0o755);
  const wrapper = resolve('scripts/codex-exec-with-status.sh');
  const run = spawnSync(wrapper, [statusPath, '--model-role', 'implement', '--', 'codex', 'exec', 'prompt'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATUS_FILE: statusPath, FAKE_INITIAL_FILE: initialPath },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const initial = JSON.parse(await readFile(initialPath, 'utf8'));
  const final = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.deepEqual(classify({ statusFile: initial, taskAlive: true }), {
    state: 'transient', terminal: false, haltReason: null,
    snapshot: { model_role: 'implement', model: 'gpt-5.6-sol', effort: 'high' },
  });
  assert.deepEqual(classify({ statusFile: final }), {
    state: 'completed', terminal: false, haltReason: null,
    snapshot: { model_role: 'implement', model: 'gpt-5.6-sol', effort: 'high' },
  });
});

test('isConfigErrorStatus recognizes only exit 78 status objects', () => {
  assert.equal(isConfigErrorStatus({ exit_code: 78 }), true);
  assert.equal(isConfigErrorStatus({ status: 'blocked', exit_code: 1 }), false);
  assert.equal(isConfigErrorStatus(null), false);
});

function spyCallbacks(overrides = {}) {
  const calls = [];
  const callback = (name, value) => async (...args) => { calls.push([name, ...args]); return value ?? name; };
  return {
    calls,
    callbacks: {
      reset: callback('reset', { ok: true }),
      dispatchNextRung: callback('dispatchNextRung'),
      halt: callback('halt'),
      reconcile: callback('reconcile'),
      ship: callback('ship'),
      poll: callback('poll'),
      ...overrides,
    },
  };
}

test('config error halts without reset/fallback and preserves the real reviewer mailbox', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'cps-config-halt-'));
  await writeToMailbox(repoRoot, 'reviewer-test', { from: 'orchestrator', text: 'keep me' });
  const classification = classify({ statusFile: { exit_code: 78 } });
  const decision = decideImplementAction({ classification, rung: 1 });
  const spies = spyCallbacks();
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(spies.calls, [['halt', 'model-role-resolution-failed']]);
  const archived = await archive({ id: 'reviewer-test' }, decision.haltReason);
  assert.equal(archived.status, 'preserved-for-resume');
  assert.equal((await readMailbox(repoRoot, 'reviewer-test')).length, 1);
});

test('blocked halts without reset', async () => {
  const spies = spyCallbacks();
  const decision = decideImplementAction({ classification: classify({ statusFile: { status: 'blocked', exit_code: 0 } }), rung: 1 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(spies.calls, [['halt', 'codex-blocked']]);
});

test('nonterminal live status polls only', async () => {
  const spies = spyCallbacks();
  const decision = decideImplementAction({ classification: classify({ statusFile: { exit_code: null }, taskAlive: true }), rung: 1 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(spies.calls, [['poll']]);
});

test('completed result reconciles first and ships only after a conforming reconciliation', async () => {
  const first = spyCallbacks();
  const classification = classify({ statusFile: { exit_code: 0 } });
  await applyImplementDecision(decideImplementAction({ classification, rung: 1 }), first.callbacks);
  assert.deepEqual(first.calls, [['reconcile']]);

  const second = spyCallbacks();
  await applyImplementDecision(decideImplementAction({ classification, rung: 1, reconciled: { commit_count: 1, non_conforming_subjects: [] } }), second.callbacks);
  assert.deepEqual(second.calls, [['ship']]);
});

test('failed rung resets before dispatching the next rung', async () => {
  const spies = spyCallbacks();
  const decision = decideImplementAction({ classification: classify({ statusFile: { exit_code: 1 } }), rung: 1 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(spies.calls, [['reset'], ['dispatchNextRung', 2]]);
});

test('failed reset result halts and never dispatches', async () => {
  const calls = [];
  const spies = spyCallbacks({
    reset: async () => { calls.push(['reset']); return { ok: false }; },
    halt: async (reason) => { calls.push(['halt', reason]); },
    dispatchNextRung: async (rung) => { calls.push(['dispatchNextRung', rung]); },
  });
  const decision = decideImplementAction({ classification: classify({ statusFile: { exit_code: 1 } }), rung: 1 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(calls, [['reset'], ['halt', 'worktree-reset-failed']]);
});

test('failed reset exception halts and never dispatches', async () => {
  const calls = [];
  const spies = spyCallbacks({
    reset: async () => { calls.push(['reset']); throw new Error('git broke'); },
    halt: async (reason) => { calls.push(['halt', reason]); },
    dispatchNextRung: async (rung) => { calls.push(['dispatchNextRung', rung]); },
  });
  const decision = decideImplementAction({ classification: classify({ statusFile: { exit_code: 1 } }), rung: 1 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(calls, [['reset'], ['halt', 'worktree-reset-failed']]);
});

test('failed final rung halts as implementer unavailable', async () => {
  const spies = spyCallbacks();
  const decision = decideImplementAction({ classification: classify({ statusFile: { exit_code: 1 } }), rung: 3 });
  await applyImplementDecision(decision, spies.callbacks);
  assert.deepEqual(spies.calls, [['halt', 'implementer-unavailable']]);
});

test('completed but nonconforming reconciliation falls back', () => {
  const classification = classify({ statusFile: { exit_code: 0 } });
  assert.deepEqual(
    decideImplementAction({ classification, rung: 1, reconciled: { commit_count: 0, non_conforming_subjects: [] } }),
    { action: 'fallback', haltReason: null, nextRung: 2 },
  );
  assert.deepEqual(
    decideImplementAction({ classification, rung: 1, reconciled: { commit_count: 1, non_conforming_subjects: ['bad'] } }),
    { action: 'fallback', haltReason: null, nextRung: 2 },
  );
});
