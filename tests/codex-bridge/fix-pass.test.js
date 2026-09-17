import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
