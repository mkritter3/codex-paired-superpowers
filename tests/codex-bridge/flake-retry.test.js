/**
 * flake-retry.test.js
 *
 * TDD tests for lib/codex-bridge/flake-retry.js.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Flake Handling"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 8
 *
 * Same-SHA flake check logic:
 *   1. If first attempt passes → return as-is.
 *   2. If first attempt fails with deterministic action error → return
 *      deterministic-failure (no retry; action errors are not retryable as flakes).
 *   3. If first attempt fails with assertion/log error → retry at same SHA
 *      (re-apply preconditions via the runner, which calls enforcer).
 *   4. Second attempt passes → status flaky; increment flakeCount.
 *   5. Second attempt fails with same assertion failure → deterministic-failure.
 *   6. flakeCount >= maxFlakes → throw live-verification-flaky-runner.
 *
 * Injection: flake-retry depends on a runner object that exposes
 *   runScenario(sliceId, scenario, attempt) → Promise<result>
 * and an adapter that exposes getHeadSha() → string.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFlakeChecker } from '../../lib/codex-bridge/flake-retry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal scenario.
 */
function makeScenario(id = 'lv-001') {
  return {
    id,
    title: 'Save settings change',
    preconditions: [],
    steps: [{ action: 'click', target: 'Button' }],
    assertions: ['Display name updated'],
    timeout_ms: 5000,
  };
}

/**
 * Build a stub runner where runScenario returns results from a sequence.
 * Each call to runScenario() returns the next result from the results array.
 */
function makeRunner(results) {
  let callIndex = 0;
  const calls = [];

  return {
    runScenario: async (sliceId, scenario, attempt) => {
      calls.push({ sliceId, scenario, attempt });
      const result = results[callIndex] ?? results[results.length - 1];
      callIndex++;
      return result;
    },
    getCalls: () => calls,
    getCallCount: () => callIndex,
  };
}

/**
 * Build a stub adapter with controllable getHeadSha.
 */
function makeAdapter(sha = 'abc123') {
  return {
    getHeadSha: () => sha,
    executeStep: async () => ({ ok: true, retried: 0 }),
    captureScreenshot: async () => {},
    openRoute: async () => {},
    now: () => new Date(),
  };
}

// ── Test 1: First failure triggers same-SHA retry ─────────────────────────────

test('first failure triggers same-SHA retry — getHeadSha() returns same value on both attempts', async () => {
  const shaCalls = [];
  const adapter = {
    ...makeAdapter('sha-111'),
    getHeadSha: () => {
      shaCalls.push('sha-111');
      return 'sha-111';
    },
  };

  // First attempt: fails with assertion failure. Second attempt: passes.
  const runner = makeRunner([
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: oops'] },
    { status: 'passed', evidence_paths: {} },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  const result = await checker.runWithFlakeRetry(makeScenario());

  // Verify that two attempts were made
  assert.equal(runner.getCallCount(), 2, 'runner.runScenario should be called twice');

  // Verify the SHA was fetched (to confirm same-SHA enforcement)
  // Both attempts should see the same SHA
  assert.ok(shaCalls.length >= 1, 'getHeadSha should be called at least once');
  const uniqueShas = new Set(shaCalls);
  assert.equal(uniqueShas.size, 1, 'all SHA checks should return the same value');
});

// ── Test 2: Preconditions re-applied between retries ─────────────────────────

test('preconditions re-applied between retries — runner.runScenario called twice', async () => {
  const adapter = makeAdapter('sha-222');

  // First attempt fails with assertion failure, second passes.
  const runner = makeRunner([
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: field missing'] },
    { status: 'passed', evidence_paths: {} },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  await checker.runWithFlakeRetry(makeScenario());

  // The runner's runScenario drives precondition enforcement internally.
  // Verify it was called twice (each call re-applies preconditions via
  // the runner's internal preconditionEnforcer).
  assert.equal(runner.getCallCount(), 2, 'runner.runScenario (which includes precondition enforcement) should be called twice');
});

// ── Test 3: Second pass → flaky ───────────────────────────────────────────────

test('second pass → status flaky', async () => {
  const adapter = makeAdapter('sha-333');

  const runner = makeRunner([
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: something'] },
    { status: 'passed', evidence_paths: {} },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  const result = await checker.runWithFlakeRetry(makeScenario());

  assert.equal(result.status, 'flaky', `expected flaky, got: ${result.status}`);
  assert.equal(result.attempts, 2, 'result.attempts should be 2');
});

test('second pass → flakeCount incremented', async () => {
  const adapter = makeAdapter('sha-444');

  const runner = makeRunner([
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: x'] },
    { status: 'passed', evidence_paths: {} },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  assert.equal(checker.flakeCount, 0, 'initial flakeCount should be 0');
  await checker.runWithFlakeRetry(makeScenario());
  assert.equal(checker.flakeCount, 1, 'flakeCount should be 1 after one flaky result');
});

// ── Test 4: Second fail with materially-same evidence → deterministic-failure ─

test('second fail with same assertion failure → status deterministic-failure', async () => {
  const adapter = makeAdapter('sha-555');

  // Both attempts fail with assertion failure (same error)
  const runner = makeRunner([
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: missing field displayName'] },
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: missing field displayName'] },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  const result = await checker.runWithFlakeRetry(makeScenario());

  assert.equal(result.status, 'deterministic-failure', `expected deterministic-failure, got: ${result.status}`);
  assert.equal(result.attempts, 2, 'result.attempts should be 2');
});

// ── Test 5: Two flakes across separate scenarios → halt with flaky-runner ─────

test('two flakes across separate scenarios in same run → throws live-verification-flaky-runner', async () => {
  const adapter = makeAdapter('sha-666');

  // Each runWithFlakeRetry call: first attempt fails, second passes (= flaky)
  const flakeResult1 = [
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: a'] },
    { status: 'passed', evidence_paths: {} },
  ];
  const flakeResult2 = [
    { status: 'failed', failure_reason: 'assertion-failure', matched_errors: ['ERROR: b'] },
    { status: 'passed', evidence_paths: {} },
  ];

  const runner1 = makeRunner(flakeResult1);
  const runner2 = makeRunner(flakeResult2);

  // maxFlakes: 2 means halt when flakeCount reaches 2
  const checker = createFlakeChecker({
    runner: runner1,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  // First flaky scenario
  const result1 = await checker.runWithFlakeRetry(makeScenario('lv-001'));
  assert.equal(result1.status, 'flaky', 'first scenario should be flaky');
  assert.equal(checker.flakeCount, 1, 'flakeCount should be 1 after first flake');

  // Swap the runner for the second scenario
  checker._runner = runner2;

  // Second flaky scenario — should throw live-verification-flaky-runner
  await assert.rejects(
    () => checker.runWithFlakeRetry(makeScenario('lv-002')),
    (err) => {
      assert.ok(
        err.code === 'live-verification-flaky-runner' || err.message.includes('live-verification-flaky-runner'),
        `expected live-verification-flaky-runner error, got: ${err.message}`
      );
      return true;
    },
    'should throw live-verification-flaky-runner when flakeCount >= maxFlakes'
  );
});

// ── Test 6: First pass — no retry, return as-is ───────────────────────────────

test('first pass — no retry, returned with original status', async () => {
  const adapter = makeAdapter('sha-777');

  const runner = makeRunner([
    { status: 'passed', evidence_paths: {} },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  const result = await checker.runWithFlakeRetry(makeScenario());

  assert.equal(result.status, 'passed', 'status should be passed on first-attempt pass');
  assert.equal(runner.getCallCount(), 1, 'runner.runScenario should only be called once when first attempt passes');
  assert.equal(checker.flakeCount, 0, 'flakeCount should remain 0 on clean pass');
});

// ── Test 7: Deterministic action failure — not retried as flake ───────────────

test('deterministic action failure — not retried, returned as deterministic-failure', async () => {
  const adapter = makeAdapter('sha-888');

  const runner = makeRunner([
    {
      status: 'failed',
      failure_reason: 'action-failure',
      failure_detail: 'element not found',
      matched_errors: [],
    },
  ]);

  const checker = createFlakeChecker({
    runner,
    adapter,
    sliceId: 'slice-8',
    maxFlakes: 2,
  });

  const result = await checker.runWithFlakeRetry(makeScenario());

  assert.equal(result.status, 'deterministic-failure', `expected deterministic-failure for action error, got: ${result.status}`);
  assert.equal(runner.getCallCount(), 1, 'runner.runScenario should only be called once for action failures (not retried as flake)');
});
