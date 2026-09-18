import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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

  function addWorktree({
    kind = 'implementation', marked = true, createdAt = OLD, overlays, probable = false, pathName,
  } = {}) {
    serial += 1;
    const name = pathName ?? `wt-${serial}`;
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
      adminDir: readFileSync(join(path, '.git'), 'utf8').slice('gitdir: '.length).replace(/\r?\n$/, ''),
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
  return git(repoRoot, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`worktree ${path}`);
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
    git(allowed.path, ['add', 'overlay.txt']);

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

test('a review checkout with a staged non-overlay change restored only in the working tree is kept', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree({ kind: 'review', overlays: [] });
    writeFileSync(join(checkout.path, 'tracked.txt'), 'staged review evidence\n');
    git(checkout.path, ['add', 'tracked.txt']);
    git(checkout.path, ['restore', '--worktree', '--source=HEAD', '--', 'tracked.txt']);
    assert.equal(git(checkout.path, ['diff', '--name-only', 'HEAD', '--']), '');
    assert.equal(git(checkout.path, ['diff', '--cached', '--name-only', 'HEAD', '--']), 'tracked.txt');

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.ok(entryFor(result.entries, checkout.path).keep.includes('review-changes-outside-overlays'));
    assert.equal(isRegistered(fx.repoRoot, checkout.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a modified implementation file hidden by assume-unchanged keeps the checkout', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    git(checkout.path, ['config', 'core.ignorestat', 'true']);
    git(checkout.path, ['update-index', '--assume-unchanged', 'tracked.txt']);
    writeFileSync(join(checkout.path, 'tracked.txt'), 'hidden implementation evidence\n');

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.ok(entryFor(result.entries, checkout.path).keep.includes('index-flags-hide-changes'));
    assert.equal(isRegistered(fx.repoRoot, checkout.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a modified review file hidden by skip-worktree keeps the checkout', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree({ kind: 'review', overlays: [] });
    git(checkout.path, ['update-index', '--skip-worktree', 'tracked.txt']);
    writeFileSync(join(checkout.path, 'tracked.txt'), 'hidden review evidence\n');

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.ok(entryFor(result.entries, checkout.path).keep.includes('index-flags-hide-changes'));
    assert.equal(isRegistered(fx.repoRoot, checkout.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('ambiguous admin backlinks keep every entry even when only one admin dir is preserved', () => {
  const fx = fixture();
  try {
    const preserved = fx.addWorktree();
    const alias = fx.addWorktree();
    writePreservationMarker(preserved.path, { reason: 'ambiguous evidence', run_id: 'run-preserved' });
    writeFileSync(join(alias.adminDir, 'gitdir'), `${join(preserved.path, '.git')}\n`);

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    const associated = result.entries.filter((entry) => entry.path === preserved.path);
    assert.ok(associated.length >= 1);
    assert.ok(associated.every((entry) => entry.keep.includes('registry-ambiguous')));
    assert.equal(existsSync(preserved.adminDir), true);
    assert.equal(existsSync(alias.adminDir), true);
    assert.equal(existsSync(preserved.path), true);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a registered checkout whose path is a symlink is kept', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    const target = `${checkout.path}-target`;
    renameSync(checkout.path, target);
    symlinkSync(target, checkout.path, 'dir');

    const entries = safeReaper().inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW });
    assert.ok(entryFor(entries, checkout.path).keep.includes('checkout-path-symlink'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('a checkout whose own gitdir pointer disagrees with its registry admin dir is kept', () => {
  const fx = fixture();
  try {
    const checkout = fx.addWorktree();
    const other = fx.addWorktree();
    writeFileSync(join(checkout.path, '.git'), `gitdir: ${other.adminDir}\n`);

    const entries = safeReaper().inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW });
    assert.ok(entryFor(entries, checkout.path).keep.includes('admin-dir-mismatch'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('NUL porcelain keeps a newline-containing checkout path as one safe inventory entry', () => {
  const fx = fixture();
  try {
    const newline = fx.addWorktree({ pathName: 'wt-with\nnewline' });
    const preserved = fx.addWorktree();
    writePreservationMarker(preserved.path, { reason: 'newline neighbor', run_id: 'run-preserved' });

    const inventory = safeReaper().inventoryCheckouts({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW });
    assert.equal(inventory.filter((entry) => entry.path === newline.path).length, 1);
    assert.equal(entryFor(inventory, preserved.path).class, 'preserved');

    const result = safeReaper().reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, newline.path).removed, true);
    assert.equal(entryFor(result.entries, preserved.path).removed, false);
    assert.equal(isRegistered(fx.repoRoot, preserved.path), true);
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

test('another candidate can preserve an earlier candidate before its target-only final evaluation', () => {
  const fx = fixture();
  try {
    const earlier = fx.addWorktree();
    const later = fx.addWorktree();
    const calls = new Map();
    const reaper = safeReaper({
      findProcesses: (path) => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        if (path === later.path && calls.get(path) === 1) {
          writePreservationMarker(earlier.path, { reason: 'late evidence', run_id: 'run-late' });
        }
        return { pids: [], complete: true, gaps: [] };
      },
    });

    const result = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.ok(entryFor(result.entries, earlier.path).keep.includes('preserved:late evidence'));
    assert.equal(entryFor(result.entries, earlier.path).removed, false);
    assert.equal(calls.get(earlier.path), 1);
    assert.equal(calls.get(later.path), 2, 'unrelated checkouts are not evaluated during another target refresh');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('each candidate has exactly one final evaluation after the shared listing work', () => {
  const fx = fixture();
  try {
    const first = fx.addWorktree();
    const second = fx.addWorktree();
    const calls = new Map();
    const reaper = safeReaper({
      findProcesses: (path) => {
        calls.set(path, (calls.get(path) ?? 0) + 1);
        return { pids: [], complete: true, gaps: [] };
      },
    });

    const result = reaper.reap({ repoRoot: fx.repoRoot, tmpDir: fx.tmpDir, now: NOW, apply: true });
    assert.equal(entryFor(result.entries, first.path).removed, true);
    assert.equal(entryFor(result.entries, second.path).removed, true);
    assert.equal(calls.get(first.path), 2);
    assert.equal(calls.get(second.path), 2);
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
