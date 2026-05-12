// v0.9.0 slice 1 — tests for lib/codex-bridge/cli-harness/harness.js.
//
// The harness is the top-level entry that dispatches a CLI turn via a
// named adapter (resolved from cli-clients/<name>.json). It returns a
// normalized DispatchResult.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../../../lib/codex-bridge/cli-harness/harness.js';

const __filename__ = fileURLToPath(import.meta.url);
const __dirname__ = dirname(__filename__);
const FAKE_OLLAMA = join(
  __dirname__,
  '..',
  '..',
  'fixtures',
  'fake-cli',
  'ollama.sh',
);

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

// Codex slice-review polish (slice-2-d1): exercise the real adapter
// registry end-to-end for Ollama. The existing tests use the DI seam
// (`deps.adapters: Map`); this confirms harness → registry → adapter wiring
// works without the test-only DI bypass.
test('harness.dispatch routes {cli:"ollama",variant} through the real registry to the adapter', async () => {
  const argsDir = mkdtempSync(join(tmpdir(), 'harness-ollama-route-'));
  const argsOut = join(argsDir, 'args.txt');

  const result = await dispatch(
    { cli: 'ollama', variant: 'kimi-k2.6' },
    'system',
    'user',
    {
      // Override the command to the fake CLI; the registry/variant
      // resolution path is what's under test, not the binary.
      command: FAKE_OLLAMA,
      env: {
        FAKE_CLI_OUTPUT: 'routed via real registry',
        OLLAMA_FAKE_ARGS_FILE: argsOut,
      },
    },
    // NO `deps.adapters` — force the real registry path.
  );

  assert.equal(result.exit, 0);
  assert.equal(result.responseText, 'routed via real registry');
  assert.equal(result.adapterMeta.model, 'kimi-k2.6:cloud');

  // Variant resolution proof at the harness layer.
  const argv = readFileSync(argsOut, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  assert.ok(
    argv.includes('kimi-k2.6:cloud'),
    `expected argv to include resolved model; got ${JSON.stringify(argv)}`,
  );
});
