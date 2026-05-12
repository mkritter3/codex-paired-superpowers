// v0.9.0 slice 2 — tests for lib/codex-bridge/cli-harness/adapters/ollama.js.
//
// Uses the bash fake-CLI fixture at tests/fixtures/fake-cli/ollama.sh to
// pin subprocess behavior. The adapter spawns `ollama run <resolved-model>`,
// pipes prompts to stdin, reads plain-text stdout, and returns a normalized
// DispatchResult (same shape as the codex adapter, minus the JSON event
// stream parsing).
//
// Variant resolution is asserted by having the fake CLI write its argv
// to an OLLAMA_FAKE_ARGS_FILE side file; the tests read that file back
// to confirm the adapter resolved `kimi-k2.6` → `kimi-k2.6:cloud` before
// spawning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  dispatch,
  OllamaAdapterError,
} from '../../../../lib/codex-bridge/cli-harness/adapters/ollama.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_OLLAMA = join(
  __dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'fake-cli',
  'ollama.sh',
);

function argsFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-adapter-test-'));
  return join(dir, 'args.txt');
}

function readArgs(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

test('ollama adapter: kimi-k2.6 variant resolves to kimi-k2.6:cloud and returns responseText', async () => {
  const argsOut = argsFile();
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: {
      FAKE_CLI_OUTPUT: 'Hello from Kimi',
      OLLAMA_FAKE_ARGS_FILE: argsOut,
    },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.responseText, 'Hello from Kimi');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.adapterMeta.model, 'kimi-k2.6:cloud');
  // Variant resolution proof: the fake CLI was invoked with the cloud-
  // suffixed model name, not the bare variant alias.
  const argv = readArgs(argsOut);
  assert.ok(
    argv.includes('kimi-k2.6:cloud'),
    `expected argv to include the resolved model; got ${JSON.stringify(argv)}`,
  );
  assert.ok(
    argv.includes('run'),
    `expected ollama to be invoked with the 'run' subcommand; got ${JSON.stringify(argv)}`,
  );
  assert.equal(typeof result.duration_ms, 'number');
  assert.ok(result.duration_ms >= 0);
});

test('ollama adapter: glm-5.1 variant resolves to glm-5.1:cloud', async () => {
  const argsOut = argsFile();
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'glm-5.1',
    env: {
      FAKE_CLI_OUTPUT: 'GLM response',
      OLLAMA_FAKE_ARGS_FILE: argsOut,
    },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.responseText, 'GLM response');
  assert.equal(result.adapterMeta.model, 'glm-5.1:cloud');
  const argv = readArgs(argsOut);
  assert.ok(
    argv.includes('glm-5.1:cloud'),
    `expected argv to include glm-5.1:cloud; got ${JSON.stringify(argv)}`,
  );
});

test('ollama adapter: missing variant rejects with OllamaAdapterError', async () => {
  await assert.rejects(
    () => dispatch('system', 'user', { command: FAKE_OLLAMA }),
    (err) => err instanceof OllamaAdapterError && /variant/i.test(err.message),
  );
});

test('ollama adapter: invalid variant (not in cli-clients/ollama.json) rejects', async () => {
  await assert.rejects(
    () =>
      dispatch('system', 'user', {
        command: FAKE_OLLAMA,
        variant: 'gpt-99-nonexistent',
      }),
    (err) =>
      err instanceof OllamaAdapterError &&
      /gpt-99-nonexistent/.test(err.message),
  );
});

test('ollama adapter: nonzero exit normalizes to cli-exit-nonzero warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: { FAKE_CLI_EXIT: '1' },
  });
  assert.equal(result.exit, 1);
  assert.equal(result.responseText, '');
  assert.ok(
    result.warnings.includes('cli-exit-nonzero'),
    `expected cli-exit-nonzero warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('ollama adapter: unauthorized stderr → ollama-cloud-unauthenticated warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: {
      FAKE_CLI_EXIT: '1',
      FAKE_CLI_STDERR: 'Error: unauthorized — Ollama Cloud token expired',
    },
  });
  assert.equal(result.exit, 1);
  assert.ok(
    result.warnings.includes('ollama-cloud-unauthenticated'),
    `expected ollama-cloud-unauthenticated warning, got ${JSON.stringify(result.warnings)}`,
  );
  // Stderr passthrough preserved for diagnostics.
  const stderrLine = result.warnings.find((w) => w.startsWith('stderr:'));
  assert.ok(
    stderrLine && stderrLine.includes('unauthorized'),
    `expected stderr passthrough, got ${JSON.stringify(result.warnings)}`,
  );
});

test('ollama adapter: rate-limited stderr → ollama-rate-limited warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: {
      FAKE_CLI_OUTPUT: 'partial response',
      FAKE_CLI_STDERR: 'Warning: rate limit exceeded — retry later',
    },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.responseText, 'partial response');
  assert.ok(
    result.warnings.includes('ollama-rate-limited'),
    `expected ollama-rate-limited warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('ollama adapter: missing binary → spawn-failed warning + ENOENT preserved', async () => {
  const result = await dispatch('system', 'user', {
    command: '/definitely/not/a/real/ollama-binary',
    variant: 'kimi-k2.6',
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
  assert.equal(result.adapterMeta.errorCode, 'ENOENT');
});

test('ollama adapter: timeout via AbortController → exit 137, timeout warning', async () => {
  const t0 = Date.now();
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
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

test('ollama adapter: empty stdout on success → empty-output warning, responseText \'\'', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: { FAKE_CLI_OUTPUT: '' },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.responseText, '');
  assert.ok(
    result.warnings.includes('empty-output'),
    `expected empty-output warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test('ollama adapter: stdout truncation triggers stdout-truncated warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: { FAKE_CLI_OUTPUT: 'a'.repeat(1000) },
    maxBufferBytes: 100,
  });
  assert.ok(
    result.warnings.includes('stdout-truncated'),
    `expected stdout-truncated warning, got ${JSON.stringify(result.warnings)}`,
  );
});

// Codex slice-review polish (slice-2-d2): the Ollama adapter shares the
// same buffer-cap branches as the codex adapter, but only stdout-truncated
// was tested directly. This pins the symmetric stderr branch.
test('ollama adapter: stderr truncation triggers stderr-truncated warning', async () => {
  const result = await dispatch('system', 'user', {
    command: FAKE_OLLAMA,
    variant: 'kimi-k2.6',
    env: { FAKE_CLI_STDERR: 'x'.repeat(1000) },
    maxBufferBytes: 100,
  });
  assert.ok(
    result.warnings.includes('stderr-truncated'),
    `expected stderr-truncated warning, got ${JSON.stringify(result.warnings)}`,
  );
});
