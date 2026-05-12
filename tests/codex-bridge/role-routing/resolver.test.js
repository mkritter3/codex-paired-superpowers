// v0.9.0 slice 3 — tests for lib/codex-bridge/role-routing/resolver.js.
//
// Result-oriented: assert returned resolution objects + thrown
// RoleRoutingError.code, never internal mock-invocation counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveAdapter,
  RoleRoutingError,
} from '../../../lib/codex-bridge/role-routing/resolver.js';

test('override path: cli available → resolution_source: "override"', () => {
  const result = resolveAdapter(
    'expert-architecture',
    new Set(['claude']),
    new Map([['expert-architecture', { cli: 'claude' }]]),
  );
  assert.equal(result.cli, 'claude');
  assert.equal(result.variant, null);
  assert.equal(result.resolution_source, 'override');
  assert.equal(result.permissions, 'read-only');
  assert.deepEqual(result.audit_warnings, []);
});

test('override path: cli unavailable → HARD HALT override-cli-unavailable', () => {
  assert.throws(
    () =>
      resolveAdapter(
        'expert-architecture',
        new Set(),
        new Map([['expert-architecture', { cli: 'claude' }]]),
      ),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'override-cli-unavailable',
  );
});

test('ladder walk: first preference available → preference_index 0', () => {
  const result = resolveAdapter(
    'expert-architecture',
    new Set(['codex', 'claude']),
    new Map(),
  );
  assert.equal(result.cli, 'codex');
  assert.equal(result.variant, null);
  assert.equal(result.resolution_source, 'recommendation');
  assert.equal(result.preference_index, 0);
  assert.deepEqual(result.unavailable_candidates, []);
  assert.equal(result.fallback_reason, null);
  assert.deepEqual(result.preference_ladder, ['codex', 'claude']);
});

test('ladder walk: skip unavailable to second → preference_index 1, unavailable_candidates populated', () => {
  const result = resolveAdapter(
    'expert-architecture',
    new Set(['claude']),
    new Map(),
  );
  assert.equal(result.cli, 'claude');
  assert.equal(result.preference_index, 1);
  assert.deepEqual(result.unavailable_candidates, ['codex']);
  assert.ok(
    result.fallback_reason && /codex/.test(result.fallback_reason),
    'fallback_reason mentions skipped CLI',
  );
});

test('ladder walk: full ladder unavailable → HARD HALT no-supported-cli-for-role', () => {
  assert.throws(
    () =>
      resolveAdapter(
        'expert-architecture',
        new Set(),
        new Map(),
      ),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'no-supported-cli-for-role',
  );
});

test('variant resolution from preference ladder', () => {
  // expert-ux ladder: claude → gemini → ollama{kimi-k2.6} → ollama{glm-5.1} → codex.
  // Only ollama is available; expect index 2 with variant kimi-k2.6.
  const result = resolveAdapter(
    'expert-ux',
    new Set(['ollama']),
    new Map(),
  );
  assert.equal(result.cli, 'ollama');
  assert.equal(result.variant, 'kimi-k2.6');
  assert.equal(result.preference_index, 2);
  assert.deepEqual(result.unavailable_candidates, ['claude', 'gemini']);
  assert.equal(result.resolution_source, 'recommendation');
});

test('variant override resolves when variant is declared', () => {
  const result = resolveAdapter(
    'expert-ux',
    new Set(['ollama']),
    new Map([
      ['expert-ux', { cli: 'ollama', variant: 'kimi-k2.6' }],
    ]),
  );
  assert.equal(result.cli, 'ollama');
  assert.equal(result.variant, 'kimi-k2.6');
  assert.equal(result.resolution_source, 'override');
});

test('variant override with unknown variant → HARD HALT override-variant-unknown', () => {
  assert.throws(
    () =>
      resolveAdapter(
        'expert-ux',
        new Set(['ollama']),
        new Map([
          ['expert-ux', { cli: 'ollama', variant: 'nonexistent' }],
        ]),
      ),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'override-variant-unknown',
  );
});

test('reviewer + write-allowed override emits audit warning', () => {
  const result = resolveAdapter(
    'paired-reviewer',
    new Set(['codex']),
    new Map([
      ['paired-reviewer', { cli: 'codex', permissions: 'write-allowed' }],
    ]),
  );
  assert.equal(result.permissions, 'write-allowed');
  assert.ok(result.audit_warnings.length > 0, 'expected audit warning');
  assert.ok(
    result.audit_warnings.some((w) => /reviewer-role-write-allowed/.test(w)),
    'audit warning mentions reviewer-role-write-allowed',
  );
});

test('implementer + write-allowed → no audit warning', () => {
  const result = resolveAdapter(
    'implementer',
    new Set(['claude']),
    new Map(),
  );
  assert.equal(result.permissions, 'write-allowed');
  assert.deepEqual(result.audit_warnings, []);
});

test('resolution_source: "implicit-fallback" is never returned in v0.9.0', () => {
  // Sample every happy-path resolution to confirm.
  const happyPaths = [
    resolveAdapter('paired-reviewer', new Set(['codex']), new Map()),
    resolveAdapter('expert-architecture', new Set(['claude']), new Map()),
    resolveAdapter('expert-ui', new Set(['claude']), new Map()),
    resolveAdapter('expert-ux', new Set(['ollama']), new Map()),
    resolveAdapter(
      'implementer',
      new Set(['claude']),
      new Map([['implementer', { cli: 'claude' }]]),
    ),
  ];
  for (const r of happyPaths) {
    assert.notEqual(r.resolution_source, 'implicit-fallback');
    assert.ok(['override', 'recommendation'].includes(r.resolution_source));
  }
});

test('all hard-halt errors are RoleRoutingError with .code set', () => {
  // override-cli-unavailable
  try {
    resolveAdapter(
      'expert-architecture',
      new Set(),
      new Map([['expert-architecture', { cli: 'claude' }]]),
    );
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof RoleRoutingError);
    assert.equal(err.code, 'override-cli-unavailable');
  }
  // override-variant-unknown
  try {
    resolveAdapter(
      'expert-ux',
      new Set(['ollama']),
      new Map([['expert-ux', { cli: 'ollama', variant: 'mystery' }]]),
    );
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof RoleRoutingError);
    assert.equal(err.code, 'override-variant-unknown');
  }
  // no-supported-cli-for-role
  try {
    resolveAdapter('expert-architecture', new Set(), new Map());
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof RoleRoutingError);
    assert.equal(err.code, 'no-supported-cli-for-role');
  }
});
