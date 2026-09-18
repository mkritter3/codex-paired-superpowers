import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CHECKER = resolve('scripts/check-vendored-deps.mjs');

function makeFixture({ runtimeVersion = '1.2.3', trackedVersion = runtimeVersion, includeRuntime = true, extraDev = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cps-vendored-'));
  const packages = {
    '': { dependencies: { runtime: '^1.0.0' }, devDependencies: { devtool: '^9.0.0' } },
    'node_modules/runtime': { version: runtimeVersion, dependencies: { 'runtime-child': '^2.0.0' } },
    'node_modules/runtime-child': { version: '2.0.1' },
    'node_modules/devtool': { version: '9.0.0', dev: true },
  };
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  spawnSync('git', ['init', '-q'], { cwd: root });

  const tracked = [];
  if (includeRuntime) tracked.push(['runtime', trackedVersion], ['runtime-child', '2.0.1']);
  if (extraDev) tracked.push(['devtool', '9.0.0']);
  for (const [name, version] of tracked) {
    const path = join(root, 'node_modules', name, 'package.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ name, version }));
    spawnSync('git', ['add', '-f', path], { cwd: root });
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
}

test('vendored dependency check passes when tracked packages match the runtime closure', (t) => {
  const root = makeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
});

test('vendored dependency check reports an extra tracked dev package', (t) => {
  const root = makeFixture({ extraDev: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^extra devtool@9\.0\.0$/m);
});

test('vendored dependency check reports a missing runtime package', (t) => {
  const root = makeFixture({ includeRuntime: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^missing runtime@1\.2\.3$/m);
});

test('vendored dependency check reports tracked and locked version drift', (t) => {
  const root = makeFixture({ trackedVersion: '1.2.2' });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^version runtime tracked=1\.2\.2 lock=1\.2\.3$/m);
});
