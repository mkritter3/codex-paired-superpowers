/**
 * CLI tests for validation-parse subcommand.
 * Uses spawnSync to invoke node lib/codex-bridge/cli.js validation-parse [--tier X]
 * with stdin. Tests the three-way exit-code semantics (0/2/1).
 *
 * NOTE: The invalid-json-input case lives ONLY here (not in unit tests) because
 * it's a CLI-layer defect — the pure parser never sees malformed JSON strings.
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
  return spawnSync('node', [CLI, 'validation-parse', ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

// Standard 14-bullet critique (tier: standard + 10 Tier-1 + 3 Tier-2)
const STANDARD_CRITIQUE_14 = JSON.stringify([
  'tier: standard',
  'happy: c',
  'edge.zero-null-empty: c',
  'edge.boundary: c',
  'edge.large-input: c',
  'edge.concurrent: c',
  'edge.adversarial: c',
  'fail.dependency: c',
  'fail.malformed-input: c',
  'fail.exception-path: c',
  'integration.cross-module: c',
  'stress.scale: not triggered',
  'perf.slo: not triggered',
  'compat.breaking: not triggered',
]);

// Critical critique: 14 standard bullets + critical.residual-risk = 15 total
const CRITICAL_CRITIQUE_15 = JSON.stringify([
  'tier: critical',
  'happy: c',
  'edge.zero-null-empty: c',
  'edge.boundary: c',
  'edge.large-input: c',
  'edge.concurrent: c',
  'edge.adversarial: c',
  'fail.dependency: c',
  'fail.malformed-input: c',
  'fail.exception-path: c',
  'integration.cross-module: c',
  'stress.scale: c',
  'perf.slo: not triggered',
  'compat.breaking: triggered — migration script breaks existing callers',
  'critical.residual-risk: stale legacy sidecar shadow mitigated by discovery rule',
]);

test('happy path: tier standard exits 0 with coverage JSON on stdout', () => {
  const r = runCli([], STANDARD_CRITIQUE_14);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tier, 'standard');
  // Coverage map should have all 13 non-tier keys (10 Tier-1 + 3 Tier-2)
  assert.equal(out.coverage['happy'], 'c');
  assert.equal(out.coverage['integration.cross-module'], 'c');
  assert.equal(out.coverage['stress.scale'], 'not triggered');
  assert.equal(out.coverage['compat.breaking'], 'not triggered');
  // tier key must NOT be in coverage
  assert.equal(out.coverage['tier'], undefined);
});

test('parser defect (tier-invalid): pipe ["tier: foo"] exits 2 with defect on stderr', () => {
  const r = runCli([], JSON.stringify(['tier: foo']));
  assert.equal(r.status, 2, `Expected exit 2 but got ${r.status}`);
  assert.equal(r.stdout, '', `Expected empty stdout but got: ${r.stdout}`);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'tier-invalid:foo');
  assert.ok(typeof err.detail === 'string' && err.detail.length > 0, 'Expected non-empty detail');
});

test('CLI-only defect (invalid-json-input): pipe non-JSON exits 2 with defect on stderr', () => {
  const r = runCli([], 'not json');
  assert.equal(r.status, 2, `Expected exit 2 but got ${r.status}`);
  assert.equal(r.stdout, '', `Expected empty stdout but got: ${r.stdout}`);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'invalid-json-input');
  assert.ok(typeof err.detail === 'string' && err.detail.length > 0, 'Expected non-empty detail');
});

test('tier-mismatch via --tier flag: standard critique with --tier critical exits 2', () => {
  const r = runCli(['--tier', 'critical'], STANDARD_CRITIQUE_14);
  assert.equal(r.status, 2, `Expected exit 2 but got ${r.status}`);
  assert.equal(r.stdout, '', `Expected empty stdout but got: ${r.stdout}`);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'tier-mismatch');
  assert.ok(typeof err.detail === 'string' && err.detail.length > 0, 'Expected non-empty detail');
});

test('round-trip: tier critical with residual-risk exits 0 with correct coverage', () => {
  const r = runCli([], CRITICAL_CRITIQUE_15);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tier, 'critical');
  // Must include the critical.residual-risk key
  assert.ok(
    typeof out.coverage['critical.residual-risk'] === 'string' &&
      out.coverage['critical.residual-risk'].length > 0,
    'Expected non-empty coverage["critical.residual-risk"]'
  );
  // Spot-check a few other required keys
  assert.equal(out.coverage['happy'], 'c');
  assert.equal(out.coverage['stress.scale'], 'c');
  // tier key must NOT be in coverage
  assert.equal(out.coverage['tier'], undefined);
});
