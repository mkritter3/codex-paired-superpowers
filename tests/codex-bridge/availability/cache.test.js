// v0.9.0 slice 4 — cache tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_TTL_MS,
  clearCache,
  isCacheFresh,
  readCache,
  writeCache,
  _cachePathFor,
} from '../../../lib/codex-bridge/availability/cache.js';

function tmpRepo(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

const SAMPLE_ENTRY_AVAILABLE = {
  name: 'codex',
  status: 'available',
  version: '0.42.0',
  resolved_path: '/usr/bin/env', // a path that exists on every dev box
  checked_at: '2026-05-11T22:00:00.000Z',
  plugin_version: '0.9.0',
};

const SAMPLE_ENTRY_MISSING = {
  name: 'qwen',
  status: 'missing',
  version: null,
  resolved_path: null,
  checked_at: '2026-05-11T22:00:00.000Z',
  plugin_version: '0.9.0',
  error: 'binary "qwen" not found on PATH',
};

test('readCache returns null when cache file is missing', (t) => {
  const repo = tmpRepo('cps-cache-read-missing-');
  t.after(() => cleanup(repo));
  assert.equal(readCache(repo), null);
});

test('writeCache + readCache round-trip preserves entries', (t) => {
  const repo = tmpRepo('cps-cache-roundtrip-');
  t.after(() => cleanup(repo));
  writeCache(repo, { codex: SAMPLE_ENTRY_AVAILABLE, qwen: SAMPLE_ENTRY_MISSING }, {
    pluginVersion: '0.9.0',
    cachedAt: '2026-05-11T22:00:00.000Z',
  });
  const got = readCache(repo);
  assert.ok(got, 'cache exists after write');
  assert.equal(got.plugin_version, '0.9.0');
  assert.equal(got.cached_at, '2026-05-11T22:00:00.000Z');
  assert.deepEqual(got.entries.codex, SAMPLE_ENTRY_AVAILABLE);
  assert.deepEqual(got.entries.qwen, SAMPLE_ENTRY_MISSING);
  assert.ok(existsSync(_cachePathFor(repo)), 'cache file present on disk');
});

test('isCacheFresh returns true when within TTL and versions match', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.9.0',
    cached_at: cachedAtIso,
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  // 30 minutes later, well under 1h TTL. Explicit currentPluginVersion so
  // the assertion doesn't depend on the live package.json version.
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 30 * 60 * 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.9.0',
    }),
    true,
  );
});

test('isCacheFresh returns false when TTL exceeded', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.9.0',
    cached_at: cachedAtIso,
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  // 61 minutes later → past 1h default. Pass currentPluginVersion so
  // the TTL assertion is the only thing failing the cache.
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 61 * 60 * 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.9.0',
    }),
    false,
  );
  // And a custom TTL also works:
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 10_000, 5_000, {
      currentPluginVersion: '0.9.0',
    }),
    false,
  );
});

test('isCacheFresh returns false when plugin_version mismatches current', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.8.1',
    cached_at: cachedAtIso,
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.9.0',
    }),
    false,
  );
  // Same call but matching version → fresh.
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.8.1',
    }),
    true,
  );
});

test('isCacheFresh returns false when resolved_path missing from disk', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.9.0',
    cached_at: cachedAtIso,
    entries: {
      codex: { ...SAMPLE_ENTRY_AVAILABLE, resolved_path: '/totally/gone/codex' },
    },
  };
  // pathExistsFn injected so we don't depend on real fs state.
  // currentPluginVersion pinned so the version check passes and only
  // the path-existence behavior is under test.
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      pathExistsFn: () => false,
      currentPluginVersion: '0.9.0',
    }),
    false,
  );
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      pathExistsFn: () => true,
      currentPluginVersion: '0.9.0',
    }),
    true,
  );
});

test('isCacheFresh returns false when fingerprint differs from current', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.9.0',
    cached_at: cachedAtIso,
    fingerprint: 'old-fingerprint-hash',
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.9.0',
      currentFingerprint: 'new-different-fingerprint',
    }),
    false,
    'mismatched fingerprint must invalidate cache',
  );
});

test('isCacheFresh returns true when fingerprint matches current', () => {
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.9.0',
    cached_at: cachedAtIso,
    fingerprint: 'matching-hash',
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000, DEFAULT_TTL_MS, {
      currentPluginVersion: '0.9.0',
      currentFingerprint: 'matching-hash',
    }),
    true,
  );
});

test('isCacheFresh defaults currentPluginVersion from package.json when not passed', () => {
  // Cache claims an absurdly old plugin_version that cannot match the real
  // package.json. isCacheFresh must default currentPluginVersion from
  // package.json (NOT echo the cached value) so missing options never let
  // stale caches survive.
  const cachedAtIso = '2026-05-11T22:00:00.000Z';
  const cachedAtMs = Date.parse(cachedAtIso);
  const payload = {
    plugin_version: '0.0.0-definitely-stale',
    cached_at: cachedAtIso,
    entries: { codex: SAMPLE_ENTRY_AVAILABLE },
  };
  // No currentPluginVersion option supplied.
  assert.equal(
    isCacheFresh(payload, cachedAtMs + 1000),
    false,
    'must default to live package.json version and reject stale cache',
  );
});

test('clearCache removes the file and no-ops on a second call', (t) => {
  const repo = tmpRepo('cps-cache-clear-');
  t.after(() => cleanup(repo));
  writeCache(repo, { codex: SAMPLE_ENTRY_AVAILABLE });
  assert.equal(existsSync(_cachePathFor(repo)), true);
  assert.equal(clearCache(repo), true);
  assert.equal(existsSync(_cachePathFor(repo)), false);
  // Second call: no-op, no throw.
  assert.equal(clearCache(repo), false);
});
