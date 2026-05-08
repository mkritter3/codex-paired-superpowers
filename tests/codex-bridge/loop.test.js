import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSidecar, loadSidecar } from '../../lib/codex-bridge/sidecar.js';
import { runRoundLoop } from '../../lib/codex-bridge/loop.js';

function mkSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-loop-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 't', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

test('runRoundLoop exits on double-SHIP', async () => {
  const { dir, spec } = mkSpec();
  const codexFn = async () => ({ reply: '<<<VERDICT>>>\nstatus: SHIP\ncritique: []\nrationale: ok\n<<<END>>>' });
  const claudeFn = async () => ({ status: 'SHIP', critique: [], rationale: 'ok' });
  const result = await runRoundLoop({
    specPath: spec,
    phase: 'spec',
    codexFn,
    claudeFn,
  });
  assert.equal(result.outcome, 'shipped');
  assert.equal(result.rounds, 1);
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('runRoundLoop hits 7-round cap and returns deadlock', async () => {
  const { dir, spec } = mkSpec();
  const codexFn = async () => ({ reply: '<<<VERDICT>>>\nstatus: REVISE\ncritique:\n  - thing\nrationale: x\n<<<END>>>' });
  const claudeFn = async () => ({ status: 'REVISE', critique: ['nope'], rationale: 'y' });
  const result = await runRoundLoop({
    specPath: spec,
    phase: 'spec',
    codexFn,
    claudeFn,
    maxRounds: 7,
  });
  assert.equal(result.outcome, 'deadlock');
  assert.equal(result.rounds, 7);
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 7);
  rmSync(dir, { recursive: true, force: true });
});

test('runRoundLoop ships when both flip to SHIP mid-loop', async () => {
  const { dir, spec } = mkSpec();
  let i = 0;
  const codexFn = async () => {
    i++;
    return i < 3
      ? { reply: '<<<VERDICT>>>\nstatus: REVISE\ncritique:\n  - a\nrationale: b\n<<<END>>>' }
      : { reply: '<<<VERDICT>>>\nstatus: SHIP\ncritique: []\nrationale: ok\n<<<END>>>' };
  };
  const claudeFn = async (round) => round < 3
    ? { status: 'REVISE', critique: ['x'], rationale: 'y' }
    : { status: 'SHIP', critique: [], rationale: 'ok' };
  const result = await runRoundLoop({ specPath: spec, phase: 'spec', codexFn, claudeFn });
  assert.equal(result.outcome, 'shipped');
  assert.equal(result.rounds, 3);
  rmSync(dir, { recursive: true, force: true });
});
