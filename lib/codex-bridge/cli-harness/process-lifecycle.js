// v0.17.0 slice 3 — shared process lifecycle helper for CLI harness adapters.
//
// Extracts timeout, AbortController, process-group reaping, SIGINT/SIGTERM
// forwarding, stream bounding, and exit classification shared between
// codex.js and agy.js adapters.

import { spawn } from 'node:child_process';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB safety cap per stream.

export const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

export const SIGNAL_TO_NUMBER = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Compose the combined stdin/prompt payload from system and user prompts.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §3
 */
export function composeStdinPayload(systemPrompt, userPrompt) {
  const sys = typeof systemPrompt === 'string' ? systemPrompt : '';
  const usr = typeof userPrompt === 'string' ? userPrompt : '';
  if (!sys) return usr;
  if (!usr) return sys;
  return `${sys}\n\n${usr}`;
}

/**
 * Run a child subprocess with managed lifecycle (process group, timeout, signal forwarding).
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §3
 *
 * @param {object} params
 * @param {string} params.command
 * @param {string[]} [params.args]
 * @param {string} [params.cwd]
 * @param {object} [params.env]
 * @param {string} [params.stdinPayload]
 * @param {number} [params.timeout_ms]
 * @param {AbortSignal} [params.signal]
 * @param {function} [params.onSpawn]
 * @param {number} [params.maxBufferBytes]
 * @returns {Promise<{
 *   exitInfo: { code: number|null, signal: string|null, err: any, spawnFailed?: boolean }|null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   externallyAborted: boolean,
 *   truncated: { stdout: boolean, stderr: boolean, any: boolean },
 *   duration_ms: number,
 *   spawnError: any
 * }>}
 */
export async function runChildWithLifecycle({
  command,
  args = [],
  cwd,
  env = {},
  stdinPayload = '',
  timeout_ms = DEFAULT_TIMEOUT_MS,
  signal,
  onSpawn,
  maxBufferBytes = MAX_BUFFER_BYTES,
} = {}) {
  const startedAt = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const SIGKILL_GRACE_MS = 500;
  let sigkillHandle = null;
  let timeoutHandle = null;
  let child = null;

  const scheduleSigkill = () => {
    if (sigkillHandle !== null) return;
    sigkillHandle = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch { /* already exited */ }
      if (child && typeof child.pid === 'number') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, SIGKILL_GRACE_MS);
  };

  const terminate = () => {
    ac.abort();
    scheduleSigkill();
  };

  const startTimeout = () => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeout_ms);
  };

  const onExternalAbort = () => {
    externallyAborted = true;
    terminate();
  };

  async function cleanupSpawnedChild() {
    if (!child || typeof child.pid !== 'number') return;
    const pid = child.pid;
    await new Promise((resolve) => {
      let settled = false;
      let killHandle;
      let fallbackHandle;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killHandle);
        clearTimeout(fallbackHandle);
        resolve();
      };
      child.once('exit', finish);
      child.once('error', finish);
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killHandle = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, SIGKILL_GRACE_MS);
      fallbackHandle = setTimeout(finish, SIGKILL_GRACE_MS * 3);
    });
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    try { child.stderr?.destroy(); } catch { /* ignore */ }
    try { child.stdin?.destroy(); } catch { /* ignore */ }
  }

  try {
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      signal: ac.signal,
      detached: true,
    };
    if (cwd !== undefined) {
      spawnOpts.cwd = cwd;
    }
    child = spawn(command, args, spawnOpts);
    if (typeof child.pid === 'number' && typeof onSpawn === 'function') {
      onSpawn(child.pid);
    }
    startTimeout();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onExternalAbort, { once: true });
      if (signal.aborted) onExternalAbort();
    }
  } catch (err) {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    await cleanupSpawnedChild();
    return {
      exitInfo: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      externallyAborted: false,
      truncated: { stdout: false, stderr: false, any: false },
      duration_ms: Date.now() - startedAt,
      spawnError: err,
    };
  }

  const forwardSignal = (sig) => {
    if (child && typeof child.pid === 'number') {
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    }
  };
  const onSigInt = () => forwardSignal('SIGINT');
  const onSigTerm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > maxBufferBytes) {
      stdoutTruncated = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return;
    }
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxBufferBytes) {
      stderrTruncated = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return;
    }
    stderr += chunk;
  });

  try {
    child.stdin.end(stdinPayload);
  } catch {
    // EPIPE if child exited before stdin write
  }

  const exitInfo = await new Promise((resolve) => {
    let resolved = false;
    function done(info) {
      if (resolved) return;
      resolved = true;
      resolve(info);
    }
    child.once('error', (err) => {
      const code = err && err.code;
      if (code && SPAWN_FAILURE_CODES.has(code)) {
        done({ code: null, signal: null, err, spawnFailed: true });
      } else {
        done({ code: null, signal: 'SIGTERM', err });
      }
    });
    child.once('exit', (code, signal) => {
      done({ code, signal, err: null });
    });
  });

  try { child.stdout && child.stdout.destroy(); } catch { /* ignore */ }
  try { child.stderr && child.stderr.destroy(); } catch { /* ignore */ }
  try { child.stdin && child.stdin.destroy(); } catch { /* ignore */ }

  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  if (sigkillHandle !== null) clearTimeout(sigkillHandle);
  if ((timedOut || externallyAborted) && child && typeof child.pid === 'number') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  try { process.removeListener('SIGINT', onSigInt); } catch { /* noop */ }
  try { process.removeListener('SIGTERM', onSigTerm); } catch { /* noop */ }
  try { signal?.removeEventListener?.('abort', onExternalAbort); } catch { /* noop */ }

  const duration_ms = Date.now() - startedAt;

  return {
    exitInfo,
    stdout,
    stderr,
    timedOut,
    externallyAborted,
    truncated: {
      stdout: stdoutTruncated,
      stderr: stderrTruncated,
      any: stdoutTruncated || stderrTruncated,
    },
    duration_ms,
    spawnError: null,
  };
}
