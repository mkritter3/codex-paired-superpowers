/**
 * project-config-bootstrap.test.js
 *
 * Tests for the v0.7.0 `worktree_bootstrap.symlinks` schema extension on
 * `loadProjectConfig`. See plan slice 1 (docs/plans/2026-05-08-v0.7.0-implementation.md)
 * and spec §8 (docs/specs/2026-05-08-v0.7.0-implementer-routing.md).
 *
 * Schema rules:
 *   - When `worktree_bootstrap` is absent OR `symlinks` is absent, the default
 *     symlinks list is applied:
 *       [{path:"node_modules",required:false},
 *        {path:".venv",       required:false},
 *        {path:"venv",        required:false}]
 *   - When `symlinks: []`, the user has explicitly opted out → empty array.
 *   - When `symlinks: ["node_modules","custom_dir"]`, each entry becomes
 *     `{path:<entry>, required:true}` (user-listed entries are required).
 *   - Reject: non-array `symlinks`; non-string element; absolute path;
 *     traversal (`..` segment); empty string element.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from '../../lib/codex-bridge/project-config.js';

// Minimal valid base config (web app, default run). Each test merges on top.
function baseConfig(extra = {}) {
  return {
    version: 1,
    app: { name: 'X', description: 'd', type: 'web' },
    live_verification: {
      default: 'run',
      ...((extra && extra.live_verification) || {}),
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'live_verification')),
  };
}

function makeRepo(content) {
  const base = mkdtempSync(join(tmpdir(), 'cps-pcb-'));
  const root = realpathSync(base);
  mkdirSync(join(root, '.codex-paired'));
  if (content !== undefined) {
    writeFileSync(join(root, '.codex-paired', 'project.json'), content);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const DEFAULT_SYMLINKS = [
  { path: 'node_modules', required: false },
  { path: '.venv',        required: false },
  { path: 'venv',         required: false },
];

// ── Defaults ────────────────────────────────────────────────────────────────

test('worktree_bootstrap absent → symlinks defaults to three required:false entries', () => {
  const root = makeRepo(JSON.stringify(baseConfig()));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.ok(result.config.worktree_bootstrap, 'worktree_bootstrap block present');
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, DEFAULT_SYMLINKS);
  } finally {
    cleanup(root);
  }
});

test('worktree_bootstrap present but symlinks absent → defaults applied', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = {};
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, DEFAULT_SYMLINKS);
  } finally {
    cleanup(root);
  }
});

test('symlinks: [] → empty array (user opted out)', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: [] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, []);
  } finally {
    cleanup(root);
  }
});

test('symlinks: ["node_modules","custom_dir"] → each entry required:true', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['node_modules', 'custom_dir'] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, [
      { path: 'node_modules', required: true },
      { path: 'custom_dir',   required: true },
    ]);
  } finally {
    cleanup(root);
  }
});

test('user-listed node_modules overrides the default required:false', () => {
  // If user explicitly lists node_modules, it is required (spec §8).
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['node_modules'] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, [
      { path: 'node_modules', required: true },
    ]);
  } finally {
    cleanup(root);
  }
});

// ── Rejections ──────────────────────────────────────────────────────────────

test('rejects non-array symlinks', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: 'node_modules' };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
    assert.match(result.error.detail, /array/i);
  } finally {
    cleanup(root);
  }
});

test('rejects non-string element', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['ok', 42] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
    assert.match(result.error.detail, /string/i);
  } finally {
    cleanup(root);
  }
});

test('rejects absolute path symlink entry', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['/etc/passwd'] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
    assert.match(result.error.detail, /absolute/i);
  } finally {
    cleanup(root);
  }
});

test('rejects traversal (.. segment) in symlink entry', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['../escape'] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
    assert.match(result.error.detail, /travers/i);
  } finally {
    cleanup(root);
  }
});

test('rejects nested traversal segment in symlink entry', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: ['foo/../../etc'] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
    assert.match(result.error.detail, /travers/i);
  } finally {
    cleanup(root);
  }
});

test('rejects empty-string symlink entry', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = { symlinks: [''] };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
  } finally {
    cleanup(root);
  }
});

test('rejects non-object worktree_bootstrap', () => {
  const cfg = baseConfig();
  cfg.worktree_bootstrap = 'nope';
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid-worktree-bootstrap');
  } finally {
    cleanup(root);
  }
});

// ── Backward compatibility ──────────────────────────────────────────────────

test('library config without worktree_bootstrap still loads with defaults', () => {
  // Library type already has its own validation rules; the new schema must not
  // interfere — defaults still applied.
  const cfg = {
    version: 1,
    app: { name: 'L', description: 'd', type: 'library' },
    live_verification: {
      default: 'skip',
      skip_reason: 'pure library',
    },
  };
  const root = makeRepo(JSON.stringify(cfg));
  try {
    const result = loadProjectConfig(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config.worktree_bootstrap.symlinks, DEFAULT_SYMLINKS);
  } finally {
    cleanup(root);
  }
});
