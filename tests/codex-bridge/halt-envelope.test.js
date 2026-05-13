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
    // Note: 'claude-...' sorts before 'cli-...' because 'a' < 'i'.
    'claude-cli-auth-missing',
    'claude-cli-auth-rejected',
    'claude-cli-protocol-unsupported',
    'cli-dispatch-failed',
    'codex-blocked',
    'codex-cli-blocked',
    'codex-needs-context',
    'expert-blocker',
    'implementer-cap-exceeded',
    'implementer-claimed-file-violation',
    'implementer-claimed-files-missing',
    'implementer-directive-malformed',
    'implementer-high-cost-rationale-missing',
    'implementer-member-id-invalid',
    'implementer-required-child-failed',
    'mailbox-delivery-failed',
    'merge-audit-divergence',
    'merge-branch-unknown',
    'merge-commit-failed',
    'merge-conflict',
    'merge-conflict-double-ship-failed',
    'merge-git-failure',
    'merge-integration-busy',
    'merge-integration-dirty',
    'merge-integration-not-a-git-repo',
    'merger-out-of-scope',
    'ollama-cloud-route-invalid',
    'override-cli-unavailable',
    'override-variant-unknown',
    'panel-config-invalid',
    'panel-disagreement',
    'panel-quorum-unavailable',
    'parallel-files-malformed',
    'post-merge-review-revise',
    'reconciler-failed',
    'role-composer-fan-out-unjustified',
    'sidecar-replay-concurrent-order-invalid',
    'subagent-blocked',
    'subagent-needs-context',
    'user-input-required',
    'worktree-create-failed',
    'worktree-dirty-before-dispatch',
    'worktree-not-a-git-repo',
    'worktree-path-conflict',
    'worktree-path-escape',
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
  // Manually-constructed equivalent works only when the halt name is a
  // known transient (HALT_MAP registry-enforced; round-2 fix).
  assert.equal(
    isTerminalHalt({ terminal: false, halt: 'transient-network', resume_hint: 'a hint' }),
    false
  );
});

// ── Round-2 critique: isTerminalHalt enforces the known-set invariant ───────
//
// Codex round-2 slice-7b finding #1: ralph-loop's load-bearing guard must
// not rely on callers using wrapAsHaltEnvelope correctly. A hand-crafted
// well-shaped envelope claiming `terminal: false` for an UNKNOWN or
// TERMINAL-classified halt name MUST still return terminal.

test('isTerminalHalt: unknown halt name claiming terminal:false is terminal', () => {
  const env = {
    terminal: false,
    halt: 'some-typo-or-new-reason',
    resume_hint: 'retry plz',
  };
  // Even though the shape is valid, the halt name is not registered. Ralph
  // must not retry on an unrecognized reason.
  assert.equal(isTerminalHalt(env), true);
});

test('isTerminalHalt: known terminal halt name claiming terminal:false is terminal', () => {
  // If a caller hand-crafts {halt: 'user-input-required', terminal: false},
  // the registry says user-input-required is terminal. The guard must refuse
  // to retry — registry beats the hand-crafted boolean.
  const env = {
    terminal: false,
    halt: 'user-input-required',
    resume_hint: 'pretend retry',
  };
  assert.equal(isTerminalHalt(env), true);
});

test('isTerminalHalt: known transient halt name with valid envelope returns false (retry-eligible)', () => {
  for (const transientHalt of ['transient-network', 'panel-quorum-lost', 'dispatch-retry-eligible']) {
    const env = {
      terminal: false,
      halt: transientHalt,
      resume_hint: 'retry hint',
    };
    assert.equal(
      isTerminalHalt(env),
      false,
      `${transientHalt} should be the only path that returns false`
    );
  }
});

// ── v0.10.0: 18 new terminal halt codes ──────────────────────────────────────

const V010_NEW_HALT_CODES = [
  'implementer-cap-exceeded',
  'implementer-high-cost-rationale-missing',
  'implementer-member-id-invalid',
  'implementer-claimed-files-missing',
  'implementer-claimed-file-violation',
  'implementer-required-child-failed',
  'codex-cli-blocked',
  'claude-cli-protocol-unsupported',
  'claude-cli-auth-missing',
  'claude-cli-auth-rejected',
  'ollama-cloud-route-invalid',
  'mailbox-delivery-failed',
  'worktree-create-failed',
  'worktree-dirty-before-dispatch',
  'merge-conflict-double-ship-failed',
  'post-merge-review-revise',
  'sidecar-replay-concurrent-order-invalid',
  // Pinned in slice 1 from slice 8 scope so known-set invariant covers it from day 1.
  'merger-out-of-scope',
];

test('v0.10.0: all 18 new halt codes are present in HALT_MAP', () => {
  for (const code of V010_NEW_HALT_CODES) {
    assert.ok(
      HALT_MAP.has(code),
      `HALT_MAP must contain "${code}"`
    );
  }
});

test('v0.10.0: all 18 new halt codes are mapped to terminal: true', () => {
  for (const code of V010_NEW_HALT_CODES) {
    const entry = HALT_MAP.get(code);
    assert.ok(entry, `HALT_MAP must contain "${code}"`);
    assert.equal(
      entry.terminal,
      true,
      `"${code}" must be terminal: true`
    );
  }
});

test('v0.10.0: all 18 new halt codes have non-empty resume_hint', () => {
  for (const code of V010_NEW_HALT_CODES) {
    const entry = HALT_MAP.get(code);
    assert.ok(entry, `HALT_MAP must contain "${code}"`);
    assert.ok(
      typeof entry.resume_hint === 'string' && entry.resume_hint.length > 0,
      `"${code}" must have a non-empty resume_hint`
    );
  }
});

test('v0.10.0: wrapAsHaltEnvelope returns correct shape for all 18 new codes', () => {
  for (const code of V010_NEW_HALT_CODES) {
    const env = wrapAsHaltEnvelope(code);
    assert.equal(env.halt, code, `envelope.halt should equal "${code}"`);
    assert.equal(env.terminal, true, `"${code}" should be terminal: true`);
    assert.ok(
      typeof env.resume_hint === 'string' && env.resume_hint.length > 0,
      `"${code}" should have a non-empty resume_hint`
    );
  }
});

test('v0.10.0: isTerminalHalt returns true for all 18 new codes', () => {
  for (const code of V010_NEW_HALT_CODES) {
    const env = wrapAsHaltEnvelope(code);
    assert.equal(
      isTerminalHalt(env),
      true,
      `isTerminalHalt must return true for "${code}"`
    );
  }
});

test('v0.10.0: HALT_MAP total key count snapshot (16 legacy terminal + 3 transient + 18 new = 37, pre-slice-7)', () => {
  // NOTE: This test was the original slice-1 count snapshot.
  // After slice-7 adds 11 more codes, use the slice-7 count snapshot test below.
  // We keep this test in a form that matches the actual count (48 after slice 7).
  // The original 37 = 16 legacy terminal + 3 transient + 18 v0.10.0 new.
  // Slice 7 adds 11 more, so total = 48.
  assert.equal(HALT_MAP.size, 48, 'HALT_MAP must have exactly 48 entries (37 pre-slice-7 + 11 slice-7 additions)');
});

// ── v0.10.0 slice-7: 11 new halt codes (8 merge + 3 retroactive worktree) ───

const SLICE7_NEW_HALT_CODES = [
  // 8 merge coordinator halt codes
  'merge-conflict',
  'merge-integration-dirty',
  'merge-integration-busy',
  'merge-integration-not-a-git-repo',
  'merge-branch-unknown',
  'merge-git-failure',
  'merge-commit-failed',
  'merge-audit-divergence',
  // 3 retroactive worktree halt codes (slice 3 used them without registering)
  'worktree-path-escape',
  'worktree-path-conflict',
  'worktree-not-a-git-repo',
];

test('slice-7: all 11 new halt codes are present in HALT_MAP', () => {
  for (const code of SLICE7_NEW_HALT_CODES) {
    assert.ok(HALT_MAP.has(code), `HALT_MAP must contain "${code}"`);
  }
});

test('slice-7: all 11 new halt codes are mapped to terminal: true', () => {
  for (const code of SLICE7_NEW_HALT_CODES) {
    const entry = HALT_MAP.get(code);
    assert.ok(entry, `HALT_MAP must contain "${code}"`);
    assert.equal(entry.terminal, true, `"${code}" must be terminal: true`);
  }
});

test('slice-7: all 11 new halt codes have non-empty resume_hint', () => {
  for (const code of SLICE7_NEW_HALT_CODES) {
    const entry = HALT_MAP.get(code);
    assert.ok(entry, `HALT_MAP must contain "${code}"`);
    assert.ok(
      typeof entry.resume_hint === 'string' && entry.resume_hint.length > 0,
      `"${code}" must have a non-empty resume_hint`
    );
  }
});

test('slice-7: isTerminalHalt returns true for all 11 new halt codes', () => {
  for (const code of SLICE7_NEW_HALT_CODES) {
    const env = wrapAsHaltEnvelope(code);
    assert.equal(
      isTerminalHalt(env),
      true,
      `isTerminalHalt must return true for "${code}"`
    );
  }
});

test('slice-7: HALT_MAP total key count snapshot updated (37 + 11 new = 48)', () => {
  // Snapshot the total count so additions are always explicit.
  assert.equal(HALT_MAP.size, 48, 'HALT_MAP must have exactly 48 entries after slice-7 additions');
});

test('slice-7: snapshot terminal vs transient classification includes new codes', () => {
  // Updated snapshot with 11 new terminal codes added.
  const terminalInMap = [];
  const transientInMap = [];
  for (const [reason, entry] of HALT_MAP) {
    if (entry.terminal) {
      terminalInMap.push(reason);
    } else {
      transientInMap.push(reason);
    }
  }

  terminalInMap.sort();
  transientInMap.sort();

  // Transient set unchanged.
  assert.deepEqual(transientInMap, [
    'dispatch-retry-eligible',
    'panel-quorum-lost',
    'transient-network',
  ]);

  // Terminal set now includes all 11 new codes.
  const expectedTerminal = [
    'claude-cli-auth-missing',
    'claude-cli-auth-rejected',
    'claude-cli-protocol-unsupported',
    'cli-dispatch-failed',
    'codex-blocked',
    'codex-cli-blocked',
    'codex-needs-context',
    'expert-blocker',
    'implementer-cap-exceeded',
    'implementer-claimed-file-violation',
    'implementer-claimed-files-missing',
    'implementer-directive-malformed',
    'implementer-high-cost-rationale-missing',
    'implementer-member-id-invalid',
    'implementer-required-child-failed',
    'mailbox-delivery-failed',
    'merge-audit-divergence',
    'merge-branch-unknown',
    'merge-commit-failed',
    'merge-conflict',
    'merge-conflict-double-ship-failed',
    'merge-git-failure',
    'merge-integration-busy',
    'merge-integration-dirty',
    'merge-integration-not-a-git-repo',
    'merger-out-of-scope',
    'ollama-cloud-route-invalid',
    'override-cli-unavailable',
    'override-variant-unknown',
    'panel-config-invalid',
    'panel-disagreement',
    'panel-quorum-unavailable',
    'parallel-files-malformed',
    'post-merge-review-revise',
    'reconciler-failed',
    'role-composer-fan-out-unjustified',
    'sidecar-replay-concurrent-order-invalid',
    'subagent-blocked',
    'subagent-needs-context',
    'user-input-required',
    'worktree-create-failed',
    'worktree-dirty-before-dispatch',
    'worktree-not-a-git-repo',
    'worktree-path-conflict',
    'worktree-path-escape',
  ];
  assert.deepEqual(terminalInMap, expectedTerminal);
});
