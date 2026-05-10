// Tests for v0.7.2 codex_dispatch config schema in project-config.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  loadProjectConfig,
  applyCodexDispatchDefaults,
  CODEX_DISPATCH_DEFAULTS,
} from '../../lib/codex-bridge/project-config.js';

function makeRepo(configContent) {
  const root = mkdtempSync(join(tmpdir(), 'cps-codex-dispatch-cfg-'));
  // project-config requires a real git repo. Initialize one + commit a marker.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'cdc@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'cdc'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  if (configContent !== null) {
    mkdirSync(join(root, '.codex-paired'), { recursive: true });
    writeFileSync(join(root, '.codex-paired', 'project.json'), configContent);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const MIN_VALID = JSON.stringify({
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'lib only' },
});

// ── default values ──────────────────────────────────────────────────────────

test('applyCodexDispatchDefaults: defaults applied when codex_dispatch absent', () => {
  const result = applyCodexDispatchDefaults({});
  assert.equal(result.max_runtime_ms, CODEX_DISPATCH_DEFAULTS.max_runtime_ms);
  assert.equal(result.log_max_bytes, CODEX_DISPATCH_DEFAULTS.log_max_bytes);
});

test('applyCodexDispatchDefaults: explicit values override defaults', () => {
  const result = applyCodexDispatchDefaults({
    codex_dispatch: { max_runtime_ms: 1800000, log_max_bytes: 524288 }
  });
  assert.equal(result.max_runtime_ms, 1800000);
  assert.equal(result.log_max_bytes, 524288);
});

test('applyCodexDispatchDefaults: partial override only fills the missing key', () => {
  const result = applyCodexDispatchDefaults({
    codex_dispatch: { max_runtime_ms: 60000 }  // log_max_bytes not set
  });
  assert.equal(result.max_runtime_ms, 60000);
  assert.equal(result.log_max_bytes, CODEX_DISPATCH_DEFAULTS.log_max_bytes);
});

test('CODEX_DISPATCH_DEFAULTS values match spec §6.7', () => {
  // 2 hours = 7200000ms; 1 MB = 1048576 bytes
  assert.equal(CODEX_DISPATCH_DEFAULTS.max_runtime_ms, 7200000);
  assert.equal(CODEX_DISPATCH_DEFAULTS.log_max_bytes, 1048576);
});

// ── load-time validation: success paths ────────────────────────────────────

test('loadProjectConfig: codex_dispatch absent → load succeeds', () => {
  const root = makeRepo(MIN_VALID);
  const result = loadProjectConfig(root);
  assert.ok(result.ok, JSON.stringify(result));
  cleanup(root);
});

test('loadProjectConfig: codex_dispatch with valid max_runtime_ms loads cleanly', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: 3600000 }
  }));
  const result = loadProjectConfig(root);
  assert.ok(result.ok, JSON.stringify(result));
  cleanup(root);
});

test('loadProjectConfig: codex_dispatch with valid log_max_bytes loads cleanly', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { log_max_bytes: 2097152 }
  }));
  const result = loadProjectConfig(root);
  assert.ok(result.ok, JSON.stringify(result));
  cleanup(root);
});

test('loadProjectConfig: codex_dispatch with both keys loads cleanly', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: 1800000, log_max_bytes: 524288 }
  }));
  const result = loadProjectConfig(root);
  assert.ok(result.ok, JSON.stringify(result));
  cleanup(root);
});

// ── load-time validation: error paths ──────────────────────────────────────

test('loadProjectConfig: codex_dispatch as non-object → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: 'invalid'
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.match(result.error.detail, /codex_dispatch.*object/);
  cleanup(root);
});

test('loadProjectConfig: codex_dispatch as array → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: []
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  cleanup(root);
});

test('loadProjectConfig: max_runtime_ms negative → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: -1 }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.match(result.error.detail, /max_runtime_ms.*positive integer/);
  cleanup(root);
});

test('loadProjectConfig: max_runtime_ms zero → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: 0 }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  cleanup(root);
});

test('loadProjectConfig: max_runtime_ms non-integer → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: 1500.5 }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  cleanup(root);
});

test('loadProjectConfig: max_runtime_ms string → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: '60000' }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  cleanup(root);
});

test('loadProjectConfig: log_max_bytes negative → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { log_max_bytes: -100 }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  cleanup(root);
});

test('loadProjectConfig: codex_dispatch unknown key → error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { type: 'library' },
    live_verification: { default: 'skip', skip_reason: 'lib' },
    codex_dispatch: { max_runtime_ms: 60000, mystery_field: true }
  }));
  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.match(result.error.detail, /unknown key.*mystery_field/);
  cleanup(root);
});
