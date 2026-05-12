// v0.9.0 slice 4 — prober tests.
//
// Result-oriented: assert the prober payload shape. No mock-invocation
// counts. Uses real subprocess spawn with throwaway shell scripts written
// to mkdtempSync dirs — the real plugin .codex-paired/ is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeCLI, _readPluginVersion } from '../../../lib/codex-bridge/availability/prober.js';

function tmpdirScoped(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function writeExecutable(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

test('probeCLI returns status=available for a real binary (node)', async () => {
  const result = await probeCLI('node', { command: 'node' });
  assert.equal(result.name, 'node');
  assert.equal(result.status, 'available');
  assert.ok(result.resolved_path && result.resolved_path.startsWith('/'), 'resolved_path should be absolute');
  assert.ok(typeof result.version === 'string' && result.version.length > 0, 'version populated');
  assert.ok(typeof result.checked_at === 'string', 'checked_at present');
  assert.equal(result.plugin_version, _readPluginVersion());
});

test('probeCLI returns status=missing when command is not on PATH', async () => {
  const result = await probeCLI('nope', { command: '/nonexistent/binary-codex-paired-test' });
  assert.equal(result.status, 'missing');
  assert.equal(result.resolved_path, null);
  assert.equal(result.version, null);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('probeCLI returns status=broken when --version exits nonzero', async (t) => {
  const scope = tmpdirScoped('cps-prober-broken-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'broken-cli',
    '#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n',
  );
  // 5s timeout for the test (real prober default is 2s). Exit happens
  // immediately on a healthy box; the extra headroom prevents flakes under
  // CI contention where spawn() itself can take >1s.
  const result = await probeCLI('broken-cli', { command: binPath }, { timeoutMs: 5000 });
  assert.equal(result.status, 'broken');
  assert.equal(result.resolved_path, binPath);
  assert.equal(result.version, null);
  assert.ok(/code 7/.test(result.error), `expected error to mention exit code 7, got: ${result.error}`);
});

test('probeCLI returns status=broken with timeout indicator when --version hangs', async (t) => {
  const scope = tmpdirScoped('cps-prober-timeout-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'hangs',
    '#!/usr/bin/env bash\nsleep 5\n',
  );
  const result = await probeCLI('hangs', { command: binPath }, { timeoutMs: 200 });
  assert.equal(result.status, 'broken');
  assert.equal(result.resolved_path, binPath);
  assert.ok(/timed out/i.test(result.error), `expected timeout in error, got: ${result.error}`);
});

test('probeCLI treats claude-task as available when CLAUDECODE env is set', async () => {
  const result = await probeCLI(
    'claude',
    { command: '/nonexistent/claude', runtime_kind: 'claude-task' },
    { env: { CLAUDECODE: '1' } },
  );
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'session');
  assert.equal(result.runtime_kind, 'claude-task');
});

test('probeCLI plugin_version matches package.json', async () => {
  const result = await probeCLI('node', { command: 'node' });
  const pkgPath = new URL('../../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(result.plugin_version, pkg.version);
});
