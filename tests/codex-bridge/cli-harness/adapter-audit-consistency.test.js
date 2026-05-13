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
      const result = await mod.dispatch('system', 'user', {
        command: script,
        args: [],
        variant: 'kimi-k2.6',
        timeout_ms: 1000,
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
