/**
 * safety-gate.test.js
 *
 * TDD tests for lib/codex-bridge/safety-gate.js.
 * The module is a pure function — no I/O, no side effects.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Safety Gate"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 5
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSafetyGate } from '../../lib/codex-bridge/safety-gate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal config with no takeover block (default mode).
 */
function defaultConfig() {
  return {
    live_verification: {}
  };
}

/**
 * Build a config with confirm_each_phase_e mode explicitly set.
 */
function confirmConfig() {
  return {
    live_verification: {
      takeover: {
        mode: 'confirm_each_phase_e'
      }
    }
  };
}

/**
 * Build a scheduled_window config.
 * @param {Array} windows - array of window objects
 */
function scheduledConfig(windows) {
  return {
    live_verification: {
      takeover: {
        mode: 'scheduled_window',
        scheduled_windows: windows
      }
    }
  };
}

/**
 * A fixed Monday 2026-01-05 at 04:00:00 UTC
 * In America/Los_Angeles that is 2026-01-04 (Sunday) at 20:00 PST.
 */
const MONDAY_UTC_0400 = new Date('2026-01-05T04:00:00Z');

/**
 * A fixed Wednesday 2026-01-07 at 04:00:00 UTC
 * In America/Los_Angeles that is 2026-01-06 (Tuesday) at 20:00 PST.
 */
const WEDNESDAY_UTC_0400 = new Date('2026-01-07T04:00:00Z');

/**
 * Tuesday 2026-01-06 at 12:00:00 UTC
 * In America/Los_Angeles that is 2026-01-06 (Tuesday) at 04:00 PST.
 */
const TUESDAY_UTC_1200 = new Date('2026-01-06T12:00:00Z');

/**
 * Tuesday 2026-01-06 at 22:00:00 UTC
 * In America/Los_Angeles that is 2026-01-06 (Tuesday) at 14:00 PST.
 */
const TUESDAY_UTC_2200 = new Date('2026-01-06T22:00:00Z');

// ── Test 1: confirm_each_phase_e mode (default) returns requires-confirmation ─

test('default config (no takeover block) returns requires-confirmation', () => {
  const result = evaluateSafetyGate(defaultConfig(), MONDAY_UTC_0400);
  assert.equal(result.status, 'requires-confirmation');
  assert.ok(typeof result.promptText === 'string', 'promptText should be a string');
  assert.ok(result.promptText.length > 0, 'promptText should not be empty');
});

// ── Test 2: promptText matches spec ──────────────────────────────────────────

test('promptText contains required spec text', () => {
  const result = evaluateSafetyGate(defaultConfig(), MONDAY_UTC_0400);
  assert.equal(result.status, 'requires-confirmation');
  assert.ok(
    result.promptText.includes('Phase E live verification is about to take screen control'),
    `promptText missing Phase E opening. Got: ${result.promptText}`
  );
  assert.ok(
    result.promptText.includes('Continue now?'),
    `promptText missing "Continue now?". Got: ${result.promptText}`
  );
});

// ── Test 3: confirm_each_phase_e mode explicit ────────────────────────────────

test('explicit confirm_each_phase_e mode returns requires-confirmation', () => {
  const result = evaluateSafetyGate(confirmConfig(), MONDAY_UTC_0400);
  assert.equal(result.status, 'requires-confirmation');
  assert.ok(typeof result.promptText === 'string');
  assert.ok(result.promptText.includes('Phase E live verification is about to take screen control'));
  assert.ok(result.promptText.includes('Continue now?'));
});

// ── Test 4: scheduled_window mode, IN window ─────────────────────────────────
// Tuesday 2026-01-06 at 04:00 LA time (TUESDAY_UTC_1200) → inside tue 02:00–06:00

test('scheduled_window mode IN window returns ok', () => {
  const config = scheduledConfig([
    {
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '02:00',
      end: '06:00',
      timezone: 'America/Los_Angeles'
    }
  ]);
  const result = evaluateSafetyGate(config, TUESDAY_UTC_1200);
  assert.equal(result.status, 'ok');
  assert.equal(result.promptText, undefined, 'ok result should have no promptText');
  assert.equal(result.haltReason, undefined, 'ok result should have no haltReason');
});

// ── Test 5: scheduled_window mode, OUT of window ─────────────────────────────
// Tuesday 2026-01-06 at 14:00 LA time (TUESDAY_UTC_2200) → outside tue 02:00–06:00

test('scheduled_window mode OUT of window returns halt', () => {
  const config = scheduledConfig([
    {
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '02:00',
      end: '06:00',
      timezone: 'America/Los_Angeles'
    }
  ]);
  const result = evaluateSafetyGate(config, TUESDAY_UTC_2200);
  assert.equal(result.status, 'halt');
  assert.equal(result.haltReason, 'live-verification-outside-scheduled-window');
  assert.ok(typeof result.detail === 'string', 'halt result should include a detail string');
  assert.ok(result.detail.length > 0);
});

// ── Test 6: scheduled_window honors days array ────────────────────────────────
// MONDAY_UTC_0400 → In LA is Sunday 20:00, which is a Sunday — not in mon-fri window

test('scheduled_window with days: ["mon"] halts when now is Sunday in LA timezone', () => {
  // MONDAY_UTC_0400 = 2026-01-05T04:00Z, which in LA (UTC-8 in Jan) = 2026-01-04 20:00 (Sunday)
  const config = scheduledConfig([
    {
      days: ['mon'],
      start: '18:00',
      end: '23:00',
      timezone: 'America/Los_Angeles'
    }
  ]);
  const result = evaluateSafetyGate(config, MONDAY_UTC_0400);
  assert.equal(result.status, 'halt');
  assert.equal(result.haltReason, 'live-verification-outside-scheduled-window');
});

// ── Test 7: scheduled_window honors timezone ──────────────────────────────────
// Window: tue 02:00–06:00 America/Los_Angeles
// TUESDAY_UTC_1200 → LA is tue 04:00 → IN window
// TUESDAY_UTC_2200 → LA is tue 14:00 → OUT of window

test('scheduled_window IN window for LA 04:00 when UTC is 12:00', () => {
  const config = scheduledConfig([
    {
      days: ['tue'],
      start: '02:00',
      end: '06:00',
      timezone: 'America/Los_Angeles'
    }
  ]);
  // IN window
  const inResult = evaluateSafetyGate(config, TUESDAY_UTC_1200);
  assert.equal(inResult.status, 'ok');
});

test('scheduled_window OUT of window for LA 14:00 when UTC is 22:00', () => {
  const config = scheduledConfig([
    {
      days: ['tue'],
      start: '02:00',
      end: '06:00',
      timezone: 'America/Los_Angeles'
    }
  ]);
  // OUT of window
  const outResult = evaluateSafetyGate(config, TUESDAY_UTC_2200);
  assert.equal(outResult.status, 'halt');
  assert.equal(outResult.haltReason, 'live-verification-outside-scheduled-window');
});

// ── Test 8: Multiple windows — matching either → ok ──────────────────────────
// Window A: mon 02:00–06:00 UTC, Window B: tue 02:00–06:00 UTC
// TUESDAY_UTC_1200 in UTC = Tue 12:00 — outside window B (02:00–06:00 UTC)
// Use UTC timezone for simple arithmetic

test('multiple windows — matching either window returns ok', () => {
  // Use UTC timezone so arithmetic is simple
  // Window A: mon 03:00–05:00 UTC
  // Window B: tue 11:00–13:00 UTC
  // TUESDAY_UTC_1200 = Tue 12:00 UTC → matches window B
  const config = scheduledConfig([
    {
      days: ['mon'],
      start: '03:00',
      end: '05:00',
      timezone: 'UTC'
    },
    {
      days: ['tue'],
      start: '11:00',
      end: '13:00',
      timezone: 'UTC'
    }
  ]);
  const result = evaluateSafetyGate(config, TUESDAY_UTC_1200);
  assert.equal(result.status, 'ok');
});

test('multiple windows — matching neither window returns halt', () => {
  // Window A: mon 03:00–05:00 UTC
  // Window B: wed 11:00–13:00 UTC
  // TUESDAY_UTC_1200 = Tue 12:00 UTC → matches neither
  const config = scheduledConfig([
    {
      days: ['mon'],
      start: '03:00',
      end: '05:00',
      timezone: 'UTC'
    },
    {
      days: ['wed'],
      start: '11:00',
      end: '13:00',
      timezone: 'UTC'
    }
  ]);
  const result = evaluateSafetyGate(config, TUESDAY_UTC_1200);
  assert.equal(result.status, 'halt');
  assert.equal(result.haltReason, 'live-verification-outside-scheduled-window');
});

// ── Test 9: Empty scheduled_windows array → halt ─────────────────────────────

test('scheduled_window mode with empty windows array returns halt', () => {
  const config = scheduledConfig([]);
  const result = evaluateSafetyGate(config, TUESDAY_UTC_1200);
  assert.equal(result.status, 'halt');
  assert.equal(result.haltReason, 'live-verification-outside-scheduled-window');
});

// ── Test 10: Pure function — same args, same result, no side effects ──────────

test('evaluateSafetyGate is a pure function (same args → same result)', () => {
  const config = confirmConfig();

  const r1 = evaluateSafetyGate(config, MONDAY_UTC_0400);
  const r2 = evaluateSafetyGate(config, MONDAY_UTC_0400);

  assert.deepEqual(r1, r2);
  assert.equal(r1.status, 'requires-confirmation');
});

test('evaluateSafetyGate does not mutate the config argument', () => {
  const config = scheduledConfig([
    { days: ['mon'], start: '02:00', end: '06:00', timezone: 'UTC' }
  ]);
  const configBefore = JSON.stringify(config);
  evaluateSafetyGate(config, MONDAY_UTC_0400);
  const configAfter = JSON.stringify(config);
  assert.equal(configBefore, configAfter);
});
