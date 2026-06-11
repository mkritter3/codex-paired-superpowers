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

// ── v0.15.0 auth probe ────────────────────────────────────────────────────

test('probeCLI auth_probe: exit 0 → available', async (t) => {
  const scope = tmpdirScoped('cps-prober-auth-ok-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'authed-cli',
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi\nexit 1\n',
  );
  const result = await probeCLI('authed', {
    command: binPath,
    auth_probe: { args: ['login', 'status'], timeout_ms: 5000 },
  });
  assert.equal(result.status, 'available');
  assert.equal(result.version, '1.0.0');
});

test('probeCLI auth_probe: nonzero exit → unauthenticated with remedy', async (t) => {
  const scope = tmpdirScoped('cps-prober-auth-no-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'expired-cli',
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\necho "Not logged in" >&2\nexit 1\n',
  );
  const result = await probeCLI('expired', {
    command: binPath,
    auth_probe: { args: ['login', 'status'], timeout_ms: 5000 },
  });
  assert.equal(result.status, 'unauthenticated');
  assert.equal(result.version, '1.0.0', 'version still reported');
  assert.ok(result.resolved_path, 'path still reported');
  assert.match(result.error, /Not logged in/);
  assert.match(result.error, /login/);
});

test('probeCLI auth_probe: hung probe → broken (interactive-prompt suspect)', async (t) => {
  const scope = tmpdirScoped('cps-prober-auth-hang-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'hung-cli',
    // exec + closed stdio: when the abort signal kills the process, no
    // orphaned grandchild holds the stdout pipe open (which would stall
    // the close event for the full sleep).
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi\nexec sleep 30 </dev/null >/dev/null 2>&1\n',
  );
  const result = await probeCLI('hung', {
    command: binPath,
    auth_probe: { args: ['login', 'status'], timeout_ms: 500 },
  });
  assert.equal(result.status, 'broken');
  assert.match(result.error, /hung|prompt/i);
});

test('probeCLI without auth_probe: behavior unchanged (no extra spawn)', async (t) => {
  const scope = tmpdirScoped('cps-prober-auth-absent-');
  t.after(() => scope.cleanup());
  const binPath = writeExecutable(
    scope.dir,
    'plain-cli',
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "2.0.0"; exit 0; fi\nexit 9\n',
  );
  const result = await probeCLI('plain', { command: binPath });
  assert.equal(result.status, 'available');
});
