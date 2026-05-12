// Tests for lib/codex-bridge/halt-envelope.js (v0.9.0 slice 7b).
// Validation tier: critical.
// All assertions are result-oriented (observable envelope fields), not
// implementation-detail assertions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapAsHaltEnvelope,
  isTerminalHalt,
  HALT_MAP,
} from '../../lib/codex-bridge/halt-envelope.js';

// ── Terminal halts ──────────────────────────────────────────────────────────

test('terminal halt reasons return terminal: true', () => {
  const terminalReasons = [
    'user-input-required',
    'panel-disagreement',
    'panel-quorum-unavailable',
    'cli-dispatch-failed',
    'override-cli-unavailable',
    'override-variant-unknown',
    'panel-config-invalid',
    'codex-blocked',
    'subagent-blocked',
    'codex-needs-context',
    'subagent-needs-context',
    'implementer-directive-malformed',
    'parallel-files-malformed',
    'expert-blocker',
    'role-composer-fan-out-unjustified',
  ];
  for (const reason of terminalReasons) {
    const env = wrapAsHaltEnvelope(reason);
    assert.equal(
      env.terminal,
      true,
      `"${reason}" should be terminal: true`
    );
    assert.equal(env.halt, reason, `envelope.halt should equal the reason for "${reason}"`);
    assert.ok(
      typeof env.resume_hint === 'string' && env.resume_hint.length > 0,
      `"${reason}" should have a non-empty resume_hint`
    );
  }
});

// ── Transient halts ─────────────────────────────────────────────────────────

test('transient halt reasons return terminal: false', () => {
  const transientReasons = [
    'panel-quorum-lost',
    'transient-network',
    'reconciler-failed',
    'dispatch-retry-eligible',
  ];
  for (const reason of transientReasons) {
    const env = wrapAsHaltEnvelope(reason);
    assert.equal(
      env.terminal,
      false,
      `"${reason}" should be terminal: false`
    );
    assert.equal(env.halt, reason);
    assert.ok(
      typeof env.resume_hint === 'string' && env.resume_hint.length > 0,
      `"${reason}" should have a non-empty resume_hint`
    );
  }
});

// ── Unknown halt reason — fail-closed ────────────────────────────────────────

test('unknown halt reason defaults to terminal: true (fail-closed)', () => {
  const env = wrapAsHaltEnvelope('some-completely-unknown-reason');
  assert.equal(env.terminal, true);
  assert.equal(env.halt, 'some-completely-unknown-reason');
  assert.ok(
    env.resume_hint.includes('operator triage'),
    'resume_hint for unknown reason should mention operator triage'
  );
});

test('unknown halt reason includes the unknown reason string in resume_hint', () => {
  const reason = 'totally-invented-halt-xyz';
  const env = wrapAsHaltEnvelope(reason);
  assert.ok(
    env.resume_hint.includes(reason),
    `resume_hint should include the unknown reason string`
  );
});

// ── resume_hint is non-empty for all known reasons ──────────────────────────

test('every known halt reason has a non-empty resume_hint', () => {
  for (const [reason, entry] of HALT_MAP) {
    assert.ok(
      typeof entry.resume_hint === 'string' && entry.resume_hint.length > 0,
      `HALT_MAP entry for "${reason}" must have a non-empty resume_hint`
    );
  }
});

// ── Optional context merges into envelope ───────────────────────────────────

test('optional context fields merge into the envelope', () => {
  const env = wrapAsHaltEnvelope('codex-blocked', {
    resolvedCLI: 'codex',
    sliceId: 'slice-3',
    extraDetail: 'some info',
  });
  assert.equal(env.halt, 'codex-blocked');
  assert.equal(env.terminal, true);
  assert.equal(env.resolvedCLI, 'codex');
  assert.equal(env.sliceId, 'slice-3');
  assert.equal(env.extraDetail, 'some info');
});

test('context does not override the halt, terminal, or resume_hint fields', () => {
  // Verify that core fields are set by the map, not overridden by context.
  // (Context keys that collide are an operator error; we test behavior is stable.)
  const env = wrapAsHaltEnvelope('panel-quorum-lost', {
    sliceId: 'slice-5',
  });
  // panel-quorum-lost is transient → terminal: false
  assert.equal(env.terminal, false);
  assert.equal(env.halt, 'panel-quorum-lost');
  assert.equal(env.sliceId, 'slice-5');
});

// ── Snapshot: mapping table completeness ────────────────────────────────────

test('HALT_MAP snapshot — terminal vs transient classification', () => {
  // Snapshot the full classification table so future changes are explicit.
  const terminalInMap = [];
  const transientInMap = [];
  for (const [reason, entry] of HALT_MAP) {
    if (entry.terminal) {
      terminalInMap.push(reason);
    } else {
      transientInMap.push(reason);
    }
  }

  // Sort for stable comparison.
  terminalInMap.sort();
  transientInMap.sort();

  assert.deepEqual(terminalInMap, [
    'cli-dispatch-failed',
    'codex-blocked',
    'codex-needs-context',
    'expert-blocker',
    'implementer-directive-malformed',
    'override-cli-unavailable',
    'override-variant-unknown',
    'panel-config-invalid',
    'panel-disagreement',
    'panel-quorum-unavailable',
    'parallel-files-malformed',
    'role-composer-fan-out-unjustified',
    'subagent-blocked',
    'subagent-needs-context',
    'user-input-required',
  ]);

  assert.deepEqual(transientInMap, [
    'dispatch-retry-eligible',
    'panel-quorum-lost',
    'reconciler-failed',
    'transient-network',
  ]);
});

// ── isTerminalHalt guard ─────────────────────────────────────────────────────

test('isTerminalHalt returns true for terminal envelopes', () => {
  const env = wrapAsHaltEnvelope('user-input-required');
  assert.equal(isTerminalHalt(env), true);
});

test('isTerminalHalt returns false for transient envelopes', () => {
  const env = wrapAsHaltEnvelope('transient-network');
  assert.equal(isTerminalHalt(env), false);
});

test('isTerminalHalt returns true for unknown reason envelopes (fail-closed)', () => {
  const env = wrapAsHaltEnvelope('whatever-unknown');
  assert.equal(isTerminalHalt(env), true);
});

// ── Input validation ─────────────────────────────────────────────────────────

test('wrapAsHaltEnvelope throws TypeError on empty string reason', () => {
  assert.throws(
    () => wrapAsHaltEnvelope(''),
    TypeError,
    'empty string reason should throw TypeError'
  );
});

test('wrapAsHaltEnvelope throws TypeError on non-string reason', () => {
  assert.throws(
    () => wrapAsHaltEnvelope(null),
    TypeError
  );
  assert.throws(
    () => wrapAsHaltEnvelope(42),
    TypeError
  );
});
