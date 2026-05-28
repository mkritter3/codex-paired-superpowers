// v0.10.0 slice 5 — registry tests for claude-cli adapter registration.
//
// Verifies:
//   - getAdapter('claude-cli') resolves without throwing
//   - cli-clients/claude-cli.json is present + parseable + has correct keys
//   - Registry still rejects 'claude' with NOT_CLI_HARNESS (claude-task runtime)
//   - Registry still resolves 'codex' correctly

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getAdapter,
  getAdapterConfig,
  RegistryError,
  _resetRegistryCache,
} from '../../../../lib/codex-bridge/cli-harness/adapters/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_CLIENTS_DIR = join(__dirname, '..', '..', '..', '..', 'lib', 'codex-bridge', 'cli-clients');

// ── getAdapter('claude-cli') ──────────────────────────────────────────────────

test('registry resolves claude-cli adapter to a dispatch function', async () => {
  _resetRegistryCache();
  const adapter = await getAdapter('claude-cli');
  assert.equal(typeof adapter.dispatch, 'function',
    'getAdapter("claude-cli") should return an object with a dispatch function');
  assert.equal(adapter.config.name, 'claude-cli',
    'config.name should be claude-cli');
});

// ── cli-clients/claude-cli.json ────────────────────────────────────────────────

test('cli-clients/claude-cli.json is present and parseable', () => {
  _resetRegistryCache();
  const jsonPath = join(CLI_CLIENTS_DIR, 'claude-cli.json');
  let parsed;
  assert.doesNotThrow(() => {
    const raw = readFileSync(jsonPath, 'utf8');
    parsed = JSON.parse(raw);
  }, 'claude-cli.json must exist and be valid JSON');
  assert.equal(parsed.name, 'claude-cli', 'name must be "claude-cli"');
  assert.equal(parsed.command, 'claude', 'command must be "claude"');
  // claude-cli dispatches via the cli-harness (adapters/claude-cli.js), so its runtime_kind is
  // "cli-harness" — NOT "claude-cli" (the adapter name). The earlier "claude-cli" value was an
  // invalid runtime_kind the config loader rejected; see fix in cli-clients/claude-cli.json.
  assert.equal(parsed.runtime_kind, 'cli-harness', 'runtime_kind must be "cli-harness"');
});

test('getAdapterConfig("claude-cli") returns the expected config fields', () => {
  _resetRegistryCache();
  const config = getAdapterConfig('claude-cli');
  assert.equal(config.name, 'claude-cli');
  assert.equal(config.command, 'claude');
  assert.equal(config.runtime_kind, 'cli-harness');
});

// ── JSON loaded before .js (existing registry pattern) ───────────────────────

test('registry loads JSON config before importing .js module', async () => {
  _resetRegistryCache();
  // getAdapterConfig is synchronous (reads JSON); getAdapter is async (imports .js).
  // Verify getAdapterConfig works standalone without triggering any .js import.
  const config = getAdapterConfig('claude-cli');
  assert.ok(config !== null && typeof config === 'object',
    'getAdapterConfig must return parsed JSON before .js import');
  assert.equal(config.name, 'claude-cli');
  // Now getAdapter should succeed too.
  const adapter = await getAdapter('claude-cli');
  assert.equal(typeof adapter.dispatch, 'function');
});

// ── Back-compat: claude stays NOT_CLI_HARNESS ─────────────────────────────────

test('compat: getAdapter("claude") still throws NOT_CLI_HARNESS', async () => {
  _resetRegistryCache();
  await assert.rejects(
    () => getAdapter('claude'),
    (err) => err instanceof RegistryError && err.code === 'NOT_CLI_HARNESS',
    'claude (claude-task runtime_kind) must still be rejected as NOT_CLI_HARNESS',
  );
});

// ── Back-compat: codex still works ───────────────────────────────────────────

test('compat: getAdapter("codex") still resolves correctly', async () => {
  _resetRegistryCache();
  const adapter = await getAdapter('codex');
  assert.equal(typeof adapter.dispatch, 'function',
    'getAdapter("codex") should still work after claude-cli registration');
  assert.equal(adapter.config.name, 'codex');
});
