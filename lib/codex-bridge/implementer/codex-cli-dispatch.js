import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
  const outcome = adapterResult?.haltEnvelope
    ? 'halted'
    : warnings.includes('aborted')
      ? 'cancelled'
      : adapterResult?.exit === 0 ? 'completed' : 'failed';

  let headSha = null;
  let changedFiles = [];
  let diffHash = null;
  try {
    headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: input.worktreePath,
      encoding: 'utf8',
    }).trim();
    const changed = execFileSync('git', ['diff', '--name-only', `${input.baseSha}..HEAD`], {
      cwd: input.worktreePath,
      encoding: 'utf8',
    });
    changedFiles = changed.split(/\r?\n/).filter(Boolean);
    const diff = execFileSync('git', ['diff', `${input.baseSha}..HEAD`], {
      cwd: input.worktreePath,
    });
    diffHash = `sha256:${createHash('sha256').update(diff).digest('hex')}`;
  } catch {
    // A spawn failure may happen before a usable worktree exists. Its adapter
    // error remains the primary result; git fields deliberately stay null/empty.
  }

  const result = {
    memberId: input.memberId,
    outcome,
    exitCode: Number.isFinite(adapterResult?.exit) ? adapterResult.exit : null,
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
    throw err;
  }
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
