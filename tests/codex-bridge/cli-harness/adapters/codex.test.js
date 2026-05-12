// v0.9.0 slice 1 — tests for lib/codex-bridge/cli-harness/adapters/codex.js.
//
// Uses the bash fake-CLI fixture at tests/fixtures/fake-cli/codex.sh to
// pin subprocess behavior. The adapter spawns the configured command,
// pipes prompts to stdin, parses --json events on stdout, and returns a
// normalized DispatchResult.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../../../../lib/codex-bridge/cli-harness/adapters/codex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_CODEX = join(__dirname, '..', '..', '..', 'fixtures', 'fake-cli', 'codex.sh');

function buildEvents(textChunks) {
  return textChunks
    .map((t) =>
      JSON.stringify({ type: 'assistant-text', text: t }),
    )
    .join('\n');
}

test('codex adapter happy path: parses --json events into responseText', async () => {
  const events = buildEvents(['hello ', 'world']);
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: {
      FAKE_CLI_OUTPUT_JSON_EVENTS: events,
      FAKE_CLI_EXIT: '0',
    },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.responseText, 'hello world');
  assert.deepEqual(result.warnings, []);
  assert.equal(typeof result.adapterMeta, 'object');
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
});

test('codex adapter nonzero exit: normalizes to cli-exit-nonzero warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: { FAKE_CLI_EXIT: '1' },
  });
  assert.equal(result.exit, 1);
  assert.equal(result.responseText, '');
  assert.ok(
    result.warnings.includes('cli-exit-nonzero'),
    `expected cli-exit-nonzero warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('codex adapter passes stderr through as a normalized warning', async () => {
  const events = buildEvents(['ok']);
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: {
      FAKE_CLI_OUTPUT_JSON_EVENTS: events,
      FAKE_CLI_STDERR: 'rate-limited',
    },
  });
  assert.equal(result.exit, 0);
  const stderrWarning = result.warnings.find((w) =>
    w.startsWith('stderr:'),
  );
  assert.ok(
    stderrWarning && stderrWarning.includes('rate-limited'),
    `expected stderr warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('codex adapter malformed stdout: exit 1, malformed-output warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: { FAKE_CLI_OUTPUT: 'not json' },
  });
  assert.equal(result.exit, 1);
  assert.ok(
    result.warnings.includes('malformed-output'),
    `expected malformed-output warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('codex adapter timeout: killed by AbortController, exit 137, timeout warning', async () => {
  const t0 = Date.now();
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: { FAKE_CLI_HANG: '1' },
    timeout_ms: 100,
  });
  const elapsed = Date.now() - t0;
  assert.equal(result.exit, 137);
  assert.ok(
    result.warnings.includes('timeout'),
    `expected timeout warning, got ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(elapsed < 2000, `kill should be prompt; took ${elapsed}ms`);
});

test('codex adapter missing binary: spawn-failed warning + error preserved', async () => {
  const result = await dispatch('system', 'user', {
    command: '/definitely/not/a/real/codex-binary',
    args: [],
  });
  assert.equal(result.exit, 1);
  assert.equal(result.responseText, '');
  assert.ok(
    result.warnings.includes('spawn-failed'),
    `expected spawn-failed warning, got ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    result.adapterMeta && result.adapterMeta.error,
    'adapterMeta.error must be populated',
  );
  // ENOENT is the typical code for missing binary on POSIX.
  assert.equal(result.adapterMeta.errorCode, 'ENOENT');
});

test('codex adapter stdout truncation: large output triggers stdout-truncated warning', async () => {
  // Override the buffer cap to keep the test fast; emit ~1KB of JSON events
  // so the cap (100 bytes) catches it.
  const events = buildEvents(['a'.repeat(1000)]);
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: { FAKE_CLI_OUTPUT_JSON_EVENTS: events },
    maxBufferBytes: 100,
  });
  assert.ok(
    result.warnings.includes('stdout-truncated'),
    `expected stdout-truncated warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('codex adapter stderr truncation: large stderr triggers stderr-truncated warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_CODEX,
    args: [],
    env: { FAKE_CLI_STDERR: 'x'.repeat(1000) },
    maxBufferBytes: 100,
  });
  assert.ok(
    result.warnings.includes('stderr-truncated'),
    `expected stderr-truncated warning, got ${JSON.stringify(result.warnings)}`,
  );
});
