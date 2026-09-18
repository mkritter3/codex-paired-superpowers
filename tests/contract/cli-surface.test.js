import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const fixtures = join(here, 'fixtures');
const script = join(root, 'scripts', 'cli-surface.mjs');

async function api() {
  return import(`${new URL('../../scripts/cli-surface.mjs', import.meta.url).href}?t=${Date.now()}`);
}

test('extracts flags from destructured handler parameters', async () => {
  const { extractVerbSurface } = await api();
  assert.deepEqual(extractVerbSurface(join(fixtures, 'surface/destructured.js')).verbs.alpha.flags, ['renamed', 'required']);
});

test('extracts dot and string-literal member flags', async () => {
  const { extractVerbSurface } = await api();
  assert.deepEqual(extractVerbSurface(join(fixtures, 'surface/member-access.js')).verbs.alpha.flags, ['one', 'three', 'two']);
});

test('extracts only integer-literal exits', async () => {
  const { extractVerbSurface } = await api();
  assert.deepEqual(extractVerbSurface(join(fixtures, 'surface/exit-literals.js')).verbs.alpha.exits, [0, 2]);
});

test('extracts stdout object-literal keys', async () => {
  const { extractVerbSurface } = await api();
  assert.deepEqual(extractVerbSurface(join(fixtures, 'surface/stdout-keys.js')).verbs.alpha.stdoutKeys, ['explicit', 'quoted', 'shorthand']);
});

test('manual region digests bind to normalized handler source', async () => {
  const { digestVerbRegions } = await api();
  assert.match(digestVerbRegions(join(fixtures, 'surface/stdout-keys.js')).alpha, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    digestVerbRegions(join(fixtures, 'surface/stdout-keys.js')).alpha,
    digestVerbRegions(join(fixtures, 'surface/exit-literals.js')).alpha,
  );
});

for (const [name, expected] of [
  ['unsupported-computed.js', 'computed-key'],
  ['unsupported-spread.js', 'stdout-spread'],
  ['unsupported-pass-through.js', 'args-pass-through'],
]) {
  test(`reports ${expected} without inventing coverage`, async () => {
    const { extractVerbSurface } = await api();
    assert.ok(extractVerbSurface(join(fixtures, `surface/${name}`)).verbs.alpha.unsupported.includes(expected));
  });
}

test('builds a sorted literal-import closure and applies roots/inputs expansion', async () => {
  const { inspectSurface } = await api();
  const result = inspectSurface({
    root: fixtures,
    entry: 'closure/entry.js',
    expansions: [{ site: 'closure/registry-like.js', roots: 'closure/adapters/*.js', inputs: 'closure/clients/*.json' }],
  });
  assert.deepEqual(result.closure, [
    'closure/adapters/a.js', 'closure/adapters/b.js', 'closure/entry.js',
    'closure/literal-dep.js', 'closure/registry-like.js',
  ]);
  assert.deepEqual(Object.keys(result.input_digest), ['closure/clients/a.json']);
  assert.deepEqual(result.unresolved, []);
});

for (const [file, kind] of [
  ['unresolved-import-expr.js', 'dynamic-import'],
  ['unresolved-create-require.js', 'create-require'],
  ['unresolved-resolve.js', 'require-resolve'],
  ['unresolved-meta-resolve.js', 'import-meta-resolve'],
  ['unresolved-eval.js', 'eval'],
  ['unresolved-new-function.js', 'new-function'],
]) {
  test(`reports unresolved ${kind}`, async () => {
    const { inspectSurface } = await api();
    const result = inspectSurface({ root: fixtures, entry: `closure/${file}`, expansions: [] });
    assert.equal(result.unresolved[0].kind, kind);
    assert.equal(result.unresolved[0].line, 1);
  });
}

test('CLI exits 3 when an unresolved load has no expansion', () => {
  const result = spawnSync(process.execPath, [script, '--root', fixtures, '--entry', 'closure/unresolved-import-expr.js'], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /unresolved module load/);
});

test('--digest prints only the three frozen digest keys', () => {
  const result = spawnSync(process.execPath, [script, '--digest'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ['closure', 'module_digest', 'input_digest']);
});

test('--digest --write refuses a rewrite that changes any non-digest key', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-surface-write-'));
  mkdirSync(join(temp, 'docs'));
  mkdirSync(join(temp, 'lib/codex-bridge'), { recursive: true });
  writeFileSync(join(temp, 'lib/codex-bridge/cli.js'), "const subcommands = { alpha() {} };\n");
  writeFileSync(join(temp, 'docs/public-api.md'), [
    '```json public-api:cli-verbs',
    JSON.stringify({ stability: 'stable', since: '0.18.0', expansions: [], verbs: {}, closure: [], module_digest: {}, input_digest: {} }, null, 2),
    '```', '',
  ].join('\n'));
  const before = readFileSync(join(temp, 'docs/public-api.md'), 'utf8');
  const result = spawnSync(process.execPath, [script, '--root', temp, '--digest', '--write'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(join(temp, 'docs/public-api.md'), 'utf8'), before);
  assert.match(result.stderr, /non-digest key/);
});

test('--digest --write changes exactly closure and digest keys', () => {
  const temp = mkdtempSync(join(tmpdir(), 'cli-surface-write-ok-'));
  mkdirSync(join(temp, 'docs'));
  mkdirSync(join(temp, 'lib/codex-bridge'), { recursive: true });
  writeFileSync(join(temp, 'lib/codex-bridge/cli.js'), "const subcommands = { alpha({ one }) { process.exit(2); } };\n");
  const stable = {
    stability: 'stable', since: '0.18.0', expansions: [],
    verbs: { alpha: { flags: ['one'], exits: [2], stdoutKeys: [], unsupported: [], cases: [{ case: 'preserve-me' }] } },
    closure: [], module_digest: {}, input_digest: {},
  };
  writeFileSync(join(temp, 'docs/public-api.md'), `\`\`\`json public-api:cli-verbs\n${JSON.stringify(stable, null, 2)}\n\`\`\`\n`);
  const result = spawnSync(process.execPath, [script, '--root', temp, '--digest', '--write'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(readFileSync(join(temp, 'docs/public-api.md'), 'utf8').match(/cli-verbs\n([\s\S]*?)\n```/)[1]);
  for (const key of ['stability', 'since', 'expansions', 'verbs']) assert.deepEqual(after[key], stable[key], key);
  assert.deepEqual(after.closure, ['lib/codex-bridge/cli.js']);
  assert.match(after.module_digest['lib/codex-bridge/cli.js'], /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(after.input_digest, {});
});
