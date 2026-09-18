import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { writeOwnershipMarker, writePreservationMarker } from '../../lib/codex-bridge/checkout-markers.js';
import { createCheckoutReaper } from '../../lib/codex-bridge/checkout-reaper.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(pluginRoot, 'lib/codex-bridge/cli.js');
const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const OLD = '2026-09-16T00:00:00.000Z';
const RECENT = '2026-09-18T11:30:00.000Z';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cps-reaper-'));
  const repoRoot = join(root, 'repo');
  const tmpDir = join(root, 'tmp');
  mkdirSync(repoRoot);
  mkdirSync(tmpDir);
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Reaper Test']);
  git(repoRoot, ['config', 'user.email', 'reaper@example.invalid']);
  writeFileSync(join(repoRoot, '.gitignore'), 'ignored-artifacts/\nnode_modules/\n.tia-cache/\n');
  writeFileSync(join(repoRoot, 'tracked.txt'), 'base\n');
  writeFileSync(join(repoRoot, 'overlay.txt'), 'base overlay\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  let serial = 0;

  function addWorktree({ kind = 'implementation', marked = true, createdAt = OLD, overlays, probable = false } = {}) {
    serial += 1;
    const name = `wt-${serial}`;
    let path = probable
      ? join(repoRoot, '.git-worktrees', name)
      : join(root, 'worktrees', name);
    mkdirSync(dirname(path), { recursive: true });
    git(repoRoot, ['worktree', 'add', '-q', '-b', `branch-${serial}`, path, 'HEAD']);
    path = realpathSync(path);
    if (marked) {
      writeOwnershipMarker(path, {
        kind, run_id: `run-${serial}`, base: git(repoRoot, ['rev-parse', 'HEAD']),
        created_at: createdAt, ...(overlays === undefined ? {} : { overlays }),
      });
    }
    return {
      path,
      adminDir: readFileSync(join(path, '.git'), 'utf8').trim().slice('gitdir: '.length),
    };
  }

  return { root, repoRoot, tmpDir, addWorktree };
}

function safeReaper(overrides = {}) {
  return createCheckoutReaper({
    findProcesses: () => ({ pids: [], complete: true, gaps: [] }),
    ...overrides,
  });
}

function entryFor(entries, path) {
  const entry = entries.find((candidate) => candidate.path === path);
  assert.ok(entry, `missing inventory entry for ${path}`);
  return entry;
}

function isRegistered(repoRoot, path) {
  return git(repoRoot, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${path}`);
}

test('a user-created worktree is never touched and a probable pre-v0.19.0 worktree is listed but kept', () => {
  const fx = fixture();
  try {
    const user = fx.addWorktree({ marked: false });
    const probable = fx.addWorktree({ marked: false, probable: true });
    const corruptOwnership = fx.addWorktree();
    writeFileSync(join(corruptOwnership.adminDir, 'codex-paired.json'), '{broken');
    const reaper = safeReaper();
    const inventory = reaper.inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW });
    assert.equal(entryFor(inventory, user.path).class, 'not-ours');
    assert.deepEqual(entryFor(inventory, user.path).keep, ['not-created-by-plugin']);
    assert.equal(entryFor(inventory, probable.path).class, 'not-ours');
    assert.ok(entryFor(inventory, probable.path).keep.includes('probable-plugin-leftover'));
    assert.deepEqual(entryFor(inventory, corruptOwnership.path).keep, ['ownership-marker-invalid']);

    reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(isRegistered(fx.repoRoot, user.path), true);
    assert.equal(isRegistered(fx.repoRoot, probable.path), true);
    assert.equal(isRegistered(fx.repoRoot, corruptOwnership.path), true);
    assert.equal(existsSync(user.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('preserved and corrupt-preservation checkouts are both fail-closed', () => {
  const fx = fixture();
  try {
    const preserved = fx.addWorktree();
    writePreservationMarker(preserved.path, { reason: 'forensics', run_id: 'run-preserved' });
    const corrupt = fx.addWorktree();
    writeFileSync(join(corrupt.adminDir, 'codex-paired-keep.json'), '{broken');
    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, preserved.path).class, 'preserved');
    assert.ok(entryFor(result.entries, preserved.path).keep.includes('preserved:forensics'));
    assert.equal(entryFor(result.entries, corrupt.path).class, 'preserved');
    assert.ok(entryFor(result.entries, corrupt.path).keep.includes('preservation-marker-invalid'));
    assert.equal(isRegistered(fx.repoRoot, preserved.path), true);
    assert.equal(isRegistered(fx.repoRoot, corrupt.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a clean, reachable, old candidate is reaped only in apply mode', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    const reaper = safeReaper();
    const dryRun = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: false });
    assert.deepEqual(entryFor(dryRun.entries, checkout.path).keep, []);
    assert.equal(entryFor(dryRun.entries, checkout.path).removed, false);
    assert.equal(isRegistered(fx.repoRoot, checkout.path), true);

    const applied = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(applied.entries, checkout.path).removed, true);
    assert.equal(isRegistered(fx.repoRoot, checkout.path), false);
    assert.equal(existsSync(checkout.path), false);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('each independent process, reachability, worktree, ignored-file, and age condition keeps a candidate', async (t) => {
  const cases = [
    ['in use', ({ checkout }) => ({
      reaper: safeReaper({ findProcesses: () => ({ pids: [4242], complete: true, gaps: [] }) }),
      reason: 'in-use:4242',
    })],
    ['incomplete discovery', () => ({
      reaper: safeReaper({ findProcesses: () => ({ pids: [], complete: false, gaps: [{ code: 'EACCES' }] }) }),
      reason: 'process-discovery-incomplete',
    })],
    ['unreachable HEAD', ({ repoRoot, checkout }) => {
      writeFileSync(join(checkout.path, 'tracked.txt'), 'unique\n');
      git(checkout.path, ['add', 'tracked.txt']);
      git(checkout.path, ['commit', '-qm', 'unique']);
      return { reaper: safeReaper(), reason: 'head-unreachable' };
    }],
    ['modified file', ({ checkout }) => {
      writeFileSync(join(checkout.path, 'tracked.txt'), 'modified\n');
      return { reaper: safeReaper(), reason: 'modified-files' };
    }],
    ['staged file', ({ checkout }) => {
      writeFileSync(join(checkout.path, 'tracked.txt'), 'staged\n');
      git(checkout.path, ['add', 'tracked.txt']);
      return { reaper: safeReaper(), reason: 'staged-files' };
    }],
    ['untracked file', ({ checkout }) => {
      writeFileSync(join(checkout.path, 'new.txt'), 'new\n');
      return { reaper: safeReaper(), reason: 'untracked-files' };
    }],
    ['untracked file hidden by config', ({ checkout }) => {
      git(checkout.path, ['config', 'status.showUntrackedFiles', 'no']);
      writeFileSync(join(checkout.path, 'hidden.txt'), 'hidden\n');
      return { reaper: safeReaper(), reason: 'untracked-files' };
    }],
    ['non-regenerable ignored file', ({ checkout }) => {
      mkdirSync(join(checkout.path, 'ignored-artifacts'));
      writeFileSync(join(checkout.path, 'ignored-artifacts', 'evidence.log'), 'evidence\n');
      return { reaper: safeReaper(), reason: 'ignored-non-regenerable' };
    }],
    ['too young', ({ checkout }) => {
      writeOwnershipMarker(checkout.path, {
        kind: 'implementation', run_id: 'recent', base: git(checkout.path, ['rev-parse', 'HEAD']), created_at: RECENT,
      });
      return { reaper: safeReaper(), reason: 'too-young' };
    }],
  ];

  for (const [name, arrange] of cases) {
    await t.test(name, () => {
      const fx = fixture();
      try {
        const checkout = fx.addWorktree();
        const { reaper, reason } = arrange({ ...fx, checkout });
        const result = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
        assert.ok(entryFor(result.entries, checkout.path).keep.includes(reason), `${name} did not report ${reason}`);
        assert.equal(isRegistered(fx.repoRoot, checkout.path), true);
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test('regenerable ignored files do not block implementation reaping', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    mkdirSync(join(checkout.path, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(checkout.path, '.tia-cache'), { recursive: true });
    writeFileSync(join(checkout.path, 'node_modules', 'pkg', 'index.js'), 'generated\n');
    writeFileSync(join(checkout.path, '.tia-cache', 'state'), 'generated\n');
    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, checkout.path).removed, true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('review overlays byte-identical to the primary checkout are allowed and every other change is kept', () => {
  const fx = fixture();
  try {
    const allowed = fx.addWorktree({ kind: 'review', overlays: ['overlay.txt'] });
    writeFileSync(join(fx.repoRoot, 'overlay.txt'), 'new overlay\n');
    writeFileSync(join(allowed.path, 'overlay.txt'), 'new overlay\n');

    const mismatch = fx.addWorktree({ kind: 'review', overlays: ['overlay.txt'] });
    writeFileSync(join(mismatch.path, 'overlay.txt'), 'not the source bytes\n');

    const extra = fx.addWorktree({ kind: 'review', overlays: ['overlay.txt'] });
    writeFileSync(join(extra.path, 'overlay.txt'), 'new overlay\n');
    writeFileSync(join(extra.path, 'review-notes.txt'), 'leftover\n');

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, allowed.path).removed, true);
    assert.ok(entryFor(result.entries, mismatch.path).keep.includes('overlay-mismatch'));
    assert.ok(entryFor(result.entries, extra.path).keep.includes('review-changes-outside-overlays'));
    assert.equal(isRegistered(fx.repoRoot, mismatch.path), true);
    assert.equal(isRegistered(fx.repoRoot, extra.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('mixed safe and unsafe stale entries remove one registry entry without pruning another', () => {
  const fx = fixture();
  try {
    const safe = fx.addWorktree();
    const unsafe = fx.addWorktree();
    writeFileSync(join(unsafe.path, 'tracked.txt'), 'unique\n');
    git(unsafe.path, ['add', 'tracked.txt']);
    git(unsafe.path, ['commit', '-qm', 'unique stale head']);
    rmSync(safe.path, { recursive: true, force: true });
    rmSync(unsafe.path, { recursive: true, force: true });

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, safe.path).removed, true);
    assert.ok(entryFor(result.entries, unsafe.path).keep.includes('head-unreachable'));
    assert.equal(isRegistered(fx.repoRoot, safe.path), false);
    assert.equal(isRegistered(fx.repoRoot, unsafe.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a condition that becomes false between inventory and removal keeps the checkout', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    let calls = 0;
    const reaper = safeReaper({
      findProcesses: () => (++calls === 1
        ? { pids: [], complete: true, gaps: [] }
        : { pids: [991], complete: true, gaps: [] }),
    });
    const result = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(calls, 2, 'candidate conditions must be evaluated once for listing and again before removal');
    assert.ok(entryFor(result.entries, checkout.path).keep.includes('in-use:991'));
    assert.equal(entryFor(result.entries, checkout.path).removed, false);
    assert.equal(isRegistered(fx.repoRoot, checkout.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('unregistered cps-review directories are listed and a disappearing directory is tolerated', () => {
  const fx = fixture();
  try {
    let stray = join(fx.tmpDir, 'cps-review-stray');
    mkdirSync(stray);
    stray = realpathSync(stray);
    const entries = safeReaper().inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW });
    assert.equal(entryFor(entries, stray).class, 'not-ours');
    assert.equal(entryFor(entries, stray).registered, false);
    rmSync(stray, { recursive: true, force: true });
    assert.doesNotThrow(() => safeReaper().inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW }));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('worktree-reap CLI is dry-run by default, supports --apply, and rejects usage errors', () => {
  const fx = fixture();
  try {
    const dry = spawnSync(process.execPath, [cli, 'worktree-reap', '--repoRoot', fx.repoRoot], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).apply, false);
    const apply = spawnSync(process.execPath, [cli, 'worktree-reap', '--apply', '--repoRoot', fx.repoRoot], { encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(JSON.parse(apply.stdout).apply, true);
    const invalid = spawnSync(process.execPath, [cli, 'worktree-reap'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /--repoRoot/);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
