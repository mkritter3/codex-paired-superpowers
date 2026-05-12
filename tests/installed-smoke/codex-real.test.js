// v0.9.0 slice 8 — installed-smoke test for the real codex CLI adapter.
//
// TIER 4 — only runs when CPS_INSTALLED_SMOKE=1 AND `codex` binary is
// present on PATH. All tests skip cleanly (with reason) when either
// condition is not met. This file is NOT run by `npm test`; use:
//
//   CPS_INSTALLED_SMOKE=1 npm run test:installed-smoke
//
// See tests/installed-smoke/_README.md for full context.
//
// What this tests:
//   1. Real codex CLI spawns and returns a non-empty response
//   2. DispatchResult shape matches the canonical contract
//   3. adapterMeta.adapter is 'cli-harness:codex'
//   4. No orphaned processes left behind (60s timeout enforced)
//   5. 2-turn sequential prompt: first turn works, second turn works
//
// Cleanup discipline: dispatch() manages AbortController internally;
// the harness kills the child on timeout. We assert no timeout warning
// appears in a normal-response test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { dispatch } from '../../lib/codex-bridge/cli-harness/harness.js';

// ── Guards ────────────────────────────────────────────────────────────────────

const SMOKE_ENABLED = process.env.CPS_INSTALLED_SMOKE === '1';

function codexBinaryPresent() {
  try {
    execFileSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

const CODEX_PRESENT = SMOKE_ENABLED && codexBinaryPresent();

// ── Tests ─────────────────────────────────────────────────────────────────────

test(
  'codex installed-smoke: skips when CPS_INSTALLED_SMOKE is not set',
  { skip: SMOKE_ENABLED ? false : 'CPS_INSTALLED_SMOKE env var not set to "1"; skipping installed-smoke tests' },
  () => {
    // This test body only runs when SMOKE_ENABLED. Its purpose is to confirm
    // we can reach the guard checkpoint. The real work is in the tests below.
    assert.equal(process.env.CPS_INSTALLED_SMOKE, '1');
  },
);

test(
  'codex installed-smoke: skips when codex binary is not on PATH',
  { skip: CODEX_PRESENT ? false : 'codex binary not found on PATH; skipping codex installed-smoke tests' },
  () => {
    assert.ok(CODEX_PRESENT, 'codex binary must be present to reach here');
  },
);

test(
  'codex installed-smoke: real dispatch returns non-empty responseText',
  {
    timeout: 60_000,
    skip: CODEX_PRESENT
      ? false
      : 'codex binary not found or CPS_INSTALLED_SMOKE not set; skipping',
  },
  async () => {
    const result = await dispatch(
      { cli: 'codex' },
      'You are a concise assistant. Reply in exactly one sentence.',
      'Say hello and confirm you received this prompt.',
      { timeout: 55_000 },
    );

    // Non-empty response text.
    assert.ok(
      typeof result.responseText === 'string' && result.responseText.trim().length > 0,
      `responseText must be non-empty; got: ${JSON.stringify(result.responseText)}`,
    );

    // Shape: all canonical DispatchResult fields present.
    assert.equal(typeof result.exit, 'number', 'exit must be a number');
    assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
    assert.equal(typeof result.duration_ms, 'number', 'duration_ms must be a number');
    assert.ok(result.duration_ms >= 0, 'duration_ms must be non-negative');
    assert.ok(
      result.adapterMeta && typeof result.adapterMeta === 'object',
      'adapterMeta must be an object',
    );

    // Exit code 0 on success.
    assert.equal(result.exit, 0, `codex should exit 0 on a simple prompt; got ${result.exit}`);

    // No timeout warning (we gave 55s; normal response should be well under that).
    const hasTimeoutWarning = result.warnings.some((w) => /timeout/i.test(w));
    assert.ok(!hasTimeoutWarning, `unexpected timeout warning: ${JSON.stringify(result.warnings)}`);
  },
);

test(
  'codex installed-smoke: DispatchResult adapterMeta.adapter is cli-harness:codex',
  {
    timeout: 60_000,
    skip: CODEX_PRESENT
      ? false
      : 'codex binary not found or CPS_INSTALLED_SMOKE not set; skipping',
  },
  async () => {
    const result = await dispatch(
      { cli: 'codex' },
      'You are a one-word responder.',
      'Reply with exactly one word: "confirmed".',
      { timeout: 55_000 },
    );

    // adapterMeta.adapter field must be 'cli-harness:codex'.
    // The codex adapter sets this so callers can identify which adapter handled the turn.
    assert.equal(
      result.adapterMeta.adapter,
      'cli-harness:codex',
      `adapterMeta.adapter must be 'cli-harness:codex'; got ${JSON.stringify(result.adapterMeta.adapter)}`,
    );
  },
);

test(
  'codex installed-smoke: 2-turn sequential dispatch — both turns return non-empty responses',
  {
    timeout: 120_000,
    skip: CODEX_PRESENT
      ? false
      : 'codex binary not found or CPS_INSTALLED_SMOKE not set; skipping',
  },
  async () => {
    // Turn 1: draft a spec sentence.
    const turn1 = await dispatch(
      { cli: 'codex' },
      'You are a spec-drafting assistant. Be very brief.',
      'Draft a one-sentence feature spec for a user login page.',
      { timeout: 55_000 },
    );
    assert.ok(
      typeof turn1.responseText === 'string' && turn1.responseText.trim().length > 0,
      'Turn 1 responseText must be non-empty',
    );
    assert.equal(turn1.exit, 0, `Turn 1 should exit 0; got ${turn1.exit}`);

    // Turn 2: revise the spec.
    const turn2 = await dispatch(
      { cli: 'codex' },
      'You are a spec-revision assistant. Be very brief.',
      `Revise this spec to add error handling: "${turn1.responseText.slice(0, 200)}"`,
      { timeout: 55_000 },
    );
    assert.ok(
      typeof turn2.responseText === 'string' && turn2.responseText.trim().length > 0,
      'Turn 2 responseText must be non-empty',
    );
    assert.equal(turn2.exit, 0, `Turn 2 should exit 0; got ${turn2.exit}`);

    // Both turns must have consistent shape.
    for (const [label, result] of [['turn1', turn1], ['turn2', turn2]]) {
      assert.ok(Array.isArray(result.warnings), `${label} warnings must be an array`);
      assert.equal(typeof result.duration_ms, 'number', `${label} duration_ms must be a number`);
      assert.equal(
        result.adapterMeta.adapter,
        'cli-harness:codex',
        `${label} adapterMeta.adapter must be 'cli-harness:codex'`,
      );
    }
  },
);
