// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { dispatch as dispatchCodexAdapter } from '../cli-harness/adapters/codex.js';
import { wrapAsHaltEnvelope } from '../halt-envelope.js';
import { MODEL_ROLES, SAFE_TOKEN } from '../models.js';
import { memberIdSlug } from './member-id.js';

/** @typedef {import('./types.js').ImplementerDispatchInput} ImplementerDispatchInput */
/** @typedef {import('./types.js').ImplementerDispatchResult} ImplementerDispatchResult */
/** @typedef {Record<string, any>} AttemptEvidence */
/**
 * @typedef {{state: 'launching', launched_at: string} |
 *   {state: 'running', pid: number, spawned_at: string, pidAlive?: boolean} |
 *   {state: 'exited', completed_at: string, outcome: 'completed' | 'failed' | 'cancelled' | 'halted', exit_code: number | null, head_sha: string | null, changed_files: string[], diff_hash: string | null, halt_envelope: object | null, model_role: string, model: string, effort: string}} ValidAttemptEvidence
 */
/**
 * @typedef {object} DispatchDeps
 * @property {typeof dispatchCodexAdapter} [adapterDispatch]
 * @property {(evidence: AttemptEvidence) => unknown | Promise<unknown>} [afterSpawnPublish]
 * @property {(result: ImplementerDispatchResult) => unknown | Promise<unknown>} [beforePublishTerminal]
 * @property {(input: ImplementerDispatchInput) => Promise<{headSha: string, changedFiles: string[], diffHash: string}>} [collectGitEvidence]
 * @property {typeof execFileSync} [execFileSync]
 * @property {typeof spawn} [spawn]
 * @property {(input: ImplementerDispatchInput) => AttemptEvidence | null | Promise<AttemptEvidence | null>} [readAttempt]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @param {ImplementerDispatchInput} input @param {string} caller @returns {asserts input is ImplementerDispatchInput & {repoRoot: string}} */
function requireRepoRoot(input, caller) {
  if (typeof input?.repoRoot !== 'string' || !isAbsolute(input.repoRoot)) {
    throw new Error(`${caller}: repoRoot must be an absolute path`);
  }
}

/** @param {ImplementerDispatchInput & {repoRoot: string}} input */
function attemptPath(input) {
  return join(
    input.repoRoot,
    '.codex-paired',
    'attempts',
    input.implementerRunId,
    `${memberIdSlug(input.memberId)}.json`,
  );
}

/** @param {string} path @param {unknown} value */
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (/** @type {any} */ err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
}

/** @param {AttemptEvidence | null} value */
function snapshotFrom(value) {
  if (!value?.model_role || !value?.model || !value?.effort) return null;
  return { model_role: value.model_role, model: value.model, effort: value.effort };
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// dispatchCodexCliImplementer() only ever writes one of these four outcome
// strings onto a terminal ("exited") record — see the `outcome` assignment
// above (haltEnvelope -> 'halted', warnings.includes('aborted') -> 'cancelled',
// exit === 0 -> 'completed', otherwise 'failed') and the spawn-failure catch
// block (always 'failed').
const VALID_TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'halted', 'cancelled']);

/** @param {(value: any) => boolean} predicate */
function isNullOr(predicate) {
  return (/** @type {any} */ value) => value === null || predicate(value);
}

// git rev-parse HEAD: a hex object id (abbreviated or full-length, and
// tolerant of both sha1's 40 and sha256's 64 hex chars).
const isHeadSha = (/** @type {unknown} */ value) => typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value);
// hashGitDiff() always produces `sha256:<64 lowercase hex chars>`.
const isDiffHash = (/** @type {unknown} */ value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

// The writer always spreads `modelSnapshot` (model_role/model/effort — see
// dispatchCodexCliImplementer()'s `modelSnapshot` local) onto every record,
// starting with the very first 'launching' write. A terminal record missing
// any of them cannot be trusted.
/** @param {Record<string, any>} evidence */
function hasValidModelSnapshotFields(evidence) {
  return (
    typeof evidence.model_role === 'string' && evidence.model_role.length > 0 &&
    typeof evidence.model === 'string' && evidence.model.length > 0 &&
    typeof evidence.effort === 'string' && evidence.effort.length > 0
  );
}

/** @param {Record<string, any>} evidence */
function isValidExitedEvidence(evidence) {
  if (typeof evidence.completed_at !== 'string') return false;
  if (typeof evidence.outcome !== 'string' || !VALID_TERMINAL_OUTCOMES.has(evidence.outcome)) return false;
  if (!isNullOr(Number.isInteger)(evidence.exit_code)) return false;
  if (!isNullOr(isHeadSha)(evidence.head_sha)) return false;
  if (!Array.isArray(evidence.changed_files) || !evidence.changed_files.every((/** @type {unknown} */ f) => typeof f === 'string')) {
    return false;
  }
  if (!isNullOr(isDiffHash)(evidence.diff_hash)) return false;
  if (!(evidence.halt_envelope === null || isPlainObject(evidence.halt_envelope))) return false;
  if (!hasValidModelSnapshotFields(evidence)) return false;
  // A 'completed' outcome is the only one the orchestrator treats as
  // success; it must carry the terminal evidence a completed run always
  // produces. Unsuccessful outcomes (failed/halted/cancelled) may
  // legitimately leave exit_code/head_sha/diff_hash null (e.g. a spawn
  // failure or a pre-spawn abort never collects git evidence at all).
  if (evidence.outcome === 'completed') {
    if (!Number.isInteger(evidence.exit_code)) return false;
    if (typeof evidence.head_sha !== 'string') return false;
  }
  return true;
}

// Attempt evidence is only trustworthy when it is a plain object whose
// declared `state` carries the fields that state's readers depend on, WITH
// the types those readers assume — not merely their presence. JSON
// `null`/numbers/strings/arrays parse without error but are not valid
// evidence records; a well-formed object can still be missing (or carry the
// wrong type for) the state-specific fields a partial/aborted/corrupted
// write would omit or mangle.
/** @param {unknown} evidence @returns {evidence is ValidAttemptEvidence} */
function isValidAttemptEvidence(evidence) {
  if (!isPlainObject(evidence)) return false;
  switch (evidence.state) {
    case 'launching':
      return typeof evidence.launched_at === 'string';
    case 'running':
      return Number.isInteger(evidence.pid) && typeof evidence.spawned_at === 'string';
    case 'exited':
      return isValidExitedEvidence(evidence);
    default:
      return false;
  }
}

/** @param {ImplementerDispatchInput} input @param {Extract<ValidAttemptEvidence, {state: 'exited'}>} evidence @returns {ImplementerDispatchResult} */
function resultFromEvidence(input, evidence) {
  return {
    memberId: input.memberId,
    outcome: evidence.outcome,
    exitCode: evidence.exit_code ?? null,
    headSha: evidence.head_sha ?? null,
    changedFiles: Array.isArray(evidence.changed_files) ? evidence.changed_files : [],
    diffHash: evidence.diff_hash ?? null,
    haltEnvelope: evidence.halt_envelope ?? null,
    modelSnapshot: snapshotFrom(evidence),
  };
}

/**
 * @param {ImplementerDispatchInput} input
 * @param {string} reason
 * @param {string} statusFile
 * @param {AttemptEvidence | null} evidence
 * @param {boolean} [inFlight]
 * @returns {ImplementerDispatchResult}
 */
function haltedObservation(input, reason, statusFile, evidence, inFlight = false) {
  return {
    memberId: input.memberId,
    outcome: 'halted',
    exitCode: null,
    headSha: null,
    changedFiles: [],
    diffHash: null,
    haltEnvelope: wrapAsHaltEnvelope(reason, {
      member_id: input.memberId,
      status_file: statusFile,
    }),
    modelSnapshot: snapshotFrom(evidence),
    ...(inFlight ? { attemptInFlight: true } : {}),
  };
}

/** @param {number} ms @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} worktreePath @param {string} baseSha @param {typeof spawn} [spawnFn] @returns {Promise<string>} */
function hashGitDiff(worktreePath, baseSha, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('git', ['diff', `${baseSha}..HEAD`], {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hash = createHash('sha256');
    let stderr = '';
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(`sha256:${hash.digest('hex')}`);
        return;
      }
      reject(new Error(
        `git diff failed${code === null ? '' : ` with exit ${code}`}` +
        `${signal ? ` (${signal})` : ''}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      ));
    });
  });
}

/** @param {ImplementerDispatchInput} input @param {DispatchDeps} deps */
async function collectGitEvidence(input, deps) {
  if (typeof deps.collectGitEvidence === 'function') {
    return deps.collectGitEvidence(input);
  }
  const execGit = deps.execFileSync ?? execFileSync;
  const headSha = execGit('git', ['rev-parse', 'HEAD'], {
    cwd: input.worktreePath,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
  const changed = execGit('git', ['diff', '--name-only', `${input.baseSha}..HEAD`], {
    cwd: input.worktreePath,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const diffHash = await hashGitDiff(input.worktreePath, input.baseSha, deps.spawn);
  return {
    headSha,
    changedFiles: changed.split(/\r?\n/).filter(Boolean),
    diffHash,
  };
}

/**
 * Launch one direct Codex implementer with durable attempt evidence.
 * Implements spec §4 direct-adapter launch ownership and §7 continuation.
 * @param {ImplementerDispatchInput} input
 * @param {{command?: string, timeout_ms?: number, deps?: DispatchDeps}} [options]
 * @returns {Promise<ImplementerDispatchResult>}
 */
export async function dispatchCodexCliImplementer(input, {
  command,
  timeout_ms,
  deps = {},
} = {}) {
  if (
    !MODEL_ROLES.includes(/** @type {import('../types.js').ModelRole} */ (input?.modelRole)) ||
    typeof input?.model !== 'string' || !SAFE_TOKEN.test(input.model) ||
    typeof input?.effort !== 'string' || !SAFE_TOKEN.test(input.effort)
  ) {
    throw new Error('codex-cli-dispatch: missing model snapshot');
  }
  requireRepoRoot(input, 'codex-cli-dispatch');

  const statusFile = attemptPath(input);
  const modelSnapshot = {
    model_role: /** @type {string} */ (input.modelRole),
    model: input.model,
    effort: input.effort,
  };
  /** @type {AttemptEvidence} */
  let evidence = {
    state: 'launching',
    pid: null,
    launched_at: new Date().toISOString(),
    spawned_at: null,
    completed_at: null,
    exit_code: null,
    outcome: null,
    head_sha: null,
    changed_files: [],
    diff_hash: null,
    halt_envelope: null,
    ...modelSnapshot,
  };
  writeAtomic(statusFile, evidence);
  if (typeof input.onLaunched === 'function') {
    await input.onLaunched({ ...modelSnapshot, status_file: statusFile });
  }

  const adapterDispatch = deps.adapterDispatch ?? dispatchCodexAdapter;
  /** @type {Promise<unknown>} */
  let spawnPublishPromise = Promise.resolve();
  let adapterResult;
  try {
    adapterResult = await adapterDispatch('', input.prompt, {
      command,
      execMode: 'implementer',
      cwd: input.worktreePath,
      model: input.model,
      reasoningEffort: input.effort,
      env: input.env,
      signal: input.abortSignal,
      timeout_ms,
      sliceId: input.sliceId,
      onSpawn(pid) {
        evidence = {
          ...evidence,
          state: 'running',
          pid,
          spawned_at: new Date().toISOString(),
        };
        writeAtomic(statusFile, evidence);
        if (typeof deps.afterSpawnPublish === 'function') {
          spawnPublishPromise = Promise.resolve(deps.afterSpawnPublish({ ...evidence }));
        }
      },
    });
  } catch (/** @type {any} */ err) {
    const failedEvidence = {
      ...evidence,
      state: 'exited',
      completed_at: new Date().toISOString(),
      outcome: 'failed',
      exit_code: null,
      error: err?.message ? String(err.message) : String(err),
    };
    writeAtomic(statusFile, failedEvidence);
    throw err;
  }

  await spawnPublishPromise;
  const warnings = Array.isArray(adapterResult?.warnings) ? adapterResult.warnings : [];
  /** @type {'completed' | 'failed' | 'cancelled' | 'halted'} */
  let outcome = adapterResult?.haltEnvelope
    ? 'halted'
    : warnings.includes('aborted')
      ? 'cancelled'
      : adapterResult?.exit === 0 ? 'completed' : 'failed';

  /** @type {string | null} */
  let headSha = null;
  /** @type {string[]} */
  let changedFiles = [];
  /** @type {string | null} */
  let diffHash = null;
  /** @type {any} */
  let gitEvidenceError = null;
  if (!warnings.includes('spawn-failed')) {
    try {
      ({ headSha, changedFiles, diffHash } = await collectGitEvidence(input, deps));
    } catch (err) {
      gitEvidenceError = err;
      if (outcome === 'completed') outcome = 'failed';
    }
  }

  /** @type {ImplementerDispatchResult} */
  const result = {
    memberId: input.memberId,
    outcome,
    exitCode: warnings.includes('spawn-failed')
      ? null
      : (Number.isFinite(adapterResult?.exit) ? adapterResult.exit : null),
    headSha,
    changedFiles,
    diffHash,
    haltEnvelope: adapterResult?.haltEnvelope ?? null,
    modelSnapshot,
  };
  if (typeof deps.beforePublishTerminal === 'function') {
    await deps.beforePublishTerminal(result);
  }
  evidence = {
    ...evidence,
    state: 'exited',
    completed_at: new Date().toISOString(),
    exit_code: result.exitCode,
    outcome: result.outcome,
    head_sha: result.headSha,
    changed_files: result.changedFiles,
    diff_hash: result.diffHash,
    halt_envelope: result.haltEnvelope,
    ...(warnings.includes('spawn-failed')
      ? { error: adapterResult?.adapterMeta?.error ?? 'spawn failed' }
      : gitEvidenceError
        ? { error: gitEvidenceError?.message ? String(gitEvidenceError.message) : String(gitEvidenceError) }
        : {}),
  };
  writeAtomic(statusFile, evidence);
  return result;
}

/**
 * Read durable evidence for a direct Codex attempt and report pid liveness.
 * Implements spec §7 continuation evidence lookup.
 * @param {ImplementerDispatchInput} input
 * @returns {(AttemptEvidence & {pidAlive: boolean}) | null}
 */
export function readDirectCliAttempt(input) {
  requireRepoRoot(input, 'readDirectCliAttempt');
  const path = attemptPath(input);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch (/** @type {any} */ err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
  // Valid JSON that isn't a plain object (null, a number, a string, an
  // array, ...) is not a usable evidence record.
  if (!isPlainObject(evidence)) return null;
  return {
    ...evidence,
    pidAlive: evidence.state === 'running' && typeof evidence.pid === 'number' && pidAlive(evidence.pid),
  };
}

/**
 * Observe an existing direct Codex attempt without relaunching or killing it.
 * Implements spec §7 in-flight continuation and finalization grace.
 * @param {ImplementerDispatchInput} input
 * @param {{timeout_ms?: number, poll_ms?: number, launch_grace_ms?: number, finalize_grace_ms?: number, deps?: DispatchDeps}} [options]
 * @returns {Promise<ImplementerDispatchResult>}
 */
export async function observeDirectCliAttempt(input, {
  timeout_ms = 7_200_000,
  poll_ms = 250,
  launch_grace_ms = 60_000,
  finalize_grace_ms = 10_000,
  deps = {},
} = {}) {
  requireRepoRoot(input, 'observeDirectCliAttempt');
  const statusFile = attemptPath(input);
  const readAttempt = deps.readAttempt ?? readDirectCliAttempt;
  const wait = deps.sleep ?? sleep;
  const startedAt = Date.now();
  let deadSince = null;
  let lastEvidence = null;

  for (;;) {
    const evidence = await readAttempt(input);
    if (!evidence) {
      return haltedObservation(input, 'implementer-attempt-lost', statusFile, lastEvidence);
    }
    lastEvidence = evidence;
    // Structural validation applies to every state (Claude C0 on the round-2 fix): a record
    // whose declared state lacks the fields that state's readers depend on is `lost`, never
    // polled forever, never surfaced as completed.
    if (!isValidAttemptEvidence(evidence)) {
      return haltedObservation(input, 'implementer-attempt-lost', statusFile, evidence);
    }
    if (evidence.state === 'exited') return resultFromEvidence(input, evidence);

    if (evidence.state === 'launching') {
      const launchedAt = Date.parse(evidence.launched_at);
      if (!Number.isFinite(launchedAt) || Date.now() - launchedAt > launch_grace_ms) {
        return haltedObservation(input, 'implementer-attempt-lost', statusFile, evidence);
      }
      await wait(poll_ms);
      continue;
    }

    if (evidence.state !== 'running') {
      return haltedObservation(input, 'implementer-attempt-lost', statusFile, evidence);
    }
    const alive = evidence.pidAlive ?? pidAlive(evidence.pid);
    if (alive) {
      deadSince = null;
      if (Date.now() - startedAt >= timeout_ms) {
        return haltedObservation(input, 'implementer-attempt-timeout', statusFile, evidence, true);
      }
    } else {
      deadSince ??= Date.now();
      if (Date.now() - deadSince >= finalize_grace_ms) {
        return haltedObservation(input, 'implementer-attempt-lost', statusFile, evidence);
      }
    }
    await wait(poll_ms);
  }
}
