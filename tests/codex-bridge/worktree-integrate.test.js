/**
 * worktree-integrate.test.js
 *
 * Tests for v0.7.0 ordered cherry-pick integration with patch-id resume.
 * See plan slice 6 + spec §12.
 *
 * Contract:
 *   integrate({repoRoot, integrationBranch, slices:[{sliceId, branchName, sliceStartSha}]})
 *   -> {ok:true, head_sha, commit_count, resumed_slices:[...]}
 *    | {ok:false, halt:{reason, detail}}
 *
 * Halt reasons:
 *   - worktree-integration-empty   — empty source range for a slice (broken invariant).
 *   - worktree-merge-conflict      — git cherry-pick failed; aborted; conflicting paths included.
 *   - worktree-resume-ambiguous    — partial/order-broken patch-id match on integration branch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { integrate } from '../../lib/codex-bridge/worktree-integrate.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function git(repoRoot, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...opts,
  });
}

function makeRepo() {
  const base = mkdtempSync(join(tmpdir(), 'cps-integ-'));
  const repoRoot = realpathSync(base);
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  // Initial commit on `main`.
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-q', '-m', 'init']);
  const sha = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  return { repoRoot, sha };
}

function commitOn(repoRoot, branch, file, content, msg) {
  git(repoRoot, ['checkout', '-q', branch]);
  writeFileSync(join(repoRoot, file), content);
  git(repoRoot, ['add', file]);
  git(repoRoot, ['commit', '-q', '-m', msg]);
  return git(repoRoot, ['rev-parse', 'HEAD']).trim();
}

function makeBranchAt(repoRoot, branch, atSha) {
  git(repoRoot, ['branch', branch, atSha]);
}

function checkoutBranch(repoRoot, branch) {
  git(repoRoot, ['checkout', '-q', branch]);
}

function rev(repoRoot, ref) {
  return git(repoRoot, ['rev-parse', ref]).trim();
}

function subjectOf(repoRoot, ref) {
  return git(repoRoot, ['log', '-1', '--format=%s', ref]).trim();
}

function countCommits(repoRoot, range) {
  const out = git(repoRoot, ['rev-list', '--count', range]).trim();
  return Number(out);
}

function cleanup(repoRoot) {
  rmSync(repoRoot, { recursive: true, force: true });
}

// ── test 1: single slice, normal cherry-pick ──────────────────────────────────

test('single slice: cherry-picks all commits onto integration branch', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    // integration branch = "integration", same starting point.
    makeBranchAt(repoRoot, 'integration', startSha);
    // slice-3 branch off startSha with 2 commits.
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');
    commitOn(repoRoot, 'slice-3-impl', 'b.txt', 'b', 'test(slice:3): cover a');
    const sliceTip = rev(repoRoot, 'slice-3-impl');

    // Switch to integration so worktree state is consistent.
    checkoutBranch(repoRoot, 'integration');
    const beforeHead = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.commit_count, 2);
    assert.deepEqual(result.resumed_slices, []);
    // integration HEAD advanced by 2 commits.
    const afterHead = rev(repoRoot, 'integration');
    assert.notEqual(afterHead, beforeHead);
    assert.equal(result.head_sha, afterHead);
    assert.equal(countCommits(repoRoot, `${startSha}..integration`), 2);
    // Subjects preserved on cherry-pick.
    const subjects = git(repoRoot, ['log', '--reverse', '--format=%s', `${startSha}..integration`])
      .trim().split('\n');
    assert.deepEqual(subjects, ['feat(slice:3): add a', 'test(slice:3): cover a']);
    // Cherry-pick reproduces the slice's CONTENT onto integration: the integrated tree equals the
    // slice tip's tree. (We assert tree equivalence, NOT SHA inequality: when integration shares the
    // slice's base and the cherry-picked commits land within the same 1-second git-timestamp window,
    // the resulting commit SHA can legitimately equal sliceTip — correct git behavior, not a merge.
    // The old `notEqual(afterHead, sliceTip)` was a wall-clock-second race and flaked on fast/loaded
    // machines.)
    assert.equal(
      git(repoRoot, ['rev-parse', `${afterHead}^{tree}`]).trim(),
      git(repoRoot, ['rev-parse', `${sliceTip}^{tree}`]).trim(),
      'integrated tree must equal the slice tip tree (cherry-pick preserves content)',
    );
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 2: empty range halts ─────────────────────────────────────────────────

test('empty source range halts with worktree-integration-empty', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    // slice branch has no commits beyond startSha.
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    checkoutBranch(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'worktree-integration-empty');
    assert.ok(result.halt.detail);
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 3: cherry-pick conflict ──────────────────────────────────────────────

test('cherry-pick conflict halts with worktree-merge-conflict and aborts', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    // slice branch modifies conflict.txt.
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'conflict.txt', 'slice-version\n', 'feat(slice:3): add conflict file');
    // integration also creates conflict.txt with different content.
    checkoutBranch(repoRoot, 'integration');
    writeFileSync(join(repoRoot, 'conflict.txt'), 'integration-version\n');
    git(repoRoot, ['add', 'conflict.txt']);
    git(repoRoot, ['commit', '-q', '-m', 'chore: integration version of conflict.txt']);
    const integrationHeadBefore = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'worktree-merge-conflict');
    assert.equal(result.halt.detail.slice_id, 'slice-3');
    assert.equal(result.halt.detail.branch_name, 'slice-3-impl');
    assert.ok(Array.isArray(result.halt.detail.conflicting_paths));
    assert.ok(result.halt.detail.conflicting_paths.includes('conflict.txt'));
    // cherry-pick must have been aborted: working tree clean, no CHERRY_PICK_HEAD.
    const status = git(repoRoot, ['status', '--porcelain']).trim();
    assert.equal(status, '');
    // integration HEAD unchanged (abort rolls back).
    assert.equal(rev(repoRoot, 'integration'), integrationHeadBefore);
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 4: full resume — already integrated ──────────────────────────────────

test('resume: full match — slice already on integration branch — returns resumed_slices', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');
    commitOn(repoRoot, 'slice-3-impl', 'b.txt', 'b', 'test(slice:3): cover a');

    // Pre-cherry-pick onto integration to simulate prior integration.
    checkoutBranch(repoRoot, 'integration');
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl~1')]);
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl')]);
    const headBefore = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.resumed_slices, ['slice-3']);
    assert.equal(result.head_sha, headBefore);
    // commit_count is total commits resumed/picked. resumed counts as 0 newly
    // applied commits → integration unchanged, so we expect commit_count=0.
    assert.equal(result.commit_count, 0);
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 5: no match — cherry-pick proceeds ──────────────────────────────────

test('resume: no match — cherry-picks normally', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    // integration has unrelated history.
    checkoutBranch(repoRoot, 'integration');
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'unrelated\n');
    git(repoRoot, ['add', 'unrelated.txt']);
    git(repoRoot, ['commit', '-q', '-m', 'chore: unrelated work']);

    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');

    checkoutBranch(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.resumed_slices, []);
    assert.equal(result.commit_count, 1);
    assert.equal(subjectOf(repoRoot, 'integration'), 'feat(slice:3): add a');
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 6: partial match — ambiguous ─────────────────────────────────────────

test('resume: partial match (1 of 2) halts with worktree-resume-ambiguous', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');
    commitOn(repoRoot, 'slice-3-impl', 'b.txt', 'b', 'test(slice:3): cover a');

    // Cherry-pick only the first source commit onto integration.
    checkoutBranch(repoRoot, 'integration');
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl~1')]);
    const headBefore = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'worktree-resume-ambiguous');
    const d = result.halt.detail;
    assert.equal(d.slice_id, 'slice-3');
    assert.equal(d.branch_name, 'slice-3-impl');
    assert.ok(Array.isArray(d.integrated_subjects));
    assert.ok(Array.isArray(d.missing_subjects));
    assert.ok(d.integrated_subjects.includes('feat(slice:3): add a'));
    assert.ok(d.missing_subjects.includes('test(slice:3): cover a'));
    assert.equal(d.integration_branch_head, headBefore);
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 7: same subject + different patch-id → not integrated ────────────────

test('resume: same subject but different patch-id is treated as not integrated', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);
    // integration has a commit with the same subject but different content
    // (different patch-id).
    checkoutBranch(repoRoot, 'integration');
    writeFileSync(join(repoRoot, 'a.txt'), 'different-content\n');
    git(repoRoot, ['add', 'a.txt']);
    git(repoRoot, ['commit', '-q', '-m', 'feat(slice:3): add a']);

    // Slice branch's own version of "feat(slice:3): add a".
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'slice-content\n', 'feat(slice:3): add a');

    checkoutBranch(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    // Same subject, different patch-id. Should treat as NOT integrated and
    // attempt cherry-pick. Cherry-pick will conflict because integration also
    // modified a.txt — so we expect worktree-merge-conflict (NOT
    // resume-ambiguous and NOT a successful resume).
    assert.equal(result.ok, false);
    assert.equal(result.halt.reason, 'worktree-merge-conflict');
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 8: multi-slice — slice-3 resumed, slice-5 cherry-picked ──────────────

test('multi-slice: one resumed, one cherry-picked normally', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);

    // slice-3-impl has 1 commit; pre-cherry-pick onto integration.
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');
    checkoutBranch(repoRoot, 'integration');
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl')]);

    // slice-5-impl branched from same startSha (independent file). Has 1 commit, NOT yet integrated.
    makeBranchAt(repoRoot, 'slice-5-impl', startSha);
    commitOn(repoRoot, 'slice-5-impl', 'c.txt', 'c', 'feat(slice:5): add c');

    checkoutBranch(repoRoot, 'integration');
    const headBeforeSlice5 = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
        { sliceId: 'slice-5', branchName: 'slice-5-impl', sliceStartSha: startSha },
      ],
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.resumed_slices, ['slice-3']);
    assert.equal(result.commit_count, 1); // only slice-5 actually applied.
    // integration HEAD advanced by 1 (the slice-5 cherry-pick).
    const afterHead = rev(repoRoot, 'integration');
    assert.notEqual(afterHead, headBeforeSlice5);
    assert.equal(subjectOf(repoRoot, afterHead), 'feat(slice:5): add c');
  } finally {
    cleanup(repoRoot);
  }
});

// ── test 9: merge commit in scan window does not break resume detection ───────

test('resume: merge commits in scan window are skipped (merge precedes slice tuples)', () => {
  const { repoRoot, sha: startSha } = makeRepo();
  try {
    makeBranchAt(repoRoot, 'integration', startSha);

    // Build a merge commit on integration BEFORE cherry-picking the slice.
    // Result: integration history (newest→oldest) is
    //   [test(slice:3): cover a, feat(slice:3): add a, merge, side-work, init]
    // The merge sits between the slice tuples and the older history. Resume
    // detection must skip the merge while still seeing the slice tuples as
    // the trailing non-merge subsequence.
    git(repoRoot, ['checkout', '-q', '-b', 'side', startSha]);
    writeFileSync(join(repoRoot, 'side.txt'), 'side\n');
    git(repoRoot, ['add', 'side.txt']);
    git(repoRoot, ['commit', '-q', '-m', 'chore: side work']);
    checkoutBranch(repoRoot, 'integration');
    git(repoRoot, ['merge', '--no-ff', '-m', 'merge: bring in side branch', 'side']);

    // Slice branch off startSha.
    makeBranchAt(repoRoot, 'slice-3-impl', startSha);
    commitOn(repoRoot, 'slice-3-impl', 'a.txt', 'a', 'feat(slice:3): add a');
    commitOn(repoRoot, 'slice-3-impl', 'b.txt', 'b', 'test(slice:3): cover a');

    // Pre-cherry-pick onto integration AFTER the merge.
    checkoutBranch(repoRoot, 'integration');
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl~1')]);
    git(repoRoot, ['cherry-pick', rev(repoRoot, 'slice-3-impl')]);
    const headBefore = rev(repoRoot, 'integration');

    const result = integrate({
      repoRoot,
      integrationBranch: 'integration',
      slices: [
        { sliceId: 'slice-3', branchName: 'slice-3-impl', sliceStartSha: startSha },
      ],
    });

    // Resume detection must skip the merge and find the slice tuples as the
    // trailing non-merge subsequence of the scan window.
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.resumed_slices, ['slice-3']);
    assert.equal(rev(repoRoot, 'integration'), headBefore);
  } finally {
    cleanup(repoRoot);
  }
});
