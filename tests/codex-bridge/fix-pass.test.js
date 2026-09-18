import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFixPass } from '../../lib/codex-bridge/fix-pass.js';
import { initSidecar, loadSidecar } from '../../lib/codex-bridge/sidecar.js';

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cps-fix-pass-'));
  git(repoRoot, 'init', '-q', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'test@example.com');
  git(repoRoot, 'config', 'user.name', 'Test');
  writeFileSync(join(repoRoot, '.gitignore'), '.superpowers-codex-paired/\n');
  writeFileSync(join(repoRoot, 'implementation.txt'), 'base\n');
  const specPath = join(repoRoot, 'spec.md');
  writeFileSync(specPath, '# spec\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-qm', 'feat(slice:3): implementation');
  initSidecar(specPath, { feature: 'fix', codexSession: 't', model: 'gpt-6-astra', reasoningEffort: 'high' });
  return { repoRoot, specPath, implementationSha: git(repoRoot, 'rev-parse', 'HEAD') };
}

function commit(repoRoot, subject, content = subject) {
  writeFileSync(join(repoRoot, 'implementation.txt'), `${content}\n`);
  git(repoRoot, 'add', 'implementation.txt');
  git(repoRoot, 'commit', '-qm', subject);
}

function fixEntries(specPath) {
  return loadSidecar(specPath).slice_reviews['slice-3'].phases['review-slice'].fix_passes;
}

test('successful fix pass returns reconciled fix-only commits and records its checkpoint', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async ({ fix_start_sha }) => {
      assert.equal(fix_start_sha, implementationSha);
      commit(repoRoot, 'fix(slice:3): resolve blocker');
      return { statusFile: { exit_code: 0 } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fix_start_sha, implementationSha);
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].subject, 'fix(slice:3): resolve blocker');
  assert.deepEqual(
    { pass: fixEntries(specPath)[0].pass, fix_start_sha: fixEntries(specPath)[0].fix_start_sha },
    { pass: 1, fix_start_sha: implementationSha },
  );
  rmSync(repoRoot, { recursive: true, force: true });
});

test('thrown execution keeps the checkpoint, resets only pass work, and preserves prior implementation', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const kept = join(repoRoot, 'preexisting.tmp');
  const removed = join(repoRoot, 'created-by-pass.tmp');
  writeFileSync(kept, 'keep');
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => { writeFileSync(removed, 'remove'); throw new Error('boom'); },
  });
  assert.deepEqual(result, { ok: false, reason: 'exec-failed', reset_to: implementationSha });
  assert.equal(git(repoRoot, 'rev-parse', 'HEAD'), implementationSha);
  assert.match(git(repoRoot, 'log', '-1', '--format=%s'), /^feat\(slice:3\): implementation$/);
  assert.equal(existsSync(removed), false);
  assert.equal(readFileSync(kept, 'utf8'), 'keep');
  assert.equal(fixEntries(specPath)[0].outcome, 'failed');
  rmSync(repoRoot, { recursive: true, force: true });
});

// v0.19.0 review deferred finding D1: existsSync follows symlinks, so a DANGLING link the failed
// pass created read as absent and survived the rollback. Checks use lstatSync, which sees the link.
test('failed pass that created a dangling untracked symlink: rollback removes the link itself', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const link = join(repoRoot, 'nested', 'dangling-link');
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      mkdirSync(join(repoRoot, 'nested'));
      symlinkSync(join(repoRoot, 'no-such-target'), link);
      throw new Error('boom');
    },
  });
  assert.deepEqual(result, { ok: false, reason: 'exec-failed', reset_to: implementationSha });
  assert.throws(() => lstatSync(link), { code: 'ENOENT' }, 'dangling symlink must not survive rollback');
  assert.equal(existsSync(join(repoRoot, 'nested')), false, 'emptied parent directory is removed too');
  assert.equal(git(repoRoot, 'status', '--porcelain', '--untracked-files=all'), '');
  rmSync(repoRoot, { recursive: true, force: true });
});

test('zero-commit pass fails and resets to the checkpoint', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const result = await runFixPass({ specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => ({ statusFile: { exit_code: 0 } }) });
  assert.deepEqual(result, { ok: false, reason: 'zero-commits', reset_to: implementationSha });
  rmSync(repoRoot, { recursive: true, force: true });
});

for (const subject of ['wip', 'feat(slice:3): not a fix pass']) {
  test(`non-fix commit ${JSON.stringify(subject)} fails the pass`, async () => {
    const { repoRoot, specPath, implementationSha } = makeRepo();
    const result = await runFixPass({ specPath, sliceId: 'slice-3', repoRoot, pass: 1,
      execFn: async () => { commit(repoRoot, subject); return { statusFile: { exit_code: 0 } }; } });
    assert.deepEqual(result, { ok: false, reason: 'non-conforming-commits', reset_to: implementationSha });
    assert.equal(git(repoRoot, 'rev-parse', 'HEAD'), implementationSha);
    rmSync(repoRoot, { recursive: true, force: true });
  });
}

test('structured reconciler failure becomes a failed pass without a property-access crash', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => ({ statusFile: { exit_code: 0 } }),
    _deps: { reconcile: () => ({ ok: false, halt: { reason: 'reconciler-failed', detail: 'x' } }) },
  });
  assert.deepEqual(result, { ok: false, reason: 'reconciler-failed', reset_to: implementationSha });
  assert.equal(fixEntries(specPath)[0].detail, 'x');
  rmSync(repoRoot, { recursive: true, force: true });
});

test('configuration error is terminal and leaves pass changes untouched', async () => {
  const { repoRoot, specPath } = makeRepo();
  const changed = join(repoRoot, 'implementation.txt');
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      writeFileSync(changed, 'uncommitted fix\n');
      return { statusFile: { exit_code: 78, error: 'model-role-resolution-failed' } };
    },
  });
  assert.deepEqual(result, { ok: false, terminal: true, haltReason: 'model-role-resolution-failed' });
  assert.equal(readFileSync(changed, 'utf8'), 'uncommitted fix\n');
  rmSync(repoRoot, { recursive: true, force: true });
});

test('nonzero execution status is a failed pass', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  const result = await runFixPass({ specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => ({ statusFile: { exit_code: 1 } }) });
  assert.deepEqual(result, { ok: false, reason: 'nonzero-exit', reset_to: implementationSha });
  rmSync(repoRoot, { recursive: true, force: true });
});

test('reset failure throws fix-pass-reset-failed with halt detail', async () => {
  const { repoRoot, specPath } = makeRepo();
  await assert.rejects(
    runFixPass({
      specPath, sliceId: 'slice-3', repoRoot, pass: 1,
      execFn: async () => ({ statusFile: { exit_code: 1 } }),
      _deps: { reset: () => ({ ok: false, halt: { reason: 'worktree-reset-failed', detail: 'cannot reset' } }) },
    }),
    (error) => error.code === 'fix-pass-reset-failed' && /cannot reset/.test(error.message),
  );
  rmSync(repoRoot, { recursive: true, force: true });
});

// v0.16.0 fix (Codex review-slice:slice-3 round 1): a pre-existing untracked file that the failed
// pass staged/committed must survive the rollback with its original contents.
test('failed pass that committed a pre-existing untracked file: rollback keeps the file and its contents', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'my notes\n'); // untracked before the pass
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      git(repoRoot, 'add', 'notes.txt');
      git(repoRoot, 'commit', '-qm', 'wip'); // non-conforming subject → failed pass
      return { statusFile: { exit_code: 0 } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'non-conforming-commits');
  assert.equal(git(repoRoot, 'rev-parse', 'HEAD'), implementationSha);
  assert.ok(existsSync(join(repoRoot, 'notes.txt')), 'pre-existing untracked file must survive rollback');
  assert.equal(readFileSync(join(repoRoot, 'notes.txt'), 'utf8'), 'my notes\n');
  assert.match(git(repoRoot, 'status', '--porcelain'), /\?\? notes\.txt/);
  rmSync(repoRoot, { recursive: true, force: true });
});

// Codex review-slice:slice-3 round 2: contents must be captured BEFORE the pass runs.
test('failed pass that modified and staged a pre-existing untracked file: rollback restores the ORIGINAL contents', async () => {
  const { repoRoot, specPath, implementationSha } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'original user notes\n');
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      writeFileSync(join(repoRoot, 'notes.txt'), 'failed pass replacement\n');
      git(repoRoot, 'add', 'notes.txt');
      git(repoRoot, 'commit', '-qm', 'wip');
      return { statusFile: { exit_code: 0 } };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(git(repoRoot, 'rev-parse', 'HEAD'), implementationSha);
  assert.equal(readFileSync(join(repoRoot, 'notes.txt'), 'utf8'), 'original user notes\n');
  assert.match(git(repoRoot, 'status', '--porcelain'), /\?\? notes\.txt/);
  rmSync(repoRoot, { recursive: true, force: true });
});

test('failed pass that modified (unstaged) or deleted pre-existing untracked files: rollback restores both', async () => {
  const { repoRoot, specPath } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'original\n');
  writeFileSync(join(repoRoot, 'scratch.txt'), 'keep me\n');
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      writeFileSync(join(repoRoot, 'notes.txt'), 'mutated without staging\n');
      rmSync(join(repoRoot, 'scratch.txt'));
      throw new Error('boom');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exec-failed');
  assert.equal(readFileSync(join(repoRoot, 'notes.txt'), 'utf8'), 'original\n');
  assert.equal(readFileSync(join(repoRoot, 'scratch.txt'), 'utf8'), 'keep me\n');
  rmSync(repoRoot, { recursive: true, force: true });
});

// Codex review-slice:slice-3 round 3: no size cap — a large file is preserved too, and many files
// do not accumulate in memory (disk-backed copies).
test('failed pass: a >8 MiB pre-existing untracked file and 100 small ones are all restored', async () => {
  const { repoRoot, specPath } = makeRepo();
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x41);
  writeFileSync(join(repoRoot, 'big.bin'), big);
  for (let i = 0; i < 100; i += 1) writeFileSync(join(repoRoot, `n${i}.txt`), `note ${i}\n`);
  const b = process.memoryUsage();
  const before = b.heapUsed + b.external + b.arrayBuffers;
  const result = await runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => {
      writeFileSync(join(repoRoot, 'big.bin'), 'clobbered');
      git(repoRoot, 'add', 'big.bin', 'n0.txt');
      git(repoRoot, 'commit', '-qm', 'wip');
      for (let i = 1; i < 100; i += 1) rmSync(join(repoRoot, `n${i}.txt`));
      return { statusFile: { exit_code: 0 } };
    },
  });
  const after = process.memoryUsage();
  const grew = (after.heapUsed + after.external + after.arrayBuffers) - before;
  assert.ok(grew < 8 * 1024 * 1024, `snapshot must not buffer file contents in process memory (grew ${grew} bytes incl. external/arrayBuffers)`);
  assert.equal(result.ok, false);
  const restored = readFileSync(join(repoRoot, 'big.bin'));
  assert.equal(restored.length, big.length);
  assert.ok(restored.equals(big), 'large file restored byte-for-byte');
  for (let i = 0; i < 100; i += 1) {
    assert.equal(readFileSync(join(repoRoot, `n${i}.txt`), 'utf8'), `note ${i}\n`);
  }
  assert.equal(existsSync(fixEntries(specPath)[0].snapshot_dir), false, 'snapshot dir removed after a completed rollback');
  rmSync(repoRoot, { recursive: true, force: true });
});

// Codex review-slice:slice-3 round 4: recovery copies must survive an incomplete rollback.
test('restore failure during rollback keeps the recovery copies on disk and names them', async () => {
  const { repoRoot, specPath } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'irreplaceable\n');
  let err;
  let restoring = false;
  try {
    await runFixPass({
      specPath, sliceId: 'slice-3', repoRoot, pass: 1,
      // capture succeeds (before the pass); the RESTORE copy (after the pass) fails
      execFn: async () => { restoring = true; rmSync(join(repoRoot, 'notes.txt')); throw new Error('boom'); },
      _deps: { copyFile: (src, dst) => { if (restoring) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } writeFileSync(dst, readFileSync(src)); } },
    });
  } catch (e) { err = e; }
  assert.ok(err, 'restore failure must surface');
  assert.equal(err.code, 'fix-pass-restore-failed');
  assert.ok(existsSync(err.snapshot_dir), 'snapshot directory retained');
  assert.deepEqual(err.snapshot_files, ['notes.txt']);
  const copies = readdirSync(err.snapshot_dir);
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(err.snapshot_dir, copies[0]), 'utf8'), 'irreplaceable\n');
  const entry = fixEntries(specPath)[0];
  assert.equal(entry.snapshot_retained, true);
  assert.equal(entry.snapshot_dir, err.snapshot_dir);
  rmSync(err.snapshot_dir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

test('reset failure also retains the recovery copies', async () => {
  const { repoRoot, specPath } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'keep\n');
  let err;
  try {
    await runFixPass({
      specPath, sliceId: 'slice-3', repoRoot, pass: 1,
      execFn: async () => ({ statusFile: { exit_code: 1 } }),
      _deps: { reset: () => ({ ok: false, halt: { reason: 'worktree-reset-failed', detail: 'nope' } }) },
    });
  } catch (e) { err = e; }
  assert.equal(err.code, 'fix-pass-reset-failed');
  assert.ok(existsSync(err.snapshot_dir));
  rmSync(err.snapshot_dir, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

test('checkpoint persistence failure before the pass runs cleans up the snapshot and never launches', async () => {
  const { repoRoot } = makeRepo();
  writeFileSync(join(repoRoot, 'notes.txt'), 'x\n');
  let launched = false;
  const snapshotDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('cps-fix-pass-snapshot-')).length;
  const dirsBefore = snapshotDirs();
  await assert.rejects(() => runFixPass({
    specPath: join(repoRoot, 'no-such-spec.md'), // no sidecar → appendFixPass throws
    sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => { launched = true; return { statusFile: { exit_code: 0 } }; },
  }));
  assert.equal(launched, false);
  assert.equal(snapshotDirs(), dirsBefore, 'pre-execution failure must not leak its snapshot directory');
  rmSync(repoRoot, { recursive: true, force: true });
});

// Codex review-slice:slice-3 round 5: a copy failure while capturing must not leak partial backups.
test('snapshot capture failure (second copy fails) cleans up the partial directory and never launches', async () => {
  const { repoRoot, specPath } = makeRepo();
  writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
  writeFileSync(join(repoRoot, 'b.txt'), 'b\n');
  const snapshotDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('cps-fix-pass-snapshot-')).length;
  const dirsBefore = snapshotDirs();
  let launched = false;
  let calls = 0;
  await assert.rejects(() => runFixPass({
    specPath, sliceId: 'slice-3', repoRoot, pass: 1,
    execFn: async () => { launched = true; return { statusFile: { exit_code: 0 } }; },
    _deps: { copyFile: (src, dst) => { calls += 1; if (calls === 2) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } writeFileSync(dst, readFileSync(src)); } },
  }), /ENOSPC/);
  assert.equal(launched, false);
  assert.equal(snapshotDirs(), dirsBefore, 'partial snapshot directory must be removed');
  assert.equal(readFileSync(join(repoRoot, 'a.txt'), 'utf8'), 'a\n');
  rmSync(repoRoot, { recursive: true, force: true });
});
