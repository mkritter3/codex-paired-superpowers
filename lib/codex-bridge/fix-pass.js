import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

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

// Rollback must return every PRE-EXISTING untracked file to its pre-pass contents: a failed pass
// may have modified it, staged/committed it (so `git reset --hard` would delete it), or deleted
// it outright. The contents are captured BEFORE the pass runs (Codex review round 2) as
// DISK-BACKED copies in a temporary directory (Codex review round 3): `copyFileSync` streams
// through the kernel, so memory stays bounded regardless of file count or size and no file is
// ever skipped. The snapshot directory is removed once the pass settles.
function snapshotUntracked(repoRoot, paths) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-fix-pass-snapshot-'));
  const entries = [];
  for (const relativePath of paths) {
    const abs = resolve(repoRoot, relativePath);
    if (!existsSync(abs)) continue;
    const copy = join(dir, `${entries.length}.bin`);
    copyFileSync(abs, copy);
    entries.push({ relativePath, copy });
  }
  return { dir, entries };
}

function restoreSnapshot(repoRoot, snapshot, deps = {}) {
  const copy = deps.copyFile ?? copyFileSync; // test seam for restore-failure injection
  for (const { relativePath, copy: source } of snapshot.entries) {
    const abs = resolve(repoRoot, relativePath);
    mkdirSync(dirname(abs), { recursive: true });
    copy(source, abs);
  }
}

function discardSnapshot(snapshot) {
  rmSync(snapshot.dir, { recursive: true, force: true });
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
  const preserved = snapshotUntracked(repoRoot, untrackedBefore); // BEFORE the pass runs
  let checkpointIndex;
  try {
    checkpointIndex = appendFixPass(specPath, sliceId, {
      pass,
      fix_start_sha: fixStartSha,
      started_at: new Date().toISOString(),
      snapshot_dir: preserved.dir,
      snapshot_files: preserved.entries.map((e) => e.relativePath),
    });
  } catch (error) {
    discardSnapshot(preserved); // the pass never ran; nothing to recover
    throw error;
  }
  // Snapshot ownership (Codex review round 4): the recovery copies are deleted ONLY after the
  // pass settled without needing them (success / terminal 78) or after a rollback that fully
  // restored them. Any failure while rolling back leaves the directory in place and names it,
  // so the user can recover the originals by hand.
  let outcome;
  try {
    outcome = await runFixPassBody({
      specPath, sliceId, repoRoot, pass, execFn, reset, reconcile, _deps,
      fixStartSha, untrackedBefore, preserved, checkpointIndex,
    });
  } catch (error) {
    error.snapshot_dir = preserved.dir;
    error.snapshot_files = preserved.entries.map((e) => e.relativePath);
    error.message += ` (recovery copies of pre-existing untracked files kept at ${preserved.dir})`;
    updateFixPass(specPath, sliceId, checkpointIndex, { snapshot_retained: true });
    throw error;
  }
  discardSnapshot(preserved);
  return outcome;
}

async function runFixPassBody({
  specPath, sliceId, repoRoot, execFn, reset, reconcile, _deps = {},
  fixStartSha, untrackedBefore, preserved, checkpointIndex,
}) {

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

  let resetResult;
  try {
    resetResult = await reset(repoRoot, fixStartSha);
  } catch (error) {
    throw resetFailureError({ detail: error instanceof Error ? error.message : String(error) });
  }
  if (!resetResult?.ok) throw resetFailureError(resetResult?.halt);
  removeNewUntracked(repoRoot, untrackedBefore);
  try {
    restoreSnapshot(repoRoot, preserved, _deps);
  } catch (error) {
    const wrapped = new Error(`runFixPass: rollback reset to ${fixStartSha} but restoring pre-existing untracked files failed: ${error.message}`);
    wrapped.code = 'fix-pass-restore-failed';
    wrapped.cause = error;
    throw wrapped;
  }
  updateFixPass(specPath, sliceId, checkpointIndex, {
    outcome: 'failed',
    reason: failure,
    ...(detail === undefined ? {} : { detail }),
    reset_to: fixStartSha,
    completed_at: new Date().toISOString(),
  });
  return { ok: false, reason: failure, reset_to: fixStartSha };
}
