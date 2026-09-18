import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';

const CHECKER = resolve('scripts/check-bash32.mjs');

function run(fixture) {
  return spawnSync(process.execPath, [CHECKER, fixture], { encoding: 'utf8' });
}

test('bash 3.2 guard accepts portable shell', () => {
  const fixture = resolve('tests/scripts/fixtures/bash32/good.sh');
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, '');
});

test('bash 3.2 guard lists every incompatible construct by path and line', () => {
  const fixture = resolve('tests/scripts/fixtures/bash32/bad.sh');
  const shown = relative(process.cwd(), fixture);
  const result = run(fixture);
  assert.equal(result.status, 1);
  assert.deepEqual(result.stdout.trim().split('\n'), [2, 3, 4, 5, 6, 7].map((line) => `${shown}:${line}`));
});
