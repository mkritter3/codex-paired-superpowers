import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  readMarkers,
  writeOwnershipMarker,
  writePreservationMarker,
} from '../../lib/codex-bridge/checkout-markers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(root, 'lib/codex-bridge/cli.js');

function syntheticWorktree({ relativePointer = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cps-markers-'));
  const worktreePath = join(rootDir, 'checkout');
  const adminDir = join(rootDir, 'common.git', 'worktrees', 'checkout');
  mkdirSync(worktreePath, { recursive: true });
  mkdirSync(adminDir, { recursive: true });
  const pointer = relativePointer ? relative(worktreePath, adminDir) : adminDir;
  writeFileSync(join(worktreePath, '.git'), `gitdir: ${pointer}\n`);
  return { rootDir, worktreePath, adminDir };
}

function makeRepoWithWorktree() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cps-preserve-cli-'));
  const worktreePath = join(repoRoot, 'linked');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'tracked.txt'), 'tracked\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoRoot });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', worktreePath], { cwd: repoRoot });
  const adminDir = readFileSync(join(worktreePath, '.git'), 'utf8').trim().slice('gitdir: '.length);
  return { repoRoot, worktreePath, adminDir };
}

test('readMarkers reports absent, valid, and invalid ownership and preservation markers', () => {
  const { rootDir, worktreePath, adminDir } = syntheticWorktree();
  try {
    assert.deepEqual(readMarkers({ repoRoot: rootDir, adminDir }), {
      ownership: { state: 'absent', value: null },
      preservation: { state: 'absent', value: null },
    });

    writeOwnershipMarker(worktreePath, {
      kind: 'implementation', run_id: 'run-1', base: 'abc123', created_at: '2026-09-18T12:00:00.000Z',
    });
    writePreservationMarker(worktreePath, { reason: 'manual hold', run_id: 'run-1' });
    const valid = readMarkers({ repoRoot: rootDir, adminDir });
    assert.equal(valid.ownership.state, 'valid');
    assert.deepEqual(valid.ownership.value, {
      owner: 'codex-paired-superpowers',
      kind: 'implementation',
      created_at: '2026-09-18T12:00:00.000Z',
      run_id: 'run-1',
      base: 'abc123',
    });
    assert.equal(valid.preservation.state, 'valid');
    assert.deepEqual(valid.preservation.value, {
      owner: 'codex-paired-superpowers', reason: 'manual hold', run_id: 'run-1',
    });

    writeFileSync(join(adminDir, 'codex-paired.json'), '{not json');
    writeFileSync(join(adminDir, 'codex-paired-keep.json'), JSON.stringify({ reason: 42, run_id: '' }));
    const invalid = readMarkers({ repoRoot: rootDir, adminDir });
    assert.deepEqual(invalid.ownership, { state: 'invalid', value: null });
    assert.equal(invalid.preservation.state, 'invalid');
    assert.deepEqual(invalid.preservation.value, { reason: 42, run_id: '' });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const relativePointer of [false, true]) {
  test(`marker writers resolve ${relativePointer ? 'relative' : 'absolute'} gitdir pointers and write atomically`, () => {
    const { rootDir, worktreePath, adminDir } = syntheticWorktree({ relativePointer });
    try {
      writeOwnershipMarker(worktreePath, {
        kind: 'review', run_id: 'review-1', base: 'HEAD', overlays: ['docs/spec.md'],
      });
      writePreservationMarker(worktreePath, { reason: 'review evidence', run_id: 'review-1' });
      const markers = readMarkers({ repoRoot: rootDir, adminDir });
      assert.equal(markers.ownership.state, 'valid');
      assert.deepEqual(markers.ownership.value.overlays, ['docs/spec.md']);
      assert.equal(markers.preservation.state, 'valid');
      assert.deepEqual(
        readdirSync(adminDir).filter((name) => name.includes('.tmp-')),
        [],
        'atomic writes must not leave temporary files behind',
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test('readMarkers uses the registry admin directory after the checkout directory is deleted', () => {
  const { rootDir, worktreePath, adminDir } = syntheticWorktree();
  try {
    writeOwnershipMarker(worktreePath, { kind: 'fanout', run_id: 'slice-3', base: 'abc123' });
    writePreservationMarker(worktreePath, { reason: 'keep forensics', run_id: 'slice-3' });
    rmSync(worktreePath, { recursive: true, force: true });
    assert.equal(existsSync(worktreePath), false);
    const markers = readMarkers({ repoRoot: rootDir, adminDir: relative(rootDir, adminDir) });
    assert.equal(markers.ownership.state, 'valid');
    assert.equal(markers.ownership.value.kind, 'fanout');
    assert.equal(markers.preservation.state, 'valid');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('checkout-preserve writes a marker for a registered worktree', () => {
  const { repoRoot, worktreePath, adminDir } = makeRepoWithWorktree();
  try {
    const result = spawnSync(process.execPath, [
      cli, 'checkout-preserve', '--path', worktreePath, '--reason', 'halt evidence',
      '--run', 'run-7', '--repoRoot', repoRoot,
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(readMarkers({ repoRoot, adminDir }).preservation, {
      state: 'valid',
      value: { owner: 'codex-paired-superpowers', reason: 'halt evidence', run_id: 'run-7' },
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checkout-preserve rejects an unregistered path without writing a marker', () => {
  const { repoRoot } = makeRepoWithWorktree();
  const unregistered = join(repoRoot, 'not-registered');
  mkdirSync(unregistered);
  try {
    const result = spawnSync(process.execPath, [
      cli, 'checkout-preserve', '--path', unregistered, '--reason', 'no',
      '--run', 'run-7', '--repoRoot', repoRoot,
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not a registered worktree/);
    assert.equal(existsSync(join(unregistered, '.git', 'codex-paired-keep.json')), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
