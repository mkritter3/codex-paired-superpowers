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

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB safety cap per stream.

// Error codes that mean spawn() failed to launch the child (binary missing,
// permission denied, etc.). Distinguished from post-spawn errors like
// AbortError (timeout) so we can surface a meaningful `spawn-failed` warning
// with the original error message + code preserved in adapterMeta.
const SPAWN_FAILURE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR']);

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

export async function dispatch(systemPrompt, userPrompt, options = {}) {
  const command = options.command || 'codex';
  const args = Array.isArray(options.args) ? options.args : ['--json'];
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

  // Compose the prompt that will be piped to stdin.
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
      adapterMeta: { error: String(err && err.message ? err.message : err) },
      duration_ms: Date.now() - startedAt,
    };
  }

  // Bounded stdout/stderr buffers.
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

  // Write the prompt and close stdin so the child can exit cleanly.
  try {
    child.stdin.end(stdinPayload);
  } catch {
    // EPIPE if the child exited before we could write; harmless here.
  }

  const exitInfo = await new Promise((resolve) => {
    let resolved = false;
    function done(info) {
      if (resolved) return;
      resolved = true;
      resolve(info);
    }
    child.once('error', (err) => {
      // Two ways this fires:
      //   (a) spawn-failure (ENOENT/EACCES/EPERM/ENOTDIR) — the binary
      //       couldn't be launched. We want to surface this distinctly
      //       so callers see `spawn-failed` instead of a generic SIGTERM.
      //   (b) AbortError when ac.abort() kills the process for timeout
      //       (or a similar post-spawn signal). Keep prior behavior:
      //       treat as SIGTERM-style exit so the timeout/cli-exit-nonzero
      //       path handles it.
      const code = err && err.code;
      if (code && SPAWN_FAILURE_CODES.has(code)) {
        done({ code: null, signal: null, err, spawnFailed: true });
      } else {
        done({ code: null, signal: 'SIGTERM', err });
      }
    });
    // `exit` fires when the process actually exits, regardless of stdio
    // pipe state. We prefer it over `close` because orphan grandchildren
    // (e.g. bash's `sleep 3600` from the fake-CLI hang fixture) can keep
    // inherited stdout/stderr pipes open after the parent dies, which
    // would block `close` forever.
    child.once('exit', (code, signal) => {
      done({ code, signal, err: null });
    });
  });

  // After exit, force-kill any lingering pipes so node's event loop can
  // drain. If the child's grandchildren inherited stdio, killing the
  // child won't release the pipes — but destroying our end of the
  // streams will.
  try { child.stdout && child.stdout.destroy(); } catch { /* ignore */ }
  try { child.stderr && child.stderr.destroy(); } catch { /* ignore */ }
  try { child.stdin && child.stdin.destroy(); } catch { /* ignore */ }

  clearTimeout(timeoutHandle);
  const duration_ms = Date.now() - startedAt;

  // Async spawn-failure path: ENOENT / EACCES / EPERM / ENOTDIR from
  // child.on('error') means the binary never ran. Surface this as a
  // dedicated `spawn-failed` warning with the error + code preserved so
  // callers can see WHY the spawn failed (missing binary vs. permission
  // denied vs. not-a-directory in PATH).
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
        error: err && err.message ? String(err.message) : String(err),
        errorCode: err && err.code ? String(err.code) : null,
      },
      duration_ms,
    };
  }

  // Compute exit + warnings.
  const warnings = [];
  let exitCode;
  if (timedOut) {
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
  if (stdoutTruncated) warnings.push('stdout-truncated');
  if (stderrTruncated) warnings.push('stderr-truncated');

  // Parse stdout. If we timed out or hit nonzero exit, force empty
  // responseText (the spec says nonzero exit → responseText: '').
  let responseText = '';
  let adapterMeta = {
    command,
    args,
    stderr: stderr,
    eventCount: 0,
    unknownEventCount: 0,
  };

  if (timedOut) {
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

const SIGNAL_TO_NUMBER = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};
