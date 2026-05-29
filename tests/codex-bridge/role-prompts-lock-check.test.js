// Plan 3 (reviewer naming migration) — lock integrity + `--check` mode.
//
// generate-role-prompts-lock.mjs gains a `--check` mode that recomputes the
// prompts map and compares it to the committed lock, ignoring `generated_at`,
// exiting non-zero on drift. The child-process spawn tests exercise the real
// CLI exit codes (no mocking — a mock would hide a broken comparison).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLock } from '../../scripts/generate-role-prompts-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'generate-role-prompts-lock.mjs');
const REAL_PROMPTS_DIR = join(REPO_ROOT, 'lib', 'codex-bridge', 'prompts');
const REAL_LOCK_FILE = join(REPO_ROOT, 'lib', 'codex-bridge', 'role-prompts.lock.json');

test('generate-role-prompts-lock.mjs --check exits 0 when the committed lock is fresh', () => {
  const res = spawnSync('node', [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /lock up to date/);
});

test('--check exits non-zero on a tampered lock (real child process, env-overridden lock path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lock-'));
  const tampered = JSON.parse(readFileSync(REAL_LOCK_FILE, 'utf8'));
  const firstKey = Object.keys(tampered.prompts)[0];
  tampered.prompts[firstKey].sha256 = '0'.repeat(64);
  const tamperedPath = join(dir, 'role-prompts.lock.json');
  writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2) + '\n');
  try {
    const res = spawnSync('node', [SCRIPT, '--check'], {
      encoding: 'utf8',
      env: { ...process.env, RP_LOCK_FILE_OVERRIDE: tamperedPath },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /drift/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLock() ignores generated_at and compares only the prompts map', () => {
  // Fresh committed lock → ok.
  assert.equal(checkLock(REAL_LOCK_FILE, REAL_PROMPTS_DIR).ok, true);

  const dir = mkdtempSync(join(tmpdir(), 'cps-lock2-'));
  try {
    const lock = JSON.parse(readFileSync(REAL_LOCK_FILE, 'utf8'));
    // Different generated_at but identical prompts → still ok.
    lock.generated_at = '1999-01-01T00:00:00.000Z';
    const p = join(dir, 'lock.json');
    writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
    assert.equal(checkLock(p, REAL_PROMPTS_DIR).ok, true);

    // Tamper a hash → not ok.
    lock.prompts[Object.keys(lock.prompts)[0]].sha256 = '0'.repeat(64);
    writeFileSync(p, JSON.stringify(lock, null, 2) + '\n');
    assert.equal(checkLock(p, REAL_PROMPTS_DIR).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
