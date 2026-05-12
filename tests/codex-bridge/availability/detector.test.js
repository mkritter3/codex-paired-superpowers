// v0.9.0 slice 4 — detector tests.
//
// Uses DI seams (cliClientsLoader, proberFn) so no real CLIs are spawned.
// Real cache I/O against a tmpdir repoRoot — never touches the plugin's
// own .codex-paired/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  availableCLISet,
  detectAvailableCLIs,
  firstAvailableInLadder,
} from '../../../lib/codex-bridge/availability/detector.js';
import {
  fingerprintCliClients,
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

function fakeCliClients() {
  // Map<name, configEntry> mimicking bundled cli-clients/*.json shape.
  return new Map([
    ['codex', { name: 'codex', command: 'codex' }],
    ['claude', { name: 'claude', command: 'claude', runtime_kind: 'claude-task' }],
    ['ollama', { name: 'ollama', command: 'ollama', variants: { 'kimi-k2.6': {} } }],
  ]);
}

function makeProberFn(map) {
  // proberFn that returns a canned result per cli name.
  return async (name) => {
    if (!map[name]) {
      return {
        name,
        status: 'missing',
        version: null,
        resolved_path: null,
        checked_at: '2026-05-11T22:00:00.000Z',
        plugin_version: '0.9.0',
        error: `no canned result for ${name}`,
      };
    }
    return { ...map[name], name };
  };
}

test('detectAvailableCLIs with no cache probes all clis and writes the cache', async (t) => {
  const repo = tmpRepo('cps-detect-fresh-');
  t.after(() => cleanup(repo));
  const proberFn = makeProberFn({
    codex: {
      status: 'available',
      version: '0.42.0',
      resolved_path: '/usr/bin/env',
      checked_at: '2026-05-11T22:00:00.000Z',
      plugin_version: '0.9.0',
    },
    claude: {
      status: 'available',
      version: 'session',
      resolved_path: null,
      checked_at: '2026-05-11T22:00:00.000Z',
      plugin_version: '0.9.0',
    },
    ollama: {
      status: 'missing',
      version: null,
      resolved_path: null,
      checked_at: '2026-05-11T22:00:00.000Z',
      plugin_version: '0.9.0',
    },
  });
  const result = await detectAvailableCLIs(repo, {
    cliClientsLoader: () => fakeCliClients(),
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse('2026-05-11T22:00:00.000Z'),
  });
  assert.ok(result instanceof Map);
  assert.equal(result.size, 3);
  assert.equal(result.get('codex').status, 'available');
  assert.equal(result.get('ollama').status, 'missing');

  // Cache written to disk.
  const stored = readCache(repo);
  assert.ok(stored, 'cache file written');
  assert.equal(stored.plugin_version, '0.9.0');
  assert.deepEqual(Object.keys(stored.entries).sort(), ['claude', 'codex', 'ollama']);
});

test('detectAvailableCLIs with a fresh cache returns cached values without invoking proberFn', async (t) => {
  const repo = tmpRepo('cps-detect-cached-');
  t.after(() => cleanup(repo));
  const cachedAt = '2026-05-11T22:00:00.000Z';
  writeCache(
    repo,
    {
      codex: {
        name: 'codex',
        status: 'available',
        version: '0.42.0',
        resolved_path: '/usr/bin/env',
        checked_at: cachedAt,
        plugin_version: '0.9.0',
      },
    },
    {
      pluginVersion: '0.9.0',
      cachedAt,
      // Pre-seed the fingerprint that the detector will compute from
      // fakeCliClients() so the cache survives the fingerprint check.
      fingerprint: fingerprintCliClients(fakeCliClients()),
    },
  );

  let probeCalls = 0;
  const proberFn = async () => {
    probeCalls += 1;
    return { status: 'available' };
  };
  const result = await detectAvailableCLIs(repo, {
    cliClientsLoader: () => fakeCliClients(),
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt) + 60_000, // 1 minute later, well within TTL
  });
  assert.equal(probeCalls, 0, 'proberFn must not run when cache is fresh');
  assert.equal(result.get('codex').version, '0.42.0');
});

test('detectAvailableCLIs with force=true re-probes and clears the cache first', async (t) => {
  const repo = tmpRepo('cps-detect-force-');
  t.after(() => cleanup(repo));
  const cachedAt = '2026-05-11T22:00:00.000Z';
  writeCache(
    repo,
    {
      codex: {
        name: 'codex',
        status: 'available',
        version: 'stale-1.0.0',
        resolved_path: '/usr/bin/env',
        checked_at: cachedAt,
        plugin_version: '0.9.0',
      },
    },
    { pluginVersion: '0.9.0', cachedAt },
  );

  let probeCalls = 0;
  const proberFn = async (name) => {
    probeCalls += 1;
    return {
      name,
      status: 'available',
      version: 'fresh-2.0.0',
      resolved_path: '/usr/bin/env',
      checked_at: new Date().toISOString(),
      plugin_version: '0.9.0',
    };
  };

  const result = await detectAvailableCLIs(repo, {
    cliClientsLoader: () => new Map([['codex', { name: 'codex', command: 'codex' }]]),
    proberFn,
    force: true,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt) + 60_000, // still inside TTL; force overrides
  });

  assert.equal(probeCalls, 1, 'force=true must invoke proberFn');
  assert.equal(result.get('codex').version, 'fresh-2.0.0');
  const stored = readCache(repo);
  assert.equal(stored.entries.codex.version, 'fresh-2.0.0', 'cache rewritten with fresh values');
});

test('detectAvailableCLIs re-probes when cli-clients fingerprint changes (new cli added)', async (t) => {
  const repo = tmpRepo('cps-detect-fp-changed-');
  t.after(() => cleanup(repo));
  const cachedAt = '2026-05-11T22:00:00.000Z';
  // Step 1: cache contains only codex (matching its original fingerprint).
  let probeCalls = 0;
  const proberFn = async (name) => {
    probeCalls += 1;
    return {
      name,
      status: 'available',
      version: '0.42.0',
      resolved_path: '/usr/bin/env',
      checked_at: cachedAt,
      plugin_version: '0.9.0',
    };
  };
  // Initial detect with one cli-client → writes cache with its fingerprint.
  await detectAvailableCLIs(repo, {
    cliClientsLoader: () => new Map([['codex', { name: 'codex', command: 'codex' }]]),
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt),
  });
  const probesAfterFirst = probeCalls;
  assert.equal(probesAfterFirst, 1, 'first detect probes codex');

  // Step 2: loader now returns codex + a new cli "newcli". Fingerprint
  // changes → cache is stale even though we're well inside TTL.
  const result = await detectAvailableCLIs(repo, {
    cliClientsLoader: () =>
      new Map([
        ['codex', { name: 'codex', command: 'codex' }],
        ['newcli', { name: 'newcli', command: 'newcli' }],
      ]),
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt) + 60_000, // 1 minute later, inside TTL
  });
  assert.equal(
    probeCalls,
    probesAfterFirst + 2,
    'fingerprint mismatch must re-probe BOTH codex and newcli',
  );
  assert.equal(result.size, 2, 'returned map covers both clis');
  assert.ok(result.has('codex'));
  assert.ok(result.has('newcli'));
});

test('detectAvailableCLIs reuses cache when cli-clients fingerprint matches', async (t) => {
  const repo = tmpRepo('cps-detect-fp-match-');
  t.after(() => cleanup(repo));
  const cachedAt = '2026-05-11T22:00:00.000Z';
  // First call writes the cache.
  let probeCalls = 0;
  const proberFn = async (name) => {
    probeCalls += 1;
    return {
      name,
      status: 'available',
      version: '0.42.0',
      resolved_path: '/usr/bin/env',
      checked_at: cachedAt,
      plugin_version: '0.9.0',
    };
  };
  const loader = () =>
    new Map([
      ['codex', { name: 'codex', command: 'codex' }],
      ['claude', { name: 'claude', command: 'claude', runtime_kind: 'claude-task' }],
    ]);
  await detectAvailableCLIs(repo, {
    cliClientsLoader: loader,
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt),
  });
  const probesAfterFirst = probeCalls;
  // Second call: same loader (same fingerprint) → cache should be reused.
  await detectAvailableCLIs(repo, {
    cliClientsLoader: loader,
    proberFn,
    currentPluginVersion: '0.9.0',
    nowMs: Date.parse(cachedAt) + 60_000,
  });
  assert.equal(probeCalls, probesAfterFirst, 'fingerprint match must reuse cache');
});

test('detectAvailableCLIs defaults plugin-version from package.json when option omitted', async (t) => {
  const repo = tmpRepo('cps-detect-default-pv-');
  t.after(() => cleanup(repo));
  const cachedAt = '2026-05-11T22:00:00.000Z';
  // Pre-seed cache with a plugin_version that cannot match the live
  // package.json (no matter what version it is, "0.0.0-stale" won't).
  writeCache(
    repo,
    {
      codex: {
        name: 'codex',
        status: 'available',
        version: 'stale-1.0.0',
        resolved_path: '/usr/bin/env',
        checked_at: cachedAt,
        plugin_version: '0.0.0-stale',
      },
    },
    { pluginVersion: '0.0.0-stale', cachedAt },
  );

  let probeCalls = 0;
  const proberFn = async (name) => {
    probeCalls += 1;
    return {
      name,
      status: 'available',
      version: 'fresh-2.0.0',
      resolved_path: '/usr/bin/env',
      checked_at: new Date().toISOString(),
      plugin_version: '0.9.0',
    };
  };
  // Call WITHOUT currentPluginVersion option. The detector must default
  // it from package.json — NOT silently echo the cached value.
  const result = await detectAvailableCLIs(repo, {
    cliClientsLoader: () => new Map([['codex', { name: 'codex', command: 'codex' }]]),
    proberFn,
    // intentionally no currentPluginVersion
    nowMs: Date.parse(cachedAt) + 60_000, // inside TTL
  });
  assert.equal(probeCalls, 1, 'detector must re-probe when cached plugin_version is stale, even when option omitted');
  assert.equal(result.get('codex').version, 'fresh-2.0.0');
});

test('availableCLISet keeps only entries with status=available', () => {
  const detectorResult = new Map([
    ['codex', { status: 'available' }],
    ['claude', { status: 'available' }],
    ['ollama', { status: 'missing' }],
    ['qwen', { status: 'broken' }],
  ]);
  const set = availableCLISet(detectorResult);
  assert.deepEqual([...set].sort(), ['claude', 'codex']);
});

test('firstAvailableInLadder walks preference array and returns the first installed entry', () => {
  const recEntry = {
    preference: [
      { cli: 'gemini', variant: null },
      { cli: 'claude', variant: null },
      { cli: 'codex', variant: null },
    ],
  };
  const available = new Set(['claude', 'codex']);
  const got = firstAvailableInLadder(recEntry, available);
  assert.deepEqual(got, { cli: 'claude', variant: null, index: 1 });

  // None available → null.
  assert.equal(firstAvailableInLadder(recEntry, new Set(['qwen'])), null);
});

test('bin/codex-paired-doctor --json --force includes availability section', () => {
  const __filename = fileURLToPath(import.meta.url);
  // tests/codex-bridge/availability/detector.test.js → climb to plugin root.
  const pluginRoot = resolve(dirname(__filename), '..', '..', '..');
  const doctor = join(pluginRoot, 'bin', 'codex-paired-doctor');

  // Run with stdio inherited stderr → swallow, capture stdout. Doctor may
  // exit 1 if vendored-deps are absent in this env; we don't assert on
  // exit code, only on the availability payload's presence + shape.
  let stdout;
  try {
    stdout = execFileSync(doctor, ['--json', '--force'], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // execFileSync throws on non-zero exit; stdout is still on the error.
    stdout = (err && err.stdout) || '';
  }
  assert.ok(stdout.length > 0, 'doctor --json --force must produce stdout');
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.availability, 'doctor --json --force must include availability section');
  assert.ok(Array.isArray(parsed.availability.clis), 'availability.clis is an array');
  assert.ok(Array.isArray(parsed.availability.roles), 'availability.roles is an array');
  assert.ok(parsed.availability.summary, 'availability.summary present');
  assert.equal(typeof parsed.availability.summary.total, 'number');
  assert.equal(typeof parsed.availability.summary.available, 'number');
});
