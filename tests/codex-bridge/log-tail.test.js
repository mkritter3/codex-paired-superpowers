/**
 * log-tail.test.js
 *
 * TDD tests for lib/codex-bridge/log-tail.js.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Log Tailing"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The repo root is the plugin root — used for absolute-path rejection tests
const REPO_ROOT = join(__dirname, '..', '..');

import { tailLogs } from '../../lib/codex-bridge/log-tail.js';

// ── Helper: create temp dir ───────────────────────────────────────────────────

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lt-'));
  return dir;
}

// ── Test 1: Tails a file from start ──────────────────────────────────────────

test('tailLogs: tails a file from start and returns all lines', { timeout: 5000 }, async () => {
  const tmp = makeTmp();
  const logFile = join(tmp, 'app.log');
  writeFileSync(logFile, 'line1\nline2\nline3\n');

  const tailer = tailLogs(
    [{ path: logFile, allow_absolute: true }],
    { repoRoot: REPO_ROOT }
  );

  // Give it a tick to read
  await new Promise((r) => setTimeout(r, 100));

  const result = tailer.tail(logFile, 10000);
  assert.ok(result.includes('line1'), `expected line1 in result, got: ${result}`);
  assert.ok(result.includes('line2'), `expected line2 in result, got: ${result}`);
  assert.ok(result.includes('line3'), `expected line3 in result, got: ${result}`);

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── Test 2: Respects max_bytes_per_source ─────────────────────────────────────

test('tailLogs: respects max_bytes_per_source — buffer length ≤ max', { timeout: 5000 }, async () => {
  const tmp = makeTmp();
  const logFile = join(tmp, 'big.log');

  // Write 2000 bytes of content
  const bigContent = 'X'.repeat(200) + '\n'; // 201 bytes per line
  let content = '';
  for (let i = 0; i < 10; i++) content += bigContent;
  writeFileSync(logFile, content);

  const MAX = 500;
  const tailer = tailLogs(
    [{ path: logFile, allow_absolute: true }],
    { repoRoot: REPO_ROOT, max_bytes_per_source: MAX }
  );

  await new Promise((r) => setTimeout(r, 100));

  // The internal buffer should be bounded
  const result = tailer.tail(logFile, 100000);
  assert.ok(result.length <= MAX, `buffer should be ≤ ${MAX} bytes, got ${result.length}`);

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── Test 3: excerpt_around bounded by max_bytes ───────────────────────────────

test('tailLogs: excerpt_around returns ≤ max_bytes_per_scenario', { timeout: 5000 }, async () => {
  const tmp = makeTmp();
  const logFile = join(tmp, 'excerpt.log');

  // Write many lines
  let content = '';
  for (let i = 0; i < 100; i++) {
    content += `2026-01-01T00:00:0${i % 10} INFO line ${i}\n`;
  }
  content += '2026-01-01T00:01:00 ERROR Something went wrong\n';
  for (let i = 0; i < 100; i++) {
    content += `2026-01-01T00:02:0${i % 10} INFO after ${i}\n`;
  }
  writeFileSync(logFile, content);

  const MAX_EXCERPT = 200;
  const tailer = tailLogs(
    [{ path: logFile, allow_absolute: true }],
    { repoRoot: REPO_ROOT, max_bytes_per_source: 262144 }
  );

  await new Promise((r) => setTimeout(r, 100));

  const excerpt = tailer.excerpt_around(logFile, 'ERROR', 3, 3, MAX_EXCERPT);
  assert.ok(excerpt.length <= MAX_EXCERPT, `excerpt should be ≤ ${MAX_EXCERPT} bytes, got ${excerpt.length}`);
  // Should still contain something
  assert.ok(excerpt.length > 0, 'excerpt should be non-empty when pattern found');

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── Test 4: errors_since filters by timestamp and error_patterns ───────────────

test('tailLogs: errors_since returns only ERROR lines after timestamp', { timeout: 5000 }, async () => {
  const tmp = makeTmp();
  const logFile = join(tmp, 'errors.log');

  const beforeMs = Date.now();
  // Simulate old lines (before cutoff) — we'll embed timestamp directly in content
  // and use a numeric-timestamp approach in the test by writing lines after tailer starts

  // Lines with embedded ISO timestamps
  const old = `2020-01-01T00:00:00.000Z INFO old line\n2020-01-01T00:00:01.000Z ERROR old error\n`;
  const fresh = `2026-01-01T00:00:00.000Z INFO fresh info\n2026-01-01T00:00:01.000Z ERROR fresh error\n2026-01-01T00:00:02.000Z TypeError something broke\n`;
  writeFileSync(logFile, old + fresh);

  const cutoff = new Date('2025-01-01T00:00:00.000Z');
  const tailer = tailLogs(
    [{ path: logFile, allow_absolute: true }],
    {
      repoRoot: REPO_ROOT,
      max_bytes_per_source: 262144,
      error_patterns: ['ERROR', 'TypeError'],
    }
  );

  await new Promise((r) => setTimeout(r, 100));

  const errors = tailer.errors_since(logFile, cutoff);
  assert.ok(Array.isArray(errors), 'errors_since returns array');
  // Should contain the fresh ERROR and TypeError lines
  const errText = errors.join('\n');
  assert.ok(errText.includes('fresh error'), `should contain fresh error, got: ${errText}`);
  assert.ok(errText.includes('TypeError'), `should contain TypeError, got: ${errText}`);
  // Should NOT contain the old error (before cutoff)
  assert.ok(!errText.includes('old error'), `should not contain old error, got: ${errText}`);

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── Test 5: tail(source, bytes) returns last N bytes ─────────────────────────

test('tailLogs: tail(source, bytes) returns last N bytes of buffer', { timeout: 5000 }, async () => {
  const tmp = makeTmp();
  const logFile = join(tmp, 'tail.log');
  writeFileSync(logFile, 'AAAAABBBBBCCCCC');

  const tailer = tailLogs(
    [{ path: logFile, allow_absolute: true }],
    { repoRoot: REPO_ROOT, max_bytes_per_source: 262144 }
  );

  await new Promise((r) => setTimeout(r, 100));

  const result = tailer.tail(logFile, 5);
  assert.ok(result.endsWith('CCCCC'), `expected last 5 bytes to be CCCCC, got: ${JSON.stringify(result)}`);
  assert.equal(result.length, 5, `expected 5 bytes, got ${result.length}`);

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ── Test 6: Missing log path records available: false ─────────────────────────

test('tailLogs: missing log path records available:false without throwing', { timeout: 5000 }, async () => {
  const missingPath = join(REPO_ROOT, 'tests', 'codex-bridge', 'fixtures', 'nonexistent-12345.log');

  // Should not throw
  const tailer = tailLogs(
    [{ path: missingPath }],
    { repoRoot: REPO_ROOT }
  );

  await new Promise((r) => setTimeout(r, 100));

  const sourceInfo = tailer.sourceInfo(missingPath);
  assert.equal(sourceInfo.available, false, 'unavailable source should have available:false');
  assert.equal(sourceInfo.path, missingPath);

  tailer.close();
});

// ── Test 7: Absolute path outside repo rejected ───────────────────────────────

test('tailLogs: absolute path outside repo root is rejected', { timeout: 5000 }, () => {
  // /etc/passwd is definitely outside the repo root
  assert.throws(
    () => {
      tailLogs(
        [{ path: '/etc/passwd' }],
        { repoRoot: REPO_ROOT }
      );
    },
    (err) => {
      assert.ok(
        err.message.includes('outside repo') || err.code === 'unsafe-log-path',
        `expected unsafe-log-path or "outside repo" in message, got: ${err.message}`
      );
      return true;
    }
  );
});

// ── Test 7b: Absolute path outside repo allowed when allow_absolute: true ────

test('tailLogs: absolute path outside repo allowed when allow_absolute:true in source config', { timeout: 5000 }, async () => {
  // Use a benign path that exists — /tmp is safe and outside repo
  const tmp = makeTmp();
  const outsideFile = join(tmp, 'outside.log');
  writeFileSync(outsideFile, 'outside content\n');

  // Should not throw
  const tailer = tailLogs(
    [{ path: outsideFile, allow_absolute: true }],
    { repoRoot: REPO_ROOT }
  );

  await new Promise((r) => setTimeout(r, 100));

  const result = tailer.tail(outsideFile, 10000);
  assert.ok(result.includes('outside content'), `expected content from outside file, got: ${result}`);

  tailer.close();
  rmSync(tmp, { recursive: true, force: true });
});
