/**
 * precondition-enforcer.test.js
 *
 * TDD tests for lib/codex-bridge/precondition-enforcer.js.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Precondition Enforcement"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 4
 *
 * All dependencies (adapter, spawn) are injected so tests never touch real
 * UI or the filesystem. Slice 1's config-load-time env-var checks are
 * out of scope here; this slice covers RUNTIME failures only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPreconditionEnforcer } from '../../lib/codex-bridge/precondition-enforcer.js';

// ── Stub helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal stub adapter.
 * @param {object} [overrides]
 */
function makeAdapter(overrides = {}) {
  return {
    openRoute: async (_url) => {},
    executeStep: async (_step) => ({ ok: true }),
    ...overrides,
  };
}

/**
 * Build a minimal project config with live_verification setup block.
 * @param {object} [setupOverrides]
 * @param {object} [computerUseOverrides]
 */
function makeConfig(setupOverrides = {}, computerUseOverrides = {}) {
  return {
    live_verification: {
      setup: {
        reset_command: null,
        seed_command: null,
        login_profiles: {},
        setup_timeout_ms: 60000,
        ...setupOverrides,
      },
      computer_use: {
        start_url: 'http://127.0.0.1:3000',
        ...computerUseOverrides,
      },
    },
  };
}

/**
 * Build a mock spawn that immediately resolves with a given exit code.
 * Captures stdout + stderr strings into the spawned process streams.
 *
 * @param {number} exitCode
 * @param {string} [stdout]
 * @param {string} [stderr]
 */
function mockSpawn(exitCode, stdout = '', stderr = '') {
  return (_cmd, _args, _opts) => {
    const EventEmitter = class {
      constructor() { this._handlers = {}; }
      on(evt, fn) { this._handlers[evt] = fn; return this; }
      emit(evt, ...args) { if (this._handlers[evt]) this._handlers[evt](...args); }
    };

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    // Emit data + exit in next tick so callers can attach handlers
    setImmediate(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode, null);
    });

    return proc;
  };
}

/**
 * Build a slow mock spawn that delays before exiting.
 * Used for timeout tests.
 *
 * @param {number} delayMs
 * @param {number} exitCode
 */
function slowMockSpawn(delayMs, exitCode) {
  return (_cmd, _args, _opts) => {
    const EventEmitter = class {
      constructor() { this._handlers = {}; }
      on(evt, fn) { this._handlers[evt] = fn; return this; }
      emit(evt, ...args) { if (this._handlers[evt]) this._handlers[evt](...args); }
    };

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};

    setTimeout(() => {
      proc.emit('exit', exitCode, null);
    }, delayMs);

    return proc;
  };
}

// ── Fixed time ────────────────────────────────────────────────────────────────

const FIXED_NOW = () => new Date('2026-05-08T00:00:00.000Z');

// ── Test 1: navigate opens configured start_url + route ───────────────────────

test('navigate: adapter.openRoute called with start_url + route value', async () => {
  const calls = [];
  const adapter = makeAdapter({
    openRoute: async (url) => { calls.push(url); },
  });

  const runner = createPreconditionEnforcer({ adapter, spawn: mockSpawn(0), now: FIXED_NOW });
  const preconditions = [
    { type: 'route', value: '/settings', enforcement: 'navigate' },
  ];
  const config = makeConfig();

  const result = await runner.enforce(preconditions, config);

  assert.equal(result.status, 'ok', `expected ok, got ${result.status}`);
  assert.equal(calls.length, 1, 'openRoute called once');
  assert.equal(calls[0], 'http://127.0.0.1:3000/settings', `expected full URL, got ${calls[0]}`);
});

// ── Test 2: reset_command runs and waits for exit-0 ──────────────────────────

test('reset_command: spawns the configured command and resolves on exit-0', async () => {
  const spawned = [];
  const spawnFn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return mockSpawn(0)(cmd, args, opts);
  };

  const adapter = makeAdapter();
  const runner = createPreconditionEnforcer({ adapter, spawn: spawnFn, now: FIXED_NOW });
  const config = makeConfig({ reset_command: 'npm run test:reset-db' });

  // No scenario-level preconditions needed to test reset_command
  const result = await runner.enforce([], config);

  assert.equal(result.status, 'ok');
  assert.equal(spawned.length, 1, 'spawn called once');
  // The command string should appear in either cmd or the concatenated args
  const invokedCmd = [spawned[0].cmd, ...(spawned[0].args || [])].join(' ');
  assert.ok(
    invokedCmd.includes('npm run test:reset-db') || invokedCmd.includes('test:reset-db'),
    `command should reference reset command, got: ${invokedCmd}`
  );
});

// ── Test 3: reset_command failure → blocked-precondition ─────────────────────

test('reset_command failure: exit-1 produces blocked-precondition with reason reset-command-failed', async () => {
  const adapter = makeAdapter();
  const runner = createPreconditionEnforcer({
    adapter,
    spawn: mockSpawn(1, 'stdout from reset', 'stderr from reset'),
    now: FIXED_NOW,
  });
  const config = makeConfig({ reset_command: 'npm run test:reset-db' });

  const result = await runner.enforce([], config);

  assert.equal(result.status, 'blocked-precondition', `expected blocked-precondition, got ${result.status}`);
  assert.equal(result.reason, 'reset-command-failed', `expected reset-command-failed, got ${result.reason}`);
  assert.ok(result.setup_logs !== undefined, 'result should include setup_logs');
});

// ── Test 4: seed_command failure → blocked-precondition ──────────────────────

test('seed_command failure: exit-1 produces blocked-precondition with reason seed-command-failed', async () => {
  const adapter = makeAdapter();
  const runner = createPreconditionEnforcer({
    adapter,
    spawn: mockSpawn(1, '', 'seed failed'),
    now: FIXED_NOW,
  });
  const config = makeConfig({ seed_command: 'npm run test:seed' });

  const result = await runner.enforce([], config);

  assert.equal(result.status, 'blocked-precondition');
  assert.equal(result.reason, 'seed-command-failed');
});

// ── Test 5: login_profile — openRoute + executeStep + status ok ───────────────

test('login_profile: openRoute called with login_route, executeStep called for each step, status ok', async () => {
  const routeCalls = [];
  const stepCalls = [];

  const adapter = makeAdapter({
    openRoute: async (url) => { routeCalls.push(url); },
    executeStep: async (step) => {
      stepCalls.push(step);
      return { ok: true };
    },
  });

  const runner = createPreconditionEnforcer({ adapter, spawn: mockSpawn(0), now: FIXED_NOW });

  const config = makeConfig({
    login_profiles: {
      seeded_test_user: {
        username: 'test@example.com',
        password_env: 'LIVE_TEST_PASSWORD',
        login_route: '/login',
        setup_steps: [
          { action: 'click', target: 'Email input' },
          { action: 'type', target: 'Email input', value: 'test@example.com' },
        ],
      },
    },
  });

  const preconditions = [
    { type: 'auth', value: 'seeded_test_user', enforcement: 'login_profile' },
  ];

  const result = await runner.enforce(preconditions, config);

  assert.equal(result.status, 'ok', `expected ok, got ${result.status}`);
  // openRoute should have been called with the login_route
  assert.ok(
    routeCalls.some((u) => u.includes('/login')),
    `expected openRoute called with /login, got ${JSON.stringify(routeCalls)}`
  );
  // setup_steps should have been executed
  assert.equal(stepCalls.length, 2, `expected 2 steps, got ${stepCalls.length}`);
});

// ── Test 6: login_profile step failure → blocked-precondition ────────────────

test('login_profile step failure: executeStep {ok:false} produces blocked-precondition login-step-failed', async () => {
  const adapter = makeAdapter({
    openRoute: async () => {},
    executeStep: async (_step) => ({ ok: false, error: 'Element not found' }),
  });

  const runner = createPreconditionEnforcer({ adapter, spawn: mockSpawn(0), now: FIXED_NOW });

  const config = makeConfig({
    login_profiles: {
      seeded_test_user: {
        username: 'test@example.com',
        password_env: 'LIVE_TEST_PASSWORD',
        login_route: '/login',
        setup_steps: [
          { action: 'click', target: 'Login button' },
        ],
      },
    },
  });

  const preconditions = [
    { type: 'auth', value: 'seeded_test_user', enforcement: 'login_profile' },
  ];

  const result = await runner.enforce(preconditions, config);

  assert.equal(result.status, 'blocked-precondition');
  assert.equal(result.reason, 'login-step-failed');
});

// ── Test 7: setup_steps — each step executed via adapter.executeStep ──────────

test('setup_steps: each step executed via adapter.executeStep; aggregate failure blocks', async () => {
  const stepCalls = [];
  let callCount = 0;

  const adapter = makeAdapter({
    executeStep: async (step) => {
      stepCalls.push(step);
      callCount++;
      // Fail on the 2nd step
      return callCount < 2 ? { ok: true } : { ok: false, error: 'timeout' };
    },
  });

  const runner = createPreconditionEnforcer({ adapter, spawn: mockSpawn(0), now: FIXED_NOW });
  const config = makeConfig();

  const preconditions = [
    {
      type: 'setup',
      enforcement: 'setup_steps',
      steps: [
        { action: 'click', target: 'Accept cookies' },
        { action: 'click', target: 'Sign in button' },
      ],
    },
  ];

  const result = await runner.enforce(preconditions, config);

  assert.equal(result.status, 'blocked-precondition', `expected blocked-precondition, got ${result.status}`);
  assert.equal(result.reason, 'setup-step-failed');
  assert.equal(stepCalls.length, 2, 'both steps should have been attempted before the failure was detected');
});

// ── Test 8: manual_blocked returns blocked-precondition immediately ───────────

test('manual_blocked: returns blocked-precondition immediately without running adapter', async () => {
  const stepCalls = [];
  const adapter = makeAdapter({
    openRoute: async () => { stepCalls.push('openRoute'); },
    executeStep: async () => { stepCalls.push('executeStep'); return { ok: true }; },
  });

  const runner = createPreconditionEnforcer({ adapter, spawn: mockSpawn(0), now: FIXED_NOW });
  const config = makeConfig();

  const preconditions = [
    { type: 'auth', enforcement: 'manual_blocked', reason: 'OAuth flow not automatable' },
  ];

  const result = await runner.enforce(preconditions, config);

  assert.equal(result.status, 'blocked-precondition');
  assert.equal(result.reason, 'manual-blocked');
  // Adapter should NOT have been called
  assert.equal(stepCalls.length, 0, 'adapter should not have been invoked for manual_blocked');
});

// ── Test 9: setup logs separated from scenario logs ──────────────────────────

test('setup logs separated from scenario logs: result contains setup_logs and scenario_logs', async () => {
  const adapter = makeAdapter();
  const runner = createPreconditionEnforcer({
    adapter,
    spawn: mockSpawn(0, 'reset output here', ''),
    now: FIXED_NOW,
  });
  const config = makeConfig({ reset_command: 'npm run test:reset-db' });

  const result = await runner.enforce([], config);

  assert.equal(result.status, 'ok');
  assert.ok('setup_logs' in result, 'result should have setup_logs key');
  assert.ok('scenario_logs' in result, 'result should have scenario_logs key');
  assert.ok(Array.isArray(result.scenario_logs), 'scenario_logs should be an array');
  // scenario_logs should be empty (not polluted with setup output)
  assert.equal(result.scenario_logs.length, 0, 'scenario_logs should be empty after setup-only run');
  // setup_logs should have captured output from the reset command
  const setupLogsStr = JSON.stringify(result.setup_logs);
  assert.ok(
    setupLogsStr.includes('reset') || setupLogsStr.includes('npm') || result.setup_logs.length > 0,
    'setup_logs should contain at least one entry'
  );
});

// ── Test 10: setup timeout ────────────────────────────────────────────────────

test('setup timeout: reset_command taking longer than setup_timeout_ms rejects with precondition-timeout', async () => {
  const adapter = makeAdapter();
  // slow spawn: takes 500ms, but timeout is 100ms
  const runner = createPreconditionEnforcer({
    adapter,
    spawn: slowMockSpawn(500, 0),
    now: FIXED_NOW,
  });
  const config = makeConfig({
    reset_command: 'sleep 1',
    setup_timeout_ms: 100,
  });

  const result = await runner.enforce([], config);

  assert.equal(result.status, 'blocked-precondition', `expected blocked-precondition, got ${result.status}`);
  assert.equal(result.reason, 'precondition-timeout', `expected precondition-timeout, got ${result.reason}`);
}, { timeout: 3000 });
