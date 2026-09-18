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

function requireRepoRoot(input, caller) {
  if (typeof input?.repoRoot !== 'string' || !isAbsolute(input.repoRoot)) {
    throw new Error(`${caller}: repoRoot must be an absolute path`);
  }
}

function attemptPath(input) {
  return join(
    input.repoRoot,
    '.codex-paired',
    'attempts',
    input.implementerRunId,
    `${memberIdSlug(input.memberId)}.json`,
  );
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'EPERM') return true;
    if (err?.code === 'ESRCH') return false;
    throw err;
  }
}

function snapshotFrom(value) {
  if (!value?.model_role || !value?.model || !value?.effort) return null;
  return { model_role: value.model_role, model: value.model, effort: value.effort };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Attempt evidence is only trustworthy when it is a plain object whose
// declared `state` carries the fields that state's readers depend on.
// JSON `null`/numbers/strings/arrays parse without error but are not valid
// evidence records; a well-formed object can still be missing the
// state-specific fields a partial/aborted write would omit.
function isValidAttemptEvidence(evidence) {
  if (!isPlainObject(evidence)) return false;
  switch (evidence.state) {
    case 'launching':
      return typeof evidence.launched_at === 'string';
    case 'running':
      return Number.isInteger(evidence.pid) && typeof evidence.spawned_at === 'string';
    case 'exited':
      // resultFromEvidence() reads outcome/exit_code/head_sha/changed_files/
      // diff_hash/halt_envelope; the writer above always sets all of them
      // (even to null) once a terminal record is published, so their mere
      // presence (not nullness) distinguishes a complete record from a
      // truncated/partial one such as {"state":"exited","outcome":"completed"}.
      return (
        typeof evidence.completed_at === 'string' &&
        typeof evidence.outcome === 'string' &&
        Object.prototype.hasOwnProperty.call(evidence, 'exit_code') &&
        Object.prototype.hasOwnProperty.call(evidence, 'head_sha') &&
        Array.isArray(evidence.changed_files) &&
        Object.prototype.hasOwnProperty.call(evidence, 'diff_hash') &&
        Object.prototype.hasOwnProperty.call(evidence, 'halt_envelope')
      );
    default:
      return false;
  }
}

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 */
export async function dispatchCodexCliImplementer(input, {
  command,
  timeout_ms,
  deps = {},
} = {}) {
  if (
    !MODEL_ROLES.includes(input?.modelRole) ||
    typeof input?.model !== 'string' || !SAFE_TOKEN.test(input.model) ||
    typeof input?.effort !== 'string' || !SAFE_TOKEN.test(input.effort)
  ) {
    throw new Error('codex-cli-dispatch: missing model snapshot');
  }
  requireRepoRoot(input, 'codex-cli-dispatch');

  const statusFile = attemptPath(input);
  const modelSnapshot = {
    model_role: input.modelRole,
    model: input.model,
    effort: input.effort,
  };
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
  } catch (err) {
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
  let outcome = adapterResult?.haltEnvelope
    ? 'halted'
    : warnings.includes('aborted')
      ? 'cancelled'
      : adapterResult?.exit === 0 ? 'completed' : 'failed';

  let headSha = null;
  let changedFiles = [];
  let diffHash = null;
  let gitEvidenceError = null;
  if (!warnings.includes('spawn-failed')) {
    try {
      ({ headSha, changedFiles, diffHash } = await collectGitEvidence(input, deps));
    } catch (err) {
      gitEvidenceError = err;
      if (outcome === 'completed') outcome = 'failed';
    }
  }

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
 */
export function readDirectCliAttempt(input) {
  requireRepoRoot(input, 'readDirectCliAttempt');
  const path = attemptPath(input);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return null;
  }
  // Valid JSON that isn't a plain object (null, a number, a string, an
  // array, ...) is not a usable evidence record.
  if (!isPlainObject(evidence)) return null;
  return { ...evidence, pidAlive: evidence.state === 'running' && pidAlive(evidence.pid) };
}

/**
 * Observe an existing direct Codex attempt without relaunching or killing it.
 * Implements spec §7 in-flight continuation and finalization grace.
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
