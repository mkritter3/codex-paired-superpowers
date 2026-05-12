// v0.9.0 slice 1 — adapter registry tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAdapter,
  getAdapterConfig,
  RegistryError,
  _resetRegistryCache,
} from '../../../../lib/codex-bridge/cli-harness/adapters/registry.js';

test('registry resolves the codex adapter to a dispatch function', async () => {
  _resetRegistryCache();
  const adapter = await getAdapter('codex');
  assert.equal(typeof adapter.dispatch, 'function');
  assert.equal(adapter.config.name, 'codex');
});

test('registry rejects unknown CLI names with RegistryError', async () => {
  _resetRegistryCache();
  await assert.rejects(
    () => getAdapter('definitely-not-a-real-cli'),
    (err) => err instanceof RegistryError && err.code === 'UNKNOWN_ADAPTER',
  );
});

test('registry rejects config-only entries (claude is claude-task runtime)', async () => {
  _resetRegistryCache();
  await assert.rejects(
    () => getAdapter('claude'),
    (err) =>
      err instanceof RegistryError && err.code === 'NOT_CLI_HARNESS',
  );
});

test('getAdapterConfig returns parsed JSON from cli-clients/<name>.json', () => {
  _resetRegistryCache();
  const codexCfg = getAdapterConfig('codex');
  assert.equal(codexCfg.name, 'codex');
  assert.equal(codexCfg.command, 'codex');
  assert.ok(
    codexCfg.permissions && codexCfg.permissions['read-only'],
    'codex.json must declare a read-only permission profile',
  );
});

test('getAdapterConfig surfaces unknown names as RegistryError', () => {
  _resetRegistryCache();
  assert.throws(
    () => getAdapterConfig('nonexistent-adapter'),
    (err) => err instanceof RegistryError && err.code === 'UNKNOWN_ADAPTER',
  );
});
