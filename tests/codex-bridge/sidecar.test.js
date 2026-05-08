import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  appendRound,
  setSlice,
  sidecarPathFor,
} from '../../lib/codex-bridge/sidecar.js';

test('sidecarPathFor appends .codex.json to spec path', () => {
  assert.equal(
    sidecarPathFor('/x/y/spec.md'),
    '/x/y/spec.md.codex.json'
  );
});

test('initSidecar writes valid JSON with required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'demo',
    codexSession: 'uuid-1',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.version, 1);
  assert.equal(sc.feature, 'demo');
  assert.equal(sc.codex_session, 'uuid-1');
  assert.equal(sc.model, 'gpt-5.5');
  assert.equal(sc.reasoning_effort, 'high');
  assert.deepEqual(sc.rounds, []);
  assert.deepEqual(sc.open_contentions, []);
  assert.deepEqual(sc.slice_reviews, {});
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound appends to rounds array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  appendRound(spec, { phase: 'spec', round: 1, claude: 'REVISE: x', codex: 'REVISE: y' });
  appendRound(spec, { phase: 'spec', round: 2, claude: 'SHIP', codex: 'SHIP' });
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 2);
  assert.equal(sc.rounds[1].claude, 'SHIP');
  rmSync(dir, { recursive: true, force: true });
});

test('setSlice records slice review state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  setSlice(spec, 'slice-1', { rounds: [{ round: 1, claude: 'SHIP', codex: 'SHIP' }], shipped: true });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].shipped, true);
  rmSync(dir, { recursive: true, force: true });
});
