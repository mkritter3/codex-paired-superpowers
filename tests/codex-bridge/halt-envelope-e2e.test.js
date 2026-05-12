// End-to-end halt envelope test (v0.9.0 slice 7b).
//
// Simulates autopilot emitting a halt reason and asserts that the envelope
// shape ralph-loop expects is produced correctly:
//   { halt, terminal: true, resume_hint }  — for terminal halts
//   { halt, terminal: false, resume_hint } — for transient halts
//
// These tests are integration-level: they exercise the full wrapAsHaltEnvelope
// path as a caller (autopilot or ralph-loop adapter) would use it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wrapAsHaltEnvelope,
  isTerminalHalt,
} from '../../lib/codex-bridge/halt-envelope.js';

// ── Simulate autopilot emitting a terminal halt ─────────────────────────────

test('autopilot emitting user-input-required produces envelope ralph-loop exits on', () => {
  // Simulates: sidecar.halt_reason = 'user-input-required'
  const envelope = wrapAsHaltEnvelope('user-input-required', {
    sliceId: 'slice-3',
    phase: 'B.4',
  });

  // ralph-loop reads this shape:
  assert.equal(envelope.halt, 'user-input-required');
  assert.equal(envelope.terminal, true);
  assert.ok(
    typeof envelope.resume_hint === 'string' && envelope.resume_hint.length > 0
  );
  // Context fields are preserved for diagnostics
  assert.equal(envelope.sliceId, 'slice-3');
  assert.equal(envelope.phase, 'B.4');

  // ralph-loop guard check
  assert.equal(isTerminalHalt(envelope), true);
});

test('autopilot emitting codex-blocked produces envelope ralph-loop exits on', () => {
  const envelope = wrapAsHaltEnvelope('codex-blocked', {
    sliceId: 'slice-5',
    implementer: 'codex',
  });

  assert.equal(envelope.halt, 'codex-blocked');
  assert.equal(envelope.terminal, true);
  assert.ok(envelope.resume_hint.length > 0);
  assert.equal(isTerminalHalt(envelope), true);
});

// ── Simulate autopilot emitting a transient halt (ralph should re-fire) ─────

test('autopilot emitting transient-network produces envelope ralph-loop retries on', () => {
  const envelope = wrapAsHaltEnvelope('transient-network');

  assert.equal(envelope.halt, 'transient-network');
  assert.equal(envelope.terminal, false);
  assert.ok(envelope.resume_hint.length > 0);

  // ralph-loop re-fire guard: isTerminalHalt → false means ralph should retry
  assert.equal(isTerminalHalt(envelope), false);
});

test('autopilot emitting panel-quorum-lost produces envelope ralph-loop retries on', () => {
  const envelope = wrapAsHaltEnvelope('panel-quorum-lost', {
    sliceId: 'slice-6',
  });

  assert.equal(envelope.terminal, false);
  assert.equal(isTerminalHalt(envelope), false);
});

// ── Simulate autopilot encountering an unknown halt reason ──────────────────

test('unknown halt reason from autopilot produces terminal envelope with triage hint', () => {
  // This could happen if a new halt reason is added to the sidecar schema
  // but not yet registered in halt-envelope.js.
  const envelope = wrapAsHaltEnvelope('newly-invented-halt-code', {
    sliceId: 'slice-7',
  });

  // Fail-closed: ralph-loop must exit, not retry.
  assert.equal(envelope.terminal, true);
  assert.equal(envelope.halt, 'newly-invented-halt-code');
  assert.ok(
    envelope.resume_hint.includes('operator triage'),
    'unknown reason hint must tell operator to triage'
  );
  assert.equal(isTerminalHalt(envelope), true);
});

// ── Envelope field contract for ralph-loop ──────────────────────────────────

test('envelope always contains halt, terminal, and resume_hint fields', () => {
  const reasons = [
    'user-input-required',      // known terminal
    'transient-network',        // known transient
    'completely-unknown-reason', // unknown → terminal
  ];
  for (const reason of reasons) {
    const env = wrapAsHaltEnvelope(reason);
    assert.ok(Object.hasOwn(env, 'halt'), `${reason}: missing 'halt' field`);
    assert.ok(Object.hasOwn(env, 'terminal'), `${reason}: missing 'terminal' field`);
    assert.ok(Object.hasOwn(env, 'resume_hint'), `${reason}: missing 'resume_hint' field`);
    assert.equal(typeof env.terminal, 'boolean', `${reason}: 'terminal' must be boolean`);
    assert.equal(typeof env.resume_hint, 'string', `${reason}: 'resume_hint' must be string`);
    assert.ok(env.resume_hint.length > 0, `${reason}: 'resume_hint' must be non-empty`);
  }
});
