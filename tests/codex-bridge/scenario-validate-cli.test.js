/**
 * CLI tests for `scenario-validate` subcommand.
 * Uses spawnSync to invoke node lib/codex-bridge/cli.js scenario-validate [--require-scenarios]
 * with stdin. Tests the three-way exit-code semantics (0=success, 2=parser defect, 1=infra).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(dirname(__filename)));
const CLI = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'cli.js');

function runCli(args, stdin) {
  return spawnSync('node', [CLI, 'scenario-validate', ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

const VALID_SCENARIO_JSON = JSON.stringify({
  scenarios: [
    {
      id: 'lv-001',
      title: 'x',
      risk: 'happy-path',
      why: 'y',
      preconditions: [],
      steps: [
        { action: 'click', target: 'Button' },
      ],
      assertions: ['No errors visible'],
      diagnostic_expectations: [],
      timeout_ms: 60000,
    },
  ],
  deferred: [],
});

const MULTI_SCENARIO_JSON = JSON.stringify({
  scenarios: [
    {
      id: 'lv-001',
      title: 'Save settings',
      risk: 'happy-path',
      why: 'Catches save regressions',
      preconditions: [
        { type: 'route', value: '/settings', enforcement: 'navigate' },
      ],
      steps: [
        { action: 'click', target: 'Save button' },
        { action: 'wait_for', target: 'Success toast' },
      ],
      assertions: ['Success message is displayed'],
      diagnostic_expectations: ['No 5xx response in server logs'],
      timeout_ms: 60000,
    },
    {
      id: 'lv-002',
      title: 'Navigate to dashboard',
      risk: 'happy-path',
      why: 'Ensures dashboard loads',
      preconditions: [],
      steps: [
        { action: 'navigate', target: '/dashboard' },
      ],
      assertions: ['Dashboard is shown'],
      diagnostic_expectations: [],
      timeout_ms: 30000,
    },
  ],
  deferred: [],
});

// ─── Test 1: Happy path → exit 0 ─────────────────────────────────────────────

test('happy path: valid scenario JSON → exit 0 with parsed scenarios on stdout', () => {
  const r = runCli([], VALID_SCENARIO_JSON);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.scenarios.length, 1);
  assert.equal(out.scenarios[0].id, 'lv-001');
});

// ─── Test 2: Parser defect (zero scenarios with --require-scenarios) → exit 2 ─

test('parser defect: zero scenarios with --require-scenarios → exit 2 with defect on stderr', () => {
  const empty = JSON.stringify({ scenarios: [], deferred: [] });
  const r = runCli(['--require-scenarios'], empty);
  assert.equal(r.status, 2, `Expected exit 2 but got ${r.status}`);
  assert.equal(r.stdout, '', `Expected empty stdout but got: ${r.stdout}`);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'zero-scenarios');
});

// ─── Test 3: Invalid JSON input → exit 2 ─────────────────────────────────────

test('invalid JSON input → exit 2 with invalid-json defect on stderr', () => {
  const r = runCli([], 'not valid json {{{');
  assert.equal(r.status, 2, `Expected exit 2 but got ${r.status}`);
  assert.equal(r.stdout, '', `Expected empty stdout but got: ${r.stdout}`);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'invalid-json');
});

// ─── Test 4: Round-trip happy with multiple scenarios → exit 0, all ids ──────

test('round-trip: multiple valid scenarios → exit 0; parsed stdout has all scenario ids', () => {
  const r = runCli([], MULTI_SCENARIO_JSON);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.scenarios.length, 2);
  const ids = out.scenarios.map((s) => s.id);
  assert.deepEqual(ids, ['lv-001', 'lv-002']);
});
