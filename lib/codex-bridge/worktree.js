/**
 * worktree.js
 *
 * v0.7.0 worktree primitives. Each primitive is a small, mechanical operation
 * that the autopilot orchestrator (Claude) composes per spec §11
 * (worktree lifecycle) and spec §8 (bootstrap rules).
 *
 * All return shapes:
 *   - success: `{ok:true, ...payload}`
 *   - halt:    `{ok:false, halt:{reason, detail}}`
 *
 * Halt reasons surfaced by this module:
 *   - worktree-gitignore-missing
 *   - worktree-path-conflict
 *   - worktree-create-failed
 *   - worktree-bootstrap-failed
 *   - worktree-reset-failed
 *   - worktree-cleanup-failed
 *   - worktree-branch-cleanup-failed
 *
 * `worktree-bootstrap-stale` is surfaced by the orchestrator using
 * `verifyBootstrap()`'s output, not by this module directly.
 *
 * Style: zero npm deps. ES modules. All git shell-outs go through
 * `execFileSync` with argv arrays (no shell, no injection risk).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, lstatSync, readlinkSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

// ── helpers ───────────────────────────────────────────────────────────────────

function halt(reason, detail) {
  return { ok: false, halt: { reason, detail } };
}

/**
 * Run git with argv array. Returns `{ok:true, stdout}` on exit 0 or
 * `{ok:false, stderr, status}` otherwise. Never throws on nonzero exit.
 */
function runGit(args, opts = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message;
    return { ok: false, stderr, status: e.status ?? null };
  }
}

/**
 * Extract slice number from a slice id like `slice-3`.
 * Returns the trailing identifier portion to use in the worktree directory
 * name. We keep the convention `<repo>/.git-worktrees/slice-<N>` so the slice
 * id and directory name are identical.
 */
function worktreeDirFor(repoRoot, sliceId) {
  return join(repoRoot, '.git-worktrees', sliceId);
}

function branchNameFor(sliceId) {
  return `${sliceId}-impl`;
}

/**
 * Read `.gitignore` and check whether `.git-worktrees/` is ignored.
 * Match either an exact line `.git-worktrees/` or `.git-worktrees` (with or
 * without trailing slash). Comments + blank lines are skipped.
 */
function hasWorktreesGitignored(repoRoot) {
  const gi = join(repoRoot, '.gitignore');
  if (!existsSync(gi)) return false;
  const content = readFileSync(gi, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '.git-worktrees' || line === '.git-worktrees/' || line === '/.git-worktrees' || line === '/.git-worktrees/') {
      return true;
    }
  }
  return false;
}

/**
 * Inspect existing worktree registrations. Returns array of `{path, branch}`.
 * Empty on failure or none.
 */
function listWorktrees(repoRoot) {
  const r = runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (!r.ok) return [];
  const out = [];
  let cur = {};
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim();
    } else if (line === '') {
      if (cur.path) {
        out.push(cur);
        cur = {};
      }
    }
  }
  if (cur.path) out.push(cur);
  return out;
}

// ── create ────────────────────────────────────────────────────────────────────

/**
 * Create a slice worktree at `<repo>/.git-worktrees/<sliceId>` branched as
 * `<sliceId>-impl` from `sliceStartSha`. Spec §11.
 *
 * @param {string} repoRoot
 * @param {string} sliceId        e.g. `slice-3`
 * @param {string} sliceStartSha  commit sha to branch from
 * @returns {{ok:true, worktreePath:string, branchName:string}
 *           | {ok:false, halt:{reason:string, detail:string}}}
 */
export function create(repoRoot, sliceId, sliceStartSha) {
  // Pre-flight: .git-worktrees/ must be gitignored.
  if (!hasWorktreesGitignored(repoRoot)) {
    return halt(
      'worktree-gitignore-missing',
      `.git-worktrees/ must be listed in ${join(repoRoot, '.gitignore')} before creating worktrees`,
    );
  }

  const worktreePath = worktreeDirFor(repoRoot, sliceId);
  const branch = branchNameFor(sliceId);

  // Pre-flight: path conflict. If the path exists and is not a registered
  // worktree pointing at the same slice's branch, halt.
  if (existsSync(worktreePath)) {
    const existing = listWorktrees(repoRoot).find(w => w.path === worktreePath);
    if (!existing || existing.branch !== `refs/heads/${branch}`) {
      return halt(
        'worktree-path-conflict',
        `Path ${worktreePath} exists but is not a clean registered worktree for ${branch}`,
      );
    }
    // Already registered at the right branch — treat as idempotent success.
    return { ok: true, worktreePath, branchName: branch };
  }

  // Ensure parent dir exists.
  mkdirSync(join(repoRoot, '.git-worktrees'), { recursive: true });

  const r = runGit(
    ['worktree', 'add', '-b', branch, worktreePath, sliceStartSha],
    { cwd: repoRoot },
  );
  if (!r.ok) {
    return halt(
      'worktree-create-failed',
      `git worktree add failed for ${branch} at ${worktreePath}: ${r.stderr.trim()}`,
    );
  }

  return { ok: true, worktreePath, branchName: branch };
}

// ── bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Symlink dependency artifacts from the integration checkout into the
 * worktree. Spec §8.
 *
 * Symlink entry shape: `{path:string, required:bool}`.
 * - `required:true`  → halt `worktree-bootstrap-failed` if source absent.
 * - `required:false` → skip silently if source absent.
 *
 * Idempotent: if target is already the correct symlink, succeed without re-
 * linking. If target exists as a regular file or wrong symlink, halt.
 *
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @param {Array<{path:string, required:boolean}>} symlinks
 * @returns {{ok:true, created:string[], skipped:string[]}
 *           | {ok:false, halt:{reason:string, detail:string}}}
 */
export function bootstrap(repoRoot, worktreePath, symlinks) {
  if (!Array.isArray(symlinks)) {
    return halt(
      'worktree-bootstrap-failed',
      'bootstrap: symlinks must be an array of {path, required} entries',
    );
  }

  const created = [];
  const skipped = [];

  for (const entry of symlinks) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.required !== 'boolean') {
      return halt(
        'worktree-bootstrap-failed',
        `bootstrap: malformed entry ${JSON.stringify(entry)} (expected {path, required})`,
      );
    }

    const sourceAbs = join(repoRoot, entry.path);
    const targetAbs = join(worktreePath, entry.path);

    const sourceExists = existsSync(sourceAbs);
    if (!sourceExists) {
      if (entry.required) {
        return halt(
          'worktree-bootstrap-failed',
          `required source missing: ${sourceAbs} (for symlink ${entry.path})`,
        );
      }
      skipped.push(entry.path);
      continue;
    }

    // Source exists. Inspect target.
    let targetStat = null;
    try {
      targetStat = lstatSync(targetAbs);
    } catch {
      targetStat = null;
    }

    if (targetStat) {
      if (!targetStat.isSymbolicLink()) {
        return halt(
          'worktree-bootstrap-failed',
          `target ${targetAbs} exists and is not a symlink`,
        );
      }
      // Verify symlink target.
      let actual;
      try {
        actual = readlinkSync(targetAbs);
      } catch (e) {
        return halt(
          'worktree-bootstrap-failed',
          `failed to readlink existing symlink at ${targetAbs}: ${e.message}`,
        );
      }
      if (actual !== sourceAbs) {
        return halt(
          'worktree-bootstrap-failed',
          `symlink ${targetAbs} points at ${actual}, expected ${sourceAbs}`,
        );
      }
      // Idempotent: correct symlink already in place.
      created.push(entry.path);
      continue;
    }

    // Target absent → create symlink.
    try {
      symlinkSync(sourceAbs, targetAbs);
    } catch (e) {
      return halt(
        'worktree-bootstrap-failed',
        `symlink create failed: ${sourceAbs} → ${targetAbs}: ${e.message}`,
      );
    }
    created.push(entry.path);
  }

  return { ok: true, created, skipped };
}

// ── verifyBootstrap ───────────────────────────────────────────────────────────

/**
 * Verify that each recorded symlink in `recordedSymlinks` is present in the
 * worktree as a symlink and resolves to `<repoRoot>/<path>`.
 *
 * Returns `{ok:true}` or `{ok:false, failed:[{symlink, reason, expected?, actual?}]}`.
 * Reasons:
 *   - `missing`        — target does not exist
 *   - `not-a-symlink`  — target exists but is not a symlink
 *   - `wrong-target`   — target is a symlink but resolves elsewhere
 *
 * The orchestrator surfaces `worktree-bootstrap-stale` based on this output;
 * we do not halt here.
 *
 * @param {string} worktreePath
 * @param {Array<{path:string, required:boolean}>} recordedSymlinks
 * @param {string} repoRoot
 * @returns {{ok:true} | {ok:false, failed:Array<object>}}
 */
export function verifyBootstrap(worktreePath, recordedSymlinks, repoRoot) {
  const failed = [];
  for (const entry of recordedSymlinks || []) {
    if (!entry || typeof entry.path !== 'string') continue;
    const expected = join(repoRoot, entry.path);
    const target = join(worktreePath, entry.path);

    let stat = null;
    try {
      stat = lstatSync(target);
    } catch {
      stat = null;
    }
    if (!stat) {
      failed.push({ symlink: entry.path, reason: 'missing', expected });
      continue;
    }
    if (!stat.isSymbolicLink()) {
      failed.push({ symlink: entry.path, reason: 'not-a-symlink', expected });
      continue;
    }
    let actual;
    try {
      actual = readlinkSync(target);
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      failed.push({ symlink: entry.path, reason: 'wrong-target', expected, actual });
      continue;
    }
  }

  if (failed.length === 0) return { ok: true };
  return { ok: false, failed };
}

// ── reset ─────────────────────────────────────────────────────────────────────

/**
 * `git reset --hard <sliceStartSha>` inside the worktree. Untracked files
 * (including bootstrap symlinks) are preserved. Spec §9.
 *
 * @param {string} worktreePath
 * @param {string} sliceStartSha
 * @returns {{ok:true} | {ok:false, halt:{reason:string, detail:string}}}
 */
export function reset(worktreePath, sliceStartSha) {
  const r = runGit(
    ['-C', worktreePath, 'reset', '--hard', sliceStartSha],
    {},
  );
  if (!r.ok) {
    return halt(
      'worktree-reset-failed',
      `git reset --hard ${sliceStartSha} failed in ${worktreePath}: ${r.stderr.trim()}`,
    );
  }
  return { ok: true };
}

// ── remove ────────────────────────────────────────────────────────────────────

/**
 * `git worktree remove <worktreePath>`. Halts on nonzero exit. Spec §11.
 *
 * @param {string} repoRoot
 * @param {string} worktreePath
 * @returns {{ok:true} | {ok:false, halt:{reason:string, detail:string}}}
 */
export function remove(repoRoot, worktreePath) {
  const r = runGit(
    ['worktree', 'remove', worktreePath],
    { cwd: repoRoot },
  );
  if (!r.ok) {
    return halt(
      'worktree-cleanup-failed',
      `git worktree remove ${worktreePath} failed: ${r.stderr.trim()}`,
    );
  }
  return { ok: true };
}

// ── removeBranch ──────────────────────────────────────────────────────────────

/**
 * `git branch -D <branchName>`. Halts on nonzero exit. Spec §11.
 *
 * @param {string} repoRoot
 * @param {string} branchName
 * @returns {{ok:true} | {ok:false, halt:{reason:string, detail:string}}}
 */
export function removeBranch(repoRoot, branchName) {
  const r = runGit(
    ['branch', '-D', branchName],
    { cwd: repoRoot },
  );
  if (!r.ok) {
    return halt(
      'worktree-branch-cleanup-failed',
      `git branch -D ${branchName} failed: ${r.stderr.trim()}`,
    );
  }
  return { ok: true };
}
