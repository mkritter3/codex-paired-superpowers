// Tests for v0.7.3 mailbox config in project-config.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  loadProjectConfig,
  applyMailboxDefaults,
  MAILBOX_DEFAULTS,
} from '../../lib/codex-bridge/project-config.js';

function makeRepo(configContent) {
  const root = mkdtempSync(join(tmpdir(), 'cps-mailbox-cfg-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'm@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'm'], { cwd: root });
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

const MIN_VALID_BASE = {
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'lib' },
};

test('MAILBOX_DEFAULTS values match spec rev5 §4.7', () => {
  assert.equal(MAILBOX_DEFAULTS.max_bytes, 262144);
  assert.equal(MAILBOX_DEFAULTS.archive_policy, 'rotate');
  assert.equal(MAILBOX_DEFAULTS.archive_retention_days, 30);
  assert.equal(MAILBOX_DEFAULTS.archive_retention_count, 100);
});

test('applyMailboxDefaults: defaults applied when mailbox absent', () => {
  const r = applyMailboxDefaults({});
  assert.deepEqual(r, { ...MAILBOX_DEFAULTS });
});

test('applyMailboxDefaults: explicit values override', () => {
  const r = applyMailboxDefaults({
    mailbox: { max_bytes: 1024, archive_policy: 'drop', archive_retention_days: 7, archive_retention_count: 10 }
  });
  assert.equal(r.max_bytes, 1024);
  assert.equal(r.archive_policy, 'drop');
  assert.equal(r.archive_retention_days, 7);
  assert.equal(r.archive_retention_count, 10);
});

test('applyMailboxDefaults: partial override fills missing keys', () => {
  const r = applyMailboxDefaults({ mailbox: { max_bytes: 1024 } });
  assert.equal(r.max_bytes, 1024);
  assert.equal(r.archive_policy, 'rotate');
  assert.equal(r.archive_retention_days, 30);
});

// ── load-time success ───────────────────────────────────────────────────────

test('loadProjectConfig: mailbox absent → load succeeds', () => {
  const root = makeRepo(JSON.stringify(MIN_VALID_BASE));
  const r = loadProjectConfig(root);
  assert.ok(r.ok, JSON.stringify(r));
  cleanup(root);
});

test('loadProjectConfig: valid mailbox.max_bytes loads', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { max_bytes: 524288 } }));
  const r = loadProjectConfig(root);
  assert.ok(r.ok);
  cleanup(root);
});

test('loadProjectConfig: mailbox.archive_policy=rotate loads', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { archive_policy: 'rotate' } }));
  assert.ok(loadProjectConfig(root).ok);
  cleanup(root);
});

test('loadProjectConfig: mailbox.archive_policy=drop loads', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { archive_policy: 'drop' } }));
  assert.ok(loadProjectConfig(root).ok);
  cleanup(root);
});

// ── load-time errors ────────────────────────────────────────────────────────

test('loadProjectConfig: mailbox as non-object → error', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: 'invalid' }));
  const r = loadProjectConfig(root);
  assert.equal(r.ok, false);
  assert.match(r.error.detail, /mailbox.*object/);
  cleanup(root);
});

test('loadProjectConfig: max_bytes negative → error', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { max_bytes: -1 } }));
  const r = loadProjectConfig(root);
  assert.equal(r.ok, false);
  assert.match(r.error.detail, /max_bytes.*positive integer/);
  cleanup(root);
});

test('loadProjectConfig: archive_policy unknown → error', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { archive_policy: 'shred' } }));
  const r = loadProjectConfig(root);
  assert.equal(r.ok, false);
  assert.match(r.error.detail, /archive_policy/);
  cleanup(root);
});

test('loadProjectConfig: archive_retention_days negative → error', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { archive_retention_days: -1 } }));
  const r = loadProjectConfig(root);
  assert.equal(r.ok, false);
  cleanup(root);
});

test('loadProjectConfig: mailbox unknown key → error', () => {
  const root = makeRepo(JSON.stringify({ ...MIN_VALID_BASE, mailbox: { mystery: true } }));
  const r = loadProjectConfig(root);
  assert.equal(r.ok, false);
  assert.match(r.error.detail, /unknown key.*mystery/);
  cleanup(root);
});
