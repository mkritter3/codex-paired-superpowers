// v0.9.0 slice 2 — ollama CLI adapter (stateless one-shot inference).
//
// Spawns `ollama run <resolved-model>` (or the configured fake-CLI
// fixture), pipes the system+user prompts to stdin, reads stdout as
// plain text, and normalizes the result to the DispatchResult shape
// used by every other adapter in the cli-harness.
//
// Verified Ollama CLI form (`ollama run --help`, v0.16.1):
//   ollama run MODEL [PROMPT] [flags]
// With no PROMPT argument, Ollama reads the prompt from stdin and
// writes the response to stdout as plain text. (No `--format` is
// requested, so output is NOT a JSON event stream — that's the key
// difference from the codex adapter.)
//
// CLI-only contract. Per slice-2 spec, this adapter MUST NOT fall back
// to the HTTP `/api/generate` endpoint or to the `ANTHROPIC_BASE_URL`
// env-var path (which is for local Ollama wired as a Claude backend,
// not for stateless inference). If the verified one-shot CLI form
// drifts in future Ollama versions, slice-8 installed-smoke catches it.
//
// TODO(slice-8): installed-smoke must confirm `ollama run <model>` (via
// stdin) against a real Ollama Cloud session emits plain-text stdout
// with the variants declared in cli-clients/ollama.json. The fake-CLI
// fixture mirrors the contract documented above; the live invocation is
// only verified when slice-8 runs against an authenticated cloud token.
//
// Variant resolution: callers pass `options.variant` (e.g. 'kimi-k2.6').
// The adapter reads cli-clients/ollama.json's `variants` map and
// resolves to the actual model name ('kimi-k2.6:cloud') before
// spawning. An unknown variant — or a missing variant — rejects with
// OllamaAdapterError before any subprocess is launched.
//
// Stderr normalization: Ollama Cloud surfaces auth/quota issues via
// stderr. We add structured warning codes on top of the line-level
// `stderr:` passthrough so role-routing logic can detect specific
// failure modes:
//   - any line containing /unauthor/i           → ollama-cloud-unauthenticated
//   - any line containing /rate.?limit/i        → ollama-rate-limited
// Multiple matches produce a single warning each (de-duplicated).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB safety cap per stream.

const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OLLAMA_CONFIG_PATH = join(
  __dirname,
  '..',
  '..',
  'cli-clients',
  'ollama.json',
);

export class OllamaAdapterError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'OllamaAdapterError';
    if (code) this.code = code;
  }
}

let cachedVariants = null;

function loadVariants() {
  if (cachedVariants) return cachedVariants;
  let raw;
  try {
    raw = readFileSync(OLLAMA_CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new OllamaAdapterError(
      `Failed to read cli-clients/ollama.json: ${err.message}`,
      { code: 'CONFIG_READ_FAILED' },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OllamaAdapterError(
      `cli-clients/ollama.json is not valid JSON: ${err.message}`,
      { code: 'CONFIG_INVALID_JSON' },
    );
  }
  if (!parsed || typeof parsed.variants !== 'object' || parsed.variants === null) {
    throw new OllamaAdapterError(
      'cli-clients/ollama.json must declare a `variants` object',
      { code: 'CONFIG_NO_VARIANTS' },
    );
  }
  cachedVariants = parsed.variants;
  return cachedVariants;
}

// Test hook — drop cache so a freshly edited ollama.json is picked up.
export function _resetOllamaConfigCache() {
  cachedVariants = null;
}

function resolveModel(variant) {
  if (!variant || typeof variant !== 'string') {
    throw new OllamaAdapterError(
      'Ollama adapter requires options.variant (e.g. "kimi-k2.6")',
      { code: 'VARIANT_MISSING' },
    );
  }
  const variants = loadVariants();
  const entry = variants[variant];
  if (!entry || typeof entry.model_name !== 'string') {
    throw new OllamaAdapterError(
      `Unknown Ollama variant '${variant}' — not declared in cli-clients/ollama.json`,
      { code: 'VARIANT_UNKNOWN' },
    );
  }
  return entry.model_name;
}

export async function dispatch(systemPrompt, userPrompt, options = {}) {
  const command = options.command || 'ollama';
  const model = resolveModel(options.variant);
  // Real-CLI invocation form: `ollama run <model>`. Callers can override
  // `args` if a future slice needs different flags, but the default mirrors
  // the verified one-shot stateless form.
  const args = Array.isArray(options.args) ? options.args : ['run', model];
  const envExtras = options.env && typeof options.env === 'object' ? options.env : {};
  const timeoutMs = Number.isFinite(options.timeout_ms)
    ? options.timeout_ms
    : DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = Number.isFinite(options.maxBufferBytes)
    ? options.maxBufferBytes
    : MAX_BUFFER_BYTES;

  const startedAt = Date.now();
  const ac = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);

  const stdinPayload = composeStdinPayload(systemPrompt, userPrompt);

  let child;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...envExtras },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    return {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        command,
        args,
        model,
        error: String(err && err.message ? err.message : err),
        errorCode: err && err.code ? String(err.code) : null,
      },
      duration_ms: Date.now() - startedAt,
    };
  }

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
    // EPIPE if child already exited; harmless.
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

  clearTimeout(timeoutHandle);
  const duration_ms = Date.now() - startedAt;

  if (exitInfo.spawnFailed) {
    const err = exitInfo.err;
    return {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        command,
        args,
        model,
        error: err && err.message ? String(err.message) : String(err),
        errorCode: err && err.code ? String(err.code) : null,
      },
      duration_ms,
    };
  }

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

  // Stderr → structured Ollama-Cloud warning codes + line-level passthrough.
  // Structured codes added BEFORE the per-line passthrough so role-routing
  // logic that just calls `warnings.includes('ollama-cloud-unauthenticated')`
  // can find them deterministically.
  if (stderr) {
    let sawUnauthorized = false;
    let sawRateLimit = false;
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!sawUnauthorized && /unauthor/i.test(trimmed)) {
        warnings.push('ollama-cloud-unauthenticated');
        sawUnauthorized = true;
      }
      if (!sawRateLimit && /rate.?limit/i.test(trimmed)) {
        warnings.push('ollama-rate-limited');
        sawRateLimit = true;
      }
    }
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      warnings.push(`stderr:${trimmed}`);
    }
  }
  if (stdoutTruncated) warnings.push('stdout-truncated');
  if (stderrTruncated) warnings.push('stderr-truncated');

  // Parse stdout. Ollama's default output is plain text (no JSON event
  // stream), so the adapter just trims and returns it as responseText.
  let responseText = '';
  const adapterMeta = {
    adapter: 'cli-harness:ollama',
    command,
    args,
    model,
    stderr,
  };

  if (timedOut) {
    responseText = '';
  } else if (exitCode !== 0) {
    responseText = '';
  } else if (stdout.trim().length === 0) {
    responseText = '';
    warnings.push('empty-output');
  } else {
    responseText = stdout;
  }

  return {
    responseText,
    exit: exitCode,
    warnings,
    sessionId: null,
    adapterMeta,
    duration_ms,
  };
}

function composeStdinPayload(systemPrompt, userPrompt) {
  const sys = typeof systemPrompt === 'string' ? systemPrompt : '';
  const usr = typeof userPrompt === 'string' ? userPrompt : '';
  if (!sys) return usr;
  if (!usr) return sys;
  return `${sys}\n\n${usr}`;
}

const SIGNAL_TO_NUMBER = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
