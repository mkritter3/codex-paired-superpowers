// v0.9.0 slice 1 — tests for lib/codex-bridge/cli-harness/harness.js.
//
// The harness is the top-level entry that dispatches a CLI turn via a
// named adapter (resolved from cli-clients/<name>.json). It returns a
// normalized DispatchResult.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../../../lib/codex-bridge/cli-harness/harness.js';

// A fake adapter that the tests can register via the optional `adapters`
// dependency-injection seam, so we don't depend on real CLI fixtures here.
function makeFakeAdapter(returnValue = {}) {
  const calls = [];
  return {
    calls,
    dispatch(systemPrompt, userPrompt, options) {
      calls.push({ systemPrompt, userPrompt, options });
      return Promise.resolve({
        responseText: 'hi',
        exit: 0,
        warnings: [],
        adapterMeta: { adapter: 'fake' },
        duration_ms: 1,
        ...returnValue,
      });
    },
  };
}

test('harness.dispatch returns normalized DispatchResult on happy path', async () => {
  const fake = makeFakeAdapter();
  const result = await dispatch(
    { cli: 'fake' },
    'system',
    'user',
    {},
    { adapters: new Map([['fake', fake]]) },
  );
  assert.equal(result.responseText, 'hi');
  assert.equal(result.exit, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
  assert.equal(typeof result.adapterMeta, 'object');
  assert.equal(result.adapterMeta.adapter, 'fake');
  // normalizer adds sessionId default
  assert.equal(result.sessionId, null);
});

test('harness.dispatch routes via the adapter registry by name', async () => {
  const fake = makeFakeAdapter();
  await dispatch(
    { cli: 'codex-fake' },
    'sys',
    'usr',
    {},
    { adapters: new Map([['codex-fake', fake]]) },
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].systemPrompt, 'sys');
  assert.equal(fake.calls[0].userPrompt, 'usr');
});

test('harness.dispatch rejects unknown CLI names with RegistryError', async () => {
  await assert.rejects(
    () =>
      dispatch(
        { cli: 'nonexistent' },
        'sys',
        'usr',
        {},
        { adapters: new Map() },
      ),
    (err) => err && err.name === 'RegistryError',
  );
});

test('harness.dispatch forwards variant in options to the adapter', async () => {
  const fake = makeFakeAdapter();
  await dispatch(
    { cli: 'ollama-fake', variant: 'kimi-k2.6' },
    'sys',
    'usr',
    { foo: 'bar' },
    { adapters: new Map([['ollama-fake', fake]]) },
  );
  assert.equal(fake.calls[0].options.variant, 'kimi-k2.6');
  assert.equal(fake.calls[0].options.foo, 'bar');
});

test('harness.dispatch records a non-negative duration_ms', async () => {
  const fake = makeFakeAdapter({ duration_ms: undefined });
  const result = await dispatch(
    { cli: 'fake' },
    'sys',
    'usr',
    {},
    { adapters: new Map([['fake', fake]]) },
  );
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
});
