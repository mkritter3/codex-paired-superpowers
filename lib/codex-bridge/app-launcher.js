/**
 * app-launcher.js
 *
 * Launch an application process, poll for its ready signal, and clean up.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md
 *       § "App Launch And Ready Signal"
 *       § "Cleanup And Halt Mode"
 *
 * Exports
 * ───────
 *   launchApp(config)  → Promise<handle>
 *   cleanup(handle, mode) → Promise<meta | void>
 *
 * handle shape:
 *   { pid, pgid, ready, ready_signal, ready_at, started_at, command, _proc }
 *
 * Failure: rejects with Error({ code: 'live-verification-launch-failure', message })
 *
 * Ready strategies:
 *   http         — poll GET until expected_status
 *   stdout_regex — watch stdout buffer for regex match
 *   log_regex    — poll a log file for regex match
 *   fixed_wait   — setTimeout
 *
 * Cleanup modes:
 *   kill         — SIGTERM, wait grace_ms, SIGKILL if still alive; signals whole pgid
 *   leave_running — skip kill; return metadata with pid / command / suggested_cleanup
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { get } from 'node:http';
import { get as httpsGet } from 'node:https';

// ── Internal error factory ────────────────────────────────────────────────────

function launchError(msg) {
  const e = new Error(msg);
  e.code = 'live-verification-launch-failure';
  return e;
}

// ── HTTP poller ───────────────────────────────────────────────────────────────

/**
 * Poll an HTTP URL until it returns the expected status.
 * @param {string} url
 * @param {number} expectedStatus
 * @param {number} pollIntervalMs
 * @param {number} timeoutMs
 * @returns {Promise<void>}  resolves when matched; rejects after timeout
 */
function pollHttp(url, expectedStatus, pollIntervalMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const fetcher = url.startsWith('https://') ? httpsGet : get;

    function attempt() {
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        reject(launchError(`Ready-signal timeout: HTTP ${url} did not return ${expectedStatus} within ${timeoutMs}ms`));
        return;
      }

      const req = fetcher(url, (res) => {
        if (res.statusCode === expectedStatus) {
          resolve();
        } else {
          scheduleNext();
        }
        // Drain response so connection is released
        res.resume();
      });

      req.on('error', () => {
        // Connection refused / ECONNREFUSED → process not up yet
        scheduleNext();
      });

      req.setTimeout(Math.min(pollIntervalMs, 1000), () => {
        req.destroy();
        scheduleNext();
      });
    }

    function scheduleNext() {
      const elapsed = Date.now() - start;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        reject(launchError(`Ready-signal timeout: HTTP ${url} did not return ${expectedStatus} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, Math.min(pollIntervalMs, remaining));
    }

    attempt();
  });
}

// ── stdout_regex watcher ──────────────────────────────────────────────────────

/**
 * Wait for a regex match in a string buffer (updated externally).
 * @param {() => string} getBuffer  returns the current stdout buffer string
 * @param {string} pattern          regex pattern string
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function watchStdout(getBuffer, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const re = new RegExp(pattern);
    const start = Date.now();
    const POLL = 50;

    function check() {
      if (re.test(getBuffer())) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(launchError(`Ready-signal timeout: stdout_regex /${pattern}/ not matched within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, POLL);
    }

    check();
  });
}

// ── log_regex watcher ─────────────────────────────────────────────────────────

/**
 * Poll a log file until a regex matches its contents.
 * @param {string} logPath
 * @param {string} pattern
 * @param {number} pollIntervalMs
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function watchLogFile(logPath, pattern, pollIntervalMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const re = new RegExp(pattern);
    const start = Date.now();

    function check() {
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf8');
          if (re.test(content)) {
            resolve();
            return;
          }
        } catch {
          // File may be mid-write — ignore and retry
        }
      }
      if (Date.now() - start >= timeoutMs) {
        reject(launchError(`Ready-signal timeout: log_regex /${pattern}/ not matched in "${logPath}" within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, pollIntervalMs);
    }

    check();
  });
}

// ── launchApp ─────────────────────────────────────────────────────────────────

/**
 * Launch a process and wait for its ready signal.
 *
 * @param {object} config
 * @param {object} config.launch
 * @param {string} config.launch.command
 * @param {number} [config.launch.timeout_ms]
 * @param {object} [config.launch.env]
 * @param {string} [config.launch.cwd]
 * @param {object} config.ready
 * @param {string} config.ready.strategy       'http'|'stdout_regex'|'log_regex'|'fixed_wait'
 * @param {string} [config.ready.url]          http strategy
 * @param {number} [config.ready.expected_status]
 * @param {string} [config.ready.stdout_regex] stdout_regex strategy
 * @param {string} [config.ready.log_path]     log_regex strategy
 * @param {string} [config.ready.log_regex]
 * @param {number} [config.ready.fixed_wait_ms] fixed_wait strategy
 * @param {number} [config.ready.timeout_ms]
 * @param {number} [config.ready.poll_interval_ms]
 *
 * @returns {Promise<{pid, pgid, ready, ready_signal, ready_at, started_at, command, _proc}>}
 */
export async function launchApp(config) {
  const { launch, ready } = config;

  const cmd = launch.command;
  const launchTimeoutMs = launch.timeout_ms || 120000;
  const readyTimeoutMs = ready.timeout_ms || 120000;
  const pollIntervalMs = ready.poll_interval_ms || 1000;
  const cwd = launch.cwd || '.';
  const env = { ...process.env, ...(launch.env || {}) };

  const started_at = new Date();

  // Spawn with detached:true to create a new process group (for child-tree cleanup)
  // shell:true allows compound commands; use /bin/sh -c form
  const proc = spawn('sh', ['-c', cmd], {
    detached: true,
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Capture stdout to in-memory buffer
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8'); });
  proc.stderr.on('data', (_chunk) => { /* captured but not needed for ready-signal */ });

  // Track process exit
  let exitedWith = null;
  proc.on('exit', (code, signal) => {
    exitedWith = { code, signal };
  });

  const pid = proc.pid;
  const pgid = pid; // detached:true ensures process is its own group leader

  // Wait for either the ready signal or the process to exit early
  const readyPromise = (async () => {
    switch (ready.strategy) {
      case 'http': {
        const url = ready.url;
        const expectedStatus = ready.expected_status || 200;
        await pollHttp(url, expectedStatus, pollIntervalMs, readyTimeoutMs);
        return `${url} -> ${expectedStatus}`;
      }

      case 'stdout_regex': {
        const pattern = ready.stdout_regex;
        await watchStdout(() => stdoutBuf, pattern, readyTimeoutMs);
        return `stdout_regex: ${pattern}`;
      }

      case 'log_regex': {
        const logPath = ready.log_path;
        const pattern = ready.log_regex;
        await watchLogFile(logPath, pattern, pollIntervalMs, readyTimeoutMs);
        return `log_regex: ${pattern}`;
      }

      case 'fixed_wait': {
        const waitMs = ready.fixed_wait_ms || 1000;
        await new Promise((r) => setTimeout(r, waitMs));
        return `fixed_wait: ${waitMs}ms`;
      }

      default:
        throw launchError(`Unknown ready strategy: ${ready.strategy}`);
    }
  })();

  // Race the ready-signal poll against the overall launch timeout
  const launchTimeoutPromise = new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(launchError(`Launch timeout: process did not become ready within ${launchTimeoutMs}ms`));
    }, launchTimeoutMs);
  });

  // Early exit watcher — if the process dies before ready, reject
  const earlyExitPromise = new Promise((_resolve, reject) => {
    function checkExit() {
      if (exitedWith !== null) {
        reject(launchError(
          `Process exited with code ${exitedWith.code} (signal: ${exitedWith.signal}) before ready signal`
        ));
      } else {
        setTimeout(checkExit, 50);
      }
    }
    // Start checking after a tick to let proc.on('exit') register
    setTimeout(checkExit, 20);
  });

  let ready_signal;
  try {
    ready_signal = await Promise.race([readyPromise, launchTimeoutPromise, earlyExitPromise]);
  } catch (err) {
    // Kill the process group before propagating
    try { process.kill(-pgid, 'SIGKILL'); } catch { /* already dead */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    if (!err.code) err.code = 'live-verification-launch-failure';
    throw err;
  }

  const ready_at = new Date();

  return {
    pid,
    pgid,
    ready: true,
    ready_signal,
    ready_at,
    started_at,
    command: cmd,
    _proc: proc,
  };
}

// ── cleanup ───────────────────────────────────────────────────────────────────

/**
 * Clean up a launched process.
 *
 * @param {object} handle           — as returned by launchApp
 * @param {object} mode
 * @param {string} mode.mode        'kill' | 'leave_running'
 * @param {string} [mode.signal]    signal to send first (default: 'SIGTERM')
 * @param {number} [mode.grace_ms]  grace period before SIGKILL (default: 5000)
 *
 * @returns {Promise<void | object>}
 *   kill mode → resolves void after process is gone
 *   leave_running mode → resolves with metadata object
 */
export async function cleanup(handle, mode) {
  const { pid, pgid, command, ready_signal } = handle;

  if (mode.mode === 'leave_running') {
    return {
      pid,
      pgid,
      command,
      start_url: ready_signal,
      suggested_cleanup: `kill -TERM -${pgid} && sleep 2 && kill -KILL -${pgid} 2>/dev/null || true  # or: kill ${pid}`,
    };
  }

  // kill mode
  const signal = mode.signal || 'SIGTERM';
  const graceMs = mode.grace_ms !== undefined ? mode.grace_ms : 5000;

  // Send initial signal to the whole process group
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already dead — nothing to do
    return;
  }

  // Wait grace_ms for the process to die
  await new Promise((resolve) => setTimeout(resolve, graceMs));

  // Check if still alive and SIGKILL if so
  let alive = false;
  try {
    process.kill(-pgid, 0);
    alive = true;
  } catch {
    alive = false;
  }

  if (alive) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch { /* already dead */ }

    // Also try the leader PID directly in case pgid doesn't work
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already dead */ }

    // Brief wait for SIGKILL to take effect
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
