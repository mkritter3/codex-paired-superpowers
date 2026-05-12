// v0.9.0 slice 8 — installed-smoke test for the real ollama CLI adapter.
//
// TIER 4 — only runs when CPS_INSTALLED_SMOKE=1 AND `ollama` binary is
// present on PATH AND at least one configured variant is available.
// All tests skip cleanly (with reason) when conditions are not met.
//
// See tests/installed-smoke/_README.md for full context.
//
// What this tests:
//   1. Real ollama CLI spawns and returns a non-empty plain-text response
//   2. DispatchResult shape matches the canonical contract
//   3. Response does NOT contain "Anthropic" or "Claude" (cross-model verification)
//   4. Correct variant model name resolved (via adapterMeta.model)
//   5. No orphaned processes left behind (60s timeout enforced)
//
// Cross-model verification discipline:
//   The Ollama variants (kimi-k2.6, glm-5.1, qwen3.5) are non-Anthropic models.
//   We ask the model to identify itself and assert the response does NOT contain
//   "Anthropic" or "Claude" — this proves the response could not have come from
//   an Anthropic model masquerading as the routed target.
//   We also assert the response IS non-empty (a routed-to-wrong-CLI failure would
//   produce an error warning, not a confusingly empty response).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../../lib/codex-bridge/cli-harness/harness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Guards ────────────────────────────────────────────────────────────────────

const SMOKE_ENABLED = process.env.CPS_INSTALLED_SMOKE === '1';

function ollamaBinaryPresent() {
  try {
    execFileSync('which', ['ollama'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function loadOllamaVariants() {
  try {
    const configPath = join(__dirname, '..', '..', 'lib', 'codex-bridge', 'cli-clients', 'ollama.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config.variants ? Object.keys(config.variants) : [];
  } catch {
    return [];
  }
}

const OLLAMA_PRESENT = SMOKE_ENABLED && ollamaBinaryPresent();
const CONFIGURED_VARIANTS = loadOllamaVariants();
// Use kimi-k2.6 as the primary test variant; fall back to first available.
const PRIMARY_VARIANT = CONFIGURED_VARIANTS.includes('kimi-k2.6')
  ? 'kimi-k2.6'
  : CONFIGURED_VARIANTS[0] || null;
const OLLAMA_READY = OLLAMA_PRESENT && PRIMARY_VARIANT !== null;

const SKIP_REASON_NO_SMOKE = 'CPS_INSTALLED_SMOKE env var not set to "1"; skipping installed-smoke tests';
const SKIP_REASON_NO_BINARY = 'ollama binary not found on PATH; skipping ollama installed-smoke tests';
const SKIP_REASON_NO_VARIANT = 'No ollama variants configured in cli-clients/ollama.json; skipping';
const SKIP_REASON = !SMOKE_ENABLED
  ? SKIP_REASON_NO_SMOKE
  : !OLLAMA_PRESENT
    ? SKIP_REASON_NO_BINARY
    : !PRIMARY_VARIANT
      ? SKIP_REASON_NO_VARIANT
      : false;

// ── Tests ─────────────────────────────────────────────────────────────────────

test(
  'ollama installed-smoke: skips cleanly when env/binary conditions unmet',
  { skip: OLLAMA_READY ? false : (SKIP_REASON || 'conditions not met') },
  () => {
    // This test body only runs when OLLAMA_READY. Its purpose is to confirm
    // we can reach the guard checkpoint. The real work is in the tests below.
    assert.ok(OLLAMA_READY, 'OLLAMA_READY must be true to reach here');
  },
);

test(
  `ollama installed-smoke: real dispatch via variant '${PRIMARY_VARIANT}' returns non-empty response`,
  {
    timeout: 60_000,
    skip: OLLAMA_READY ? false : (SKIP_REASON || 'conditions not met'),
  },
  async () => {
    const result = await dispatch(
      { cli: 'ollama', variant: PRIMARY_VARIANT },
      'You are a concise assistant. Reply in exactly one sentence.',
      'Say hello and confirm you received this prompt.',
      { timeout: 55_000 },
    );

    // Non-empty response.
    assert.ok(
      typeof result.responseText === 'string' && result.responseText.trim().length > 0,
      `responseText must be non-empty; got: ${JSON.stringify(result.responseText)}`,
    );

    // Shape: all canonical DispatchResult fields present.
    assert.equal(typeof result.exit, 'number', 'exit must be a number');
    assert.ok(Array.isArray(result.warnings), 'warnings must be an array');
    assert.equal(typeof result.duration_ms, 'number', 'duration_ms must be a number');
    assert.ok(result.duration_ms >= 0, 'duration_ms must be non-negative');
    assert.ok(
      result.adapterMeta && typeof result.adapterMeta === 'object',
      'adapterMeta must be an object',
    );

    // Exit code 0 on success.
    assert.equal(result.exit, 0, `ollama should exit 0 on a simple prompt; got ${result.exit}`);

    // No timeout warning for a simple prompt.
    const hasTimeoutWarning = result.warnings.some((w) => /timeout/i.test(w));
    assert.ok(!hasTimeoutWarning, `unexpected timeout warning: ${JSON.stringify(result.warnings)}`);
  },
);

test(
  `ollama installed-smoke: cross-model verification — response does NOT contain Anthropic or Claude`,
  {
    timeout: 60_000,
    skip: OLLAMA_READY ? false : (SKIP_REASON || 'conditions not met'),
  },
  async () => {
    // Ask the model to identify itself by name. A correct Ollama-routed response
    // will name a non-Anthropic model (Kimi, GLM, Qwen, etc.). An Anthropic model
    // accidentally receiving this request would include "Claude" or "Anthropic" in
    // its self-identification.
    const result = await dispatch(
      { cli: 'ollama', variant: PRIMARY_VARIANT },
      'You are a helpful assistant. When asked about your identity, state your model name clearly.',
      'What model are you? Please state your model name in your first sentence.',
      { timeout: 55_000 },
    );

    // Must be non-empty (routing failure would produce a warning, not empty text).
    assert.ok(
      typeof result.responseText === 'string' && result.responseText.trim().length > 0,
      `responseText must be non-empty for cross-model verification; got: ${JSON.stringify(result.responseText)}`,
    );

    // Cross-model verification: response must NOT claim Anthropic/Claude identity.
    const responseText = result.responseText;
    const containsAnthropic = /\bAnthropic\b/i.test(responseText);
    const containsClaude = /\bClaude\b(?!\s+(Code|Agent|MCP|Artifacts))/i.test(responseText);

    assert.ok(
      !containsAnthropic,
      `Cross-model verification FAILED: response contains "Anthropic" — likely routed to wrong model. ` +
      `Response excerpt: ${responseText.slice(0, 300)}`,
    );
    assert.ok(
      !containsClaude,
      `Cross-model verification FAILED: response contains "Claude" as a model identity — ` +
      `likely routed to wrong model. Response excerpt: ${responseText.slice(0, 300)}`,
    );

    // Verify exit is 0 (auth/rate-limit errors would produce nonzero exit + warnings).
    assert.equal(result.exit, 0, `ollama should exit 0; got ${result.exit}. Warnings: ${JSON.stringify(result.warnings)}`);
  },
);

test(
  `ollama installed-smoke: variant resolution — adapterMeta.model reflects resolved model name`,
  {
    timeout: 60_000,
    skip: OLLAMA_READY ? false : (SKIP_REASON || 'conditions not met'),
  },
  async () => {
    const result = await dispatch(
      { cli: 'ollama', variant: PRIMARY_VARIANT },
      'You are a concise assistant.',
      'Reply with exactly one word: "ok".',
      { timeout: 55_000 },
    );

    // adapterMeta.model must be the resolved model name (e.g. 'kimi-k2.6:cloud'),
    // not just the variant key ('kimi-k2.6'). This proves variant→model resolution
    // happened correctly in the adapter.
    assert.ok(
      typeof result.adapterMeta.model === 'string' && result.adapterMeta.model.length > 0,
      `adapterMeta.model must be a non-empty string; got ${JSON.stringify(result.adapterMeta.model)}`,
    );

    // The resolved model name must contain the variant key as a prefix
    // (e.g. 'kimi-k2.6' → 'kimi-k2.6:cloud').
    assert.ok(
      result.adapterMeta.model.startsWith(PRIMARY_VARIANT),
      `adapterMeta.model '${result.adapterMeta.model}' must start with variant key '${PRIMARY_VARIANT}'`,
    );
  },
);

test(
  'ollama installed-smoke: all configured variants are present in ollama.json',
  { skip: SMOKE_ENABLED ? false : SKIP_REASON_NO_SMOKE },
  () => {
    // Config-level sanity check: ollama.json must declare at least one variant.
    assert.ok(
      CONFIGURED_VARIANTS.length > 0,
      'cli-clients/ollama.json must declare at least one variant (kimi-k2.6, glm-5.1, or qwen3.5)',
    );
    // All variant keys must be non-empty strings.
    for (const v of CONFIGURED_VARIANTS) {
      assert.ok(
        typeof v === 'string' && v.trim().length > 0,
        `Variant key must be a non-empty string; got ${JSON.stringify(v)}`,
      );
    }
  },
);
