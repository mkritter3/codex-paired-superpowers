/**
 * evidence-store.test.js
 *
 * TDD tests for lib/codex-bridge/evidence-store.js.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md
 *       § "Sidecar Persistence" (retention rules)
 *       § "Scenario Execution" (evidence layout)
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 7
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvidenceStore } from '../../lib/codex-bridge/evidence-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-ev-'));
  return realpathSync(tmp);
}

function evidenceRoot(repoRoot, sliceId) {
  return join(repoRoot, '.superpowers-codex-paired', 'evidence', sliceId);
}

// ── Test 1: Evidence directory created with correct structure ─────────────────

test('init creates evidence directory for sliceId', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const dir = evidenceRoot(repoRoot, 'slice-7');
  assert.ok(existsSync(dir), `evidence dir should exist at ${dir}`);
});

test('init is idempotent — repeated calls do not throw', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');
  assert.doesNotThrow(() => store.init('slice-7'), 'second init call should not throw');
  assert.doesNotThrow(() => store.init('slice-7'), 'third init call should not throw');
});

// ── Test 2: writeScenarioResult round-trips via readScenarioResult ────────────

test('writeScenarioResult round-trips — readScenarioResult returns same payload', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const payload = {
    status: 'passed',
    sha: 'abc123',
    assertions: ['Saved display name visible'],
    logs_excerpt: 'no errors',
    duration_ms: 1234,
  };

  store.writeScenarioResult('slice-7', 'lv-001', 1, payload);
  const read = store.readScenarioResult('slice-7', 'lv-001', 1);
  assert.deepEqual(read, payload);
});

test('writeScenarioResult writes to correct path: <scenario-id>/attempt-<N>/result.json', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeScenarioResult('slice-7', 'lv-002', 3, { status: 'failed' });

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-002', 'attempt-3', 'result.json');
  assert.ok(existsSync(expected), `result.json should exist at ${expected}`);
});

// ── Test 3: writeBeforeScreenshot / writeAfterScreenshot ─────────────────────

test('writeBeforeScreenshot writes at <scenario-id>/attempt-<N>/before.png', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const fakeScreenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
  store.writeBeforeScreenshot('slice-7', 'lv-001', 1, fakeScreenshot);

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001', 'attempt-1', 'before.png');
  assert.ok(existsSync(expected), `before.png should exist at ${expected}`);
});

test('writeAfterScreenshot writes at <scenario-id>/attempt-<N>/after.png', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const fakeScreenshot = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  store.writeAfterScreenshot('slice-7', 'lv-001', 2, fakeScreenshot);

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001', 'attempt-2', 'after.png');
  assert.ok(existsSync(expected), `after.png should exist at ${expected}`);
});

// ── Test 4: writeLogs / writeSetupLogs ────────────────────────────────────────

test('writeLogs writes logs.txt at <scenario-id>/attempt-<N>/logs.txt', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeLogs('slice-7', 'lv-001', 1, 'INFO: scenario started\nERROR: oops\n');

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001', 'attempt-1', 'logs.txt');
  assert.ok(existsSync(expected), `logs.txt should exist at ${expected}`);
  const content = readFileSync(expected, 'utf8');
  assert.ok(content.includes('ERROR: oops'), 'logs.txt content should match written value');
});

test('writeSetupLogs writes setup-logs.txt at <scenario-id>/attempt-<N>/setup-logs.txt', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeSetupLogs('slice-7', 'lv-001', 1, 'resetting db...\ndone\n');

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001', 'attempt-1', 'setup-logs.txt');
  assert.ok(existsSync(expected), `setup-logs.txt should exist at ${expected}`);
  const content = readFileSync(expected, 'utf8');
  assert.ok(content.includes('resetting db'), 'setup-logs.txt content should match written value');
});

// ── Test 5: writeSummary ──────────────────────────────────────────────────────

test('writeSummary writes summary.json at the slice evidence root', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const summary = {
    total: 3,
    passed: 2,
    failed: 1,
    flaky: 0,
    deferred: 0,
    verdict: 'fail',
  };

  store.writeSummary('slice-7', summary);

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'summary.json');
  assert.ok(existsSync(expected), 'summary.json should exist at slice root');
  const parsed = JSON.parse(readFileSync(expected, 'utf8'));
  assert.deepEqual(parsed, summary);
});

// ── Test 6: writeScenarios ────────────────────────────────────────────────────

test('writeScenarios writes scenarios.json at the slice evidence root', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const scenarios = [
    { id: 'lv-001', title: 'Save settings', risk: 'happy-path' },
    { id: 'lv-002', title: 'Show recent saves', risk: 'happy-path' },
  ];

  store.writeScenarios('slice-7', scenarios);

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'scenarios.json');
  assert.ok(existsSync(expected), 'scenarios.json should exist at slice root');
  const parsed = JSON.parse(readFileSync(expected, 'utf8'));
  assert.deepEqual(parsed, scenarios);
});

// ── Test 7: writeLaunchMetadata ───────────────────────────────────────────────

test('writeLaunchMetadata writes launch.json at the slice evidence root', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  const metadata = {
    command: 'npm run dev',
    pid: 12345,
    ready: true,
    ready_signal: 'http://127.0.0.1:3000/healthz -> 200',
  };

  store.writeLaunchMetadata('slice-7', metadata);

  const expected = join(evidenceRoot(repoRoot, 'slice-7'), 'launch.json');
  assert.ok(existsSync(expected), 'launch.json should exist at slice root');
  const parsed = JSON.parse(readFileSync(expected, 'utf8'));
  assert.deepEqual(parsed, metadata);
});

// ── Test 8: pruneOnShip preserves failed_fixed ────────────────────────────────

test('pruneOnShip preserves failed_fixed scenario directories', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  // Set up two scenarios: lv-001 (failed_fixed), lv-002 (passed)
  store.writeScenarioResult('slice-7', 'lv-001', 1, { status: 'fixed' });
  store.writeBeforeScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));
  store.writeScenarioResult('slice-7', 'lv-002', 1, { status: 'passed' });
  store.writeBeforeScreenshot('slice-7', 'lv-002', 1, Buffer.from('png'));

  const sliceState = {
    failed_fixed: ['lv-001'],
    flaky: [],
    deferred: [],
    passed: ['lv-002'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  // lv-001 must be preserved
  const lv001Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001');
  assert.ok(existsSync(lv001Dir), 'failed_fixed lv-001 directory should be preserved');

  // lv-002 should be pruned
  const lv002Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-002');
  assert.ok(!existsSync(lv002Dir), 'passing lv-002 directory should be pruned');
});

// ── Test 9: pruneOnShip preserves flaky ──────────────────────────────────────

test('pruneOnShip preserves flaky scenario directories', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeScenarioResult('slice-7', 'lv-002', 1, { status: 'flaky' });
  store.writeBeforeScreenshot('slice-7', 'lv-002', 1, Buffer.from('png'));
  store.writeScenarioResult('slice-7', 'lv-003', 1, { status: 'passed' });
  store.writeBeforeScreenshot('slice-7', 'lv-003', 1, Buffer.from('png'));

  const sliceState = {
    failed_fixed: [],
    flaky: ['lv-002'],
    deferred: [],
    passed: ['lv-003'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const lv002Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-002');
  assert.ok(existsSync(lv002Dir), 'flaky lv-002 directory should be preserved');

  const lv003Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-003');
  assert.ok(!existsSync(lv003Dir), 'passing lv-003 directory should be pruned');
});

// ── Test 10: pruneOnShip preserves deferred ───────────────────────────────────

test('pruneOnShip preserves deferred scenario directories', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeScenarioResult('slice-7', 'lv-003', 1, { status: 'blocked-precondition' });
  store.writeBeforeScreenshot('slice-7', 'lv-003', 1, Buffer.from('png'));
  store.writeScenarioResult('slice-7', 'lv-004', 1, { status: 'passed' });

  const sliceState = {
    failed_fixed: [],
    flaky: [],
    deferred: ['lv-003'],
    passed: ['lv-004'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const lv003Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-003');
  assert.ok(existsSync(lv003Dir), 'deferred lv-003 directory should be preserved');

  const lv004Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-004');
  assert.ok(!existsSync(lv004Dir), 'passing lv-004 directory should be pruned');
});

// ── Test 11: pruneOnShip never prunes top-level files ─────────────────────────

test('pruneOnShip never removes summary.json, scenarios.json, or launch.json', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeSummary('slice-7', { total: 1, verdict: 'pass' });
  store.writeScenarios('slice-7', [{ id: 'lv-001', title: 'Test' }]);
  store.writeLaunchMetadata('slice-7', { command: 'npm run dev', pid: 1 });

  // Also write a passing scenario to prune
  store.writeScenarioResult('slice-7', 'lv-001', 1, { status: 'passed' });

  const sliceState = {
    failed_fixed: [],
    flaky: [],
    deferred: [],
    passed: ['lv-001'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const root = evidenceRoot(repoRoot, 'slice-7');
  assert.ok(existsSync(join(root, 'summary.json')), 'summary.json must never be pruned');
  assert.ok(existsSync(join(root, 'scenarios.json')), 'scenarios.json must never be pruned');
  assert.ok(existsSync(join(root, 'launch.json')), 'launch.json must never be pruned');
});

// ── Test 12: pruneOnShip honors prune_pass_evidence_on_ship: true ─────────────

test('pruneOnShip prunes passing raw evidence when prune_pass_evidence_on_ship: true', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeScenarioResult('slice-7', 'lv-001', 1, { status: 'passed' });
  store.writeBeforeScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));
  store.writeAfterScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));
  store.writeLogs('slice-7', 'lv-001', 1, 'all good');

  const sliceState = {
    failed_fixed: [],
    flaky: [],
    deferred: [],
    passed: ['lv-001'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const lv001Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001');
  assert.ok(!existsSync(lv001Dir), 'passing scenario directory should be removed when prune_pass_evidence_on_ship: true');
});

// ── Test 13: pruneOnShip honors prune_pass_evidence_on_ship: false ────────────

test('pruneOnShip is a no-op when prune_pass_evidence_on_ship: false', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  store.writeScenarioResult('slice-7', 'lv-001', 1, { status: 'passed' });
  store.writeBeforeScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));
  store.writeLogs('slice-7', 'lv-001', 1, 'all good');

  const sliceState = {
    failed_fixed: [],
    flaky: [],
    deferred: [],
    passed: ['lv-001'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: false };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const lv001Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001');
  assert.ok(existsSync(lv001Dir), 'passing scenario directory should NOT be removed when prune_pass_evidence_on_ship: false');
});

// ── Test 14: pruneOnShip never removes failed_fixed — defensive overlap check ─

test('pruneOnShip preserves failed_fixed even when scenario also appears in passed list', () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-7');

  // lv-001 appears in BOTH passed and failed_fixed (defensive overlap)
  store.writeScenarioResult('slice-7', 'lv-001', 1, { status: 'fixed' });
  store.writeBeforeScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));
  store.writeAfterScreenshot('slice-7', 'lv-001', 1, Buffer.from('png'));

  const sliceState = {
    failed_fixed: ['lv-001'],
    flaky: [],
    deferred: [],
    // Scenario also shows up as passed (defensive overlap — if prune logic is
    // wrong, this would prune it; the test proves it never does)
    passed: ['lv-001'],
  };
  const projectConfig = { prune_pass_evidence_on_ship: true };

  store.pruneOnShip('slice-7', sliceState, projectConfig);

  const lv001Dir = join(evidenceRoot(repoRoot, 'slice-7'), 'lv-001');
  assert.ok(existsSync(lv001Dir), 'failed_fixed lv-001 MUST be preserved even if it also appears in passed list');
});
