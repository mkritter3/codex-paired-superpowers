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
    // Per Codex round-1 slice-7b finding #2: reconciler-failed covers bad
    // SHA / broken worktree (autopilot §B.5), which is not safe to auto-retry.
    // It is terminal — the operator must inspect the worktree.
    'reconciler-failed',
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
    'reconciler-failed',
    'role-composer-fan-out-unjustified',
    'subagent-blocked',
    'subagent-needs-context',
    'user-input-required',
  ]);

  assert.deepEqual(transientInMap, [
    'dispatch-retry-eligible',
    'panel-quorum-lost',
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

// ── Round-1 critique: context must NOT override canonical halt fields ───────
//
// Codex round-1 slice-7b finding #1: a caller passing `{terminal: false}` in
// context alongside a terminal halt reason MUST NOT flip ralph-loop into a
// retry loop. The canonical {halt, terminal, resume_hint} are load-bearing
// for ralph-loop's exit guard.

test('context cannot override the canonical halt field', () => {
  const env = wrapAsHaltEnvelope('user-input-required', { halt: 'evil-spoof' });
  assert.equal(
    env.halt,
    'user-input-required',
    'context.halt must not override the canonical halt field'
  );
});

test('context cannot override the canonical terminal field (terminal halt)', () => {
  const env = wrapAsHaltEnvelope('user-input-required', { terminal: false });
  assert.equal(
    env.terminal,
    true,
    'context.terminal=false must NOT flip a terminal halt into transient'
  );
  assert.equal(isTerminalHalt(env), true);
});

test('context cannot override the canonical terminal field (transient halt)', () => {
  // Inverse direction: a caller cannot upgrade a transient halt to terminal
  // either. The classification is the contract — not negotiable per-call.
  const env = wrapAsHaltEnvelope('transient-network', { terminal: true });
  assert.equal(
    env.terminal,
    false,
    'context.terminal=true must NOT override a transient halt classification'
  );
});

test('context cannot override the canonical resume_hint field', () => {
  const env = wrapAsHaltEnvelope('user-input-required', { resume_hint: 'spoofed' });
  assert.notEqual(
    env.resume_hint,
    'spoofed',
    'context.resume_hint must not override the canonical resume_hint'
  );
  assert.ok(env.resume_hint.length > 0);
});

test('context cannot override canonical fields on unknown reason path either', () => {
  const env = wrapAsHaltEnvelope('newly-invented-reason', {
    halt: 'spoof',
    terminal: false,
    resume_hint: 'spoof',
  });
  assert.equal(env.halt, 'newly-invented-reason');
  assert.equal(env.terminal, true);
  assert.ok(env.resume_hint.includes('operator triage'));
});

test('context fields that DO NOT collide are preserved alongside canonical fields', () => {
  const env = wrapAsHaltEnvelope('user-input-required', {
    sliceId: 'slice-3',
    phase: 'B.4',
    resolvedCLI: 'codex',
  });
  assert.equal(env.sliceId, 'slice-3');
  assert.equal(env.phase, 'B.4');
  assert.equal(env.resolvedCLI, 'codex');
  // Canonical fields still correct
  assert.equal(env.halt, 'user-input-required');
  assert.equal(env.terminal, true);
});

// ── Round-1 critique: isTerminalHalt fails closed on malformed envelopes ────
//
// Codex round-1 slice-7b finding #3: ralph-loop must NOT re-fire on malformed
// envelopes (missing terminal, non-boolean terminal, missing resume_hint,
// non-object). isTerminalHalt is the guard — anything that is not a
// well-formed transient envelope returns true.

test('isTerminalHalt: null envelope is terminal (fail-closed)', () => {
  assert.equal(isTerminalHalt(null), true);
});

test('isTerminalHalt: undefined envelope is terminal (fail-closed)', () => {
  assert.equal(isTerminalHalt(undefined), true);
});

test('isTerminalHalt: non-object envelope is terminal', () => {
  assert.equal(isTerminalHalt('string-not-object'), true);
  assert.equal(isTerminalHalt(42), true);
  assert.equal(isTerminalHalt(true), true);
});

test('isTerminalHalt: object missing terminal field is terminal', () => {
  assert.equal(isTerminalHalt({ halt: 'foo' }), true);
});

test('isTerminalHalt: non-boolean terminal is terminal', () => {
  assert.equal(isTerminalHalt({ terminal: 'false', halt: 'foo', resume_hint: 'h' }), true);
  assert.equal(isTerminalHalt({ terminal: 0, halt: 'foo', resume_hint: 'h' }), true);
  assert.equal(isTerminalHalt({ terminal: null, halt: 'foo', resume_hint: 'h' }), true);
});

test('isTerminalHalt: transient-shaped envelope missing halt is terminal', () => {
  assert.equal(isTerminalHalt({ terminal: false, resume_hint: 'h' }), true);
});

test('isTerminalHalt: transient-shaped envelope missing resume_hint is terminal', () => {
  assert.equal(isTerminalHalt({ terminal: false, halt: 'foo' }), true);
});

test('isTerminalHalt: transient-shaped envelope with empty resume_hint is terminal', () => {
  assert.equal(isTerminalHalt({ terminal: false, halt: 'foo', resume_hint: '' }), true);
});

test('isTerminalHalt: only a well-formed transient envelope returns false', () => {
  const env = wrapAsHaltEnvelope('transient-network');
  assert.equal(isTerminalHalt(env), false);
  // Manually-constructed equivalent works the same
  assert.equal(
    isTerminalHalt({ terminal: false, halt: 'something', resume_hint: 'a hint' }),
    false
  );
});
