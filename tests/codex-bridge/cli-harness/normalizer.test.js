// v0.9.0 slice 1 — normalizer.js: enforce canonical DispatchResult shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDispatchResult } from '../../../lib/codex-bridge/cli-harness/normalizer.js';

test('normalizeDispatchResult fills missing fields with sane defaults', () => {
  const out = normalizeDispatchResult({ responseText: 'hi' });
  assert.equal(out.responseText, 'hi');
  assert.equal(out.exit, 0);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.sessionId, null);
  assert.deepEqual(out.adapterMeta, {});
  assert.equal(out.duration_ms, 0);
});

test('normalizeDispatchResult preserves explicit canonical values', () => {
  const out = normalizeDispatchResult({
    responseText: 'r',
    exit: 137,
    warnings: ['timeout'],
    sessionId: 'sess-123',
    adapterMeta: { adapter: 'codex' },
    duration_ms: 42,
  });
  assert.equal(out.responseText, 'r');
  assert.equal(out.exit, 137);
  assert.deepEqual(out.warnings, ['timeout']);
  assert.equal(out.sessionId, 'sess-123');
  assert.deepEqual(out.adapterMeta, { adapter: 'codex' });
  assert.equal(out.duration_ms, 42);
});

test('normalizeDispatchResult moves extras into adapterMeta', () => {
  const out = normalizeDispatchResult({
    responseText: 'hi',
    rawStdout: 'noise',
    customField: 99,
  });
  assert.equal(out.adapterMeta.rawStdout, 'noise');
  assert.equal(out.adapterMeta.customField, 99);
});

test('normalizeDispatchResult keeps explicit null sessionId', () => {
  const out = normalizeDispatchResult({ responseText: 'hi', sessionId: null });
  assert.equal(out.sessionId, null);
});

test('normalizeDispatchResult tolerates non-object input', () => {
  const out = normalizeDispatchResult(null);
  assert.equal(out.responseText, '');
  assert.equal(out.exit, 0);
  assert.deepEqual(out.warnings, []);
});
