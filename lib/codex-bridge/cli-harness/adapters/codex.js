// v0.9.0 slice 1 — codex CLI adapter.
//
// Spawns the configured `codex` (or fake-CLI fixture) subprocess, pipes
// the system+user prompts to stdin, reads the `--json` event stream from
// stdout, and normalizes the result to the DispatchResult shape.
//
// One-shot dispatch only; session continuity is a v0.9.1 concern.
//
// The real codex CLI invocation contract used here:
//   - `codex --json [permission-args]` is spawned (the `--json` flag is
//     part of cli-clients/codex.json's `additional_args`).
//   - The system+user prompt are written to stdin as a single combined
//     payload (system prompt first, then a blank line, then the user
//     prompt). Real codex reads the prompt from stdin in non-interactive
//     mode.
//   - Stdout is a newline-delimited stream of `--json` events. Each
//     event is a JSON object; events with `type === 'assistant-text'` (or
//     `agent_message` / `message`) contribute their `text` (or `content`)
//     to the concatenated `responseText`. Unknown event types are
//     ignored but counted in `adapterMeta.unknownEventCount`.
//
// If the exact event shape codex emits today drifts from these names,
// later slices can extend the type-mapping; the contract here is "the
// adapter consumes whatever codex --json emits and produces a coherent
// responseText".

import { wrapAsHaltEnvelope } from '../../halt-envelope.js';
import { SAFE_TOKEN } from '../../models.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
  SIGNAL_TO_NUMBER,
  composeStdinPayload,
  runChildWithLifecycle,
} from '../process-lifecycle.js';

// Event types whose payload contributes to responseText. We keep the set
// liberal so we tolerate minor naming variants from the real codex CLI
// until we lock the contract via an installed-smoke test.
const TEXT_EVENT_TYPES = new Set([
  'assistant-text',
  'assistant_text',
  'agent_message',
  'message',
  'text',
]);

// Blocked-output sentinel patterns: codex CLI signals that its sandbox
// blocked an action via a JSON event with type 'blocked' or a specific
// stderr sentinel line. We use a precise match to avoid false positives
// from incidental log messages that contain the word "blocked".
//
// Stderr sentinel: the exact string "codex:blocked" or a JSON event
// with type === 'blocked' on stdout.
const BLOCKED_STDERR_SENTINEL = 'codex:blocked';

function detectBlocked(stdout, stderr) {
  // Check stderr for the exact blocked sentinel line.
  if (stderr) {
    for (const line of stderr.split(/\r?\n/)) {
      if (line.trim() === BLOCKED_STDERR_SENTINEL) {
        return true;
      }
    }
  }
  // Check stdout for a JSON event with type 'blocked'.
  if (stdout) {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && (obj.type === 'blocked' || obj.blocked === true)) {
          return true;
        }
      } catch {
        // Non-JSON line; continue.
      }
    }
  }
  return false;
}

export async function dispatch(systemPrompt, userPrompt, options = {}) {
  const command = options.command || 'codex';
  const execMode = options.execMode !== undefined ? options.execMode : 'reviewer';

  // Validate execMode synchronously.
  if (execMode !== 'reviewer' && execMode !== 'implementer') {
    throw new Error('invalid execMode');
  }

  // For implementer mode, cwd is required.
  if (execMode === 'implementer') {
    if (!options.cwd || typeof options.cwd !== 'string' || options.cwd.trim() === '') {
      throw new Error('implementer mode requires options.cwd');
    }
  }

  const hasModelOptions = options.model !== undefined || options.reasoningEffort !== undefined;
  if (Array.isArray(options.args) && hasModelOptions) {
    throw new Error('codex adapter: options.args and model options are mutually exclusive');
  }
  if (hasModelOptions) {
    if (typeof options.model !== 'string' || !SAFE_TOKEN.test(options.model)) {
      throw new Error('codex adapter: model must be a safe non-empty token');
    }
    if (typeof options.reasoningEffort !== 'string' || !SAFE_TOKEN.test(options.reasoningEffort)) {
      throw new Error('codex adapter: reasoningEffort must be a safe non-empty token');
    }
  }

  // Compose args: if options.args is explicitly supplied, use it (escape hatch).
  // Otherwise compose based on execMode.
  let args;
  if (Array.isArray(options.args)) {
    args = options.args;
  } else if (execMode === 'implementer') {
    args = ['exec', '--sandbox', 'workspace-write', '-C', options.cwd];
  } else {
    args = ['--json'];
  }
  if (hasModelOptions) {
    args = [
      ...args,
      '-m',
      options.model,
      '-c',
      `model_reasoning_effort=${options.reasoningEffort}`,
    ];
  }

  // Spawn cwd: implementer mode sets cwd to options.cwd; reviewer mode leaves
  // it undefined (inherits current process cwd — preserves v0.9.x behavior).
  const spawnCwd = execMode === 'implementer' ? options.cwd : undefined;

  const envExtras = options.env && typeof options.env === 'object' ? options.env : {};
  const timeoutMs = Number.isFinite(options.timeout_ms)
    ? options.timeout_ms
    : DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = Number.isFinite(options.maxBufferBytes)
    ? options.maxBufferBytes
    : MAX_BUFFER_BYTES;

  const stdinPayload = composeStdinPayload(systemPrompt, userPrompt);
  const lifecycleResult = await runChildWithLifecycle({
    command,
    args,
    cwd: spawnCwd,
    env: envExtras,
    stdinPayload,
    timeout_ms: timeoutMs,
    signal: options.signal,
    onSpawn: options.onSpawn,
    maxBufferBytes,
  });

  if (lifecycleResult.spawnError) {
    const err = lifecycleResult.spawnError;
    return {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        adapter: 'cli-harness:codex',
        exec_mode: execMode,
        error: String(err && err.message ? err.message : err),
      },
      duration_ms: lifecycleResult.duration_ms,
    };
  }

  if (lifecycleResult.exitInfo?.spawnFailed) {
    const err = lifecycleResult.exitInfo.err;
    return {
      responseText: '',
      exit: 1,
      warnings: ['spawn-failed'],
      sessionId: null,
      adapterMeta: {
        adapter: 'cli-harness:codex',
        exec_mode: execMode,
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
      duration_ms: lifecycleResult.duration_ms,
    };
  }

  const { exitInfo, stdout, stderr, timedOut, externallyAborted, truncated, duration_ms } =
    lifecycleResult;

  // Compute exit + warnings.
  const warnings = [];
  let exitCode;
  if (externallyAborted) {
    warnings.push('aborted');
    exitCode = 130;
  } else if (timedOut) {
    warnings.push('timeout');
    exitCode = 137;
  } else if (exitInfo.signal) {
    // 128 + signal-number convention; SIGTERM=15 → 143, SIGKILL=9 → 137.
    const signalNum = SIGNAL_TO_NUMBER[exitInfo.signal] ?? 15;
    exitCode = 128 + signalNum;
    warnings.push('cli-exit-nonzero');
  } else if (exitInfo.code === null) {
    // Errored before we could spawn / mid-spawn.
    exitCode = 1;
    warnings.push('cli-exit-nonzero');
  } else {
    exitCode = exitInfo.code;
    if (exitCode !== 0) warnings.push('cli-exit-nonzero');
  }

  // Normalize stderr lines into warnings (one per non-blank line) when
  // we have stderr content. Even on success, stderr passes through —
  // codex emits rate-limit / deprecation notices there.
  if (stderr) {
    for (const line of stderr.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      warnings.push(`stderr:${trimmed}`);
    }
  }
  if (truncated.stdout) warnings.push('stdout-truncated');
  if (truncated.stderr) warnings.push('stderr-truncated');
  const anyTruncated = truncated.any;

  // Parse stdout. If we timed out or hit nonzero exit, force empty
  // responseText (the spec says nonzero exit → responseText: '').
  let responseText = '';
  let adapterMeta = {
    adapter: 'cli-harness:codex',
    exec_mode: execMode,
    command,
    args,
    stderr: stderr,
    eventCount: 0,
    unknownEventCount: 0,
    ...(anyTruncated ? { truncated: true } : {}),
  };

  if (timedOut || externallyAborted) {
    responseText = '';
  } else if (exitCode !== 0) {
    responseText = '';
  } else if (stdout.trim().length === 0) {
    // Empty stdout on success is benign but worth flagging.
    responseText = '';
    warnings.push('empty-output');
  } else {
    const parsed = parseJsonEventStream(stdout);
    if (!parsed.ok) {
      warnings.push('malformed-output');
      exitCode = 1;
      responseText = '';
      adapterMeta.parseError = parsed.error;
    } else {
      responseText = parsed.responseText;
      adapterMeta.eventCount = parsed.eventCount;
      adapterMeta.unknownEventCount = parsed.unknownEventCount;
    }
  }

  // Blocked-output normalization: detect if the codex CLI emitted a blocked
  // sentinel in either stdout or stderr. When detected, surface it as
  // adapterMeta.blocked and add haltEnvelope so callers can halt cleanly.
  const isBlocked = detectBlocked(stdout, stderr);
  if (isBlocked) {
    adapterMeta.blocked = true;
    const envelope = wrapAsHaltEnvelope('codex-cli-blocked', {
      sliceId: options.sliceId,
      phase: 'implement',
    });
    return {
      responseText,
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


function parseJsonEventStream(stdout) {
  // Two acceptable shapes:
  //   (a) newline-delimited JSON objects, one per line
  //   (b) a single JSON object with {events: [...]} or similar
  // We try (a) first since codex --json's documented output is NDJSON.
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, error: 'empty stream' };
  }
  // Try line-by-line NDJSON.
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
  // Fall back: try the whole blob as a single JSON.
  try {
    const obj = JSON.parse(stdout);
    if (obj && Array.isArray(obj.events)) {
      let txt = '';
      for (const ev of obj.events) {
        if (ev && TEXT_EVENT_TYPES.has(ev.type)) {
          if (typeof ev.text === 'string') txt += ev.text;
          else if (typeof ev.content === 'string') txt += ev.content;
        }
      }
      return {
        ok: true,
        responseText: txt,
        eventCount: obj.events.length,
        unknownEventCount: 0,
      };
    }
    return { ok: false, error: 'unrecognized JSON shape' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

