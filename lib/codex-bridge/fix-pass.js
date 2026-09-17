import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { reset as resetWorktree } from './worktree.js';
import { reconcileWorktree } from './reconciler.js';
import { appendFixPass, updateFixPass } from './sidecar.js';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function untrackedFiles(repoRoot) {
  const output = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return new Set(
    output.split('\0')
      .filter((record) => record.startsWith('?? '))
      .map((record) => record.slice(3)),
  );
}

function removeNewUntracked(repoRoot, before) {
  const root = resolve(repoRoot);
  const rootPrefix = `${root}${sep}`;
  const created = [...untrackedFiles(repoRoot)].filter((path) => !before.has(path));
  for (const relativePath of created) {
    const target = resolve(root, relativePath);
    if (!target.startsWith(rootPrefix) || !existsSync(target)) continue;
    rmSync(target, { force: true });
    let parent = dirname(target);
    while (parent.startsWith(rootPrefix)) {
      try { rmdirSync(parent); } catch { break; }
      parent = dirname(parent);
    }
  }
}

// A pre-existing untracked file that the failed pass staged or committed would be deleted by
// `git reset --hard` (it became tracked in the discarded range). Snapshot such files' contents
// before the reset and write them back afterwards so rollback never loses the user's work.
function snapshotPreexistingNowTracked(repoRoot, before) {
  const tracked = new Set(git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean));
  const out = [];
  for (const relativePath of before) {
    if (!tracked.has(relativePath)) continue;
    const abs = resolve(repoRoot, relativePath);
    if (!existsSync(abs)) continue;
    out.push({ relativePath, content: readFileSync(abs) });
  }
  return out;
}

function restoreSnapshot(repoRoot, snapshot) {
  for (const { relativePath, content } of snapshot) {
    const abs = resolve(repoRoot, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function sliceNumber(sliceId) {
  const match = typeof sliceId === 'string' ? sliceId.match(/\d+/) : null;
  if (!match) throw new Error(`runFixPass: sliceId ${JSON.stringify(sliceId)} contains no slice number`);
  return match[0];
}

function resetFailureError(halt) {
  const detail = halt?.detail ?? 'worktree reset failed without detail';
  const error = new Error(`runFixPass: could not restore the fix-pass checkpoint: ${detail}`);
  error.code = 'fix-pass-reset-failed';
  return error;
}

/**
 * Run one bounded, checkpointed reviewer fix pass and restore only its work on
 * failure (v0.16.0 spec §6 step 3).
 */
export async function runFixPass({
  specPath,
  sliceId,
  repoRoot,
  pass,
  execFn,
  _deps = { reset: resetWorktree, reconcile: reconcileWorktree },
}) {
  const reset = _deps.reset ?? resetWorktree;
  const reconcile = _deps.reconcile ?? reconcileWorktree;
  const fixStartSha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  const untrackedBefore = untrackedFiles(repoRoot);
  const checkpointIndex = appendFixPass(specPath, sliceId, {
    pass,
    fix_start_sha: fixStartSha,
    started_at: new Date().toISOString(),
  });

  let execution;
  let failure = null;
  let detail;
  try {
    execution = await execFn({ fix_start_sha: fixStartSha });
  } catch (error) {
    failure = 'exec-failed';
    detail = error instanceof Error ? error.message : String(error);
  }

  const statusFile = execution?.statusFile;
  if (!failure && statusFile?.exit_code === 78) {
    const haltReason = statusFile.error;
    updateFixPass(specPath, sliceId, checkpointIndex, {
      outcome: 'terminal', reason: haltReason, completed_at: new Date().toISOString(),
    });
    return { ok: false, terminal: true, haltReason };
  }
  if (!failure && statusFile?.exit_code !== 0) {
    failure = 'nonzero-exit';
  }

  let reconciled;
  if (!failure) {
    try {
      reconciled = reconcile({
        worktreePath: repoRoot,
        sliceStartSha: fixStartSha,
        sliceId,
      });
    } catch (error) {
      failure = 'reconciler-failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    if (!failure && !reconciled?.ok) {
      failure = 'reconciler-failed';
      detail = reconciled?.halt?.detail ?? 'reconciler failed without detail';
    } else if (!failure && reconciled.commit_count === 0) {
      failure = 'zero-commits';
    } else if (!failure) {
      const number = sliceNumber(sliceId);
      const fixSubject = new RegExp(`^fix\\(slice:${number}\\):`);
      if (reconciled.commits.some((commit) => !fixSubject.test(commit.subject))) {
        failure = 'non-conforming-commits';
      }
    }
  }

  if (!failure) {
    updateFixPass(specPath, sliceId, checkpointIndex, {
      outcome: 'succeeded',
      head_sha: reconciled.head_sha,
      commits: reconciled.commits,
      completed_at: new Date().toISOString(),
    });
    return {
      ok: true,
      fix_start_sha: fixStartSha,
      head_sha: reconciled.head_sha,
      commits: reconciled.commits,
    };
  }

  const preserved = snapshotPreexistingNowTracked(repoRoot, untrackedBefore);
  let resetResult;
  try {
    resetResult = await reset(repoRoot, fixStartSha);
  } catch (error) {
    throw resetFailureError({ detail: error instanceof Error ? error.message : String(error) });
  }
  if (!resetResult?.ok) throw resetFailureError(resetResult?.halt);
  removeNewUntracked(repoRoot, untrackedBefore);
  restoreSnapshot(repoRoot, preserved);
  updateFixPass(specPath, sliceId, checkpointIndex, {
    outcome: 'failed',
    reason: failure,
    ...(detail === undefined ? {} : { detail }),
    reset_to: fixStartSha,
    completed_at: new Date().toISOString(),
  });
  return { ok: false, reason: failure, reset_to: fixStartSha };
}
