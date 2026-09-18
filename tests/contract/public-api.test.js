import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { digestVerbRegions, inspectSurface, parsePublicApiBlocks } from '../../scripts/cli-surface.mjs';
import { loadProjectConfig } from '../../lib/codex-bridge/project-config.js';
import { initSidecar } from '../../lib/codex-bridge/sidecar.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const cli = join(root, 'lib/codex-bridge/cli.js');
const wrapper = join(root, 'scripts/codex-exec-with-status.sh');
const fixtures = join(here, 'fixtures/project-config');
const expectedSections = ['skills', 'cli-verbs', 'wrapper', 'doctor', 'project-config', 'sidecar', 'semver'];

function blocksFrom(path = join(root, 'docs/public-api.md')) {
  return parsePublicApiBlocks(readFileSync(path, 'utf8'));
}

function block(name) {
  return blocksFrom().get(name).value;
}

function stdoutKind(stdout) {
  if (stdout === '') return 'empty';
  try { JSON.parse(stdout); return 'json'; } catch { return 'text'; }
}

function writeProject(dir, input) {
  mkdirSync(join(dir, '.codex-paired'), { recursive: true });
  writeFileSync(join(dir, '.codex-paired/project.json'), `${JSON.stringify(input)}\n`);
}

function assertSubset(actual, expected, path = 'config') {
  if (expected === null || typeof expected !== 'object') return assert.deepEqual(actual, expected, path);
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(key in actual, `${path}.${key} is missing`);
    assertSubset(actual[key], value, `${path}.${key}`);
  }
}

function projected(verbs) {
  return Object.fromEntries(Object.entries(verbs).map(([name, entry]) => [name, {
    flags: entry.flags, exits: entry.exits, stdoutKeys: entry.stdoutKeys, unsupported: entry.unsupported,
  }]));
}

function setupInvocation(setup, caseTemp) {
  const values = { '$TMP': caseTemp, '$REPO': caseTemp, '$SPEC': join(caseTemp, 'docs/spec.md') };
  if (!setup) return { values, env: {} };
  if (setup === 'repo' || setup === 'sidecar' || setup.startsWith('anchor') || setup.startsWith('app-state') || setup.startsWith('reviewer')) {
    spawnSync('git', ['init', '-q'], { cwd: caseTemp });
  }
  if (setup === 'anchor-present') {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    spawnSync(process.execPath, [cli, 'anchor-write', '--repoRoot', caseTemp, '--specPath', values.$SPEC], { cwd: caseTemp });
  }
  if (setup === 'app-state') {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
    const seeded = spawnSync(process.execPath, [cli, 'app-state-init', '--specPath', values.$SPEC, '--goals', '[{"id":"g","text":"goal"}]'], { cwd: caseTemp, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stderr);
  }
  if (setup === 'sidecar') {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
  }
  if (setup === 'mailbox-message') {
    const written = spawnSync(process.execPath, [cli, 'mailbox-write', '--to', 'orchestrator', '--from', 'slice-1', '--text', 'contract', '--repoRoot', caseTemp], { cwd: caseTemp, encoding: 'utf8' });
    assert.equal(written.status, 0, written.stderr);
    values.$MESSAGE_ID = JSON.parse(written.stdout).id;
  }
  if (setup.startsWith('reviewer')) {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    writeProject(caseTemp, {
      version: 1, app: { type: 'web' }, live_verification: {},
      models: { review: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' } },
    });
    spawnSync('git', ['add', '.'], { cwd: caseTemp });
    const committed = spawnSync('git', ['-c', 'user.name=Contract', '-c', 'user.email=contract@example.invalid', 'commit', '-qm', 'fixture'], { cwd: caseTemp, encoding: 'utf8' });
    assert.equal(committed.status, 0, committed.stderr);
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
    const bin = join(caseTemp, 'bin');
    mkdirSync(bin);
    copyFileSync(join(root, 'tests/fixtures/fake-cli/agy.sh'), join(bin, 'agy'));
    chmodSync(join(bin, 'agy'), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_AGY_CONVERSATION: 'contract-thread', FAKE_AGY_RESPONSE: 'reviewed', FAKE_AGY_STATUS: setup.endsWith('failure') ? 'ERROR' : 'SUCCESS' };
    if (setup === 'reviewer-reply') {
      const opened = spawnSync(process.execPath, [cli, 'reviewer-thread-open', '--role', 'review', '--specPath', values.$SPEC, '--repoRoot', caseTemp], { cwd: caseTemp, input: 'seed', env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.equal(opened.status, 0, opened.stderr);
    }
    return { values, env };
  }
  return { values, env: {} };
}

test('public API markdown has exactly seven unique parseable blocks', () => {
  const blocks = blocksFrom();
  assert.deepEqual([...blocks.keys()].sort(), [...expectedSections].sort());
  assert.throws(() => parsePublicApiBlocks('```json public-api:unknown\n{}\n```'), /unknown/);
  assert.throws(() => parsePublicApiBlocks('```json public-api:skills\n{}\n```\n```json public-api:skills\n{}\n```'), /duplicate/);
  assert.throws(() => parsePublicApiBlocks('```json public-api:skills\nnot-json\n```'), /JSON/);
});

test('runtime unknown-verb inventory is the documented 52-verb inventory', () => {
  const result = spawnSync(process.execPath, [cli, '__unknown__'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  const match = result.stderr.match(/^available: (.+)$/m);
  assert.ok(match, result.stderr);
  const runtime = match[1].split(', ');
  assert.equal(runtime.length, 52);
  assert.deepEqual(runtime.sort(), Object.keys(block('cli-verbs').verbs).sort());
});

test('every CLI coverage case executes and every extracted item is inventoried', () => {
  const temp = mkdtempSync(join(tmpdir(), 'public-api-cli-'));
  const documented = block('cli-verbs');
  const observed = inspectSurface({ root, entry: 'lib/codex-bridge/cli.js', expansions: documented.expansions });
  const regions = digestVerbRegions(cli);
  assert.deepEqual(projected(documented.verbs), observed.verbs);
  for (const [verb, entry] of Object.entries(documented.verbs)) {
    assert.ok(entry.cases.length > 0, `${verb} has no cases`);
    const coveredFlags = new Set(entry.cases.flatMap((item) => item.covers.flags));
    const coveredExits = new Set(entry.cases.flatMap((item) => item.covers.exits));
    const coveredKeys = new Set(entry.cases.flatMap((item) => item.covers.stdoutKeys));
    assert.deepEqual(entry.flag_contract.map((item) => item.name), entry.flags, `${verb} flag contract drift`);
    for (const item of entry.flag_contract) {
      assert.equal(typeof item.required, 'boolean', `${verb} --${item.name} required must be boolean`);
      assert.equal(typeof item.value_type, 'string', `${verb} --${item.name} needs a value type`);
    }
    for (const flag of entry.flags) {
      const flagCase = entry.cases.find((item) => item.covers.flags.includes(flag));
      assert.ok(flagCase, `${verb} flag --${flag} is uninventoried`);
      assert.ok(flagCase.invocation.args.includes(`--${flag}`), `${verb} flag case does not invoke --${flag}`);
    }
    for (const exit of entry.exits) {
      assert.ok(coveredExits.has(exit), `${verb} exit ${exit} is uninventoried`);
      if (!entry.manual) assert.ok(entry.cases.some((item) => item.covers.exits.includes(exit) && item.expect.exit === exit), `${verb} exit ${exit} is not exercised`);
    }
    for (const key of entry.stdoutKeys) assert.ok(coveredKeys.has(key), `${verb} stdout key ${key} is uninventoried`);
    for (const key of entry.stdoutKeys) assert.equal(typeof entry.stdout_types[key], 'string', `${verb}.${key} needs a JSON type`);
    if (entry.unsupported.length) {
      assert.equal(typeof entry.manual?.reason, 'string', `${verb} requires a manual reason`);
      assert.equal(entry.manual.region_digest, regions[verb], `${verb} manual region changed`);
    }
    for (const item of entry.cases) {
      const caseTemp = mkdtempSync(join(temp, 'case-'));
      const prepared = setupInvocation(item.invocation.setup, caseTemp);
      const args = item.invocation.args.map((value) => prepared.values[value] || value);
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: caseTemp, input: item.invocation.stdin || '', encoding: 'utf8',
        env: { ...process.env, ...prepared.env, ...(item.invocation.env || {}) },
      });
      assert.equal(result.status, item.expect.exit, `${verb}/${item.case}: ${result.stderr}`);
      assert.equal(stdoutKind(result.stdout), item.expect.stdout.kind, `${verb}/${item.case}`);
      if (item.covers.stdoutKeys.length) {
        const payload = JSON.parse(result.stdout);
        for (const key of item.covers.stdoutKeys) assert.ok(key in payload, `${verb}/${item.case} does not emit ${key}`);
      }
    }
  }
});

test('module closure, normalized module digests, and raw input digests match', () => {
  const documented = block('cli-verbs');
  const actual = inspectSurface({ root, entry: 'lib/codex-bridge/cli.js', expansions: documented.expansions });
  assert.deepEqual(actual.unresolved, []);
  assert.deepEqual(actual.closure, documented.closure);
  assert.deepEqual(actual.module_digest, documented.module_digest);
  assert.deepEqual(actual.input_digest, documented.input_digest);
});

test('all eight CLI completeness negative controls detect drift', () => {
  const documented = block('cli-verbs');
  const source = readFileSync(cli, 'utf8');
  const controls = [
    ['new flag', source.replace("'model-role'({ role, repoRoot, format = 'json' })", "'model-role'({ role, repoRoot, format = 'json', newFlag })")],
    ['new stdout key', source.replace('role,\n      cli: execInfo.cli,', 'role,\n      new_stdout_key: true,\n      cli: execInfo.cli,')],
    ['format text', source.replace("if (format === 'flags')", "if (format === 'text') return process.stdout.write('text');\n    if (format === 'flags')")],
    ['MESSAGE_ID_RE', source.replace('Z-\\d{4}$/', 'Z-\\d{3,4}$/')],
  ];
  for (const [name, tampered] of controls) {
    const temp = mkdtempSync(join(tmpdir(), 'public-api-negative-'));
    mkdirSync(join(temp, 'lib/codex-bridge'), { recursive: true });
    writeFileSync(join(temp, 'lib/codex-bridge/cli.js'), tampered);
    const actual = inspectSurface({ root: temp, entry: 'lib/codex-bridge/cli.js', expansions: [] });
    const changed = JSON.stringify(actual.verbs) !== JSON.stringify(projected(documented.verbs))
      || actual.module_digest['lib/codex-bridge/cli.js'] !== documented.module_digest['lib/codex-bridge/cli.js'];
    assert.equal(changed, true, name);
  }

  for (const [name, rel, edit, digestKey] of [
    ['mcpCallConfig', 'lib/codex-bridge/models.js', (s) => `${s}\n// changed producer\n`, 'module_digest'],
    ['agy adapter', 'lib/codex-bridge/cli-harness/adapters/agy.js', (s) => `${s}\n// changed adapter\n`, 'module_digest'],
    ['agy runtime_kind', 'lib/codex-bridge/cli-clients/agy.json', (s) => s.replace('{', '{\n  "runtime_kind": "changed",'), 'input_digest'],
  ]) {
    const temp = mkdtempSync(join(tmpdir(), 'public-api-negative-'));
    const target = join(temp, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, edit(readFileSync(join(root, rel), 'utf8')));
    const actual = digestKey === 'module_digest'
      ? inspectSurface({ root: temp, entry: rel, expansions: [] }).module_digest[rel]
      : createHash('sha256').update(readFileSync(target)).digest('hex');
    const pinned = digestKey === 'module_digest' ? documented.module_digest[rel] : documented.input_digest[rel].slice(7);
    assert.notEqual(actual, pinned, name);
  }

  const temp = mkdtempSync(join(tmpdir(), 'public-api-negative-'));
  mkdirSync(join(temp, 'lib/codex-bridge'), { recursive: true });
  writeFileSync(join(temp, 'lib/codex-bridge/cli.js'), `${source}\nimport(getComputedModule());\n`);
  assert.equal(inspectSurface({ root: temp, entry: 'lib/codex-bridge/cli.js', expansions: [] }).unresolved[0].kind, 'dynamic-import');
});

test('project config schema and runtime cases characterize the existing loader', () => {
  const contract = block('project-config');
  const validate = new Ajv2020({ strict: true }).compile(contract.schema);
  for (const name of ['accepted-minimal.json', 'accepted-version-2.json', 'accepted-unknown-keys.json', 'accepted-null-blocks.json']) {
    const value = JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
  for (const [name, error] of [
    ['rejected-missing-version.json', 'missing-field:version'],
    ['rejected-missing-app.json', 'missing-field:app'],
    ['rejected-bad-models.json', 'models-config-malformed'],
  ]) {
    const input = JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
    assert.equal(validate(input), false, name);
    const temp = mkdtempSync(join(tmpdir(), 'project-schema-rejected-'));
    writeProject(temp, input);
    assert.equal(loadProjectConfig(temp).error.code, error, name);
  }
  for (const item of contract.runtime) {
    const temp = mkdtempSync(join(tmpdir(), 'project-contract-'));
    writeProject(temp, item.input);
    const saved = {};
    for (const [key, value] of Object.entries(item.env || {})) {
      saved[key] = process.env[key];
      if (value === null) delete process.env[key]; else process.env[key] = value;
    }
    try {
      const actual = loadProjectConfig(temp);
      if (item.expect.error) assert.equal(actual.error.code, item.expect.error, item.case);
      else {
        assert.equal(actual.ok, true, item.case);
        assertSubset(actual.config, item.expect.config, item.case);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
});

test('sidecar contract pins version and initial top-level keys', () => {
  const contract = block('sidecar');
  const temp = mkdtempSync(join(tmpdir(), 'sidecar-contract-'));
  const specPath = join(temp, 'spec.md');
  writeFileSync(specPath, '# spec\n');
  const sidecar = initSidecar(specPath, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
  assert.equal(sidecar.version, contract.version);
  assert.deepEqual(Object.keys(sidecar).sort(), contract.top_level_keys);
});

test('wrapper usage, child passthrough, and status lifecycle match the contract', () => {
  const contract = block('wrapper');
  assert.deepEqual(contract.exit_codes, [0, 64, 74, 78, 129, 130, 143, 'child-passthrough']);
  const usage = spawnSync('bash', [wrapper], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
  const temp = mkdtempSync(join(tmpdir(), 'wrapper-contract-'));
  const statusPath = join(temp, 'status.json');
  const child = spawnSync('bash', [wrapper, statusPath, '--', 'bash', '-c', 'exit 23'], { encoding: 'utf8' });
  assert.equal(child.status, 23);
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  assert.deepEqual(Object.keys(status).sort(), contract.status_file.required_fields.sort());
  assert.equal(status.state, 'exited');
  assert.equal(status.exit_code, 23);
  const successPath = join(temp, 'success.json');
  assert.equal(spawnSync('bash', [wrapper, successPath, '--', 'bash', '-c', 'exit 0']).status, 0);
  assert.equal(JSON.parse(readFileSync(successPath, 'utf8')).exit_code, 0);
  const cannotWrite = spawnSync('bash', [wrapper, '/dev/null/status.json', '--', 'bash', '-c', 'exit 0'], { encoding: 'utf8' });
  assert.equal(cannotWrite.status, 74);
  const badRolePath = join(temp, 'bad-role.json');
  const badRole = spawnSync('bash', [wrapper, badRolePath, '--model-role', 'not-a-role', '--', 'bash', '-c', 'exit 0'], { encoding: 'utf8' });
  assert.equal(badRole.status, 78);
  assert.equal(JSON.parse(readFileSync(badRolePath, 'utf8')).error, 'model-role-resolution-failed');
});

for (const [signal, exit] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`wrapper records ${signal} as exit ${exit}`, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'wrapper-signal-'));
    const statusPath = join(temp, 'status.json');
    const child = spawn('bash', [wrapper, statusPath, '--', 'bash', '-c', 'while :; do sleep 1; done'], { stdio: 'ignore' });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    child.kill(signal);
    await new Promise((resolvePromise) => child.once('exit', resolvePromise));
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.exit_code, exit);
    assert.equal(status.signal, signal);
  });
}

test('doctor JSON and human output obey the documented envelope and line rules', () => {
  const contract = block('doctor');
  const temp = mkdtempSync(join(tmpdir(), 'doctor-contract-'));
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  symlinkSync(join(root, 'tests/fixtures/fake-cli/codex.sh'), join(bin, 'codex'));
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, HOME: temp, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` };
  const json = spawnSync('bash', [join(root, 'bin/codex-paired-doctor'), '--json'], { cwd: temp, env, encoding: 'utf8' });
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(payload).sort(), contract.json_envelope.keys.sort());
  assert.deepEqual(payload.checks.map((item) => item.name), contract.check_names);
  for (const item of payload.checks) assert.ok(['pass', 'warn', 'fail'].includes(item.status));
  const human = spawnSync('bash', [join(root, 'bin/codex-paired-doctor')], { cwd: temp, env, encoding: 'utf8' });
  const lines = human.stdout.split('\n').filter((line) => /^  (PASS|WARN|FAIL)\s/.test(line));
  assert.equal(lines.length, contract.check_names.length);
  const failed = spawnSync('bash', [join(root, 'bin/codex-paired-doctor')], {
    cwd: temp, env: { ...env, CPS_DOCTOR_PLATFORM_OVERRIDE: 'win32' }, encoding: 'utf8',
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^  FAIL\s+platform/m);
});

test('section comparators reject one tampered field in every public API block', () => {
  for (const section of expectedSections) {
    const value = structuredClone(block(section));
    value.stability = value.stability === 'stable' ? 'experimental' : 'stable';
    assert.notDeepEqual(value, block(section), section);
  }
  const source = readFileSync(wrapper, 'utf8').replace('exit 64', 'exit 65');
  const temp = mkdtempSync(join(tmpdir(), 'wrapper-tamper-'));
  const changed = join(temp, 'wrapper.sh');
  writeFileSync(changed, source);
  const result = spawnSync('bash', [changed], { encoding: 'utf8' });
  assert.notEqual(result.status, block('wrapper').exit_codes[1]);
});
