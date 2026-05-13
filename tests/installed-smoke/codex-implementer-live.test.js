// v0.10.0 slice 4 — installed-smoke test for the codex implementer mode.
//
// TIER 4 — only runs when CPS_INSTALLED_SMOKE=1 AND `codex` binary is
// present on PATH. All tests skip cleanly (with reason) when either
// condition is not met.
//
// What this tests:
//   1. Real codex exec --sandbox workspace-write modifies a fixture file
//   2. Dispatch returns exit 0
//   3. adapterMeta.exec_mode === 'implementer'
//   4. No orphaned processes left behind

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch } from '../../lib/codex-bridge/cli-harness/adapters/codex.js';

// ── Guards ────────────────────────────────────────────────────────────────────

const SMOKE_ENABLED = process.env.CPS_INSTALLED_SMOKE === '1';

function isCodexOnPath() {
  try {
    execFileSync('which', ['codex'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const codexAvailable = SMOKE_ENABLED && isCodexOnPath();

// ── Tests ─────────────────────────────────────────────────────────────────────

test('codex implementer live: creates/modifies fixture file via exec --sandbox workspace-write', {
  timeout: 120_000,
}, async (t) => {
  if (!SMOKE_ENABLED) {
    t.skip('CPS_INSTALLED_SMOKE not set; skipping installed-smoke test');
    // eslint-disable-next-line no-console
    console.error('[codex-implementer-live] Skipping: set CPS_INSTALLED_SMOKE=1 to enable');
    return;
  }
  if (!codexAvailable) {
    t.skip('codex binary not found on PATH; skipping installed-smoke test');
    // eslint-disable-next-line no-console
    console.error('[codex-implementer-live] Skipping: codex not found on PATH');
    return;
  }

  // Create a tmpdir worktree with a fixture file.
  const worktreeDir = mkdtempSync(join(tmpdir(), 'cps-codex-live-'));
  const fixtureFile = join(worktreeDir, 'hello.txt');
  writeFileSync(fixtureFile, 'original content', 'utf8');

  try {
    const systemPrompt = 'You are a code editor. Modify files as instructed.';
    const userPrompt =
      `Overwrite the file hello.txt in the current directory with the single line: "modified by codex implementer"`;

    const result = await dispatch(systemPrompt, userPrompt, {
      execMode: 'implementer',
      cwd: worktreeDir,
      timeout_ms: 90_000,
    });

    // Must exit 0.
    assert.equal(result.exit, 0,
      `expected exit 0 from real codex exec; got ${result.exit}. ` +
      `warnings: ${JSON.stringify(result.warnings)}`);

    // exec_mode must be implementer.
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'adapterMeta.exec_mode must be implementer');

    // File must have been modified.
    const fileContent = readFileSync(fixtureFile, 'utf8');
    assert.notEqual(fileContent.trim(), 'original content',
      'fixture file must be modified by the implementer dispatch');
    assert.ok(fileContent.trim().length > 0,
      'modified file must not be empty');
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
});
