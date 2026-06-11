// v0.15.0 — stale in-flight autopilot scan.
//
// A run abandoned at a phase start with halt_reason:null sat silently
// resumable for 11 days (Vesikaa seed-based-shared-reading, slice 4) —
// indistinguishable from "running elsewhere". scanStaleAutopilot makes
// abandonment visible; skills surface it at entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSidecar,
  setAutopilot,
  scanStaleAutopilot,
} from '../../lib/codex-bridge/sidecar.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'codex-bridge', 'cli.js');

function makeRepoWithSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-scanstale-'));
  spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 5000 });
  const spec = join(dir, 'docs', 'specs');
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, '# spec');
  initSidecar(specPath, { feature: 'scan', codexSession: 't', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, specPath };
}

const HOURS = 3_600_000;

function apBlock(overrides = {}) {
  return {
    started_at: '2026-06-01T00:00:00Z',
    last_tick_at: '2026-06-01T05:00:00Z',
    current_slice: '4',
    current_phase: 'plan-slice',
    halt_reason: null,
    plan_path: 'docs/plans/x.md',
    ...overrides,
  };
}

test('scanStaleAutopilot: in-flight block idle past threshold is reported', () => {
  const { dir, specPath } = makeRepoWithSpec();
  setAutopilot(specPath, apBlock());
  const now = new Date(Date.parse('2026-06-01T05:00:00Z') + 30 * HOURS);
  const stale = scanStaleAutopilot(dir, { maxAgeHours: 24, now });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].current_slice, '4');
  assert.equal(stale[0].current_phase, 'plan-slice');
  assert.equal(stale[0].idle_hours, 30);
  assert.equal(stale[0].plan_path, 'docs/plans/x.md');
  rmSync(dir, { recursive: true, force: true });
});

test('scanStaleAutopilot: recently-ticked and halted runs are NOT reported', () => {
  const { dir, specPath } = makeRepoWithSpec();
  // Fresh tick — under threshold.
  setAutopilot(specPath, apBlock());
  const soon = new Date(Date.parse('2026-06-01T05:00:00Z') + 2 * HOURS);
  assert.equal(scanStaleAutopilot(dir, { maxAgeHours: 24, now: soon }).length, 0);
  // Halted (completed) — not in-flight, regardless of age.
  setAutopilot(specPath, apBlock({ halt_reason: 'completed' }));
  const muchLater = new Date(Date.parse('2026-06-01T05:00:00Z') + 500 * HOURS);
  assert.equal(scanStaleAutopilot(dir, { maxAgeHours: 24, now: muchLater }).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('scanStaleAutopilot: no .superpowers-codex-paired dir → empty, no throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-scanstale-empty-'));
  assert.deepEqual(scanStaleAutopilot(dir), []);
  rmSync(dir, { recursive: true, force: true });
});

test('scanStaleAutopilot: corrupt sidecar JSON is skipped, not fatal', () => {
  const { dir, specPath } = makeRepoWithSpec();
  setAutopilot(specPath, apBlock());
  writeFileSync(join(dir, '.superpowers-codex-paired', 'broken.json'), '{ nope');
  const now = new Date(Date.parse('2026-06-01T05:00:00Z') + 30 * HOURS);
  const stale = scanStaleAutopilot(dir, { maxAgeHours: 24, now });
  assert.equal(stale.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('cli sidecar-scan-stale: emits JSON array', () => {
  const { dir, specPath } = makeRepoWithSpec();
  setAutopilot(specPath, apBlock({ last_tick_at: '2020-01-01T00:00:00Z' }));
  const stdout = execFileSync('node', [CLI, 'sidecar-scan-stale', '--repoRoot', dir], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].idle_hours > 24);
  rmSync(dir, { recursive: true, force: true });
});
