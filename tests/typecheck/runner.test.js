import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const RUNNER = resolve('scripts/typecheck.mjs');
const FIXTURES = resolve('tests/typecheck/fixtures');
const CONFIG = resolve('tsconfig.json');

function run({ root = FIXTURES, allowlist, tsconfig = CONFIG }) {
  return spawnSync(process.execPath, [
    RUNNER,
    '--root', root,
    '--allowlist', allowlist,
    '--tsconfig', tsconfig,
  ], { encoding: 'utf8' });
}

test('typecheck runner reports semantic diagnostics with exit 1', () => {
  const result = run({ allowlist: 'allowlists/bad-types.json' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /bad-types\.js:3:\d+ TS2322/);
});

test('typecheck runner rejects an allowlisted file without the pragma', () => {
  const result = run({ allowlist: 'allowlists/no-pragma.json' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no-pragma\.js/);
  assert.match(result.stderr, /@ts-check/);
});

test('typecheck runner rejects a marked lib file missing from the allowlist', () => {
  const root = join(FIXTURES, 'roots', 'unlisted-pragma');
  const result = run({ root, allowlist: join(FIXTURES, 'allowlists', 'unlisted-pragma.json') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lib\/marked\.js/);
});

test('typecheck runner ignores semantic errors imported from unmarked JavaScript', () => {
  const result = run({ allowlist: 'allowlists/imports-unmarked-error.json' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('typecheck runner rejects an imported marked file missing from the allowlist', () => {
  const root = join(FIXTURES, 'roots', 'imports-marked');
  const result = run({ root, allowlist: join(FIXTURES, 'allowlists', 'imports-marked.json') });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /lib\/marked-error\.js/);
});

test('typecheck runner reports syntax errors imported from unmarked JavaScript', () => {
  const result = run({ allowlist: 'allowlists/imports-syntax-error.json' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /syntax-error\.js:1:\d+ TS1109/);
});

test('typecheck runner reports invalid compiler options as configuration errors', () => {
  const result = run({
    allowlist: 'allowlists/invalid-option.json',
    tsconfig: join(FIXTURES, 'tsconfig.invalid-option.json'),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /TS5023/);
  assert.match(result.stderr, /Unknown compiler option/);
});

test('typecheck runner discovers a TypeScript-recognized pragma after leading trivia', () => {
  const root = join(FIXTURES, 'roots', 'misplaced-pragma');
  const result = run({ root, allowlist: 'allowlist.json' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unlisted @ts-check file: lib\/late-pragma\.js/);
});

test('typecheck runner discovers imported marked files outside scanned directories', () => {
  const root = join(FIXTURES, 'roots', 'outside-scan');
  const result = run({ root, allowlist: 'allowlist.json' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unlisted @ts-check file: tests-like\/helper\.js/);
});

test('typecheck runner keeps strict pragma placement for allowlisted files', () => {
  const root = join(FIXTURES, 'roots', 'misplaced-allowlisted-pragma');
  const result = run({ root, allowlist: 'allowlist.json' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /allowlisted file is missing required @ts-check pragma: lib\/entry\.js/);
});
