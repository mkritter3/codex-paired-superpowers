import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ADAPTER_DIR = fileURLToPath(
  new URL('../../../lib/codex-bridge/cli-harness/adapters/', import.meta.url),
);

const EXPECTED_ADAPTER_META = {
  'codex.js': 'cli-harness:codex',
  'ollama.js': 'cli-harness:ollama',
  'gemini.js': 'cli-harness:gemini',
  'qwen.js': 'cli-harness:qwen',
  'claude.js': 'cli-harness:claude',
  // v0.10.0 slice 5: claude-cli adapter (implementer mode, routes to Ollama Cloud / Anthropic API)
  'claude-cli.js': 'cli-harness:claude-cli',
};

// Per-adapter dispatch options overrides. Some adapters require specific options
// that the generic test harness doesn't supply. These are merged into the default
// dispatch options only for the named adapter, so the dispatch call doesn't throw
// during the adapterMeta.adapter audit.
const ADAPTER_EXTRA_OPTIONS = {
  // claude-cli requires cwd, model, and route (implementer-only adapter).
  // We also stub OLLAMA_CLOUD_API_KEY so resolveToken doesn't throw before
  // the spawn attempt (spawn will fail with ENOENT, giving us adapterMeta.adapter).
  'claude-cli.js': {
    cwd: process.cwd(),
    model: 'audit-model',
    route: 'ollama-cloud',
    // Use a fake token so resolveToken succeeds; the command is the empty-success
    // CLI which will be invoked and exit 0 with no JSON output.
    _deps: {
      keychain: { getToken: () => 'audit-test-token' },
    },
  },
};

function makeEmptySuccessCli() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-adapter-audit-'));
  const script = join(dir, 'fake-cli');
  writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(script, 0o755);
  return { dir, script };
}

test('cli-harness adapters: dispatch result includes adapterMeta.adapter', async () => {
  const adapterFiles = readdirSync(ADAPTER_DIR)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => name !== 'registry.js')
    .sort();

  assert.ok(adapterFiles.length > 0, 'expected at least one cli-harness adapter');

  for (const file of adapterFiles) {
    assert.ok(file in EXPECTED_ADAPTER_META, `missing expected adapter value for ${file}`);
    const { dir, script } = makeEmptySuccessCli();
    try {
      const mod = await import(pathToFileURL(join(ADAPTER_DIR, file)).href);
      assert.equal(typeof mod.dispatch, 'function', `${file} must export dispatch()`);
      const extraOpts = ADAPTER_EXTRA_OPTIONS[file] || {};
      const result = await mod.dispatch('system', 'user', {
        command: script,
        args: [],
        variant: 'kimi-k2.6',
        timeout_ms: 1000,
        ...extraOpts,
      });
      assert.equal(
        result.adapterMeta?.adapter,
        EXPECTED_ADAPTER_META[file],
        `${file} must populate adapterMeta.adapter`,
      );
      assert.equal(typeof result.adapterMeta.adapter, 'string');
      assert.ok(result.adapterMeta.adapter.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
