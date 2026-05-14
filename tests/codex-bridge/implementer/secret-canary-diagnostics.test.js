// v0.10.0 slice 10 — canary redaction at diagnostic breadcrumb writer.
//
// The writeBreadcrumb function in hook-mailbox-inject.js writes to
// .codex-paired/diagnostics/hook-failures.jsonl. This test verifies that
// canary tokens in error messages are redacted before persistence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeBreadcrumb } from '../../../lib/codex-bridge/hook-mailbox-inject.js';
import { CANARY_TOKENS, ALL_CANARIES, hasAnyCanary } from './fixtures/canary-tokens.js';

function makeRepo(prefix = 'cps-canary-diag-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // Create the .codex-paired directory so writeBreadcrumb can create the diagnostics subdir
  mkdirSync(join(dir, '.codex-paired'), { recursive: true });
  return dir;
}

function readDiagnostics(repoRoot) {
  const path = join(repoRoot, '.codex-paired', 'diagnostics', 'hook-failures.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ── Test: canary in error message is redacted ────────────────────────────────

test('writeBreadcrumb: canary in error message is redacted before write', () => {
  const repoRoot = makeRepo();
  try {
    const canary = CANARY_TOKENS.anthropicApi;
    const errMsg = `Authentication failed with token ${canary} — retry`;

    writeBreadcrumb(repoRoot, 'slice-3', errMsg);

    // Read back and check
    const entries = readDiagnostics(repoRoot);
    assert.equal(entries.length, 1, 'Should have written 1 breadcrumb');

    const entry = entries[0];
    assert.equal(typeof entry.error, 'string', 'error field should be a string');

    // Must NOT contain the canary
    assert.ok(
      !entry.error.includes(canary),
      `Persisted error must not contain canary token; got: ${entry.error}`
    );

    // Must contain <REDACTED>
    assert.ok(
      entry.error.includes('<REDACTED>'),
      `Persisted error should contain <REDACTED>; got: ${entry.error}`
    );

    // Byte-scan the file too
    const rawContent = readFileSync(
      join(repoRoot, '.codex-paired', 'diagnostics', 'hook-failures.jsonl'),
      'utf8'
    );
    assert.ok(
      !hasAnyCanary(rawContent),
      `Raw file content must not contain any canary token`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Test: all 4 canaries are redacted ───────────────────────────────────────

for (const [tokenName, tokenValue] of Object.entries(CANARY_TOKENS)) {
  test(`writeBreadcrumb: canary token ${tokenName} is redacted`, () => {
    const repoRoot = makeRepo();
    try {
      writeBreadcrumb(repoRoot, 'slice-3', `Error: ${tokenValue}`);

      const entries = readDiagnostics(repoRoot);
      assert.equal(entries.length, 1);
      assert.ok(
        !entries[0].error.includes(tokenValue),
        `Token ${tokenName} must not appear in persisted error`
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
}

// ── Test: clean error message round-trips unchanged ──────────────────────────

test('writeBreadcrumb: clean error message round-trips without modification', () => {
  const repoRoot = makeRepo();
  try {
    const cleanMsg = 'mailbox read failed: ENOENT no such file or directory';
    writeBreadcrumb(repoRoot, 'slice-5', cleanMsg);

    const entries = readDiagnostics(repoRoot);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].error, cleanMsg, 'Clean error should round-trip unchanged');
    assert.equal(entries[0].slice, 'slice-5');
    assert.equal(typeof entries[0].ts, 'string');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Test: multiple breadcrumbs, none with canary ─────────────────────────────

test('writeBreadcrumb: multiple appends, canaries are redacted in each', () => {
  const repoRoot = makeRepo();
  try {
    writeBreadcrumb(repoRoot, 'slice-1', `normal error`);
    writeBreadcrumb(repoRoot, 'slice-2', `token=${CANARY_TOKENS.openai} failed`);
    writeBreadcrumb(repoRoot, 'slice-3', `another ${CANARY_TOKENS.ollamaCloud} error`);
    writeBreadcrumb(repoRoot, 'slice-4', `clean message`);

    const rawContent = readFileSync(
      join(repoRoot, '.codex-paired', 'diagnostics', 'hook-failures.jsonl'),
      'utf8'
    );

    // No canary tokens in the whole file
    assert.ok(
      !hasAnyCanary(rawContent),
      `Diagnostics file must not contain any canary tokens`
    );

    const entries = readDiagnostics(repoRoot);
    assert.equal(entries.length, 4);
    assert.equal(entries[0].error, 'normal error');
    assert.ok(entries[1].error.includes('<REDACTED>'));
    assert.ok(entries[2].error.includes('<REDACTED>'));
    assert.equal(entries[3].error, 'clean message');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
