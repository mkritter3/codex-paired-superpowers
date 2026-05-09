/**
 * scenario-runner.test.js
 *
 * TDD tests for lib/codex-bridge/scenario-runner.js.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Scenario Execution"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 8
 *
 * Per-attempt flow:
 *   1. Record current SHA via adapter.getHeadSha()
 *   2. Call preconditionEnforcer.enforce(scenario.preconditions, projectConfig)
 *   3. Capture before.png via adapter.captureScreenshot(path)
 *   4. Execute steps via adapter.executeStep(step, ctx). Honor max_action_retries.
 *   5. Capture after.png
 *   6. Capture logs from logTailer.tail() and logTailer.errors_since()
 *   7. Evaluate assertions (satisfied if no error_patterns matched + no action failed)
 *   8. Persist evidence via evidenceStore
 *   9. Return result { status, evidence_paths, ... }
 *
 * Adapter contract (PINNED):
 *   { executeStep(step, ctx) → { ok, retried, error? },
 *     captureScreenshot(absPath) → void,
 *     openRoute(url) → void,
 *     getHeadSha() → string,
 *     now() → Date }
 *
 * Injection strategy: stub adapter (all executeStep calls return {ok:true});
 * real evidence-store from slice 7 for path correctness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createScenarioRunner } from '../../lib/codex-bridge/scenario-runner.js';
import { createEvidenceStore } from '../../lib/codex-bridge/evidence-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-sr-'));
  return realpathSync(tmp);
}

/**
 * Build a minimal adapter stub.
 * executeStep returns {ok: true, retried: 0} by default.
 */
function makeAdapter(overrides = {}) {
  return {
    executeStep: async (_step, _ctx) => ({ ok: true, retried: 0 }),
    captureScreenshot: async (_absPath) => {},
    openRoute: async (_url) => {},
    getHeadSha: () => 'abc123def456',
    now: () => new Date('2026-05-08T10:00:00Z'),
    ...overrides,
  };
}

/**
 * Build a stub precondition enforcer that always succeeds.
 */
function makeEnforcer(overrides = {}) {
  return {
    enforce: async (_preconditions, _projectConfig) => ({
      status: 'ok',
      setup_logs: [],
      scenario_logs: [],
    }),
    ...overrides,
  };
}

/**
 * Build a stub log tailer.
 * errors_since returns [] unless overridden.
 */
function makeLogTailer(overrides = {}) {
  return {
    tail: (_path, _bytes) => '',
    errors_since: (_path, _timestamp) => [],
    sourceInfo: (_path) => ({ path: _path, available: true }),
    ...overrides,
  };
}

/**
 * Build a minimal project config.
 */
function makeProjectConfig(overrides = {}) {
  return {
    live_verification: {
      computer_use: {
        start_url: 'http://127.0.0.1:3000',
        scenario_timeout_ms: 5000,
        max_action_retries: 2,
      },
      logs: {
        paths: [],
        include_process_output: true,
        max_bytes_per_source: 262144,
        max_excerpt_bytes_per_scenario: 32768,
        error_patterns: ['ERROR', 'Unhandled', 'TypeError', '500'],
      },
      ...overrides,
    },
  };
}

/**
 * Build a minimal scenario object.
 */
function makeScenario(overrides = {}) {
  return {
    id: 'lv-001',
    title: 'Save settings change',
    risk: 'happy-path',
    preconditions: [],
    steps: [
      { action: 'click', target: 'Settings nav item' },
      { action: 'type', target: 'Display name input', value: 'Avery' },
    ],
    assertions: ['Saved display name is visible without page reload'],
    diagnostic_expectations: ['No uncaught exception in app logs'],
    timeout_ms: 5000,
    ...overrides,
  };
}

function evidenceRoot(repoRoot, sliceId) {
  return join(repoRoot, '.superpowers-codex-paired', 'evidence', sliceId);
}

// ── Test 1: Single passing scenario ──────────────────────────────────────────

test('single passing scenario — all steps succeed, status is passed', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter();
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario();

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.equal(result.status, 'passed', 'status should be passed when all steps succeed and no error patterns match');
  assert.ok(result.evidence_paths, 'result should include evidence_paths');
});

test('single passing scenario — before.png, after.png, logs.txt, result.json all written', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter();
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario();

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  await runner.runScenario('slice-8', scenario, 1);

  const attemptDir = join(evidenceRoot(repoRoot, 'slice-8'), 'lv-001', 'attempt-1');
  assert.ok(existsSync(join(attemptDir, 'before.png')), 'before.png should be written');
  assert.ok(existsSync(join(attemptDir, 'after.png')), 'after.png should be written');
  assert.ok(existsSync(join(attemptDir, 'logs.txt')), 'logs.txt should be written');
  assert.ok(existsSync(join(attemptDir, 'result.json')), 'result.json should be written');
});

// ── Test 2: Failing scenario (assertion fails via error patterns in logs) ─────

test('failing scenario (assertion fails) — error_pattern in logs → status is failed', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter();
  const enforcer = makeEnforcer();
  // Simulate log tailer that returns error lines
  const logTailer = makeLogTailer({
    errors_since: (_path, _timestamp) => ['ERROR: missing field displayName'],
  });
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario();

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.equal(result.status, 'failed', 'status should be failed when error patterns are matched in logs');
  assert.ok(result.matched_errors, 'result should include matched_errors');
  assert.ok(
    result.matched_errors.some((e) => e.includes('ERROR')),
    'matched_errors should contain the error line'
  );
});

test('failing scenario (assertion fails) — result.json captures the matched error', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter();
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer({
    errors_since: (_path, _timestamp) => ['ERROR: missing field displayName'],
  });
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario();

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  await runner.runScenario('slice-8', scenario, 1);

  const resultPath = join(evidenceRoot(repoRoot, 'slice-8'), 'lv-001', 'attempt-1', 'result.json');
  assert.ok(existsSync(resultPath), 'result.json should be written on failure');

  const { readFileSync } = await import('node:fs');
  const saved = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(saved.status, 'failed', 'saved result.json status should be failed');
  assert.ok(saved.matched_errors, 'saved result.json should contain matched_errors');
});

// ── Test 3: Failing scenario (action fails) ───────────────────────────────────

test('failing scenario (action fails) — executeStep returns {ok: false} → status failed', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  // Adapter whose executeStep always fails (after exhausting retries)
  const adapter = makeAdapter({
    executeStep: async (_step, _ctx) => ({ ok: false, retried: 0, error: 'element not found' }),
  });
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario();

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.equal(result.status, 'failed', 'status should be failed when executeStep returns ok:false');
  assert.ok(
    result.failure_reason === 'action-failure' || (result.failure_detail && result.failure_detail.includes('element not found')),
    `result should capture action-failure detail, got: ${JSON.stringify(result)}`
  );
});

// ── Test 4: scenario_timeout_ms honored ──────────────────────────────────────

test('scenario_timeout_ms honored — steps that exceed timeout → status failed with timeout reason', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  // executeStep that takes longer than the timeout
  const adapter = makeAdapter({
    executeStep: async (_step, _ctx) => {
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true, retried: 0 };
    },
  });
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();

  // Set a very short timeout (50ms) so the steps exceed it
  const projectConfig = makeProjectConfig({
    computer_use: {
      start_url: 'http://127.0.0.1:3000',
      scenario_timeout_ms: 50,
      max_action_retries: 0,
    },
  });
  const scenario = makeScenario({ timeout_ms: 50 });

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.equal(result.status, 'failed', 'status should be failed on timeout');
  assert.ok(
    result.failure_reason === 'timeout' || (result.failure_detail && result.failure_detail.includes('timeout')),
    `result should capture timeout reason, got: ${JSON.stringify(result)}`
  );
});

// ── Test 5: max_action_retries honored on action failures ─────────────────────

test('max_action_retries honored — runner retries up to max before failing scenario', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  let callCount = 0;
  const adapter = makeAdapter({
    executeStep: async (_step, _ctx) => {
      callCount++;
      return { ok: false, retried: 0, error: 'element not found' };
    },
  });
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();

  // max_action_retries: 2 means initial attempt + 2 retries = 3 total calls per step
  const projectConfig = makeProjectConfig({
    computer_use: {
      start_url: 'http://127.0.0.1:3000',
      scenario_timeout_ms: 5000,
      max_action_retries: 2,
    },
  });
  // Scenario with a single step to make retry count predictable
  const scenario = makeScenario({
    steps: [{ action: 'click', target: 'Settings nav item' }],
  });

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.equal(result.status, 'failed', 'status should be failed when all retries exhausted');
  // 1 initial attempt + 2 retries = 3 total calls for the single step
  assert.equal(callCount, 3, `executeStep should be called 3 times (1 initial + 2 retries), got ${callCount}`);
});

test('max_action_retries — retry count captured in result', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter({
    executeStep: async (_step, _ctx) => ({ ok: false, retried: 0, error: 'element not found' }),
  });
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();
  const projectConfig = makeProjectConfig({
    computer_use: {
      start_url: 'http://127.0.0.1:3000',
      scenario_timeout_ms: 5000,
      max_action_retries: 2,
    },
  });
  const scenario = makeScenario({
    steps: [{ action: 'click', target: 'Button' }],
  });

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  assert.ok(
    result.retries_used != null || (result.failure_detail && result.failure_detail.includes('retries')),
    `result should capture retry info, got: ${JSON.stringify(result)}`
  );
});

// ── Test 6: Evidence directory layout correct ─────────────────────────────────

test('evidence directory layout correct — scenario lv-001 attempt 1 paths match spec', async () => {
  const repoRoot = makeTmpRepo();
  const store = createEvidenceStore(repoRoot);
  store.init('slice-8');

  const adapter = makeAdapter();
  const enforcer = makeEnforcer();
  const logTailer = makeLogTailer();
  const projectConfig = makeProjectConfig();
  const scenario = makeScenario({ id: 'lv-001' });

  const runner = createScenarioRunner({
    adapter,
    evidenceStore: store,
    preconditionEnforcer: enforcer,
    logTailer,
    projectConfig,
  });

  const result = await runner.runScenario('slice-8', scenario, 1);

  // Evidence layout per spec:
  // .superpowers-codex-paired/evidence/<sliceId>/<scenario-id>/attempt-<N>/
  const expectedBase = join(
    repoRoot,
    '.superpowers-codex-paired',
    'evidence',
    'slice-8',
    'lv-001',
    'attempt-1'
  );

  assert.ok(existsSync(join(expectedBase, 'before.png')), `before.png should exist at ${expectedBase}`);
  assert.ok(existsSync(join(expectedBase, 'after.png')), `after.png should exist at ${expectedBase}`);
  assert.ok(existsSync(join(expectedBase, 'logs.txt')), `logs.txt should exist at ${expectedBase}`);
  assert.ok(existsSync(join(expectedBase, 'result.json')), `result.json should exist at ${expectedBase}`);

  // result.evidence_paths should expose these paths
  assert.ok(result.evidence_paths, 'result should include evidence_paths');
  assert.ok(result.evidence_paths.before_png, 'evidence_paths should include before_png');
  assert.ok(result.evidence_paths.after_png, 'evidence_paths should include after_png');
  assert.ok(result.evidence_paths.logs_txt, 'evidence_paths should include logs_txt');
  assert.ok(result.evidence_paths.result_json, 'evidence_paths should include result_json');
});
