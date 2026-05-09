/**
 * worktree.test.js
 *
 * Tests for v0.7.0 worktree primitives. See plan slice 2 + spec §8 (bootstrap
 * rules) and §11 (worktree lifecycle).
 *
 * Primitives covered:
 *   - create(repoRoot, sliceId, sliceStartSha)
 *   - bootstrap(repoRoot, worktreePath, symlinks)
 *   - verifyBootstrap(worktreePath, recordedSymlinks)
 *   - reset(worktreePath, sliceStartSha)
 *   - remove(repoRoot, worktreePath)
 *   - removeBranch(repoRoot, branchName)
 *
 * Halt return shape: `{ok:false, halt:{reason, detail}}`.
 * Success return shape: `{ok:true, ...payload}`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync,
  symlinkSync, lstatSync, readlinkSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  create,
  bootstrap,
  verifyBootstrap,
  reset,
  remove,
  removeBranch,
} from '../../lib/codex-bridge/worktree.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Make a fresh git repo with .gitignore (containing `.git-worktrees/`) and an
 * initial commit. Returns `{repoRoot, sha}`.
 */
function makeRepo({ gitignoreWorktrees = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cps-wt-'));
  const repoRoot = realpathSync(base);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot });

  if (gitignoreWorktrees) {
    writeFileSync(join(repoRoot, '.gitignore'), '.git-worktrees/\n');
  } else {
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n');
  }
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  return { repoRoot, sha };
}

function cleanupRepo(repoRoot) {
  // Remove worktrees first (to clear any administrative refs in main repo)
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot });
  } catch { /* ignore */ }
  rmSync(repoRoot, { recursive: true, force: true });
}

// Make an extra commit on the repo's HEAD; returns new sha
function commitFile(repoRoot, file, content, msg) {
  writeFileSync(join(repoRoot, file), content);
  execFileSync('git', ['add', file], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repoRoot });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

// ── create ────────────────────────────────────────────────────────────────────

test('create: succeeds and returns worktree path with branch <slice-id>-impl', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const r = create(repoRoot, 'slice-3', sha);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.worktreePath, join(repoRoot, '.git-worktrees', 'slice-3'));
    assert.equal(r.branchName, 'slice-3-impl');
    assert.ok(existsSync(r.worktreePath));
    // branch exists
    const branches = execFileSync('git', ['branch', '--list', 'slice-3-impl'], { cwd: repoRoot })
      .toString();
    assert.match(branches, /slice-3-impl/);
    // worktree HEAD == sha
    const wtHead = execFileSync('git', ['-C', r.worktreePath, 'rev-parse', 'HEAD'])
      .toString().trim();
    assert.equal(wtHead, sha);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('create: halts worktree-gitignore-missing when .git-worktrees/ not gitignored', () => {
  const { repoRoot, sha } = makeRepo({ gitignoreWorktrees: false });
  try {
    const r = create(repoRoot, 'slice-1', sha);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-gitignore-missing');
    assert.match(r.halt.detail || '', /\.git-worktrees/);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('create: halts worktree-gitignore-missing when .gitignore is absent entirely', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    rmSync(join(repoRoot, '.gitignore'));
    // Need a commit reflecting the removal so we have a clean tree, but the
    // gitignore file is the artifact we actually check; a missing file is the
    // condition under test.
    const r = create(repoRoot, 'slice-1', sha);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-gitignore-missing');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('create: halts worktree-path-conflict when path exists as a non-worktree directory', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, '.git-worktrees', 'slice-1'), { recursive: true });
    writeFileSync(join(repoRoot, '.git-worktrees', 'slice-1', 'random.txt'), 'hi');
    const r = create(repoRoot, 'slice-1', sha);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-path-conflict');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('create: halts worktree-create-failed when sha is invalid', () => {
  const { repoRoot } = makeRepo();
  try {
    const r = create(repoRoot, 'slice-9', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-create-failed');
    assert.ok(r.halt.detail && r.halt.detail.length > 0);
  } finally {
    cleanupRepo(repoRoot);
  }
});

// ── bootstrap ─────────────────────────────────────────────────────────────────

test('bootstrap: creates symlinks for required entries when source exists', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'node_modules', 'pkg.txt'), 'x');
    const c = create(repoRoot, 'slice-1', sha);
    assert.equal(c.ok, true);
    const r = bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    const linkPath = join(c.worktreePath, 'node_modules');
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath), join(repoRoot, 'node_modules'));
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: skips silently when required:false source is absent', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const r = bootstrap(repoRoot, c.worktreePath, [
      { path: 'node_modules', required: false },
      { path: '.venv', required: false },
    ]);
    assert.equal(r.ok, true);
    // No symlinks created at either path.
    assert.equal(existsSync(join(c.worktreePath, 'node_modules')), false);
    assert.equal(existsSync(join(c.worktreePath, '.venv')), false);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: halts worktree-bootstrap-failed when required source is absent', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const r = bootstrap(repoRoot, c.worktreePath, [{ path: 'custom_dir', required: true }]);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-bootstrap-failed');
    assert.match(r.halt.detail || '', /custom_dir/);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: idempotent when target is already the correct symlink', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    const c = create(repoRoot, 'slice-1', sha);
    const r1 = bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    assert.equal(r1.ok, true);
    const r2 = bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    assert.equal(r2.ok, true);
    assert.equal(lstatSync(join(c.worktreePath, 'node_modules')).isSymbolicLink(), true);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: halts when target exists but is a regular file', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    const c = create(repoRoot, 'slice-1', sha);
    writeFileSync(join(c.worktreePath, 'node_modules'), 'a regular file');
    const r = bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-bootstrap-failed');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: halts when target exists but is a symlink to the wrong target', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    mkdirSync(join(repoRoot, 'somewhere_else'));
    const c = create(repoRoot, 'slice-1', sha);
    symlinkSync(join(repoRoot, 'somewhere_else'), join(c.worktreePath, 'node_modules'));
    const r = bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-bootstrap-failed');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('bootstrap: handles empty symlink list as ok', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const r = bootstrap(repoRoot, c.worktreePath, []);
    assert.equal(r.ok, true);
  } finally {
    cleanupRepo(repoRoot);
  }
});

// ── verifyBootstrap ───────────────────────────────────────────────────────────

test('verifyBootstrap: ok when all recorded symlinks are present and resolve correctly', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    const c = create(repoRoot, 'slice-1', sha);
    bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    const v = verifyBootstrap(c.worktreePath, [{ path: 'node_modules', required: true }], repoRoot);
    assert.deepEqual(v, { ok: true });
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('verifyBootstrap: reports missing entries', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const v = verifyBootstrap(c.worktreePath, [{ path: 'node_modules', required: true }], repoRoot);
    assert.equal(v.ok, false);
    assert.equal(v.failed.length, 1);
    assert.equal(v.failed[0].symlink, 'node_modules');
    assert.equal(v.failed[0].reason, 'missing');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('verifyBootstrap: reports not-a-symlink when target is a regular file/dir', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    mkdirSync(join(c.worktreePath, 'node_modules'));
    const v = verifyBootstrap(c.worktreePath, [{ path: 'node_modules', required: true }], repoRoot);
    assert.equal(v.ok, false);
    assert.equal(v.failed.length, 1);
    assert.equal(v.failed[0].reason, 'not-a-symlink');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('verifyBootstrap: reports wrong-target with expected/actual', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'somewhere_else'));
    const c = create(repoRoot, 'slice-1', sha);
    symlinkSync(join(repoRoot, 'somewhere_else'), join(c.worktreePath, 'node_modules'));
    const v = verifyBootstrap(c.worktreePath, [{ path: 'node_modules', required: true }], repoRoot);
    assert.equal(v.ok, false);
    assert.equal(v.failed[0].reason, 'wrong-target');
    assert.equal(v.failed[0].expected, join(repoRoot, 'node_modules'));
    assert.equal(v.failed[0].actual, join(repoRoot, 'somewhere_else'));
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('verifyBootstrap: aggregates multiple failures', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    mkdirSync(join(c.worktreePath, '.venv')); // not a symlink
    const v = verifyBootstrap(
      c.worktreePath,
      [
        { path: 'node_modules', required: true }, // missing
        { path: '.venv',        required: true }, // not-a-symlink
      ],
      repoRoot,
    );
    assert.equal(v.ok, false);
    assert.equal(v.failed.length, 2);
    const reasons = v.failed.map(f => f.reason).sort();
    assert.deepEqual(reasons, ['missing', 'not-a-symlink']);
  } finally {
    cleanupRepo(repoRoot);
  }
});

// ── reset ─────────────────────────────────────────────────────────────────────

test('reset: hard-resets to slice_start_sha and preserves untracked symlinks', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    mkdirSync(join(repoRoot, 'node_modules'));
    const c = create(repoRoot, 'slice-1', sha);
    bootstrap(repoRoot, c.worktreePath, [{ path: 'node_modules', required: true }]);
    // Make a commit in the worktree
    writeFileSync(join(c.worktreePath, 'newfile.txt'), 'extra');
    execFileSync('git', ['-C', c.worktreePath, 'add', 'newfile.txt']);
    execFileSync('git', ['-C', c.worktreePath, 'commit', '-q', '-m', 'extra']);

    const r = reset(c.worktreePath, sha);
    assert.equal(r.ok, true);
    const head = execFileSync('git', ['-C', c.worktreePath, 'rev-parse', 'HEAD']).toString().trim();
    assert.equal(head, sha);
    // Symlink remains because it was untracked
    assert.equal(lstatSync(join(c.worktreePath, 'node_modules')).isSymbolicLink(), true);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('reset: halts worktree-reset-failed on invalid sha', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const r = reset(c.worktreePath, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-reset-failed');
  } finally {
    cleanupRepo(repoRoot);
  }
});

// ── remove ────────────────────────────────────────────────────────────────────

test('remove: removes a clean worktree', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const c = create(repoRoot, 'slice-1', sha);
    const r = remove(repoRoot, c.worktreePath);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(existsSync(c.worktreePath), false);
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('remove: halts worktree-cleanup-failed on unknown path', () => {
  const { repoRoot } = makeRepo();
  try {
    const r = remove(repoRoot, join(repoRoot, '.git-worktrees', 'nonexistent-slice'));
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-cleanup-failed');
  } finally {
    cleanupRepo(repoRoot);
  }
});

// ── removeBranch ──────────────────────────────────────────────────────────────

test('removeBranch: deletes a merged/unmerged branch via -D', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    // Create + remove worktree so branch is detached from any worktree, then
    // delete branch.
    const c = create(repoRoot, 'slice-2', sha);
    const rem = remove(repoRoot, c.worktreePath);
    assert.equal(rem.ok, true);
    const r = removeBranch(repoRoot, 'slice-2-impl');
    assert.equal(r.ok, true);
    const branches = execFileSync('git', ['branch', '--list', 'slice-2-impl'], { cwd: repoRoot })
      .toString();
    assert.equal(branches.trim(), '');
  } finally {
    cleanupRepo(repoRoot);
  }
});

test('removeBranch: halts worktree-branch-cleanup-failed on missing branch', () => {
  const { repoRoot } = makeRepo();
  try {
    const r = removeBranch(repoRoot, 'never-existed-branch');
    assert.equal(r.ok, false);
    assert.equal(r.halt.reason, 'worktree-branch-cleanup-failed');
  } finally {
    cleanupRepo(repoRoot);
  }
});
