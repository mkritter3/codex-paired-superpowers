// @ts-check

// v0.17.0 slice 3 — shared process lifecycle helper for CLI harness adapters.
//
// Extracts timeout, AbortController, process-group reaping, SIGINT/SIGTERM
// forwarding, stream bounding, and exit classification shared between
// codex.js and agy.js adapters.

import { spawn } from 'node:child_process';

/** @typedef {import('node:child_process').ChildProcessWithoutNullStreams} ChildProcessWithoutNullStreams */
/** @typedef {import('node:child_process').SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>} PipeSpawnOptions */
/** @typedef {ReturnType<typeof setTimeout>} Timer */
/**
 * @typedef {object} ProcessLifecycleParams
 * @property {string} command
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [stdinPayload]
 * @property {number} [timeout_ms]
 * @property {AbortSignal} [signal]
 * @property {(pid: number) => void} [onSpawn]
 * @property {number} [maxBufferBytes]
 */

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB safety cap per stream.

export const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

/** @type {Readonly<Record<string, number>>} */
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
 * @param {unknown} systemPrompt
 * @param {unknown} userPrompt
 * @returns {string}
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
 * @typedef {{
 *   exitInfo: { code: number|null, signal: NodeJS.Signals|null, err: any, spawnFailed?: boolean },
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   externallyAborted: boolean,
 *   truncated: { stdout: boolean, stderr: boolean, any: boolean },
 *   duration_ms: number,
 *   spawnError: null
 * } | {
 *   exitInfo: null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   externallyAborted: boolean,
 *   truncated: { stdout: boolean, stderr: boolean, any: boolean },
 *   duration_ms: number,
 *   spawnError: Error
 * }} ChildLifecycleResult
 */
/**
 * Public signature: `command` is required.
 * @overload
 * @param {ProcessLifecycleParams} params
 * @returns {Promise<ChildLifecycleResult>}
 */
/**
 * Implementation signature (hidden from callers by the overload above): typed as Partial so the
 * missing-command path is visible to the checker without asserting an empty default. Runtime
 * semantics are the original ones — destructuring with a `{}` default (so `null` still rejects),
 * and a non-string command fails inside the try below with Node's own error.
 * @param {Partial<ProcessLifecycleParams>} [params]
 * @returns {Promise<ChildLifecycleResult>}
 */
export async function runChildWithLifecycle(params = {}) {
  const {
    command,
    args = [],
    cwd,
    env = {},
    stdinPayload = '',
    timeout_ms = DEFAULT_TIMEOUT_MS,
    signal,
    onSpawn,
    maxBufferBytes = MAX_BUFFER_BYTES,
  } = params;
  const startedAt = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  let externallyAborted = false;

  const SIGKILL_GRACE_MS = 500;
  /** @type {Timer | null} */
  let sigkillHandle = null;
  /** @type {Timer | null} */
  let timeoutHandle = null;
  /** @type {ChildProcessWithoutNullStreams | null} */
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

  // Probe whether a process GROUP still has any members. `process.kill(-pid, 0)`
  // sends no signal but reports ESRCH once every process in the group is gone.
  /** @param {number} pid */
  function groupIsGone(pid) {
    try {
      process.kill(-pid, 0);
      return false;
    } catch (/** @type {any} */ err) {
      return err && err.code === 'ESRCH';
    }
  }

  async function cleanupSpawnedChild() {
    if (!child) return;
    const spawnedChild = child;
    const pid = spawnedChild.pid;
    if (typeof pid !== 'number') return;
    await new Promise((/** @type {(value?: void) => void} */ resolve) => {
      let settled = false;
      /** @type {Timer | undefined} */
      let killHandle;
      /** @type {Timer | undefined} */
      let fallbackHandle;
      /** @type {Timer | undefined} */
      let groupPollHandle;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killHandle);
        clearTimeout(fallbackHandle);
        clearTimeout(groupPollHandle);
        resolve();
      };
      // Once the SIGKILL escalation timer has fired, keep verifying the
      // process GROUP (not just the leader) is actually gone before
      // resolving — a descendant that ignored SIGTERM but survived past
      // the leader's own exit must still be reaped.
      const finishAfterGroupGone = () => {
        if (settled) return;
        if (groupIsGone(pid)) {
          finish();
          return;
        }
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        groupPollHandle = setTimeout(finishAfterGroupGone, 50);
      };
      const onLeaderExit = () => {
        // The leader exiting does not guarantee the whole process group is
        // gone (a detached descendant may still be running). Always issue a
        // group-wide SIGKILL and confirm the group is empty before settling.
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        finishAfterGroupGone();
      };
      spawnedChild.once('exit', onLeaderExit);
      spawnedChild.once('error', onLeaderExit);
      if (spawnedChild.exitCode !== null || spawnedChild.signalCode !== null) {
        onLeaderExit();
        return;
      }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
      try { spawnedChild.kill('SIGTERM'); } catch { /* already gone */ }
      killHandle = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
        try { spawnedChild.kill('SIGKILL'); } catch { /* already gone */ }
        finishAfterGroupGone();
      }, SIGKILL_GRACE_MS);
      fallbackHandle = setTimeout(finish, SIGKILL_GRACE_MS * 3);
    });
    try { spawnedChild.stdout?.destroy(); } catch { /* ignore */ }
    try { spawnedChild.stderr?.destroy(); } catch { /* ignore */ }
    try { spawnedChild.stdin?.destroy(); } catch { /* ignore */ }
  }

  try {
    /** @type {PipeSpawnOptions} */
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      signal: ac.signal,
      detached: true,
    };
    if (cwd !== undefined) {
      spawnOpts.cwd = cwd;
    }
    if (typeof command !== 'string') {
      // Node's spawn raises exactly this for a non-string command; making it explicit keeps the
      // type honest (command is string | undefined here) without changing the failure path.
      const typeErr = /** @type {NodeJS.ErrnoException} */ (new TypeError(
        `The "file" argument must be of type string. Received ${command === undefined ? 'undefined' : typeof command}`,
      ));
      typeErr.code = 'ERR_INVALID_ARG_TYPE';
      throw typeErr;
    }
    child = spawn(command, args, spawnOpts);
    // Attach a safety net for the child's 'error' event BEFORE evaluating an
    // already-aborted external signal. `spawn(..., { signal: ac.signal })`
    // makes the child emit an AbortError 'error' event as soon as `ac` is
    // aborted; if `signal.aborted` is already true below, `onExternalAbort()`
    // calls `terminate()` -> `ac.abort()` synchronously, and with no 'error'
    // listener yet installed that event would be an uncaught exception that
    // crashes the process. This listener is a no-op — the real 'error'
    // handling happens in the exitInfo promise wired up further down — but
    // its mere presence keeps Node from treating the event as unhandled.
    child.on('error', () => { /* handled by the exitInfo listener below */ });
    if (typeof child.pid === 'number' && typeof onSpawn === 'function') {
      onSpawn(child.pid);
    }
    startTimeout();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onExternalAbort, { once: true });
      if (signal.aborted) onExternalAbort();
    }
  } catch (/** @type {any} */ err) {
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

  /** @param {NodeJS.Signals} sig */
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

  child.stdout.on('data', (/** @type {string} */ chunk) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > maxBufferBytes) {
      stdoutTruncated = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return;
    }
    stdout += chunk;
  });
  child.stderr.on('data', (/** @type {string} */ chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxBufferBytes) {
      stderrTruncated = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      return;
    }
    stderr += chunk;
  });

  // If the child was already killed (e.g. a pre-aborted external signal),
  // writing to its stdin can fail asynchronously with EPIPE — that surfaces
  // as an 'error' event on the stream, not a synchronous throw, so the
  // try/catch below does not cover it. Swallow it explicitly.
  child.stdin.on('error', () => { /* EPIPE from a child that exited/was killed early */ });
  try {
    child.stdin.end(stdinPayload);
  } catch {
    // EPIPE if child exited before stdin write
  }

  /** @type {{code: number | null, signal: NodeJS.Signals | null, err: any, spawnFailed?: boolean}} */
  const exitInfo = await new Promise((resolve) => {
    let resolved = false;
    /** @param {{code: number | null, signal: NodeJS.Signals | null, err: any, spawnFailed?: boolean}} info */
    function done(info) {
      if (resolved) return;
      resolved = true;
      resolve(info);
    }
    child.once('error', (/** @type {NodeJS.ErrnoException} */ err) => {
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
