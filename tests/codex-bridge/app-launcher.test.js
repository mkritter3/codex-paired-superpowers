/**
 * app-launcher.test.js
 *
 * TDD tests for lib/codex-bridge/app-launcher.js.
 * Tests run against a real fixture script so they exercise actual process management.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "App Launch And Ready Signal"
 *       docs/specs/2026-05-08-v0.6.0-live-verification.md § "Cleanup And Halt Mode"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = join(__dirname, 'fixtures', 'launcher-fixture.js');

import { launchApp, cleanup } from '../../lib/codex-bridge/app-launcher.js';

// ── Helper: find a free port ──────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ── Helper: is process alive ──────────────────────────────────────────────────

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Test 1: Launches and resolves on http-200 ready ───────────────────────────

test('launchApp resolves on http-200 ready signal', { timeout: 10000 }, async () => {
  const port = await getFreePort();
  const config = {
    launch: {
      command: `node ${FIXTURE} http-ready ${port}`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'http',
      url: `http://127.0.0.1:${port}/healthz`,
      expected_status: 200,
      timeout_ms: 8000,
      poll_interval_ms: 100,
    },
  };

  const handle = await launchApp(config);

  assert.ok(typeof handle.pid === 'number' && handle.pid > 0, 'handle has numeric pid');
  assert.equal(handle.ready, true, 'handle.ready is true');
  assert.equal(handle.ready_signal, `http://127.0.0.1:${port}/healthz -> 200`);
  assert.ok(handle.ready_at instanceof Date, 'ready_at is a Date');
  assert.ok(handle.started_at instanceof Date, 'started_at is a Date');
  assert.ok(handle.ready_at >= handle.started_at, 'ready_at is after started_at');

  await cleanup(handle, { mode: 'kill', signal: 'SIGTERM', grace_ms: 500 });
});

// ── Test 2: Resolves on stdout regex match ────────────────────────────────────

test('launchApp resolves on stdout regex match', { timeout: 10000 }, async () => {
  const config = {
    launch: {
      command: `node ${FIXTURE} stdout-ready`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'stdout_regex',
      stdout_regex: 'ready',
      timeout_ms: 8000,
    },
  };

  const handle = await launchApp(config);

  assert.ok(typeof handle.pid === 'number' && handle.pid > 0);
  assert.equal(handle.ready, true);
  assert.equal(handle.ready_signal, 'stdout_regex: ready');

  await cleanup(handle, { mode: 'kill', signal: 'SIGTERM', grace_ms: 500 });
});

// ── Test 3: Resolves on log-file regex match ──────────────────────────────────

test('launchApp resolves on log-file regex match', { timeout: 10000 }, async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cps-al-'));
  const logPath = join(tmpDir, 'app.log');

  const config = {
    launch: {
      command: `node ${FIXTURE} log-ready ${logPath}`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'log_regex',
      log_path: logPath,
      log_regex: 'Ready in',
      timeout_ms: 8000,
      poll_interval_ms: 100,
    },
  };

  const handle = await launchApp(config);

  assert.ok(typeof handle.pid === 'number' && handle.pid > 0);
  assert.equal(handle.ready, true);
  assert.ok(handle.ready_signal.includes('log_regex'));

  await cleanup(handle, { mode: 'kill', signal: 'SIGTERM', grace_ms: 500 });
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 4: Rejects when launch command exits early ───────────────────────────

test('launchApp rejects with live-verification-launch-failure when command exits early', { timeout: 8000 }, async () => {
  const config = {
    launch: {
      command: `node ${FIXTURE} exits-early`,
      timeout_ms: 5000,
    },
    ready: {
      strategy: 'stdout_regex',
      stdout_regex: 'ready',
      timeout_ms: 5000,
    },
  };

  await assert.rejects(
    () => launchApp(config),
    (err) => {
      assert.equal(err.code, 'live-verification-launch-failure', `expected launch-failure code, got: ${err.code}`);
      return true;
    }
  );
});

// ── Test 5: Rejects on ready-signal timeout ───────────────────────────────────

test('launchApp rejects with live-verification-launch-failure on ready-signal timeout', { timeout: 5000 }, async () => {
  const config = {
    launch: {
      command: `node ${FIXTURE} sleeps-forever`,
      timeout_ms: 2000,
    },
    ready: {
      strategy: 'stdout_regex',
      stdout_regex: 'ready',
      timeout_ms: 500,
      poll_interval_ms: 50,
    },
  };

  await assert.rejects(
    () => launchApp(config),
    (err) => {
      assert.equal(err.code, 'live-verification-launch-failure', `expected launch-failure code, got: ${err.code}`);
      return true;
    }
  );
});

// ── Test 6: Cleanup kill sends SIGTERM then SIGKILL after grace ───────────────

test('cleanup kill mode: process is gone within grace + buffer ms', { timeout: 10000 }, async () => {
  const port = await getFreePort();
  const config = {
    launch: {
      command: `node ${FIXTURE} http-ready ${port}`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'http',
      url: `http://127.0.0.1:${port}/healthz`,
      expected_status: 200,
      timeout_ms: 8000,
      poll_interval_ms: 100,
    },
  };

  const handle = await launchApp(config);
  const { pid } = handle;

  assert.ok(isAlive(pid), 'process should be alive before cleanup');

  await cleanup(handle, { mode: 'kill', signal: 'SIGTERM', grace_ms: 100 });

  // After cleanup completes, the process should be gone
  // Give a tiny extra buffer for OS to reap
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!isAlive(pid), 'process should be dead after cleanup');
});

// ── Test 7: Cleanup leave_running records metadata and returns ────────────────

test('cleanup leave_running mode: process still running, metadata returned', { timeout: 10000 }, async () => {
  const port = await getFreePort();
  const config = {
    launch: {
      command: `node ${FIXTURE} http-ready ${port}`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'http',
      url: `http://127.0.0.1:${port}/healthz`,
      expected_status: 200,
      timeout_ms: 8000,
      poll_interval_ms: 100,
    },
  };

  const handle = await launchApp(config);
  const { pid } = handle;

  const meta = await cleanup(handle, { mode: 'leave_running' });

  assert.ok(isAlive(pid), 'process should still be alive after leave_running cleanup');
  assert.equal(meta.pid, pid, 'metadata includes pid');
  assert.ok(typeof meta.command === 'string' && meta.command.length > 0, 'metadata includes command');
  assert.ok(typeof meta.suggested_cleanup === 'string' && meta.suggested_cleanup.length > 0, 'metadata includes suggested_cleanup text');

  // Clean up for real now
  try { process.kill(-handle.pgid, 'SIGKILL'); } catch { /* already dead */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
});

// ── Test 8: PID and PGID captured ─────────────────────────────────────────────

test('launchApp captures pid and pgid for child-tree cleanup', { timeout: 10000 }, async () => {
  const config = {
    launch: {
      command: `node ${FIXTURE} stdout-ready`,
      timeout_ms: 8000,
    },
    ready: {
      strategy: 'stdout_regex',
      stdout_regex: 'ready',
      timeout_ms: 8000,
    },
  };

  const handle = await launchApp(config);

  assert.ok(typeof handle.pid === 'number' && handle.pid > 0, 'pid is set');
  assert.ok(typeof handle.pgid === 'number' && handle.pgid > 0, 'pgid is set');

  await cleanup(handle, { mode: 'kill', signal: 'SIGTERM', grace_ms: 500 });
});
