// v0.10.0 slice 5 — secret-redaction module tests.
//
// Tests for:
//   resolveToken(provider, deps?) — token lookup with DI keychain + env fallback
//   sanitizeEnv(env)              — strip 6 denylist keys, preserve others
//   redactSecretFields(obj)       — deep-walk + replace secret values

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveToken,
  sanitizeEnv,
  redactSecretFields,
} from '../../../lib/codex-bridge/implementer/secret-redaction.js';

// ── resolveToken ──────────────────────────────────────────────────────────────

test('resolveToken: keychain takes priority over env for ollama-cloud', () => {
  const old = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    process.env.OLLAMA_CLOUD_API_KEY = 'env-token';
    const token = resolveToken('ollama-cloud', {
      keychain: { getToken: () => 'keychain-token' },
    });
    assert.equal(token, 'keychain-token', 'keychain token should take priority');
  } finally {
    if (old === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = old;
  }
});

test('resolveToken: env fallback when no keychain for ollama-cloud', () => {
  const old = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    process.env.OLLAMA_CLOUD_API_KEY = 'env-ollama-token';
    const token = resolveToken('ollama-cloud');
    assert.equal(token, 'env-ollama-token');
  } finally {
    if (old === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = old;
  }
});

test('resolveToken: env fallback when keychain returns null for ollama-cloud', () => {
  const old = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    process.env.OLLAMA_CLOUD_API_KEY = 'env-ollama-null-fallback';
    const token = resolveToken('ollama-cloud', {
      keychain: { getToken: () => null },
    });
    assert.equal(token, 'env-ollama-null-fallback');
  } finally {
    if (old === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = old;
  }
});

test('resolveToken: env fallback when keychain throws for ollama-cloud', () => {
  const old = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    process.env.OLLAMA_CLOUD_API_KEY = 'env-fallback-after-throw';
    const token = resolveToken('ollama-cloud', {
      keychain: { getToken: () => { throw new Error('keychain unavailable'); } },
    });
    assert.equal(token, 'env-fallback-after-throw');
  } finally {
    if (old === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = old;
  }
});

test('resolveToken: env fallback for anthropic-api with ANTHROPIC_AUTH_TOKEN', () => {
  const old = process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = 'anthropic-env-token';
    const token = resolveToken('anthropic-api');
    assert.equal(token, 'anthropic-env-token');
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = old;
  }
});

test('resolveToken: throws claude-cli-auth-missing when both keychain and env fail', () => {
  const oldOllama = process.env.OLLAMA_CLOUD_API_KEY;
  try {
    delete process.env.OLLAMA_CLOUD_API_KEY;
    assert.throws(
      () => resolveToken('ollama-cloud', {
        keychain: { getToken: () => null },
      }),
      (err) => {
        assert.equal(err.message, 'claude-cli-auth-missing');
        assert.equal(err.code, 'claude-cli-auth-missing');
        return true;
      },
    );
  } finally {
    if (oldOllama === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = oldOllama;
  }
});

test('resolveToken: throws claude-cli-auth-unknown-provider for unknown provider', () => {
  assert.throws(
    () => resolveToken('unknown-provider'),
    (err) => {
      assert.equal(err.message, 'claude-cli-auth-unknown-provider');
      assert.equal(err.code, 'claude-cli-auth-unknown-provider');
      return true;
    },
  );
});

// ── sanitizeEnv ───────────────────────────────────────────────────────────────

test('sanitizeEnv: strips all 6 denylist keys', () => {
  const env = {
    OLLAMA_CLOUD_API_KEY: 'tok1',
    ANTHROPIC_AUTH_TOKEN: 'tok2',
    ANTHROPIC_API_KEY: 'tok3',
    ANTHROPIC_BASE_URL: 'https://example.com',
    ANTHROPIC_MODEL: 'claude-3',
    OPENAI_API_KEY: 'sk-test',
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
  };
  const result = sanitizeEnv(env);
  // Denylist keys must be absent.
  assert.ok(!('OLLAMA_CLOUD_API_KEY' in result), 'OLLAMA_CLOUD_API_KEY should be stripped');
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in result), 'ANTHROPIC_AUTH_TOKEN should be stripped');
  assert.ok(!('ANTHROPIC_API_KEY' in result), 'ANTHROPIC_API_KEY should be stripped');
  assert.ok(!('ANTHROPIC_BASE_URL' in result), 'ANTHROPIC_BASE_URL should be stripped');
  assert.ok(!('ANTHROPIC_MODEL' in result), 'ANTHROPIC_MODEL should be stripped');
  assert.ok(!('OPENAI_API_KEY' in result), 'OPENAI_API_KEY should be stripped');
});

test('sanitizeEnv: preserves PATH, HOME, LANG, LC_ALL', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
    MY_CUSTOM_KEY: 'keep-me',
    ANTHROPIC_AUTH_TOKEN: 'strip-me',
  };
  const result = sanitizeEnv(env);
  assert.equal(result.PATH, '/usr/bin:/bin');
  assert.equal(result.HOME, '/home/user');
  assert.equal(result.LANG, 'en_US.UTF-8');
  assert.equal(result.LC_ALL, 'en_US.UTF-8');
  assert.equal(result.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(result.MY_CUSTOM_KEY, 'keep-me');
});

test('sanitizeEnv: exact denylist key count check', () => {
  const env = {
    OLLAMA_CLOUD_API_KEY: 'a',
    ANTHROPIC_AUTH_TOKEN: 'b',
    ANTHROPIC_API_KEY: 'c',
    ANTHROPIC_BASE_URL: 'd',
    ANTHROPIC_MODEL: 'e',
    OPENAI_API_KEY: 'f',
    KEEP_ME: 'yes',
  };
  const result = sanitizeEnv(env);
  const keys = Object.keys(result);
  assert.deepEqual(keys.sort(), ['KEEP_ME'], 'only KEEP_ME should survive');
});

// ── redactSecretFields ────────────────────────────────────────────────────────

// The 4 canary tokens from spec L612-618
const CANARIES = [
  'ollama-tok-test-canary-abc123',
  'anthropic-auth-test-canary-def456',
  'sk-ant-canary-xyz789',
  'sk-openai-canary-uvw000',
];

test('redactSecretFields: redacts each of the 4 canary tokens as exact string', () => {
  for (const canary of CANARIES) {
    const result = redactSecretFields({ value: canary });
    assert.equal(result.value, '<REDACTED>',
      `canary token ${canary} should be redacted`);
  }
});

test('redactSecretFields: redacts canary token as substring in longer string', () => {
  const obj = {
    msg: `prefix-${CANARIES[0]}-suffix`,
  };
  const result = redactSecretFields(obj);
  assert.equal(result.msg, '<REDACTED>',
    'string containing canary as substring should be fully redacted');
});

test('redactSecretFields: redacts unknown token matching sk-ant- regex', () => {
  const obj = { token: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' };
  const result = redactSecretFields(obj);
  assert.equal(result.token, '<REDACTED>',
    'sk-ant- token should be redacted by regex');
});

test('redactSecretFields: redacts unknown token matching sk-openai- regex', () => {
  const obj = { token: 'sk-openai-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01' };
  const result = redactSecretFields(obj);
  assert.equal(result.token, '<REDACTED>',
    'sk-openai- token should be redacted by regex');
});

test('redactSecretFields: redacts unknown token matching ollama-tok- regex', () => {
  const obj = { token: 'ollama-tok-secrettoken123' };
  const result = redactSecretFields(obj);
  assert.equal(result.token, '<REDACTED>',
    'ollama-tok- token should be redacted by regex');
});

test('redactSecretFields: redacts unknown token matching anthropic-auth- regex', () => {
  const obj = { token: 'anthropic-auth-verylongsecret' };
  const result = redactSecretFields(obj);
  assert.equal(result.token, '<REDACTED>',
    'anthropic-auth- token should be redacted by regex');
});

test('redactSecretFields: 5-level deep object with canaries at every level', () => {
  const deepObj = {
    level1: CANARIES[0],
    nested: {
      level2: CANARIES[1],
      nested: {
        level3: CANARIES[2],
        nested: {
          level4: CANARIES[3],
          nested: {
            level5: CANARIES[0],
            safe: 'keep-me',
          },
        },
      },
    },
  };
  const result = redactSecretFields(deepObj);
  assert.equal(result.level1, '<REDACTED>');
  assert.equal(result.nested.level2, '<REDACTED>');
  assert.equal(result.nested.nested.level3, '<REDACTED>');
  assert.equal(result.nested.nested.nested.level4, '<REDACTED>');
  assert.equal(result.nested.nested.nested.nested.level5, '<REDACTED>');
  assert.equal(result.nested.nested.nested.nested.safe, 'keep-me',
    'non-secret value should be preserved at deep level');
});

test('redactSecretFields: array traversal — redacts canaries inside arrays', () => {
  const obj = {
    items: [CANARIES[0], 'safe', CANARIES[1], 42, null],
  };
  const result = redactSecretFields(obj);
  assert.equal(result.items[0], '<REDACTED>');
  assert.equal(result.items[1], 'safe');
  assert.equal(result.items[2], '<REDACTED>');
  assert.equal(result.items[3], 42, 'number should be preserved');
  assert.equal(result.items[4], null, 'null should be preserved');
});

test('redactSecretFields: denylist key — value redacted regardless of content', () => {
  const obj = {
    ANTHROPIC_AUTH_TOKEN: 'some-value',
    OLLAMA_CLOUD_API_KEY: { complex: 'object' },
    SAFE_KEY: 'preserved',
  };
  const result = redactSecretFields(obj);
  assert.equal(result.ANTHROPIC_AUTH_TOKEN, '<REDACTED>');
  assert.equal(result.OLLAMA_CLOUD_API_KEY, '<REDACTED>');
  assert.equal(result.SAFE_KEY, 'preserved');
});

test('redactSecretFields: cycle-safe — does not throw on circular references', () => {
  const obj = { a: 1 };
  obj.self = obj; // circular reference
  // Should not throw.
  const result = redactSecretFields(obj);
  assert.equal(result.a, 1);
  // The cycle is broken by returning the already-visited object.
  assert.ok(result !== undefined);
});

test('redactSecretFields: preserves numbers, booleans, null, undefined', () => {
  const obj = {
    num: 42,
    bool: true,
    falseBool: false,
    nullVal: null,
    nested: { num: -1.5, bool: false },
  };
  const result = redactSecretFields(obj);
  assert.equal(result.num, 42);
  assert.equal(result.bool, true);
  assert.equal(result.falseBool, false);
  assert.equal(result.nullVal, null);
  assert.equal(result.nested.num, -1.5);
  assert.equal(result.nested.bool, false);
});

test('redactSecretFields: preserves safe metadata keys like secret_presence', () => {
  const obj = {
    secret_presence: 'present',
    token_status: 'ok',
    result: 'success',
  };
  const result = redactSecretFields(obj);
  assert.equal(result.secret_presence, 'present',
    'safe metadata key secret_presence should not be redacted');
  assert.equal(result.token_status, 'ok');
  assert.equal(result.result, 'success');
});

test('stress.scale deep-redaction at scale: 100 entries × 1KB strings × 10 canaries under 100ms', () => {
  // Build 100 entries; 10 of them contain a canary, rest are safe.
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
  const obj = { entries };

  const start = Date.now();
  const result = redactSecretFields(obj);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 100,
    `deep-redaction at scale must complete within 100ms; took ${elapsed}ms`);

  // All 10 canary entries must be redacted.
  for (let i = 0; i < 100; i++) {
    if (i < 10) {
      assert.equal(result.entries[i].value, '<REDACTED>',
        `entry ${i} containing canary should be redacted`);
    } else {
      assert.ok(result.entries[i].value !== '<REDACTED>',
        `entry ${i} with no canary should not be redacted`);
    }
  }
});

test('stress.scale canary in 60KB string — 3 canaries at different offsets all redacted', () => {
  const chunk1 = 'a'.repeat(20000);
  const chunk2 = 'b'.repeat(20000);
  const chunk3 = 'c'.repeat(19000);
  // Insert 3 different canaries at early, middle, and near-end positions.
  const bigStr = chunk1 + CANARIES[0] + chunk2 + CANARIES[1] + chunk3 + CANARIES[2];
  assert.ok(bigStr.length > 59000, 'string should be ~60KB+');

  const result = redactSecretFields({ data: bigStr });
  assert.equal(result.data, '<REDACTED>',
    '60KB string with 3 canaries should be fully redacted');
  // Verify none of the 3 canary tokens appear in the redacted result.
  for (const canary of CANARIES.slice(0, 3)) {
    assert.ok(!JSON.stringify(result).includes(canary),
      `canary ${canary} should not appear in redacted result`);
  }
});
