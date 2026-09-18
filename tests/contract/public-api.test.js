import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertJsonShape(actual, shape, path = 'stdout') {
  if (typeof shape === 'string') {
    if (shape === 'json') return;
    assert.notEqual(shape, 'array', `${path} array declaration needs an element type`);
    assert.notEqual(shape, 'object', `${path} object declaration needs a field shape`);
    const arrayMatch = shape.match(/^(.+)\[\]$/);
    if (arrayMatch) {
      assert.notEqual(arrayMatch[1], 'object', `${path} object[] declaration needs items`);
      assert.equal(jsonType(actual), 'array', `${path} expected ${shape}, got ${jsonType(actual)}`);
      actual.forEach((item, index) => assertJsonShape(item, arrayMatch[1], `${path}[${index}]`));
      return;
    }
    const accepted = shape.split('|');
    assert.ok(accepted.includes(jsonType(actual)), `${path} expected ${shape}, got ${jsonType(actual)}`);
    return;
  }
  if ('type' in shape) {
    const accepted = shape.type.split('|');
    if (actual === null) {
      assert.ok(accepted.includes('null'), `${path} expected ${shape.type}, got null`);
      return;
    }
    if (accepted.includes('object[]')) {
      assert.equal(jsonType(actual), 'array', `${path} expected ${shape.type}, got ${jsonType(actual)}`);
      assert.ok(shape.items, `${path} object[] declaration needs items`);
      actual.forEach((item, index) => assertJsonShape(item, shape.items, `${path}[${index}]`));
      return;
    }
    assert.ok(accepted.includes('object'), `${path} has unsupported structured type ${shape.type}`);
    assert.equal(jsonType(actual), 'object', `${path} expected ${shape.type}, got ${jsonType(actual)}`);
    const required = shape.required || {};
    const optional = shape.optional || {};
    const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
    for (const key of Object.keys(required)) assert.ok(key in actual, `${path}.${key} missing`);
    if (shape.additional !== true) {
      assert.deepEqual(Object.keys(actual).filter((key) => !allowed.has(key)), [], `${path} undeclared fields`);
    }
    for (const [key, nested] of Object.entries({ ...required, ...optional })) {
      if (key in actual) assertJsonShape(actual[key], nested, `${path}.${key}`);
    }
    return;
  }
  assert.equal(jsonType(actual), 'object', `${path} must be an object`);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(shape).sort(), `${path} field set`);
  for (const [key, nested] of Object.entries(shape)) assertJsonShape(actual[key], nested, `${path}.${key}`);
}

function assertStdout(stdout, expectation, stdoutTypes, label) {
  assert.equal(stdoutKind(stdout), expectation.kind, label);
  if (expectation.kind === 'empty') {
    assert.equal(stdout, '', label);
    return;
  }
  if (expectation.kind === 'text') {
    if ('exact' in expectation) assert.equal(stdout, expectation.exact, label);
    else {
      assert.equal(typeof expectation.pattern, 'string', `${label} needs text exact or pattern`);
      assert.match(stdout, new RegExp(expectation.pattern), label);
    }
    return;
  }
  assert.equal(typeof expectation.schema, 'string', `${label} needs a JSON schema name`);
  const shape = stdoutTypes[expectation.schema];
  assert.notEqual(shape, undefined, `${label} references missing stdout_types.${expectation.schema}`);
  const parsed = JSON.parse(stdout);
  assertJsonShape(parsed, shape, label);
  if (expectation.field_values) assertSubset(parsed, expectation.field_values, `${label} field_values`);
}

function assertDeclaredType(value, declaration, path) {
  const choices = declaration.split('|');
  const domainTypes = new Set(['string', 'number', 'boolean', 'null', 'array', 'object']);
  if (choices.every((choice) => domainTypes.has(choice))) {
    assert.ok(choices.includes(jsonType(value)), `${path} expected ${declaration}, got ${jsonType(value)}`);
  } else {
    assert.ok(choices.includes(value), `${path} expected ${declaration}, got ${JSON.stringify(value)}`);
  }
}

function assertRecordTypes(record, declarations, required, optional, path) {
  const allowed = [...required, ...optional];
  assert.deepEqual(Object.keys(record).filter((key) => !allowed.includes(key)), [], `${path} undeclared fields`);
  for (const key of required) assert.ok(key in record, `${path}.${key} missing`);
  for (const [key, declaration] of Object.entries(declarations)) {
    if (key in record) assertDeclaredType(record[key], declaration, `${path}.${key}`);
  }
}

async function waitForJson(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { /* atomic rename may be in flight */ }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
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

function parsedSkillInputs(body) {
  const inputs = body.match(/^## Inputs\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (inputs) {
    const fenced = inputs[1].match(/```[^\n]*\n([\s\S]*?)\n```/);
    assert.ok(fenced, '## Inputs must contain a fenced inventory');
    return [...fenced[1].matchAll(/^([a-z][a-z0-9_-]*):/gm)].map((match) => match[1]).sort();
  }
  const required = body.match(/^## Required inputs\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(required, 'skill must contain an input section');
  return [...new Set([...required[1].matchAll(/<([a-z][a-z0-9-]*)>/g)]
    .map((match) => match[1].replace(/-path$/, '')))].sort();
}

function assertSkillsContract(contract) {
  assert.equal(contract.input_parse_rule, 'Under ## Inputs, parse keys before : in the first fenced block. Under ## Required inputs, parse unique <name> placeholders in that section and strip a -path suffix.');
  const commands = readdirSync(join(root, 'commands')).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
  assert.deepEqual(contract.items.map((item) => item.command.name).sort(), commands);
  for (const item of contract.items) {
    const command = readFileSync(join(root, 'commands', `${item.command.name}.md`), 'utf8');
    const frontmatter = command.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.equal(item.command.argument_hint, frontmatter.match(/^argument-hint:\s*"([\s\S]*)"$/m)?.[1]);
    assert.deepEqual([...item.inputs].sort(), parsedSkillInputs(readFileSync(join(root, 'skills', item.skill, 'SKILL.md'), 'utf8')));
  }
}

function assertSemverContract(contract) {
  assert.deepEqual(contract.policy, {
    breaking_stable_change: 'major', stable_addition: 'minor', internal_change: 'patch',
  });
  assert.ok(contract.public.includes('lib/codex-bridge/cli.js'));
  assert.deepEqual(contract.internal, ['lib/** except lib/codex-bridge/cli.js']);
  assert.equal(contract.wrapper_requirement, 'role-aware invocations use --model-role');
}

function projected(verbs) {
  return Object.fromEntries(Object.entries(verbs).map(([name, entry]) => [name, {
    flags: entry.flags, exits: entry.exits, stdoutKeys: entry.stdoutKeys, unsupported: entry.unsupported,
  }]));
}

function setupInvocation(setup, caseTemp) {
  const values = { '$TMP': caseTemp, '$REPO': caseTemp, '$SPEC': join(caseTemp, 'docs/spec.md') };
  if (!setup) return { values, env: {} };
  if (setup === 'repo' || setup.startsWith('sidecar') || setup.startsWith('honest-reporting') || setup.startsWith('anchor') || setup.startsWith('app-state') || setup.startsWith('reviewer')) {
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
  if (['sidecar', 'sidecar-autopilot', 'sidecar-dependency-graph', 'sidecar-goals'].includes(setup)) {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
    const seedArgs = {
      'sidecar-autopilot': ['sidecar-set-autopilot', '--specPath', values.$SPEC, '--block', '{"halt_reason":null,"current_phase":"contract"}'],
      'sidecar-dependency-graph': ['sidecar-set-dependency-graph', '--specPath', values.$SPEC, '--graph', '{"digest":"contract","dag":{"ok":true}}'],
      'sidecar-goals': ['sidecar-set-goals', '--specPath', values.$SPEC, '--block', '<<<GOALS>>>contract<<<END_GOALS>>>'],
    }[setup];
    if (seedArgs) {
      const seeded = spawnSync(process.execPath, [cli, ...seedArgs], { cwd: caseTemp, encoding: 'utf8' });
      assert.equal(seeded.status, 0, seeded.stderr);
    }
  }
  if (setup === 'sidecar-audit' || setup === 'sidecar-replay') {
    mkdirSync(join(caseTemp, 'docs'), { recursive: true });
    writeFileSync(values.$SPEC, '# spec\n');
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
    if (setup === 'sidecar-audit') {
      const audit = JSON.stringify({
        phase: 'contract', round: 1, side: 'codex',
        commands: [{ cmd: 'node --test', summary: 'passed', kind: 'verification', exit_code: 0 }],
        verdict_basis: 'contract evidence',
      });
      const seeded = spawnSync(process.execPath, [cli, 'sidecar-append-audit', '--specPath', values.$SPEC, '--audit', audit], { cwd: caseTemp, encoding: 'utf8' });
      assert.equal(seeded.status, 0, seeded.stderr);
    } else {
      for (const args of [
        ['sidecar-append-round', '--specPath', values.$SPEC, '--round', JSON.stringify({ phase: 'contract', round: 1, claude: 'continue', codex: 'continue' })],
        ['sidecar-add-contention', '--specPath', values.$SPEC, '--contention', JSON.stringify({ id: 'c1', summary: 'contract' })],
        ['sidecar-rotate-thread-id', '--specPath', values.$SPEC, '--role', 'paired-reviewer', '--oldThreadId', 'thread', '--newThreadId', 'thread-2', '--reason', 'contract', '--phase', 'contract', '--round', '1'],
      ]) {
        const seeded = spawnSync(process.execPath, [cli, ...args], { cwd: caseTemp, encoding: 'utf8' });
        assert.equal(seeded.status, 0, seeded.stderr);
      }
    }
  }
  if (setup === 'stale-sidecar') {
    const staleDir = join(caseTemp, '.superpowers-codex-paired');
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'stale.json'), JSON.stringify({
      autopilot: {
        halt_reason: null, last_tick_at: '2000-01-01T00:00:00.000Z',
        current_slice: 'slice-1', current_phase: 'implement', plan_path: 'docs/plan.md',
      },
    }));
  }
  if (setup === 'honest-reporting-active' || setup === 'honest-reporting-expired') {
    const seeded = spawnSync(process.execPath, [cli, 'honest-reporting-mark-active', '--skill', 'contract', '--cwd', caseTemp], {
      cwd: caseTemp, encoding: 'utf8',
    });
    assert.equal(seeded.status, 0, seeded.stderr);
    if (setup === 'honest-reporting-expired') {
      const markerPath = join(caseTemp, '.codex-paired', 'honest-reporting-active.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      marker.expiresAt = '2000-01-01T00:00:00.000Z';
      writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    }
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
    values.$HEAD = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: caseTemp, encoding: 'utf8' }).stdout.trim();
    initSidecar(values.$SPEC, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
    const bin = join(caseTemp, 'bin');
    mkdirSync(bin);
    copyFileSync(join(root, 'tests/fixtures/fake-cli/agy.sh'), join(bin, 'agy'));
    chmodSync(join(bin, 'agy'), 0o755);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_AGY_CONVERSATION: 'contract-thread',
      FAKE_AGY_RESPONSE: 'reviewed',
      FAKE_AGY_STATUS: setup.endsWith('failure') ? 'ERROR' : 'SUCCESS',
      FAKE_AGY_DENIED: setup.endsWith('failure') ? '' : 'contract-action',
    };
    if (setup === 'reviewer-null-usage') {
      env.FAKE_CLI_OUTPUT = JSON.stringify({
        conversation_id: 'contract-thread', status: 'ERROR', response: '', denied_actions: [],
      });
    }
    if (setup === 'reviewer-reply') {
      const opened = spawnSync(process.execPath, [cli, 'reviewer-thread-open', '--role', 'review', '--specPath', values.$SPEC, '--repoRoot', caseTemp], { cwd: caseTemp, input: 'seed', env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.equal(opened.status, 0, opened.stderr);
    }
    return { values, env };
  }
  return { values, env: {} };
}

function executeCliCase(verb, entry, item, executable = cli) {
  const caseTemp = mkdtempSync(join(tmpdir(), 'public-api-cli-case-'));
  const prepared = setupInvocation(item.invocation.setup, caseTemp);
  const args = item.invocation.args.map((value) => prepared.values[value] || value);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: caseTemp, input: item.invocation.stdin || '', encoding: 'utf8',
    env: { ...process.env, ...prepared.env, ...(item.invocation.env || {}) },
  });
  assert.equal(result.status, item.expect.exit, `${verb}/${item.case}: ${result.stderr}`);
  assertStdout(result.stdout, item.expect.stdout, entry.stdout_types, `${verb}/${item.case}`);
}

function assertCliContract(documented, executable = cli) {
  const observed = inspectSurface({ root, entry: 'lib/codex-bridge/cli.js', expansions: documented.expansions });
  const regions = digestVerbRegions(cli);
  assert.deepEqual(projected(documented.verbs), observed.verbs);
  for (const [verb, entry] of Object.entries(documented.verbs)) {
    assert.ok(entry.cases.length > 0, `${verb} has no cases`);
    const successful = entry.cases.filter((item) => item.expect.exit === 0);
    assert.ok(successful.length > 0, `${verb} has no successful case`);
    const coveredFlags = new Set(entry.cases.flatMap((item) => item.covers.flags));
    const coveredExits = new Set(entry.cases.flatMap((item) => item.covers.exits));
    const coveredKeys = new Set(entry.cases.flatMap((item) => item.covers.stdoutKeys));
    const jsonSchemas = entry.cases
      .filter((item) => item.expect.stdout.kind === 'json')
      .map((item) => item.expect.stdout.schema);
    assert.deepEqual(Object.keys(entry.stdout_types).sort(), [...jsonSchemas].sort(), `${verb} stdout_types inventory`);
    assert.deepEqual(entry.flag_contract.map((item) => item.name), entry.flags, `${verb} flag contract drift`);
    for (const item of entry.flag_contract) {
      assert.equal(typeof item.required, 'boolean', `${verb} --${item.name} required must be boolean`);
      assert.equal(typeof item.value_type, 'string', `${verb} --${item.name} needs a value type`);
    }
    for (const flag of entry.flags) {
      const flagCase = entry.cases.find((item) => item.covers.flags.includes(flag));
      assert.ok(flagCase, `${verb} flag --${flag} is uninventoried`);
      assert.ok(flagCase.invocation.args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`)),
        `${verb} flag case does not invoke --${flag}`);
      assert.ok(successful.some((item) => item.covers.flags.includes(flag)
        && item.invocation.args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`))),
      `${verb} flag --${flag} is not invoked on a success path`);
    }
    for (const exit of entry.exits) {
      assert.ok(coveredExits.has(exit), `${verb} exit ${exit} is uninventoried`);
      if (!entry.manual) assert.ok(entry.cases.some((item) => item.covers.exits.includes(exit) && item.expect.exit === exit), `${verb} exit ${exit} is not exercised`);
    }
    for (const key of entry.stdoutKeys) assert.ok(coveredKeys.has(key), `${verb} stdout key ${key} is uninventoried`);
    if (entry.unsupported.length > 0) {
      assert.ok(entry.manual, `${verb} requires a manual entry for unsupported extraction`);
    }
    if (entry.manual) {
      assert.equal(typeof entry.manual.reason, 'string', `${verb} requires a manual reason`);
      assert.equal(entry.manual.region_digest, regions[verb], `${verb} manual region changed`);
    }
    for (const item of entry.cases) {
      executeCliCase(verb, entry, item, executable);
    }
  }
}

test('public API markdown has exactly seven unique parseable blocks', () => {
  const blocks = blocksFrom();
  assert.deepEqual([...blocks.keys()].sort(), [...expectedSections].sort());
  assert.throws(() => parsePublicApiBlocks('```json public-api:unknown\n{}\n```'), /unknown/);
  assert.throws(() => parsePublicApiBlocks('```json public-api:skills\n{}\n```\n```json public-api:skills\n{}\n```'), /duplicate/);
  assert.throws(() => parsePublicApiBlocks('```json public-api:skills\nnot-json\n```'), /JSON/);
});

test('skills and semver policy blocks match their observed public boundaries', () => {
  assertSkillsContract(block('skills'));
  assertSemverContract(block('semver'));
});

test('runtime unknown-verb inventory is the documented 52-verb inventory', () => {
  const contract = block('cli-verbs');
  const result = spawnSync(process.execPath, [cli, '__unknown__'], { encoding: 'utf8' });
  assert.equal(result.status, contract.unknown_verb.exit);
  const prefix = contract.unknown_verb.stderr_prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = result.stderr.match(new RegExp(`^${prefix}(.+)$`, 'm'));
  assert.ok(match, result.stderr);
  const runtime = match[1].split(', ');
  assert.equal(runtime.length, 52);
  assert.deepEqual(runtime.sort(), Object.keys(contract.verbs).sort());
});

test('every CLI coverage case executes and every extracted item is inventoried', () => {
  const documented = block('cli-verbs');
  assertCliContract(documented);
});

test('every conditional stdout branch has an executable output variant', () => {
  const verbs = block('cli-verbs').verbs;
  const expectedCases = {
    'app-state-get': ['empty-valid-sidecar', 'all-flags-success'],
    'honest-reporting-is-active': ['no-marker', 'active-marker', 'expired-marker'],
    'honest-reporting-read-marker': ['no-marker', 'active-marker', 'expired-marker'],
    'parse-skip-frontmatter': ['without-reason', 'with-reason'],
    'sidecar-get-autopilot': ['empty-valid-sidecar', 'json-present'],
    'sidecar-get-dependency-graph': ['empty-valid-sidecar', 'json-present'],
    'sidecar-get-goals': ['empty-valid-sidecar', 'json-present'],
    'sidecar-thread-id': ['empty-role', 'text-present'],
  };
  for (const [verb, cases] of Object.entries(expectedCases)) {
    const documented = new Set(verbs[verb].cases.map((item) => item.case));
    for (const name of cases) assert.ok(documented.has(name), `${verb} missing output variant ${name}`);
  }
  const activeCases = Object.fromEntries(verbs['honest-reporting-is-active'].cases.map((item) => [item.case, item]));
  assert.deepEqual(activeCases['no-marker'].expect.stdout.field_values, {
    active: false, reason: 'marker-absent-or-malformed', marker: null,
  });
  assert.deepEqual(activeCases['active-marker'].expect.stdout.field_values, { active: true, reason: 'active' });
  assert.deepEqual(activeCases['expired-marker'].expect.stdout.field_values, { active: false, reason: 'expired' });
});

test('nested public JSON shapes reject malformed records recursively', () => {
  const verbs = block('cli-verbs').verbs;
  assert.throws(() => assertJsonShape(
    [42, { renamed_message_field: true }],
    verbs['mailbox-read'].stdout_types.success,
  ));
  assert.throws(() => assertJsonShape(
    { initialized_at: 'now', goals: [42], plans: [false], active_plan: { wrong_field: 42 } },
    verbs['app-state-get'].stdout_types['all-flags-success'],
  ));
  assert.throws(() => assertJsonShape(
    {
      threadId: 'thread', content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      ok: true, exit: 0, status: 'SUCCESS', warnings: [42],
    },
    verbs['reviewer-thread-open'].stdout_types['agy-success-json'],
  ));
});

test('unsupported extraction requires a bound manual inventory entry', () => {
  const documented = structuredClone(block('cli-verbs'));
  delete documented.verbs['model-roles'].manual;
  assert.throws(() => assertCliContract(documented), /model-roles requires a manual entry/);
});

test('successful flag coverage invokes every claimed flag', () => {
  const documented = block('cli-verbs');
  for (const [verb, entry] of Object.entries(documented.verbs)) {
    for (const flag of entry.flags) {
      assert.ok(entry.cases.some((item) => item.expect.exit === 0
        && item.covers.flags.includes(flag)
        && item.invocation.args.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`))),
      `${verb} --${flag} lacks an invoking success case`);
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
    ['mcpCallConfig', 'lib/codex-bridge/models.js', (s) => s.replace(
      'return { model: snapshot.model, config: { model_reasoning_effort: snapshot.effort } };',
      'return { model: snapshot.model, config: { model_reasoning_effort: snapshot.effort }, contract_extra: true };',
    ), 'module_digest'],
    ['agy adapter', 'lib/codex-bridge/cli-harness/adapters/agy.js', (s) => s.replace(
      "'--output-format',\n      'json',",
      "'--output-format',\n      'text',",
    ), 'module_digest'],
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
  cpSync(join(root, 'lib'), join(temp, 'lib'), { recursive: true });
  const registryPath = join(temp, 'lib/codex-bridge/cli-harness/adapters/registry.js');
  writeFileSync(registryPath, `${readFileSync(registryPath, 'utf8')}\nimport(outsideExpansion());\n`);
  const unresolved = inspectSurface({ root: temp, entry: 'lib/codex-bridge/cli.js', expansions: documented.expansions }).unresolved;
  assert.ok(unresolved.some((item) => item.path.endsWith('/registry.js') && item.kind === 'dynamic-import'));
});

function assertProjectConfigContract(contract) {
  const validate = new Ajv2020({ strict: true }).compile(contract.schema);
  const fixtureCases = [
    ['accepted-minimal.json', true],
    ['accepted-version-2.json', true],
    ['accepted-version-legacy.json', true],
    ['accepted-unknown-keys.json', true],
    ['accepted-null-blocks.json', true],
    ['accepted-library-skip.json', true],
    ['accepted-codex-dispatch-positive.json', true],
    ['accepted-mailbox-policy.json', true],
    ['accepted-worktree-symlinks.json', true],
    ['rejected-missing-version.json', false, 'missing-field:version'],
    ['rejected-missing-app.json', false, 'missing-field:app'],
    ['rejected-bad-models.json', false, 'models-config-malformed'],
    ['rejected-library-missing-skip.json', false, 'library-must-skip'],
    ['rejected-codex-dispatch-negative.json', false, 'live-verification-config-malformed'],
    ['rejected-mailbox-policy.json', false, 'live-verification-config-malformed'],
    ['rejected-worktree-numeric-symlink.json', false, 'invalid-worktree-bootstrap'],
  ];
  assert.deepEqual(
    fixtureCases.map(([name]) => name).sort(),
    readdirSync(fixtures).filter((name) => name.endsWith('.json')).sort(),
    'every project-config fixture needs an expected loader verdict',
  );
  for (const [name, accepted, error] of fixtureCases) {
    const input = JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
    const temp = mkdtempSync(join(tmpdir(), 'project-schema-rejected-'));
    writeProject(temp, input);
    const loaded = loadProjectConfig(temp);
    const loaderAccepted = loaded?.ok === true;
    const schemaAccepted = validate(input);
    assert.equal(loaderAccepted, accepted, `${name}: loader verdict`);
    assert.equal(schemaAccepted, loaderAccepted, `${name}: schema/loader disagree: ${JSON.stringify(validate.errors)}`);
    if (!accepted) assert.equal(loaded.error.code, error, name);
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
      const loaderAccepted = actual?.ok === true;
      const schemaAccepted = validate(item.input);
      if (item.schema_runtime_exception) {
        assert.equal(typeof item.schema_runtime_exception, 'string', `${item.case}: schema exception needs a reason`);
      } else {
        assert.equal(schemaAccepted, loaderAccepted, `${item.case}: schema/loader disagree: ${JSON.stringify(validate.errors)}`);
      }
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
}

test('project config schema and runtime cases characterize the existing loader', () => {
  const contract = block('project-config');
  const expectedCases = [
    'version-false-permissive', 'version-object-permissive', 'web-default-number-permissive',
    'web-skip-reason-number-permissive',
    'valid-takeover-window', 'set-login-password-env', 'valid-worktree-opt-out',
    'valid-codex-dispatch', 'valid-mailbox', 'valid-codex-model', 'valid-agy-model',
    'live-verification-array-permissive', 'takeover-null-defaulted', 'takeover-array-permissive',
    'scheduled-windows-non-array-defaulted', 'scheduled-window-primitive-permissive',
    'scheduled-window-array-coercion', 'scheduled-window-array-invalid',
    'worktree-null-defaulted', 'worktree-missing-symlinks-defaulted',
    'worktree-newline-name-permissive', 'worktree-trailing-newline-parent-permissive',
    'invalid-app-type', 'invalid-takeover-mode', 'invalid-window-start', 'invalid-window-end',
    'missing-live-verification',
    'library-must-skip', 'library-missing-skip-reason', 'unset-login-password-env',
    'worktree-block-not-object', 'worktree-symlinks-not-array', 'worktree-symlink-not-string',
    'worktree-symlink-empty', 'worktree-symlink-absolute', 'worktree-symlink-traversal',
    'codex-dispatch-not-object', 'codex-dispatch-runtime-invalid', 'codex-dispatch-log-invalid',
    'codex-dispatch-unknown-key', 'mailbox-not-object', 'mailbox-max-invalid',
    'mailbox-policy-invalid', 'mailbox-retention-days-invalid', 'mailbox-retention-count-invalid',
    'mailbox-unknown-key', 'models-not-object', 'models-unknown-role', 'models-role-not-object',
    'models-unknown-key', 'models-cli-invalid', 'models-model-empty', 'models-model-unsafe-token',
    'models-effort-invalid', 'models-agy-suffix-invalid', 'models-agy-effort-mismatch',
  ];
  for (const name of expectedCases) {
    assert.ok(contract.runtime.some((item) => item.case === name), `missing characterization case ${name}`);
  }
  assertProjectConfigContract(contract);
});

function assertSidecarContract(contract) {
  const temp = mkdtempSync(join(tmpdir(), 'sidecar-contract-'));
  const specPath = join(temp, 'spec.md');
  writeFileSync(specPath, '# spec\n');
  const sidecar = initSidecar(specPath, { feature: 'contract', codexSession: 'thread', model: 'model', reasoningEffort: 'high' });
  assert.equal(sidecar.version, contract.version);
  assert.deepEqual(Object.keys(sidecar).sort(), contract.top_level_keys);
}

test('sidecar contract pins version and initial top-level keys', () => {
  assertSidecarContract(block('sidecar'));
});

function assertWrapperUsage(contract, executable = wrapper) {
  assert.deepEqual(contract.exit_codes, [0, 64, 74, 78, 129, 130, 143, 'child-passthrough']);
  const usage = spawnSync('bash', [executable], { encoding: 'utf8' });
  assert.equal(usage.status, 64, usage.stderr);
}

test('wrapper usage, child passthrough, and status lifecycle match the contract', async () => {
  const contract = block('wrapper');
  assertWrapperUsage(contract);
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
  const badRoleStatus = JSON.parse(readFileSync(badRolePath, 'utf8'));
  assert.equal(badRoleStatus.error, 'model-role-resolution-failed');
  assertRecordTypes(badRoleStatus, contract.status_file.types, contract.status_file.required_fields, contract.status_file.optional_fields, 'wrapper config error');

  const roleRepo = join(temp, 'role-repo');
  mkdirSync(roleRepo);
  writeProject(roleRepo, {
    version: 1, app: { type: 'web' }, live_verification: {},
    models: { implement: { cli: 'codex', model: 'gpt-contract', effort: 'high' } },
  });
  const bin = join(roleRepo, 'bin');
  mkdirSync(bin);
  copyFileSync(join(root, 'tests/fixtures/fake-cli/codex.sh'), join(bin, 'codex'));
  chmodSync(join(bin, 'codex'), 0o755);
  const roleStatusPath = join(temp, 'role-aware.json');
  const roleChild = spawn('bash', [wrapper, roleStatusPath,
    '--model-role', 'implement', '--repo-root', roleRepo, '--cwd', roleRepo,
    '--', 'codex', 'exec', 'contract'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLI_DELAY_MS: '500' },
    stdio: 'ignore',
  });
  const started = await waitForJson(roleStatusPath);
  assert.equal(started.state, 'started');
  assert.equal(started.exit_code, null);
  for (const field of ['model_role', 'model', 'effort', 'cli', 'cwd']) assert.ok(field in started, `started.${field} missing`);
  assertRecordTypes(started, contract.status_file.types, contract.status_file.required_fields, contract.status_file.optional_fields, 'wrapper started');
  const roleExit = await new Promise((resolvePromise) => roleChild.once('exit', resolvePromise));
  assert.equal(roleExit, 0);
  const terminal = JSON.parse(readFileSync(roleStatusPath, 'utf8'));
  assert.equal(terminal.state, 'exited');
  assert.equal(terminal.exit_code, 0);
  assertRecordTypes(terminal, contract.status_file.types, contract.status_file.required_fields, contract.status_file.optional_fields, 'wrapper terminal');
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

function assertDoctorContract(contract) {
  const temp = mkdtempSync(join(tmpdir(), 'doctor-contract-'));
  const bin = join(temp, 'bin');
  mkdirSync(bin);
  symlinkSync(join(root, 'tests/fixtures/fake-cli/codex.sh'), join(bin, 'codex'));
  chmodSync(join(bin, 'codex'), 0o755);
  const env = { ...process.env, HOME: temp, CLAUDE_PLUGIN_ROOT: root, PATH: `${bin}:${process.env.PATH}` };
  const json = spawnSync('bash', [join(root, 'bin/codex-paired-doctor'), '--json'], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(json.status, contract.exit.no_fail, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(payload).sort(), contract.json_envelope.keys.sort());
  for (const [key, declaration] of Object.entries(contract.json_envelope.types)) {
    if (typeof declaration === 'string') assertDeclaredType(payload[key], declaration, `doctor.${key}`);
    else assertJsonShape(payload[key], declaration, `doctor.${key}`);
  }
  assert.deepEqual(payload.checks.map((item) => item.name), contract.check_names);
  for (const item of payload.checks) {
    assert.deepEqual(Object.keys(item).sort(), Object.keys(contract.json_envelope.check_fields).sort(), `doctor check ${item.name} fields`);
    for (const [field, declaration] of Object.entries(contract.json_envelope.check_fields)) {
      assertDeclaredType(item[field], declaration, `doctor check ${item.name}.${field}`);
    }
  }
  const human = spawnSync('bash', [join(root, 'bin/codex-paired-doctor')], { cwd: temp, env, encoding: 'utf8' });
  assert.equal(human.status, contract.exit.no_fail, human.stderr);
  const lines = human.stdout.split('\n').filter((line) => /^  (PASS|WARN|FAIL)\s/.test(line));
  assert.equal(lines.length, contract.check_names.length);
  const failedJson = spawnSync('bash', [join(root, 'bin/codex-paired-doctor'), '--json'], {
    cwd: temp, env: { ...env, CPS_DOCTOR_PLATFORM_OVERRIDE: 'win32' }, encoding: 'utf8',
  });
  assert.equal(failedJson.status, contract.exit.any_fail);
  assert.ok(JSON.parse(failedJson.stdout).checks.some((item) => item.name === 'platform' && item.status === 'fail'));
  const failedHuman = spawnSync('bash', [join(root, 'bin/codex-paired-doctor')], {
    cwd: temp, env: { ...env, CPS_DOCTOR_PLATFORM_OVERRIDE: 'win32' }, encoding: 'utf8',
  });
  assert.equal(failedHuman.status, contract.exit.any_fail);
  assert.match(failedHuman.stdout, /^  FAIL\s+platform/m);
}

test('doctor JSON and human output obey the documented envelope and line rules', () => {
  assertDoctorContract(block('doctor'));
});

test('section comparators reject behaviorally meaningful doc mutations', () => {
  const skills = structuredClone(block('skills'));
  skills.items[0].command.name = 'renamed-command';
  assert.throws(() => assertSkillsContract(skills));

  const cliContract = structuredClone(block('cli-verbs'));
  delete cliContract.verbs['anchor-read'].cases.find((item) => item.case === 'json-present').expect.stdout.schema;
  assert.throws(() => assertCliContract(cliContract));

  const wrapperContract = structuredClone(block('wrapper'));
  wrapperContract.exit_codes = wrapperContract.exit_codes.filter((value) => value !== 64);
  assert.throws(() => assertWrapperUsage(wrapperContract));

  const doctorContract = structuredClone(block('doctor'));
  doctorContract.json_envelope.check_fields.name = 'number';
  assert.throws(() => assertDoctorContract(doctorContract), /expected number/);

  const projectContract = structuredClone(block('project-config'));
  projectContract.schema.properties.version = { type: 'number' };
  assert.throws(() => assertProjectConfigContract(projectContract), /schema\/loader disagree/);

  const sidecarContract = structuredClone(block('sidecar'));
  sidecarContract.top_level_keys = sidecarContract.top_level_keys.filter((key) => key !== 'version');
  assert.throws(() => assertSidecarContract(sidecarContract));

  const semverContract = structuredClone(block('semver'));
  semverContract.public = semverContract.public.filter((item) => item !== 'lib/codex-bridge/cli.js');
  assert.throws(() => assertSemverContract(semverContract));
});

test('tampered CLI and wrapper implementations fail documented behavioral cases', () => {
  const temp = mkdtempSync(join(tmpdir(), 'public-api-implementation-tamper-'));
  cpSync(join(root, 'lib'), join(temp, 'lib'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'));
  const tamperedCli = join(temp, 'lib/codex-bridge/cli.js');
  const cliSource = readFileSync(tamperedCli, 'utf8');
  const changedCliSource = cliSource.replace(
    'process.stdout.write(JSON.stringify({\n      role,',
    'process.stdout.write(JSON.stringify({\n      renamedRole: role,',
  );
  assert.notEqual(changedCliSource, cliSource, 'CLI tamper must alter the handler');
  writeFileSync(tamperedCli, changedCliSource);
  const entry = block('cli-verbs').verbs['model-role'];
  const behaviorCase = entry.cases.find((item) => item.case === 'planning-json');
  assert.throws(() => executeCliCase('model-role', entry, behaviorCase, tamperedCli), /field set/);

  const source = readFileSync(wrapper, 'utf8').replace('exit 64', 'exit 65');
  const wrapperTemp = mkdtempSync(join(tmpdir(), 'wrapper-tamper-'));
  const changed = join(wrapperTemp, 'wrapper.sh');
  writeFileSync(changed, source);
  assert.throws(() => assertWrapperUsage(block('wrapper'), changed));
});
