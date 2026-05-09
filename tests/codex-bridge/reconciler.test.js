/**
 * reconciler.test.js
 *
 * Tests for v0.7.0 reconciler module. See plan slice 4 + spec §7.
 *
 * Contract:
 *   reconcileWorktree({worktreePath, sliceStartSha, sliceId})
 *   -> {ok:true, commits, head_sha, commit_count, non_conforming_subjects}
 *      | {ok:false, halt:{reason:"reconciler-failed", detail}}
 *
 * Conforming subject regex (per spec §7):
 *   ^(feat|test|fix|docs|refactor|chore)\(slice:<N>\): <description>
 *
 * `<N>` is derived from the `sliceId` parameter (numeric portion). Both
 * `"3"` and `"slice-3"` resolve to `<N>=3`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { reconcileWorktree } from '../../lib/codex-bridge/reconciler.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), 'cps-recon-'));
  const repoRoot = realpathSync(base);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
  return { repoRoot, sha };
}

function commitFile(repoRoot, file, content, msg) {
  writeFileSync(join(repoRoot, file), content);
  execFileSync('git', ['add', file], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repoRoot });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();
}

function cleanup(repoRoot) {
  rmSync(repoRoot, { recursive: true, force: true });
}

// ── empty range ───────────────────────────────────────────────────────────────

test('empty range (HEAD === sliceStartSha) returns no commits', () => {
  const { repoRoot, sha } = makeRepo();
  try {
    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: sha,
      sliceId: 'slice-3',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.commits, []);
    assert.equal(result.commit_count, 0);
    assert.deepEqual(result.non_conforming_subjects, []);
    assert.equal(result.head_sha, sha);
  } finally {
    cleanup(repoRoot);
  }
});

// ── all conforming ────────────────────────────────────────────────────────────

test('all-conforming commits are listed in commits, none non-conforming', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    const sha1 = commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:3): add a');
    const sha2 = commitFile(repoRoot, 'b.txt', 'b', 'test(slice:3): tests for a');
    const sha3 = commitFile(repoRoot, 'c.txt', 'c', 'fix(slice:3): edge case');

    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'slice-3',
    });

    assert.equal(result.ok, true);
    assert.equal(result.commit_count, 3);
    assert.equal(result.head_sha, sha3);
    assert.deepEqual(result.non_conforming_subjects, []);
    assert.equal(result.commits.length, 3);
    // oldest → newest
    assert.equal(result.commits[0].sha, sha1);
    assert.equal(result.commits[0].subject, 'feat(slice:3): add a');
    assert.equal(result.commits[1].sha, sha2);
    assert.equal(result.commits[2].sha, sha3);
  } finally {
    cleanup(repoRoot);
  }
});

// ── numeric sliceId works equivalently ────────────────────────────────────────

test('sliceId accepts numeric string form ("3")', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:3): add a');
    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: '3',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.non_conforming_subjects, []);
    assert.equal(result.commit_count, 1);
  } finally {
    cleanup(repoRoot);
  }
});

// ── one non-conforming wrong format ───────────────────────────────────────────

test('non-conforming subject (wrong format) is reported with reason wrong-format', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    const goodSha = commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:3): add a');
    const badSha = commitFile(repoRoot, 'b.txt', 'b', 'wip on b');

    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'slice-3',
    });

    assert.equal(result.ok, true);
    assert.equal(result.commit_count, 2);
    assert.equal(result.non_conforming_subjects.length, 1);
    const nc = result.non_conforming_subjects[0];
    assert.equal(nc.sha, badSha);
    assert.equal(nc.subject, 'wip on b');
    assert.equal(nc.reason, 'wrong-format');
    // Conforming commit is not in the non-conforming list.
    assert.ok(result.non_conforming_subjects.every(x => x.sha !== goodSha));
  } finally {
    cleanup(repoRoot);
  }
});

// ── wrong slice number ────────────────────────────────────────────────────────

test('subject for wrong slice number is non-conforming with reason wrong-slice-number', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    const wrongSha = commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:2): mislabeled');
    const goodSha = commitFile(repoRoot, 'b.txt', 'b', 'feat(slice:3): correct');

    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'slice-3',
    });

    assert.equal(result.ok, true);
    assert.equal(result.commit_count, 2);
    assert.equal(result.non_conforming_subjects.length, 1);
    const nc = result.non_conforming_subjects[0];
    assert.equal(nc.sha, wrongSha);
    assert.equal(nc.subject, 'feat(slice:2): mislabeled');
    assert.equal(nc.reason, 'wrong-slice-number');
    assert.ok(result.non_conforming_subjects.every(x => x.sha !== goodSha));
  } finally {
    cleanup(repoRoot);
  }
});

// ── ordering: oldest → newest ─────────────────────────────────────────────────

test('commits array is ordered oldest → newest', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    const a = commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:3): a');
    const b = commitFile(repoRoot, 'b.txt', 'b', 'feat(slice:3): b');
    const c = commitFile(repoRoot, 'c.txt', 'c', 'feat(slice:3): c');
    const d = commitFile(repoRoot, 'd.txt', 'd', 'feat(slice:3): d');

    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'slice-3',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.commits.map(c => c.sha), [a, b, c, d]);
  } finally {
    cleanup(repoRoot);
  }
});

// ── reconciler failure ────────────────────────────────────────────────────────

test('git failure (bad sliceStartSha) returns {ok:false, halt:reconciler-failed}', () => {
  const { repoRoot } = makeRepo();
  try {
    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: 'deadbeefcafebabe1234567890abcdef12345678',
      sliceId: 'slice-3',
    });
    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'reconciler-failed');
    assert.ok(typeof result.halt.detail === 'string' && result.halt.detail.length > 0);
  } finally {
    cleanup(repoRoot);
  }
});

test('git failure (worktree path does not exist) returns {ok:false, halt:reconciler-failed}', () => {
  const result = reconcileWorktree({
    worktreePath: '/tmp/cps-recon-does-not-exist-zzz',
    sliceStartSha: 'HEAD~1',
    sliceId: 'slice-3',
  });
  assert.equal(result.ok, false);
  assert.equal(result.halt.reason, 'reconciler-failed');
});

// ── shape of non-conforming entries ───────────────────────────────────────────

test('non-conforming entries have shape {sha, subject, reason}', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    commitFile(repoRoot, 'a.txt', 'a', 'feat(slice:3): a');
    commitFile(repoRoot, 'b.txt', 'b', 'wip something'); // wrong-format
    commitFile(repoRoot, 'c.txt', 'c', 'feat(slice:7): wrong number'); // wrong-slice-number

    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'slice-3',
    });

    assert.equal(result.ok, true);
    assert.equal(result.non_conforming_subjects.length, 2);
    for (const nc of result.non_conforming_subjects) {
      assert.ok(typeof nc.sha === 'string' && nc.sha.length === 40);
      assert.ok(typeof nc.subject === 'string');
      assert.ok(['wrong-format', 'wrong-slice-number'].includes(nc.reason));
    }
    const reasons = result.non_conforming_subjects.map(x => x.reason).sort();
    assert.deepEqual(reasons, ['wrong-format', 'wrong-slice-number']);
  } finally {
    cleanup(repoRoot);
  }
});

// ── invalid sliceId ───────────────────────────────────────────────────────────

test('sliceId without a numeric component fails as reconciler-failed', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    const result = reconcileWorktree({
      worktreePath: repoRoot,
      sliceStartSha: startSha,
      sliceId: 'not-a-slice',
    });
    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'reconciler-failed');
  } finally {
    cleanup(repoRoot);
  }
});
