import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = join(ROOT, 'scripts', 'run-shell-tests.sh');
const FIXTURES = join(ROOT, 'tests', 'scripts', 'fixtures', 'shell-runner');

function run({ suites = '', probes = '' }) {
  return spawnSync('bash', [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPS_SHELL: 'bash',
      CPS_SHELL_SUITES: suites,
      CPS_SHELL_PROBES: probes,
    },
  });
}

test('passing suite list passes and the default inventory covers every shell test', () => {
  const runnerSource = readFileSync(RUNNER, 'utf8');
  for (const name of readdirSync(join(ROOT, 'tests', 'scripts')).filter((entry) => entry.endsWith('.test.sh'))) {
    assert.match(runnerSource, new RegExp(name.replaceAll('.', '\\.')), `${name} is absent from the runner inventory`);
  }

  const result = run({ suites: join(FIXTURES, 'pass.sh') });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS suite/);
});

test('a failing suite makes the runner fail', () => {
  const result = run({ suites: join(FIXTURES, 'fail.sh') });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL suite.*fail\.sh/);
});

test('a probe with the wrong expected exit makes the runner fail', () => {
  const probe = `${relative(ROOT, join(FIXTURES, 'probe-exit-1.sh'))}|0`;
  const result = run({ probes: probe });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL probe.*expected 0.*got 1/);
});

test('a probe with the right expected exit passes', () => {
  const probe = `${join(FIXTURES, 'probe-exit-1.sh')}|1`;
  const result = run({ probes: probe });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS probe/);
});
