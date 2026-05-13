// v0.10.0 implementer-experts — worktree fan-out.
//
// Creates per-implementer git worktrees under:
//   <repoRoot>/.codex-paired/worktrees/v0.10.0-implementer-experts/<memberIdSlug>
//
// Each worktree gets its own branch:
//   implementer/<sliceId>/<memberIdSlug>
//
// Returns a Map<memberId, {worktreePath, branchName, baseSha}>.

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, symlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { memberIdSlug } from './member-id.js';
import { wrapAsHaltEnvelope } from '../halt-envelope.js';

const WORKTREES_SUBDIR = '.codex-paired/worktrees/v0.10.0-implementer-experts';

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return result;
}

function gitOrThrow(args, cwd, haltCode, causeMsg) {
  const r = git(args, cwd);
  if (r.status !== 0) {
    const cause = (r.stderr || '').trim() || causeMsg || `git ${args[0]} failed`;
    const err = Object.assign(new Error(cause), {
      haltEnvelope: wrapAsHaltEnvelope(haltCode, { cause, args }),
    });
    throw err;
  }
  return (r.stdout || '').trim();
}

// ── input validation ──────────────────────────────────────────────────────────

function validateInputs({ repoRoot, sliceId, baseSha, implementers }) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw Object.assign(new Error('createImplementerWorktrees: repoRoot must be a non-empty string'), {
      haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'empty repoRoot' }),
    });
  }
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw Object.assign(new Error('createImplementerWorktrees: sliceId must be a non-empty string'), {
      haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'empty sliceId' }),
    });
  }
  if (typeof baseSha !== 'string' || baseSha.length === 0) {
    throw Object.assign(new Error('createImplementerWorktrees: baseSha must be a non-empty string'), {
      haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'empty baseSha' }),
    });
  }
  if (!Array.isArray(implementers) || implementers.length === 0) {
    throw Object.assign(new Error('createImplementerWorktrees: implementers must be a non-empty array'), {
      haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'empty implementers' }),
    });
  }

  const seen = new Set();
  for (const impl of implementers) {
    if (!impl || typeof impl !== 'object') {
      throw Object.assign(new Error('createImplementerWorktrees: each implementer must be an object'), {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'implementer not an object' }),
      });
    }
    if (typeof impl.memberId !== 'string' || impl.memberId.length === 0) {
      throw Object.assign(new Error('createImplementerWorktrees: each implementer must have a non-empty memberId'), {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'missing memberId' }),
      });
    }
    if (typeof impl.adapter !== 'string' || impl.adapter.length === 0) {
      throw Object.assign(new Error(`createImplementerWorktrees: implementer "${impl.memberId}" missing adapter`), {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'missing adapter' }),
      });
    }
    if (typeof impl.model !== 'string' || impl.model.length === 0) {
      throw Object.assign(new Error(`createImplementerWorktrees: implementer "${impl.memberId}" missing model`), {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'missing model' }),
      });
    }
    if (seen.has(impl.memberId)) {
      throw Object.assign(new Error(`createImplementerWorktrees: duplicate memberId "${impl.memberId}"`), {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', { detail: 'duplicate memberId' }),
      });
    }
    seen.add(impl.memberId);
  }
}

// ── path safety ───────────────────────────────────────────────────────────────

/**
 * Build and verify the worktree path for a single implementer.
 * Returns the resolved absolute path.
 * Throws haltEnvelope `worktree-path-escape` if the path escapes the safe prefix.
 */
function buildWorktreePath(repoRoot, slug) {
  const base = join(repoRoot, WORKTREES_SUBDIR);
  const candidate = resolve(join(base, slug));
  const expectedPrefix = resolve(base) + '/';

  if (!candidate.startsWith(expectedPrefix)) {
    throw Object.assign(
      new Error(`createImplementerWorktrees: worktree path escape detected for slug "${slug}"`),
      {
        haltEnvelope: wrapAsHaltEnvelope('worktree-path-escape', { slug, candidate }),
      }
    );
  }
  return candidate;
}

/**
 * Pre-flight: reject pre-existing symlinks at target path.
 * Throws haltEnvelope `worktree-path-conflict`.
 */
function checkNoSymlink(worktreePath) {
  try {
    const stat = lstatSync(worktreePath);
    if (stat.isSymbolicLink()) {
      throw Object.assign(
        new Error(`createImplementerWorktrees: pre-existing symlink at "${worktreePath}"`),
        {
          haltEnvelope: wrapAsHaltEnvelope('worktree-path-conflict', { worktreePath }),
        }
      );
    }
  } catch (err) {
    if (err.code === 'ENOENT') return; // path does not exist, good
    throw err; // re-throw worktree-path-conflict or other errors
  }
}

// ── pre-flight: repo-level checks ─────────────────────────────────────────────

function preFlightRepo(repoRoot) {
  // 1. Must be a git repo.
  {
    const r = git(['rev-parse', '--git-dir'], repoRoot);
    if (r.status !== 0) {
      throw Object.assign(
        new Error(`createImplementerWorktrees: "${repoRoot}" is not a git repo`),
        {
          haltEnvelope: wrapAsHaltEnvelope('worktree-not-a-git-repo', { repoRoot }),
        }
      );
    }
  }

  // 2. Working tree must be clean.
  {
    const r = git(['status', '--porcelain'], repoRoot);
    if (r.status !== 0) {
      throw Object.assign(
        new Error(`createImplementerWorktrees: git status failed for "${repoRoot}"`),
        {
          haltEnvelope: wrapAsHaltEnvelope('worktree-dirty-before-dispatch', { repoRoot }),
        }
      );
    }
    const out = (r.stdout || '').trim();
    if (out.length > 0) {
      throw Object.assign(
        new Error(`createImplementerWorktrees: repo "${repoRoot}" has uncommitted changes`),
        {
          haltEnvelope: wrapAsHaltEnvelope('worktree-dirty-before-dispatch', { repoRoot, status: out }),
        }
      );
    }
  }
}

function preFlightBaseSha(repoRoot, baseSha) {
  const r = git(['rev-parse', '--verify', `${baseSha}^{commit}`], repoRoot);
  if (r.status !== 0) {
    throw Object.assign(
      new Error(`createImplementerWorktrees: baseSha "${baseSha}" is not a valid commit`),
      {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', {
          detail: 'invalid baseSha',
          baseSha,
        }),
      }
    );
  }
}

function preFlightBranch(repoRoot, branchName) {
  const r = git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoRoot);
  if (r.status === 0) {
    throw Object.assign(
      new Error(`createImplementerWorktrees: branch "${branchName}" already exists`),
      {
        haltEnvelope: wrapAsHaltEnvelope('worktree-create-failed', {
          detail: 'branch collision',
          branchName,
        }),
      }
    );
  }
}

// ── rollback helpers ──────────────────────────────────────────────────────────

function rollbackWorktree(repoRoot, worktreePath, branchName) {
  // Best-effort: ignore errors during rollback.
  try {
    git(['worktree', 'remove', '--force', worktreePath], repoRoot);
  } catch {
    // ignore
  }
  try {
    git(['branch', '-D', branchName], repoRoot);
  } catch {
    // ignore
  }
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Create one git worktree per implementer.
 *
 * @param {{
 *   repoRoot: string,
 *   sliceId: string,
 *   implementers: Array<{memberId: string, adapter: string, model: string}>,
 *   baseSha: string,
 * }} opts
 * @returns {Map<string, {worktreePath: string, branchName: string, baseSha: string}>}
 */
export async function createImplementerWorktrees({ repoRoot, sliceId, implementers, baseSha }) {
  // ── 1. input validation (before any git command) ──────────────────────────
  validateInputs({ repoRoot, sliceId, baseSha, implementers });

  // ── 2. per-implementer path pre-flights (filesystem only, before git checks)
  //    Symlink check must happen before the dirty-tree check so that a
  //    pre-existing symlink at the target path emits `worktree-path-conflict`
  //    rather than `worktree-dirty-before-dispatch`.
  const plan = implementers.map((impl) => {
    const slug = memberIdSlug(impl.memberId);
    const worktreePath = buildWorktreePath(repoRoot, slug);
    const branchName = `implementer/${sliceId}/${slug}`;
    checkNoSymlink(worktreePath);
    return { impl, slug, worktreePath, branchName };
  });

  // ── 3. repo-level pre-flights (git checks) ────────────────────────────────
  preFlightRepo(repoRoot);
  preFlightBaseSha(repoRoot, baseSha);

  // ── 4. per-implementer branch pre-flights ────────────────────────────────
  for (const { branchName } of plan) {
    preFlightBranch(repoRoot, branchName);
  }

  // Ensure parent directory exists.
  const parentDir = resolve(join(repoRoot, WORKTREES_SUBDIR));
  mkdirSync(parentDir, { recursive: true });

  // ── 5. create worktrees (with mid-batch rollback on failure) ──────────────
  const created = []; // { worktreePath, branchName }
  for (const { worktreePath, branchName } of plan) {
    try {
      gitOrThrow(
        ['worktree', 'add', '-b', branchName, worktreePath, baseSha],
        repoRoot,
        'worktree-create-failed',
        `git worktree add failed for branch "${branchName}"`
      );
      created.push({ worktreePath, branchName });
    } catch (err) {
      // Mid-batch failure: rollback all previously created worktrees+branches.
      for (const prev of created) {
        rollbackWorktree(repoRoot, prev.worktreePath, prev.branchName);
      }
      // Re-wrap with the original cause if not already wrapped.
      if (!err.haltEnvelope) {
        err.haltEnvelope = wrapAsHaltEnvelope('worktree-create-failed', { cause: err.message });
      }
      throw err;
    }
  }

  // ── 6. build result map ───────────────────────────────────────────────────
  const result = new Map();
  for (let i = 0; i < plan.length; i++) {
    const { impl, worktreePath, branchName } = plan[i];
    result.set(impl.memberId, { worktreePath, branchName, baseSha });
  }
  return result;
}

/**
 * Clean up implementer worktrees.
 *
 * @param {Map<string, {worktreePath: string, branchName: string}>} worktreeMap
 * @param {{keepForensics?: boolean}} opts
 *   keepForensics=true  → preserve worktrees AND branches (forensic mode)
 *   keepForensics=false → remove worktrees, keep branches
 */
export async function cleanupImplementerWorktrees(worktreeMap, { keepForensics = false } = {}) {
  if (keepForensics) {
    // Preserve everything.
    return;
  }

  // Remove worktrees but keep branches.
  for (const [, { worktreePath, branchName }] of worktreeMap) {
    // Try to find the repoRoot from the worktree path by walking up git dirs.
    // We use the worktreePath parent to find the main repo.
    try {
      // Find the main git worktree's git dir from inside the linked worktree.
      const r = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--git-common-dir'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
      if (r.status === 0) {
        const commonDir = r.stdout.trim();
        // commonDir is either an absolute path or relative to worktreePath.
        const resolvedCommonDir = resolve(worktreePath, commonDir);
        // The repoRoot is the parent of the .git dir (or the dir itself if bare).
        const repoRoot = resolvedCommonDir.endsWith('.git')
          ? resolve(resolvedCommonDir, '..')
          : resolvedCommonDir;

        spawnSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], {
          stdio: 'ignore',
        });
      }
    } catch {
      // Best-effort cleanup.
    }
    void branchName; // branches preserved
  }
}
