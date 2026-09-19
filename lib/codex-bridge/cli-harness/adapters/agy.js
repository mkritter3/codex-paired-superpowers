// @ts-check

// v0.17.0 slice 3 — agy CLI adapter.
//
// Spawns the Antigravity `agy` CLI in headless JSON mode (-p, --output-format json),
// parses the JSON response into the standard DispatchResult shape, and manages
// process lifecycle via the shared helper process-lifecycle.js.

import { SAFE_TOKEN, agyPermissionMode } from '../../models.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_BUFFER_BYTES,
  SIGNAL_TO_NUMBER,
  composeStdinPayload,
  runChildWithLifecycle,
} from '../process-lifecycle.js';

/**
 * @typedef {object} AgyDispatchOptions
 * @property {'reviewer' | 'implementer'} [execMode]
 * @property {string} [cwd]
 * @property {string} [model]
 * @property {string} [conversationId]
 * @property {string} [command]
 * @property {number} [timeout_ms]
 * @property {number} [maxBufferBytes]
 * @property {AbortSignal} [signal]
 * @property {(pid: number) => void} [onSpawn]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string[]} [addDirs]
 * @property {string[]} [args]
 */

/**
 * @typedef {object} DispatchResult
 * @property {string} responseText
 * @property {number} exit
 * @property {string[]} warnings
 * @property {string | null} sessionId
 * @property {Record<string, any>} adapterMeta
 * @property {number} duration_ms
 */

/**
 * Dispatch a prompt to the Antigravity (agy) CLI.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §3
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {AgyDispatchOptions} [options]
 * @returns {Promise<DispatchResult>}
 */
export async function dispatch(systemPrompt, userPrompt, options = {}) {
  const execMode = options.execMode !== undefined ? options.execMode : 'reviewer';
  if (execMode !== 'reviewer' && execMode !== 'implementer') {
    throw new Error('invalid execMode');
  }

  const hasModelOptions = options.model !== undefined;
  if (Array.isArray(options.args) && hasModelOptions) {
    throw new Error('agy adapter: options.args and model options are mutually exclusive');
  }

  if (!Array.isArray(options.args)) {
    // Resolve before spawning: an unknown value is a configuration error, never a silent default.
    agyPermissionMode({ ...process.env, ...(options.env ?? {}) });
    if (!options.cwd || typeof options.cwd !== 'string' || options.cwd.trim() === '') {
      throw new Error('agy adapter requires options.cwd');
    }
    if (!options.model || typeof options.model !== 'string' || !SAFE_TOKEN.test(options.model)) {
      throw new Error('agy adapter: model must be a safe non-empty token');
    }
  }

  return dispatchAsync(systemPrompt, userPrompt, options, execMode);
}

/**
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {AgyDispatchOptions} options
 * @param {'reviewer' | 'implementer'} execMode
 * @returns {Promise<DispatchResult>}
 */
async function dispatchAsync(systemPrompt, userPrompt, options, execMode) {
  const command = options.command || 'agy';
  const timeoutMs = typeof options.timeout_ms === 'number' && Number.isFinite(options.timeout_ms)
    ? options.timeout_ms
    : DEFAULT_TIMEOUT_MS;
  const maxBufferBytes = typeof options.maxBufferBytes === 'number' && Number.isFinite(options.maxBufferBytes)
    ? options.maxBufferBytes
    : MAX_BUFFER_BYTES;
  const envExtras = options.env && typeof options.env === 'object' ? options.env : {};

  const permissions = agyPermissionMode({ ...process.env, ...envExtras });
  let args;
  if (Array.isArray(options.args)) {
    args = options.args;
  } else {
    const prompt = composeStdinPayload(systemPrompt, userPrompt);
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      /** @type {string} */ (options.model),
    ];
    if (options.conversationId) {
      args.push('--conversation', String(options.conversationId));
    }
    args.push('--sandbox');
    if (permissions === 'auto') args.push('--dangerously-skip-permissions');
    if (execMode === 'reviewer') {
      args.push('--mode', 'plan');
    } else if (permissions === 'accept-edits') {
      args.push('--mode', 'accept-edits');
    }
    if (Array.isArray(options.addDirs)) {
      for (const dir of options.addDirs) {
        args.push('--add-dir', String(dir));
      }
    }
    args.push('--print-timeout', `${timeoutSec}s`);
  }

  const lifecycleResult = await runChildWithLifecycle({
    command,
    args,
    cwd: options.cwd,
    env: envExtras,
    stdinPayload: '',
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
        adapter: 'cli-harness:agy',
        exec_mode: execMode,
        command,
        args,
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
        adapter: 'cli-harness:agy',
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

  const warnings = [];
  let exitCode;
  if (externallyAborted) {
    warnings.push('aborted');
    exitCode = 130;
  } else if (timedOut) {
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
  if (truncated.stdout) warnings.push('stdout-truncated');
  if (truncated.stderr) warnings.push('stderr-truncated');
  const anyTruncated = truncated.any;

  let responseText = '';
  let sessionId = null;
  /** @type {Record<string, any>} */
  let adapterMeta = {
    adapter: 'cli-harness:agy',
    exec_mode: execMode,
    command,
    args,
    ...(stderr ? { stderr } : {}),
    ...(anyTruncated ? { truncated: true } : {}),
  };

  if (timedOut || externallyAborted) {
    responseText = '';
  } else if (stdout.trim().length === 0) {
    responseText = '';
    if (exitCode === 0) {
      warnings.push('empty-output');
    }
  } else {
    try {
      const json = JSON.parse(stdout.trim());
      sessionId = json.conversation_id ?? null;
      adapterMeta = {
        adapter: 'cli-harness:agy',
        exec_mode: execMode,
        command,
        args,
        status: json.status,
        denied_actions: Array.isArray(json.denied_actions) ? json.denied_actions : [],
        usage: json.usage,
        conversation_id: json.conversation_id,
        ...(stderr ? { stderr } : {}),
        ...(anyTruncated ? { truncated: true } : {}),
      };

      if (json.status !== 'SUCCESS') {
        exitCode = 1;
        warnings.push(`agy-status:${json.status}`);
        responseText = '';
      } else if (exitCode !== 0) {
        responseText = '';
      } else {
        responseText = typeof json.response === 'string' ? json.response : '';
      }

      if (Array.isArray(json.denied_actions) && json.denied_actions.length > 0) {
        const names = json.denied_actions.map((/** @type {any} */ item) =>
          typeof item === 'string'
            ? item
            : (item?.display_name ?? item?.name ?? String(item)),
        );
        warnings.push(`agy-denied:${names.join(',')}`);
        // A headless refusal ends the whole turn: agy still says SUCCESS but answers nothing.
        if (exitCode === 0 && responseText === '') {
          exitCode = 1;
          warnings.push('agy-permission-denied');
          adapterMeta.error = permissions === 'accept-edits'
            ? `agy refused ${names.join(', ')} and produced no answer. With `
              + 'CODEX_PAIRED_AGY_PERMISSIONS=accept-edits every command must match your agy allow-list '
              + '(permissions.allow in ~/.gemini/antigravity-cli/settings.json); unset it to use the '
              + 'default sandboxed mode.'
            : `agy refused ${names.join(', ')} and produced no answer (headless agy cannot ask for `
              + `approval; ${execMode === 'reviewer' ? 'reviewers run in --mode plan' : 'check the sandbox'}).`;
        }
      }
    } catch (/** @type {any} */ parseErr) {
      warnings.push('malformed-output');
      exitCode = 1;
      responseText = '';
      adapterMeta.parseError = parseErr.message;
    }
  }

  return {
    responseText,
    exit: exitCode,
    warnings,
    sessionId,
    adapterMeta,
    duration_ms,
  };
}
