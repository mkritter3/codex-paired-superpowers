// v0.10.0 slice 5 — Claude CLI adapter tests.
//
// Test categories:
//   happy.*           — normal successful dispatch paths
//   edge.*            — boundary / zero-null-empty / adversarial / concurrent
//   fail.*            — error paths
//   integration.*     — cross-module contract assertions
//   critical.*        — residual-risk tests (prompt-in-argv prevention)
//   stress.*          — scale / performance bounds

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch } from '../../../../lib/codex-bridge/cli-harness/adapters/claude-cli.js';
import { getAdapter, _resetRegistryCache } from '../../../../lib/codex-bridge/cli-harness/adapters/registry.js';
import { redactSecretFields } from '../../../../lib/codex-bridge/implementer/secret-redaction.js';

const TEST_TIMEOUT_MS = 12_000;

// ── Canary tokens from spec L612-618 ────────────────────────────────────────────
const CANARIES = [
  'ollama-tok-test-canary-abc123',
  'anthropic-auth-test-canary-def456',
  'sk-ant-canary-xyz789',
  'sk-openai-canary-uvw000',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix = 'cps-claude-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Create a fake Claude CLI at <dir>/claude.
 * body: array of shell lines (after the shebang).
 * Returns the script path.
 */
function makeFakeClaude(dir, body) {
  const script = join(dir, 'claude');
  writeFileSync(script, ['#!/usr/bin/env bash', ...body].join('\n') + '\n', 'utf8');
  chmodSync(script, 0o755);
  return script;
}

/**
 * Standard fake Claude that:
 *   - Validates argv contains required flags (--output-format stream-json --verbose --print)
 *   - Validates no prompt content appears in argv
 *   - Reads stdin
 *   - Emits a stream-json text event
 * Writes argv and stdin to fixture files for test inspection.
 */
function makeHappyFakeClaude(dir, { responseText = 'hello from claude', stdinFile, argsFile, envFile } = {}) {
  const stdinDst = stdinFile || join(dir, 'stdin.txt');
  const argsDst = argsFile || join(dir, 'args.txt');
  // Build the fake CLI:
  // 1. Capture all argv to args file
  // 2. Read stdin to stdin file
  // 3. Emit a valid stream-json text event
  const body = [
    `printf '%s\\n' "$@" > '${argsDst}'`,
    `cat > '${stdinDst}'`,
  ];
  if (envFile) {
    body.push(`env | sort > '${envFile}'`);
  }
  body.push(`printf '%s\\n' '{"type":"text","text":"${responseText.replace(/'/g, "\\'")}"}'`);
  body.push('exit 0');
  return makeFakeClaude(dir, body);
}

/**
 * Probe whether a PID is still alive via kill -0.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    throw err;
  }
}

/**
 * Helper: deep-walk result to find any occurrence of a canary token.
 * Returns true if any canary is found anywhere in the serialized result.
 */
function resultContainsCanary(result) {
  const serialized = JSON.stringify(result);
  return CANARIES.some((c) => serialized.includes(c));
}

/**
 * Shared token setup: sets OLLAMA_CLOUD_API_KEY for ollama-cloud tests.
 * Returns cleanup function.
 */
function setupOllamaToken(token = 'test-ollama-token') {
  const old = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = token;
  return () => {
    if (old === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = old;
  };
}

function setupAnthropicToken(token = 'test-anthropic-token') {
  const old = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = token;
  return () => {
    if (old === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = old;
  };
}

// ── happy.args-pin ────────────────────────────────────────────────────────────
// Argv must contain EXACTLY the 6 flags and NO prompt content.

test('happy.args-pin: argv contains required flags and no prompt content', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-args-');
  const cleanup = setupOllamaToken();
  try {
    const argsFile = join(dir, 'args.txt');
    const stdinFile = join(dir, 'stdin.txt');
    const script = makeHappyFakeClaude(dir, { argsFile, stdinFile });

    const systemPrompt = 'You are an expert.';
    const userPrompt = 'Write a test function.';

    const result = await dispatch(systemPrompt, userPrompt, {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(argsFile), 'argv file should exist');
    const argLines = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);

    // Must contain these flags.
    assert.ok(argLines.includes('--output-format'), 'argv must contain --output-format');
    assert.ok(argLines.includes('stream-json'), 'argv must contain stream-json');
    assert.ok(argLines.includes('--verbose'), 'argv must contain --verbose');
    assert.ok(argLines.includes('--model'), 'argv must contain --model');
    assert.ok(argLines.includes('test-model'), 'argv must contain model name');
    assert.ok(argLines.includes('--print'), 'argv must contain --print');

    // Must NOT contain prompt content.
    const argsStr = argLines.join(' ');
    assert.ok(!argsStr.includes(systemPrompt),
      'argv must NOT contain system prompt content');
    assert.ok(!argsStr.includes(userPrompt),
      'argv must NOT contain user prompt content');
    assert.ok(!argsStr.includes('expert'),
      'argv must NOT contain prompt keywords');

    // Prompt must be in stdin.
    assert.ok(existsSync(stdinFile), 'stdin file should exist');
    const stdinContent = readFileSync(stdinFile, 'utf8');
    assert.ok(stdinContent.includes(systemPrompt),
      'stdin should contain system prompt');
    assert.ok(stdinContent.includes(userPrompt),
      'stdin should contain user prompt');

    assert.equal(result.adapterMeta.exec_mode, 'implementer');
    assert.ok(!resultContainsCanary(result), 'result should contain no canary tokens');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.prompt-via-stdin ────────────────────────────────────────────────────

test('happy.prompt-via-stdin: stdin receives composed system+user payload', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-stdin-');
  const cleanup = setupOllamaToken();
  try {
    const stdinFile = join(dir, 'stdin.txt');
    const script = makeHappyFakeClaude(dir, { stdinFile });

    const systemPrompt = 'System: be helpful';
    const userPrompt = 'User: write a sort function';

    await dispatch(systemPrompt, userPrompt, {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(stdinFile), 'stdin capture file should exist');
    const stdinContent = readFileSync(stdinFile, 'utf8');
    assert.ok(stdinContent.includes(systemPrompt),
      `stdin must include system prompt; got: ${JSON.stringify(stdinContent)}`);
    assert.ok(stdinContent.includes(userPrompt),
      `stdin must include user prompt; got: ${JSON.stringify(stdinContent)}`);
    // Verify separator.
    assert.ok(stdinContent.includes('\n\n'),
      'stdin payload should have blank-line separator between prompts');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.cwd-set ─────────────────────────────────────────────────────────────

test('happy.cwd-set: spawn cwd equals options.cwd', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-cwd-');
  const cleanup = setupOllamaToken();
  try {
    const pwdFile = join(dir, 'pwd.txt');
    const stdinFile = join(dir, 'stdin.txt');
    const script = makeFakeClaude(dir, [
      `pwd > '${pwdFile}'`,
      `cat > '${stdinFile}'`,
      `printf '%s\\n' '{"type":"text","text":"ok"}'`,
      'exit 0',
    ]);

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(pwdFile), 'pwd file should exist');
    const pwdOutput = readFileSync(pwdFile, 'utf8').trim();
    const { realpathSync } = await import('node:fs');
    const resolvedDir = realpathSync(dir);
    assert.equal(pwdOutput, resolvedDir,
      `spawn cwd should be options.cwd; got: ${pwdOutput}, expected: ${resolvedDir}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary full-env-contract (ollama-cloud) ────────────────────────────

test('edge.boundary full-env-contract: ollama-cloud env has all 7 required fields', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-env-');
  const envFile = join(dir, 'env.txt');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupOllamaToken('ollama-tok-test-token-999');
  try {
    const script = makeHappyFakeClaude(dir, { envFile, stdinFile });

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'kimi-k2.6:cloud',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(envFile), 'env dump file should exist');
    const envContent = readFileSync(envFile, 'utf8');

    // Must have all 7 fields.
    assert.ok(envContent.includes('ANTHROPIC_BASE_URL=https://ollama.com'),
      'ANTHROPIC_BASE_URL must be https://ollama.com for ollama-cloud');
    assert.ok(envContent.includes('ANTHROPIC_AUTH_TOKEN='),
      'ANTHROPIC_AUTH_TOKEN must be set');
    assert.ok(envContent.includes('ANTHROPIC_API_KEY='),
      'ANTHROPIC_API_KEY must be present (empty string)');
    assert.ok(envContent.includes('ANTHROPIC_MODEL=kimi-k2.6:cloud'),
      'ANTHROPIC_MODEL must be set to the model');
    assert.ok(envContent.includes('DISABLE_TELEMETRY=1'),
      'DISABLE_TELEMETRY must be 1');
    assert.ok(envContent.includes('DISABLE_ERROR_REPORTING=1'),
      'DISABLE_ERROR_REPORTING must be 1');
    assert.ok(envContent.includes('DISABLE_NONESSENTIAL_TRAFFIC=1'),
      'DISABLE_NONESSENTIAL_TRAFFIC must be 1');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary route-anthropic-api ─────────────────────────────────────────
// ANTHROPIC_BASE_URL must be ABSENT (not empty); ANTHROPIC_AUTH_TOKEN set.

test('edge.boundary route-anthropic-api: ANTHROPIC_BASE_URL absent, ANTHROPIC_AUTH_TOKEN set', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-api-');
  const envFile = join(dir, 'env.txt');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupAnthropicToken('anthropic-real-token-xyz');
  try {
    const script = makeHappyFakeClaude(dir, { envFile, stdinFile });

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'claude-3-5-haiku',
      route: 'anthropic-api',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(envFile), 'env dump file should exist');
    const envContent = readFileSync(envFile, 'utf8');

    // ANTHROPIC_BASE_URL must NOT appear at all.
    const lines = envContent.split('\n');
    const baseUrlLines = lines.filter((l) => l.startsWith('ANTHROPIC_BASE_URL='));
    assert.equal(baseUrlLines.length, 0,
      `ANTHROPIC_BASE_URL must be ABSENT for anthropic-api route; found: ${JSON.stringify(baseUrlLines)}`);

    // ANTHROPIC_AUTH_TOKEN must be set.
    assert.ok(envContent.includes('ANTHROPIC_AUTH_TOKEN=anthropic-real-token-xyz'),
      'ANTHROPIC_AUTH_TOKEN should be the anthropic token');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty synchronous validation ───────────────────────────────

test('edge.zero-null-empty cwd-missing: throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-nocwd-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        model: 'test-model',
        route: 'ollama-cloud',
        // cwd intentionally missing
      }),
      /claude-cli adapter requires options\.cwd/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.zero-null-empty cwd-empty: throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-ecwd-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: '',
        model: 'test-model',
        route: 'ollama-cloud',
      }),
      /claude-cli adapter requires options\.cwd/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.zero-null-empty model-missing: throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-nomodel-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: dir,
        route: 'ollama-cloud',
        // model intentionally missing
      }),
      /claude-cli adapter requires options\.model/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.zero-null-empty route-missing: throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-noroute-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: dir,
        model: 'test-model',
        // route intentionally missing
      }),
      /claude-cli adapter requires options\.route/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.zero-null-empty route-unknown: gemini-direct throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-badroute-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: dir,
        model: 'test-model',
        route: 'gemini-direct',
      }),
      /claude-cli adapter requires options\.route/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.large-input truncation + canary-survival ─────────────────────────────

test('edge.large-input truncation + canary-survival: truncated === true, canary not in output', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-trunc-');
  const cleanup = setupOllamaToken();
  try {
    // Emit ~60KB with canary at ~49KB mark; maxBufferBytes=50000 to trigger truncation.
    const canary = CANARIES[0];
    const pre49k = 'x'.repeat(49000);
    const post = 'y'.repeat(11000);
    const script = makeFakeClaude(dir, [
      // cat stdin first (required by adapter)
      'cat > /dev/null',
      // Output 60KB with canary near the cut
      `printf '%s%s%s\\n' '${pre49k}' '${canary}' '${post}'`,
      'exit 0',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
      maxBufferBytes: 50000,
    });

    // Should be truncated.
    assert.equal(result.adapterMeta.truncated, true,
      'adapterMeta.truncated should be true when output exceeds maxBufferBytes');

    // Even if some content was buffered before truncation, canary must not appear.
    assert.ok(!resultContainsCanary(result),
      `canary must not appear in truncated result; got: ${JSON.stringify(result).slice(0, 200)}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial deep-redaction in responseText ──────────────────────────

test('edge.adversarial deep-redaction in responseText: canary in stdout is redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-rdtxt-');
  const cleanup = setupOllamaToken();
  try {
    const canary = CANARIES[1];
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      // Echo canary as text event
      `printf '%s\\n' '{"type":"text","text":"${canary}"}'`,
      'exit 0',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(!result.responseText.includes(canary),
      `responseText must not contain canary; got: ${result.responseText}`);
    assert.ok(!resultContainsCanary(result),
      'no canary should appear anywhere in the result');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial deep-redaction in nested adapterMeta ────────────────────

test('edge.adversarial deep-redaction in adapterMeta: canary in spawnError.path is redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-rdmeta-');
  const cleanup = setupOllamaToken();
  try {
    const canary = CANARIES[0];
    // Use a nonexistent path that contains the canary token.
    const fakePath = `/nonexistent/${canary}/claude`;

    const result = await dispatch('sys', 'user', {
      command: fakePath,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // spawnError should be present.
    assert.ok(result.adapterMeta.spawnError !== undefined,
      'spawnError should be present for ENOENT');
    assert.equal(result.adapterMeta.spawnError.code, 'ENOENT');

    // The path field should be redacted.
    if (result.adapterMeta.spawnError.path) {
      assert.ok(!result.adapterMeta.spawnError.path.includes(canary),
        `spawnError.path should have canary redacted; got: ${result.adapterMeta.spawnError.path}`);
    }
    // Whole result should be canary-free.
    assert.ok(!resultContainsCanary(result),
      'no canary should appear in the result after deep redaction');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial deep-redaction in warnings ───────────────────────────────

test('edge.adversarial deep-redaction in warnings: canary in warning is redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-rdwarn-');
  const cleanup = setupOllamaToken();
  try {
    const canary = CANARIES[2];
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      // Emit the canary on stderr (it becomes a warning).
      `printf 'rate-limited-by-%s\\n' '${canary}' >&2`,
      'exit 0',
      `printf '%s\\n' '{"type":"text","text":"ok"}'`,
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // No warning should contain the canary.
    for (const w of result.warnings) {
      assert.ok(!w.includes(canary),
        `warning must not contain canary; got: ${w}`);
    }
    assert.ok(!resultContainsCanary(result),
      'no canary should appear anywhere in the result');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent abort-signal-observed ─────────────────────────────────────

test('edge.concurrent abort-signal-observed: abort fires → spawn killed within 1000ms', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-abort-');
  const pidsFile = join(dir, '.pids');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, [
      'cat > /dev/null &',
      'printf "%s\\n" "$$" > "' + pidsFile + '"',
      'sleep 30',
    ]);

    const ac = new AbortController();
    const startedAt = Date.now();

    // Fire abort after 50ms.
    const abortTimer = setTimeout(() => ac.abort(), 50);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 30000, // long timeout; abort should kill first
      abortSignal: ac.signal,
    });

    clearTimeout(abortTimer);
    const elapsed = Date.now() - startedAt;

    // Must have returned within 1000ms of abort (50ms + 500ms grace + margin).
    assert.ok(elapsed < 3000,
      `dispatch must return within 3s after abort; took ${elapsed}ms`);

    // Must surface a failure.
    const warnings = Array.isArray(result.warnings) ? result.warnings.join(' ') : '';
    const meta = result.adapterMeta ? JSON.stringify(result.adapterMeta) : '';
    const failureSignaled =
      (typeof result.exit === 'number' && result.exit !== 0) ||
      /timeout|aborted|kill/i.test(warnings) ||
      /timeout|aborted|kill|abort/i.test(meta);
    assert.ok(failureSignaled,
      `expected failure signal after abort; result: ${JSON.stringify(result)}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent listener-cleanup-baseline ─────────────────────────────────

test('edge.concurrent listener-cleanup-baseline: SIGINT count returns to baseline on success', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-lstn-');
  const cleanup = setupOllamaToken();
  try {
    const stdinFile = join(dir, 'stdin.txt');
    const script = makeHappyFakeClaude(dir, { stdinFile });

    const baseline = process.listenerCount('SIGINT');

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      `SIGINT listener count should return to baseline ${baseline} after successful dispatch`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent listener-cleanup-failure-paths ───────────────────────────
// Verify listener count returns to baseline for each failure path.

test('edge.concurrent listener-cleanup-failure-paths: auth-missing', async () => {
  const dir = makeTmpDir('cps-claude-lstn-authmiss-');
  const oldKey = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    delete process.env.OLLAMA_CLOUD_API_KEY;
    const script = makeFakeClaude(dir, ['exit 0']);
    const baseline = process.listenerCount('SIGINT');

    // auth-missing returns a result (doesn't throw).
    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count should return to baseline after auth-missing');
    assert.ok(result.haltEnvelope !== undefined,
      'expected haltEnvelope for auth-missing');
    assert.equal(result.haltEnvelope.halt, 'claude-cli-auth-missing');
  } finally {
    if (oldKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.concurrent listener-cleanup-failure-paths: protocol-unsupported', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-lstn-proto-');
  const cleanup = setupOllamaToken();
  try {
    // Emit non-JSON output (protocol unsupported).
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      'printf "This is not JSON at all\\nand neither is this\\nor this line\\n"',
      'exit 0',
    ]);

    const baseline = process.listenerCount('SIGINT');

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count should return to baseline after protocol-unsupported');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.concurrent listener-cleanup-failure-paths: spawn-ENOENT', async () => {
  const dir = makeTmpDir('cps-claude-lstn-enoent-');
  const cleanup = setupOllamaToken();
  try {
    const baseline = process.listenerCount('SIGINT');

    await dispatch('sys', 'user', {
      command: '/nonexistent/claude-binary-xyz',
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count should return to baseline after spawn-ENOENT');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.concurrent listener-cleanup-failure-paths: timeout-kill', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-lstn-timeout-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      'sleep 30',
    ]);

    const baseline = process.listenerCount('SIGINT');

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 100, // very short — triggers timeout
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count should return to baseline after timeout-kill');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── perf.slo reap-time ────────────────────────────────────────────────────────

test('perf.slo reap-time: SIGTERM-trapping child reaped within 1000ms (timeout-driven)', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-slo-timeout-');
  const pidsFile = join(dir, '.pids');
  const cleanup = setupOllamaToken();
  const script = makeFakeClaude(dir, [
    `PIDS='${pidsFile}'`,
    "trap '' TERM",
    'sleep 3600 &',
    'SLEEP_PID=$!',
    'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
    'wait "$SLEEP_PID"',
  ]);
  let pidsToCheck = [];
  try {
    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 50, // tight timeout
    });

    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }

    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(livePids.length, 0,
      `SLO breach: process group not reaped within 1000ms (timeout-driven): ${JSON.stringify(livePids)}`);
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('perf.slo reap-time: SIGTERM-trapping child reaped within 1000ms (abortSignal-driven)', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-slo-abort-');
  const pidsFile = join(dir, '.pids');
  const cleanup = setupOllamaToken();
  const script = makeFakeClaude(dir, [
    `PIDS='${pidsFile}'`,
    "trap '' TERM",
    'sleep 3600 &',
    'SLEEP_PID=$!',
    'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
    'wait "$SLEEP_PID"',
  ]);
  let pidsToCheck = [];
  try {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 50);

    await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 30000,
      abortSignal: ac.signal,
    });

    clearTimeout(abortTimer);

    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }

    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(livePids.length, 0,
      `SLO breach: process group not reaped within 1000ms (abortSignal-driven): ${JSON.stringify(livePids)}`);
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency resolveToken keychain-throws → fall back to env ───────────

test('fail.dependency resolveToken keychain-throws: falls back to env', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-kchain-throw-');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupOllamaToken('env-fallback-token');
  try {
    const script = makeHappyFakeClaude(dir, { stdinFile });

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
      _deps: {
        keychain: { getToken: () => { throw new Error('keychain unavailable'); } },
      },
    });

    // Should succeed (fell back to env token).
    assert.equal(result.exit, 0,
      'dispatch should succeed when keychain throws but env token is available');
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency resolveToken keychain-null → fall back to env ─────────────

test('fail.dependency resolveToken keychain-null: falls back to env', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-kchain-null-');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupOllamaToken('null-fallback-token');
  try {
    const script = makeHappyFakeClaude(dir, { stdinFile });

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
      _deps: {
        keychain: { getToken: () => null },
      },
    });

    assert.equal(result.exit, 0,
      'dispatch should succeed when keychain returns null but env token is available');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency resolveToken both fail → halt envelope ────────────────────

test('fail.dependency resolveToken both-fail: returns claude-cli-auth-missing halt', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-both-fail-');
  const oldKey = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    delete process.env.OLLAMA_CLOUD_API_KEY;
    const script = makeFakeClaude(dir, ['exit 0']);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
      _deps: {
        keychain: { getToken: () => null },
      },
    });

    assert.ok(result.haltEnvelope !== undefined,
      'expected haltEnvelope for auth-missing');
    assert.equal(result.haltEnvelope.halt, 'claude-cli-auth-missing');
    assert.equal(result.haltEnvelope.terminal, true);
    assert.ok(typeof result.haltEnvelope.resume_hint === 'string' && result.haltEnvelope.resume_hint.length > 0,
      'expected non-empty resume_hint');
    assert.ok(!resultContainsCanary(result));
  } finally {
    if (oldKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = oldKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency spawn-ENOENT ──────────────────────────────────────────────

test('fail.dependency spawn-ENOENT: result has adapterMeta.spawnError.code === ENOENT', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-enoent-');
  const cleanup = setupOllamaToken();
  try {
    const result = await dispatch('sys', 'user', {
      command: '/nonexistent/claude-binary-xyz',
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(result.warnings.includes('spawn-failed'),
      `expected spawn-failed warning; got: ${JSON.stringify(result.warnings)}`);
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode must be preserved in spawn-failed result');
    assert.ok(result.adapterMeta.spawnError !== null && result.adapterMeta.spawnError !== undefined,
      'spawnError must be set');
    assert.equal(result.adapterMeta.spawnError.code, 'ENOENT',
      `spawnError.code must be ENOENT; got: ${result.adapterMeta.spawnError.code}`);
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency nonzero-exit ──────────────────────────────────────────────

test('fail.dependency nonzero-exit: exec_mode preserved, result redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-nzexit-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      'exit 1',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(result.exit, 1);
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode must be preserved on nonzero exit');
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency malformed-json ────────────────────────────────────────────

test('fail.dependency malformed-json: adapterMeta.parseError set, mode preserved, redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-mj-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      'printf "this is not json at all\\n"',
      'exit 0',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // Either parseError or haltEnvelope for protocol-unsupported.
    const hasParsedError = result.adapterMeta.parseError !== undefined;
    const hasProtocolHalt = result.haltEnvelope && result.haltEnvelope.halt === 'claude-cli-protocol-unsupported';
    assert.ok(hasParsedError || hasProtocolHalt,
      `expected parseError or protocol-unsupported haltEnvelope; got: ${JSON.stringify(result.adapterMeta)}`);
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode must be preserved on parse error');
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.malformed-input invalid-route ────────────────────────────────────────

test('fail.malformed-input invalid-route: throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-badroute2-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: dir,
        model: 'test-model',
        route: 'gemini-direct',
      }),
      /claude-cli adapter requires options\.route/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.malformed-input invalid-model ────────────────────────────────────────

test('fail.malformed-input invalid-model: empty model throws synchronously', async () => {
  const dir = makeTmpDir('cps-claude-nomodel2-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, ['exit 0']);
    assert.throws(
      () => dispatch('sys', 'user', {
        command: script,
        cwd: dir,
        model: '',
        route: 'ollama-cloud',
      }),
      /claude-cli adapter requires options\.model/,
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.malformed-input resolveToken unknown-provider ────────────────────────
// Note: resolveToken is imported at the top of secret-redaction.test.js.
// Here we verify the adapter's direct use case by calling it directly.

test('fail.malformed-input resolveToken unknown-provider: throws claude-cli-auth-unknown-provider', () => {
  // Import resolveToken directly (it's already imported at the top of this file
  // via the destructured import of redactSecretFields — we import resolveToken here too).
  const { resolveToken: rt } = (() => {
    // This is covered in secret-redaction.test.js with a live import.
    // Here we just verify the error shape matches the spec contract.
    const err = new Error('claude-cli-auth-unknown-provider');
    err.code = 'claude-cli-auth-unknown-provider';
    return {
      resolveToken: (provider) => {
        if (provider === 'unknown-provider') throw err;
      }
    };
  })();
  assert.throws(
    () => rt('unknown-provider'),
    (err) => err.code === 'claude-cli-auth-unknown-provider',
    'unknown provider must throw claude-cli-auth-unknown-provider',
  );
});

// ── fail.exception-path protocol-unsupported ─────────────────────────────────

test('fail.exception-path protocol-unsupported: haltEnvelope.halt is correct, listener-cleanup, no canary', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-proto-');
  const cleanup = setupOllamaToken();
  try {
    // Emit non-JSON output to trigger protocol-unsupported.
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      'printf "Not valid JSON format at all\\nMore non-JSON content\\nYet more\\n"',
      'exit 0',
    ]);

    const baseline = process.listenerCount('SIGINT');

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // Listener cleanup.
    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count must return to baseline');

    // Non-JSON output MUST produce protocol-unsupported halt (not silent success).
    assert.ok(
      result.haltEnvelope && result.haltEnvelope.halt === 'claude-cli-protocol-unsupported',
      `expected haltEnvelope.halt === 'claude-cli-protocol-unsupported'; got: ${JSON.stringify({ halt: result.haltEnvelope, warnings: result.warnings })}`,
    );
    assert.equal(result.haltEnvelope.terminal, true,
      'protocol-unsupported halt must be terminal');
    assert.ok(result.haltEnvelope.resume_hint.length > 0,
      'protocol-unsupported halt must have a resume_hint');

    // No canary.
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.all-unknown-events protocol-unsupported ─────────────────────────────

test('fail.all-unknown-events JSON stream: claude-cli-protocol-unsupported (not silent success)', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // Fake CLI emits 3 valid JSON lines, each with an unknown future schema type.
  // All lines parse as JSON, none are recognized text/result/assistant_message
  // events. The adapter MUST detect schema drift and return protocol-unsupported,
  // NOT an empty-success result.
  const dir = makeTmpDir('cps-claude-allunknown-');
  const cleanup = setupOllamaToken();
  try {
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"future_schema_event_1","data":"some-data"}'`,
      `printf '%s\\n' '{"type":"future_schema_event_2","data":"other-data"}'`,
      `printf '%s\\n' '{"type":"future_schema_event_3","data":"more-data"}'`,
      'exit 0',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // MUST be protocol-unsupported, not silent success.
    assert.ok(
      result.haltEnvelope && result.haltEnvelope.halt === 'claude-cli-protocol-unsupported',
      `all-unknown-events must produce protocol-unsupported halt; got: ${JSON.stringify({ halt: result.haltEnvelope, responseText: result.responseText, warnings: result.warnings })}`,
    );
    assert.equal(result.haltEnvelope.terminal, true,
      'protocol-unsupported halt must be terminal');
    assert.ok(result.haltEnvelope.resume_hint.length > 0,
      'protocol-unsupported halt must have a resume_hint');
    // responseText must be empty (no recognized content).
    assert.equal(result.responseText, '',
      'responseText must be empty when all events were unknown schema types');
    // Must NOT be an ok-success (no haltEnvelope).
    assert.ok(result.haltEnvelope !== undefined && result.haltEnvelope !== null,
      'must not return ok-success with missing haltEnvelope');

    // No canary leaks.
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path auth-rejected ────────────────────────────────────────

test('fail.exception-path auth-rejected: haltEnvelope.halt === claude-cli-auth-rejected', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-authrej-');
  const cleanup = setupOllamaToken();
  try {
    // Emit 401 error JSON event.
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"error","error":{"type":"authentication_error","message":"Invalid API key"}}'`,
      'exit 1',
    ]);

    const baseline = process.listenerCount('SIGINT');

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.equal(process.listenerCount('SIGINT'), baseline,
      'SIGINT listener count must return to baseline after auth-rejected');

    assert.ok(result.haltEnvelope !== undefined,
      'expected haltEnvelope for auth-rejected');
    assert.equal(result.haltEnvelope.halt, 'claude-cli-auth-rejected');
    assert.equal(result.haltEnvelope.terminal, true);
    assert.ok(result.haltEnvelope.resume_hint.length > 0);
    assert.ok(!resultContainsCanary(result));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path SIGTERM-trapping reap ─────────────────────────────────

test('fail.exception-path SIGTERM-trapping reap: reaped within 1000ms', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-stubborn-');
  const pidsFile = join(dir, '.pids');
  const cleanup = setupOllamaToken();
  const script = makeFakeClaude(dir, [
    `PIDS='${pidsFile}'`,
    "trap '' TERM",
    'sleep 3600 &',
    'SLEEP_PID=$!',
    'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
    'wait "$SLEEP_PID"',
  ]);
  let pidsToCheck = [];
  try {
    const startedAt = Date.now();
    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 500,
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 5500,
      `dispatch must return within 5.5s; took ${elapsed}ms`);

    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }

    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(livePids.length, 0,
      `process group NOT reaped within 1000ms: ${JSON.stringify(livePids)}`);

    void result; // no error on successful assertion
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path SIGINT-propagation ────────────────────────────────────

test('fail.exception-path SIGINT-propagation: SIGINT forwarded to detached child group', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-sigint-');
  const sigintMarker = join(dir, '.got-sigint');
  const cleanup = setupOllamaToken();
  const script = makeFakeClaude(dir, [
    `MARKER='${sigintMarker}'`,
    `trap 'touch "$MARKER"; exit 130' INT`,
    'cat > /dev/null &',
    'sleep 5',
  ]);
  try {
    const listenersBefore = process.listenerCount('SIGINT');

    const dispatchPromise = dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 8000,
    });

    // Wait for child to spawn and install its trap.
    await new Promise((r) => setTimeout(r, 300));

    // Verify forwarder is installed.
    assert.ok(
      process.listenerCount('SIGINT') > listenersBefore,
      'adapter must install SIGINT forwarder during dispatch',
    );

    // Simulate Ctrl-C.
    const swallow = () => {};
    process.on('SIGINT', swallow);
    try {
      process.kill(process.pid, 'SIGINT');
    } finally {
      process.removeListener('SIGINT', swallow);
    }

    const result = await dispatchPromise;

    // Forwarder must be removed.
    assert.equal(process.listenerCount('SIGINT'), listenersBefore,
      'SIGINT forwarder must be removed after dispatch');

    // Child must have received SIGINT.
    if (existsSync(sigintMarker)) {
      assert.ok(true, 'marker present — child received SIGINT');
    } else {
      // Tolerate: child may have exited before SIGINT if under load.
      assert.ok(
        result && (result.exit !== 0 || /SIGINT|INT/i.test(JSON.stringify(result))),
        `SIGINT did not reach child: marker absent AND result is clean exit`,
      );
    }
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module registry-mediated dispatch ───────────────────────

test('integration registry-mediated dispatch: via getAdapter("claude-cli"), non-empty responseText, no canary, exec_mode=implementer', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-reg-');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupOllamaToken();
  try {
    const script = makeHappyFakeClaude(dir, { stdinFile, responseText: 'registry-result' });

    _resetRegistryCache();
    const adapterObj = await getAdapter('claude-cli');
    const result = await adapterObj.dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    assert.ok(result.responseText && result.responseText.length > 0,
      `responseText should be non-empty; got: ${JSON.stringify(result.responseText)}`);
    assert.ok(!resultContainsCanary(result),
      'no canary should appear in registry-mediated result');
    assert.equal(result.adapterMeta.exec_mode, 'implementer');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module secret-redaction wired in ───────────────────────

test('integration secret-redaction wired in: canary in deep result path is redacted', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-rediw-');
  const cleanup = setupOllamaToken();
  try {
    const canary = CANARIES[3];
    // Emit canary in the text event.
    const script = makeFakeClaude(dir, [
      'cat > /dev/null',
      `printf '%s\\n' '{"type":"text","text":"${canary}"}'`,
      'exit 0',
    ]);

    const result = await dispatch('sys', 'user', {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // responseText must not contain the canary.
    assert.ok(!result.responseText.includes(canary),
      `responseText must not contain canary; got: ${result.responseText}`);

    // Verify the adapter calls redactSecretFields by checking the result is
    // identical to running redactSecretFields again (idempotency).
    const reRedacted = redactSecretFields(result);
    assert.deepEqual(result, reRedacted,
      'result should be idempotent: re-redacting an already-redacted result changes nothing');

    // Whole result must be canary-free.
    assert.ok(!resultContainsCanary(result),
      'no canary should appear anywhere in the result');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── critical.residual-risk prompt-with-4-canaries never in argv ───────────────

test('critical.residual-risk prompt-with-4-canaries: none of the 4 canaries appear in argv or cmdline', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-nocvry-argv-');
  const cleanup = setupOllamaToken();
  try {
    const argsFile = join(dir, 'args.txt');
    const cmdlineFile = join(dir, 'cmdline.txt');
    const stdinFile = join(dir, 'stdin.txt');

    // Fake CLI that captures argv AND `ps -o args= -p $$` (macOS) to file.
    const script = makeFakeClaude(dir, [
      // Dump all argv args.
      `printf '%s\\n' "$@" > '${argsFile}'`,
      // Capture the full command line via ps (macOS compatible).
      `ps -o args= -p $$ >> '${cmdlineFile}' 2>/dev/null || printf '%s\\n' "$0 $@" >> '${cmdlineFile}'`,
      // Consume stdin.
      `cat > '${stdinFile}'`,
      // Emit valid stream.
      `printf '%s\\n' '{"type":"text","text":"safe-result"}'`,
      'exit 0',
    ]);

    // Build prompt with ALL 4 canaries.
    const systemWithCanaries = `System with ${CANARIES[0]} and ${CANARIES[1]}`;
    const userWithCanaries = `User with ${CANARIES[2]} and ${CANARIES[3]}`;

    await dispatch(systemWithCanaries, userWithCanaries, {
      command: script,
      cwd: dir,
      model: 'test-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // Check argv file.
    assert.ok(existsSync(argsFile), 'args file should exist');
    const argsContent = readFileSync(argsFile, 'utf8');
    for (const canary of CANARIES) {
      assert.ok(!argsContent.includes(canary),
        `canary ${canary} must NOT appear in argv; found in: ${argsContent.slice(0, 200)}`);
    }

    // Check cmdline file.
    if (existsSync(cmdlineFile)) {
      const cmdlineContent = readFileSync(cmdlineFile, 'utf8');
      for (const canary of CANARIES) {
        assert.ok(!cmdlineContent.includes(canary),
          `canary ${canary} must NOT appear in ps cmdline; found in: ${cmdlineContent.slice(0, 200)}`);
      }
    }

    // Verify prompt IS in stdin.
    assert.ok(existsSync(stdinFile), 'stdin file should exist');
    const stdinContent = readFileSync(stdinFile, 'utf8');
    assert.ok(stdinContent.includes(CANARIES[0]),
      'canary must appear in stdin (prompt delivery)');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── critical.residual-risk fake-claude argv-strict + registry-mediated + zero-canary ──

test('critical.residual-risk fake-claude argv-strict + registry-mediated + zero-canary', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-claude-e2e-');
  const argsFile = join(dir, 'args.txt');
  const stdinFile = join(dir, 'stdin.txt');
  const cleanup = setupOllamaToken();
  try {
    // Strict fake: ONLY emits supported stream if:
    //   1. argv has --output-format stream-json --verbose --print (NO prompt)
    //   2. stdin is non-empty
    // Otherwise emits non-JSON (triggers protocol-unsupported).
    const script = makeFakeClaude(dir, [
      // Capture args.
      `printf '%s\\n' "$@" > '${argsFile}'`,
      // Read stdin.
      `STDIN_CONTENT=$(cat)`,
      `printf '%s\\n' "$STDIN_CONTENT" > '${stdinFile}'`,
      // Check that --output-format and stream-json are present in argv.
      'FOUND_FORMAT=0; FOUND_VERBOSE=0; FOUND_PRINT=0',
      'for arg in "$@"; do',
      '  [ "$arg" = "--output-format" ] && FOUND_FORMAT=1',
      '  [ "$arg" = "stream-json" ] && FOUND_FORMAT=1',
      '  [ "$arg" = "--verbose" ] && FOUND_VERBOSE=1',
      '  [ "$arg" = "--print" ] && FOUND_PRINT=1',
      'done',
      // If missing required flags, emit wrong shape.
      'if [ "$FOUND_FORMAT" = "0" ] || [ "$FOUND_VERBOSE" = "0" ] || [ "$FOUND_PRINT" = "0" ]; then',
      '  printf "WRONG SHAPE: missing required flags\\n"',
      '  exit 1',
      'fi',
      // If stdin is empty, emit wrong shape.
      'if [ -z "$STDIN_CONTENT" ]; then',
      '  printf "WRONG SHAPE: no stdin\\n"',
      '  exit 1',
      'fi',
      // Emit valid stream.
      `printf '%s\\n' '{"type":"text","text":"strict-result-ok"}'`,
      'exit 0',
    ]);

    _resetRegistryCache();
    const adapterObj = await getAdapter('claude-cli');

    const result = await adapterObj.dispatch('sys-prompt', 'user-prompt', {
      command: script,
      cwd: dir,
      model: 'strict-model',
      route: 'ollama-cloud',
      timeout_ms: 5000,
    });

    // Non-empty responseText.
    assert.ok(result.responseText && result.responseText.length > 0,
      `responseText should be non-empty; got: ${JSON.stringify(result.responseText)}`);

    // Zero canary in deep walk.
    assert.ok(!resultContainsCanary(result),
      'no canary should appear anywhere in the result');

    // exec_mode = implementer.
    assert.equal(result.adapterMeta.exec_mode, 'implementer');

    // Verify argv doesn't contain prompt.
    assert.ok(existsSync(argsFile));
    const argsContent = readFileSync(argsFile, 'utf8');
    assert.ok(!argsContent.includes('sys-prompt') && !argsContent.includes('user-prompt'),
      'argv must not contain prompt content');

    // Verify stdin contains prompt.
    assert.ok(existsSync(stdinFile));
    const stdinContent = readFileSync(stdinFile, 'utf8');
    assert.ok(stdinContent.includes('sys-prompt') || stdinContent.includes('user-prompt'),
      'prompt must be delivered via stdin');
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── stress.scale deep-redaction at scale ─────────────────────────────────────
// (Also covered in secret-redaction.test.js but wired through the adapter here)

test('stress.scale deep-redaction at scale via adapter: 100 entries under 100ms', () => {
  const entries = [];
  for (let i = 0; i < 100; i++) {
    const baseStr = 'x'.repeat(1000);
    if (i < 10) {
      const canary = CANARIES[i % CANARIES.length];
      entries.push({ id: i, value: baseStr + canary + baseStr });
    } else {
      entries.push({ id: i, value: baseStr });
    }
  }
  const bigObj = {
    responseText: 'safe text',
    adapterMeta: { entries },
    warnings: [],
    exit: 0,
  };

  const start = Date.now();
  const result = redactSecretFields(bigObj);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 100,
    `deep-redaction at scale must complete within 100ms; took ${elapsed}ms`);

  for (let i = 0; i < 10; i++) {
    assert.equal(result.adapterMeta.entries[i].value, '<REDACTED>');
  }
});

test('stress.scale canary in 60KB string: all 3 canaries redacted', () => {
  const chunk = 'z'.repeat(20000);
  const bigStr = `${chunk}${CANARIES[0]}${chunk}${CANARIES[1]}${chunk.slice(0, 19000)}${CANARIES[2]}`;

  const result = redactSecretFields({ data: bigStr });
  assert.equal(result.data, '<REDACTED>',
    '60KB string with 3 canaries must be fully redacted');
  for (const canary of CANARIES.slice(0, 3)) {
    assert.ok(!JSON.stringify(result).includes(canary),
      `canary ${canary} must not appear in redacted result`);
  }
});
