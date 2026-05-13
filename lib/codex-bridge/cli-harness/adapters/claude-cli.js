// v0.10.0 slice 5 — Claude CLI adapter (implementer mode only).
//
// Spawns `claude --output-format stream-json --verbose --model <model> --print`
// and writes the combined system+user prompt to STDIN (never argv — argv is
// process-visible via `ps`/`/proc/<pid>/cmdline` per spec L361).
//
// Routes:
//   'ollama-cloud'  — ANTHROPIC_BASE_URL=https://ollama.com, token via OLLAMA_CLOUD_API_KEY
//   'anthropic-api' — no ANTHROPIC_BASE_URL, token via ANTHROPIC_AUTH_TOKEN
//
// All v0.9.1 hardening is preserved: AbortController, 500ms SIGKILL grace,
// detached + process-group reap, SIGINT/SIGTERM forwarders removed in finally.
//
// Full DispatchResult deep-walked through redactSecretFields before return.

import { spawn } from 'node:child_process';
import { wrapAsHaltEnvelope } from '../../halt-envelope.js';
import {
  resolveToken,
  sanitizeEnv,
  redactSecretFields,
} from '../../implementer/secret-redaction.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB safety cap per stream.
const SIGKILL_GRACE_MS = 500;

// Spawn failure codes (binary missing, permission denied, etc.)
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

// Event types from the Claude CLI stream-json format whose payload contributes
// to responseText. Claude's stream-json emits objects with type: 'text',
// 'content_block_delta' (delta.type='text_delta'), or similar.
const TEXT_EVENT_TYPES = new Set([
  'text',
  'assistant-text',
  'assistant_text',
  'message',
  'content',
]);

// Signal → number mapping for exit-code computation.
const SIGNAL_TO_NUMBER = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/**
 * Compose the combined stdin payload from system and user prompts.
 * Same format as codex.js (system\n\nuser).
 */
function composeStdinPayload(systemPrompt, userPrompt) {
  const sys = typeof systemPrompt === 'string' ? systemPrompt : '';
  const usr = typeof userPrompt === 'string' ? userPrompt : '';
  if (!sys) return usr;
  if (!usr) return sys;
  return `${sys}\n\n${usr}`;
}

/**
 * Parse the Claude CLI stream-json event stream.
 * Accepts NDJSON lines. Returns { ok, responseText, eventCount, unknownEventCount }
 * or { ok: false, error: string }.
 */
function parseStreamJson(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, error: 'empty stream' };
  }

  let responseText = '';
  let eventCount = 0;
  let unknownEventCount = 0;
  let allLinesParsed = true;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      eventCount += 1;
      if (obj && typeof obj === 'object') {
        if (TEXT_EVENT_TYPES.has(obj.type)) {
          const piece =
            typeof obj.text === 'string'
              ? obj.text
              : typeof obj.content === 'string'
                ? obj.content
                : '';
          responseText += piece;
        } else if (obj.type === 'content_block_delta' && obj.delta) {
          // Claude stream-json content_block_delta shape
          if (obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
            responseText += obj.delta.text;
            eventCount += 0; // already counted
          } else {
            unknownEventCount += 1;
          }
        } else {
          unknownEventCount += 1;
        }
      } else {
        unknownEventCount += 1;
      }
    } catch {
      allLinesParsed = false;
      break;
    }
  }

  if (allLinesParsed) {
    return { ok: true, responseText, eventCount, unknownEventCount };
  }
  return { ok: false, error: 'malformed JSON in stream' };
}

/**
 * Detect auth-rejected (401-equivalent) in stdout/stderr.
 * Claude CLI may emit a JSON event with error.type indicating auth failure.
 */
function detectAuthRejected(stdout, stderr) {
  const combined = (stdout || '') + '\n' + (stderr || '');
  // Look for 401 indicators.
  if (/\b401\b/.test(combined)) return true;
  if (/authentication_error|auth_error|invalid.*api.*key|unauthorized/i.test(combined)) return true;
  // Claude CLI structured error event.
  for (const line of combined.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && obj.type === 'error') {
        const errType = (obj.error && obj.error.type) || '';
        if (/auth|401|unauthorized/i.test(errType)) return true;
      }
    } catch { /* non-JSON line */ }
  }
  return false;
}

/**
 * Detect protocol-unsupported: response shape is not the expected stream-json.
 * We fire this when the stream could not be parsed AND the output doesn't look
 * like a version that simply failed auth.
 */
function detectProtocolUnsupported(stdout) {
  if (!stdout || stdout.trim().length === 0) return false;
  // If there's output but none of it parses as NDJSON events, flag it.
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  let badLines = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      badLines++;
    }
  }
  // If more than half the non-empty lines are not JSON, treat as wrong protocol.
  return badLines > lines.length / 2;
}

/**
 * dispatch — the main export. Input validation is synchronous (throws before
 * returning a Promise). Uses a non-async wrapper so the throw happens in the
 * synchronous frame, not inside an async function (which would turn it into a
 * rejected Promise instead of a real throw).
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options
 * @param {string} options.cwd          REQUIRED — working directory for spawn
 * @param {string} options.model        REQUIRED — model name passed to --model
 * @param {string} options.route        REQUIRED — 'ollama-cloud' | 'anthropic-api'
 * @param {string} [options.command]    Override the claude binary path (for tests)
 * @param {AbortSignal} [options.abortSignal]  Orchestrator cancellation signal
 * @param {number} [options.timeout_ms]
 * @param {number} [options.maxBufferBytes]
 * @param {string} [options.sliceId]    For halt envelope context
 * @param {object} [options._deps]      DI: { keychain } for resolveToken
 * @returns {Promise<DispatchResult>}
 */
export function dispatch(systemPrompt, userPrompt, options = {}) {
  // ── Synchronous input validation (throws HERE, not inside a Promise) ────────
  if (!options.cwd || typeof options.cwd !== 'string' || options.cwd.trim() === '') {
    throw new Error('claude-cli adapter requires options.cwd');
  }
  if (!options.model || typeof options.model !== 'string' || options.model.trim() === '') {
    throw new Error('claude-cli adapter requires options.model');
  }
  const VALID_ROUTES = new Set(['ollama-cloud', 'anthropic-api']);
  if (!options.route || !VALID_ROUTES.has(options.route)) {
    throw new Error(
      'claude-cli adapter requires options.route in {ollama-cloud, anthropic-api}',
    );
  }
  // After synchronous validation passes, delegate to the async implementation.
  return dispatchAsync(systemPrompt, userPrompt, options);
}

async function dispatchAsync(systemPrompt, userPrompt, options) {

  const route = options.route;
  const model = options.model;
  const command = options.command || 'claude';
  const timeoutMs = Number.isFinite(options.timeout_ms)
    ? options.timeout_ms
    : DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = Number.isFinite(options.maxBufferBytes)
    ? options.maxBufferBytes
    : MAX_BUFFER_BYTES;
  const deps = options._deps || {};

  // ── Token resolution ────────────────────────────────────────────────────────
  // Do this before spawning so a missing token is a fast, clean failure.
  let token;
  try {
    token = resolveToken(route, deps);
  } catch (err) {
    // Returns a DispatchResult with haltEnvelope (not a throw).
    const envelope = wrapAsHaltEnvelope('claude-cli-auth-missing', {
      sliceId: options.sliceId,
      phase: 'implement',
    });
    const result = {
      responseText: '',
      exit: 1,
      warnings: ['auth-missing'],
      sessionId: null,
      adapterMeta: {
        adapter: 'cli-harness:claude-cli',
        exec_mode: 'implementer',
        error: err && err.message ? String(err.message) : String(err),
      },
      duration_ms: 0,
      haltEnvelope: {
        halt: envelope.halt,
        terminal: envelope.terminal,
        resume_hint: envelope.resume_hint,
      },
    };
    return redactSecretFields(result);
  }

  // ── Build argv (NO prompt content in argv) ──────────────────────────────────
  const args = [
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--print',
  ];

  // ── Build child env ─────────────────────────────────────────────────────────
  // 1. Start with sanitized ambient env (strips the 6 denylist keys).
  const childEnv = sanitizeEnv(process.env);
  // 2. Set route-specific env.
  if (route === 'ollama-cloud') {
    childEnv['ANTHROPIC_BASE_URL'] = 'https://ollama.com';
  }
  // (For 'anthropic-api', ANTHROPIC_BASE_URL is intentionally ABSENT.)
  childEnv['ANTHROPIC_AUTH_TOKEN'] = token;
  childEnv['ANTHROPIC_API_KEY'] = ''; // per spec L127
  childEnv['ANTHROPIC_MODEL'] = model;
  childEnv['DISABLE_TELEMETRY'] = '1';
  childEnv['DISABLE_ERROR_REPORTING'] = '1';
  childEnv['DISABLE_NONESSENTIAL_TRAFFIC'] = '1';

  // ── Stdin payload (system+user combined, same format as codex.js:167-170) ───
  const stdinPayload = composeStdinPayload(systemPrompt, userPrompt);

  // ── AbortController + timeout ───────────────────────────────────────────────
  const ac = new AbortController();
  let timedOut = false;
  let sigkillHandle = null;
  let timeoutHandle = null;

  function escalateKill() {
    try { child && child.kill('SIGKILL'); } catch { /* already exited */ }
    if (child && typeof child.pid === 'number') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  const startTimeout = () => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      ac.abort();
      sigkillHandle = setTimeout(escalateKill, SIGKILL_GRACE_MS);
    }, timeoutMs);
  };

  // If caller supplied an abortSignal (orchestrator-driven cancellation),
  // register an abort listener that fires the same kill path as timeout.
  let abortSignalHandler = null;
  if (options.abortSignal) {
    abortSignalHandler = () => {
      timedOut = true; // reuse the same "was killed" flag
      ac.abort();
      sigkillHandle = setTimeout(escalateKill, SIGKILL_GRACE_MS);
    };
    // If already aborted, fire immediately when the dispatch actually runs.
    if (options.abortSignal.aborted) {
      abortSignalHandler();
    } else {
      options.abortSignal.addEventListener('abort', abortSignalHandler, { once: true });
    }
  }

  const startedAt = Date.now();
  let child;

  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
      signal: ac.signal,
      cwd: options.cwd,
      // v0.9.1: detached creates a new process group (pgid == pid) so we can
      // reap grandchildren via `process.kill(-pid, SIGKILL)` if needed.
      detached: true,
    });
    startTimeout();
  } catch (err) {
    // Synchronous spawn error (rare but can happen on some platforms).
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    if (sigkillHandle !== null) clearTimeout(sigkillHandle);
    if (abortSignalHandler && options.abortSignal) {
      options.abortSignal.removeEventListener('abort', abortSignalHandler);
    }
    const result = {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        adapter: 'cli-harness:claude-cli',
        exec_mode: 'implementer',
        error: err && err.message ? String(err.message) : String(err),
      },
      duration_ms: Date.now() - startedAt,
    };
    return redactSecretFields(result);
  }

  // ── v0.9.1 round-2: SIGINT/SIGTERM forwarders ───────────────────────────────
  // detached: true breaks terminal-SIGINT propagation. Re-install explicitly.
  const forwardSignal = (sig) => {
    if (child && typeof child.pid === 'number') {
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    }
  };
  const onSigInt = () => forwardSignal('SIGINT');
  const onSigTerm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  // ── Bounded stdout/stderr buffers ────────────────────────────────────────────
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

  // Write combined prompt to stdin and close it.
  try {
    child.stdin.end(stdinPayload);
  } catch {
    // EPIPE if child exited before we wrote; harmless.
  }

  // ── Await child exit ─────────────────────────────────────────────────────────
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

  // Destroy pipes so the event loop can drain.
  try { child.stdout && child.stdout.destroy(); } catch { /* ignore */ }
  try { child.stderr && child.stderr.destroy(); } catch { /* ignore */ }
  try { child.stdin && child.stdin.destroy(); } catch { /* ignore */ }

  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  if (sigkillHandle !== null) clearTimeout(sigkillHandle);

  // Belt-and-suspenders: reap the group on timeout/abort.
  if (timedOut && child && typeof child.pid === 'number') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  // ── Cleanup: remove all per-dispatch signal listeners ───────────────────────
  // This runs regardless of which exit path fires (happy, auth-missing,
  // protocol-unsupported, spawn-failure, timeout). Structural invariant.
  try { process.removeListener('SIGINT', onSigInt); } catch { /* noop */ }
  try { process.removeListener('SIGTERM', onSigTerm); } catch { /* noop */ }
  if (abortSignalHandler && options.abortSignal) {
    options.abortSignal.removeEventListener('abort', abortSignalHandler);
  }

  const duration_ms = Date.now() - startedAt;

  // ── Spawn failure path ────────────────────────────────────────────────────────
  if (exitInfo.spawnFailed) {
    const err = exitInfo.err;
    const result = {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        adapter: 'cli-harness:claude-cli',
        exec_mode: 'implementer',
        command,
        args,
        error: err && err.message ? String(err.message) : String(err),
        errorCode: err && err.code ? String(err.code) : null,
        spawnError: err
          ? {
              code: err.code != null ? String(err.code) : null,
              errno: err.errno != null ? err.errno : null,
              syscall: err.syscall != null ? String(err.syscall) : null,
              path: err.path != null ? String(err.path) : null,
              message: err.message != null ? String(err.message) : null,
            }
          : null,
      },
      duration_ms,
    };
    return redactSecretFields(result);
  }

  // ── Compute exit code + warnings ─────────────────────────────────────────────
  const warnings = [];
  let exitCode;

  if (timedOut) {
    warnings.push('timeout');
    exitCode = 137;
  } else if (exitInfo.signal) {
    const signalNum = SIGNAL_TO_NUMBER[exitInfo.signal] ?? 15;
    exitCode = 128 + signalNum;
    warnings.push('cli-exit-nonzero');
  } else if (exitInfo.code === null) {
    exitCode = 1;
    warnings.push('cli-exit-nonzero');
  } else {
    exitCode = exitInfo.code;
    if (exitCode !== 0) warnings.push('cli-exit-nonzero');
  }

  if (stderr) {
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      warnings.push(`stderr:${trimmed}`);
    }
  }
  if (stdoutTruncated) warnings.push('stdout-truncated');
  if (stderrTruncated) warnings.push('stderr-truncated');
  const anyTruncated = stdoutTruncated || stderrTruncated;

  // Base adapterMeta.
  let adapterMeta = {
    adapter: 'cli-harness:claude-cli',
    exec_mode: 'implementer',
    command,
    args,
    stderr,
    eventCount: 0,
    unknownEventCount: 0,
    ...(anyTruncated ? { truncated: true } : {}),
  };

  // ── Auth-rejected detection ───────────────────────────────────────────────────
  if (!timedOut && detectAuthRejected(stdout, stderr)) {
    const envelope = wrapAsHaltEnvelope('claude-cli-auth-rejected', {
      sliceId: options.sliceId,
      phase: 'implement',
    });
    const result = {
      responseText: '',
      exit: exitCode,
      warnings,
      sessionId: null,
      adapterMeta,
      duration_ms,
      haltEnvelope: {
        halt: envelope.halt,
        terminal: envelope.terminal,
        resume_hint: envelope.resume_hint,
      },
    };
    return redactSecretFields(result);
  }

  // ── Parse output ─────────────────────────────────────────────────────────────
  let responseText = '';

  if (timedOut || exitCode !== 0) {
    responseText = '';
  } else if (stdout.trim().length === 0) {
    responseText = '';
    warnings.push('empty-output');
  } else {
    const parsed = parseStreamJson(stdout);
    if (!parsed.ok) {
      // Detect whether this is wrong protocol vs. simply malformed.
      if (detectProtocolUnsupported(stdout)) {
        const envelope = wrapAsHaltEnvelope('claude-cli-protocol-unsupported', {
          sliceId: options.sliceId,
          phase: 'implement',
        });
        const result = {
          responseText: '',
          exit: exitCode,
          warnings,
          sessionId: null,
          adapterMeta: { ...adapterMeta, parseError: parsed.error },
          duration_ms,
          haltEnvelope: {
            halt: envelope.halt,
            terminal: envelope.terminal,
            resume_hint: envelope.resume_hint,
          },
        };
        return redactSecretFields(result);
      }
      warnings.push('malformed-output');
      exitCode = 1;
      adapterMeta.parseError = parsed.error;
    } else {
      responseText = parsed.responseText;
      adapterMeta.eventCount = parsed.eventCount;
      adapterMeta.unknownEventCount = parsed.unknownEventCount;
    }
  }

  const result = {
    responseText,
    exit: exitCode,
    warnings,
    sessionId: null,
    adapterMeta,
    duration_ms,
  };

  // ── Deep redact the entire result before return ───────────────────────────────
  return redactSecretFields(result);
}
