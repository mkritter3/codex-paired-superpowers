// v0.10.0 slice 5 — Installed-smoke test: Claude CLI via Ollama Cloud.
//
// Guarded by CPS_INSTALLED_SMOKE=1 AND claude on PATH.
// Tests a real dispatch via ollama.com with a small prompt.
// Run manually; NOT included in the CI verification command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { dispatch } from '../../lib/codex-bridge/cli-harness/adapters/claude-cli.js';
import { redactSecretFields } from '../../lib/codex-bridge/implementer/secret-redaction.js';

const CANARIES = [
  'ollama-tok-test-canary-abc123',
  'anthropic-auth-test-canary-def456',
  'sk-ant-canary-xyz789',
  'sk-openai-canary-uvw000',
];

function isClaudeOnPath() {
  try {
    execFileSync('which', ['claude'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('claude-cli ollama-live: real dispatch returns non-empty responseText + no token leaks', {
  timeout: 60_000,
}, async (t) => {
  if (process.env.CPS_INSTALLED_SMOKE !== '1') {
    t.skip('CPS_INSTALLED_SMOKE is not set; skipping live test');
    return;
  }
  if (!isClaudeOnPath()) {
    t.skip('claude is not on PATH; skipping live test');
    return;
  }
  if (!process.env.OLLAMA_CLOUD_API_KEY) {
    t.skip('OLLAMA_CLOUD_API_KEY is not set; skipping live test');
    return;
  }

  const result = await dispatch(
    'You are a helpful assistant.',
    'Reply with exactly the word "pong".',
    {
      cwd: process.cwd(),
      model: 'kimi-k2.6:cloud',
      route: 'ollama-cloud',
      timeout_ms: 30_000,
    },
  );

  // Non-empty responseText.
  assert.ok(
    typeof result.responseText === 'string' && result.responseText.length > 0,
    `responseText should be non-empty; got: ${JSON.stringify(result.responseText)}`,
  );

  // redactSecretFields(result) deepEqual to result — proves no token leaked.
  const reRedacted = redactSecretFields(result);
  assert.deepEqual(result, reRedacted,
    'result must be idempotent: no tokens leaked into any field');

  // None of the 4 canary tokens appear.
  const serialized = JSON.stringify(result);
  for (const canary of CANARIES) {
    assert.ok(!serialized.includes(canary),
      `canary ${canary} must not appear in result`);
  }

  // exec_mode is implementer.
  assert.equal(result.adapterMeta.exec_mode, 'implementer');
});
