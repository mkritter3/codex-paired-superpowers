/**
 * CLI tests for live-validation-parse subcommand.
 * Uses spawnSync to invoke node lib/codex-bridge/cli.js live-validation-parse [--tier X]
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
  return spawnSync('node', [CLI, 'live-validation-parse', ...args], {
    input: stdin,
    encoding: 'utf8',
  });
}

// Standard 14-bullet Phase E critique (tier: standard + 13 live.* keys)
const STANDARD_CRITIQUE_14 = JSON.stringify([
  'tier: standard',
  'live.scenarios-covered: c',
  'live.preconditions-enforced: c',
  'live.user-takeover-safe: c',
  'live.evidence-quality: c',
  'live.assertions-visible: c',
  'live.logs-reviewed: c',
  'live.flake-triaged: c',
  'live.failures-fixed: c',
  'live.regressions-rerun: c',
  'live.cleanup-recorded: c',
  'live.deferred-justified: c',
  'live.environment-reproducible: c',
  'live.residual-risk: c',
]);

// Critical critique: 14 bullets (same count — no extra key for critical in Phase E)
const CRITICAL_CRITIQUE_14 = JSON.stringify([
  'tier: critical',
  'live.scenarios-covered: full suite run',
  'live.preconditions-enforced: env locked',
  'live.user-takeover-safe: confirmed',
  'live.evidence-quality: high — screenshots + logs',
  'live.assertions-visible: all assertions in CI output',
  'live.logs-reviewed: reviewed — no unexpected errors',
  'live.flake-triaged: stable over 10 runs',
  'live.failures-fixed: all failures resolved',
  'live.regressions-rerun: regression suite passed',
  'live.cleanup-recorded: test data cleaned up',
  'live.deferred-justified: no deferred items',
  'live.environment-reproducible: Docker-based, confirmed reproducible',
  'live.residual-risk: low — edge case under adversarial load acknowledged',
]);

test('happy path: tier standard exits 0 with coverage JSON on stdout', () => {
  const r = runCli([], STANDARD_CRITIQUE_14);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tier, 'standard');
  // Coverage map should have all 13 live.* keys
  assert.equal(out.coverage['live.scenarios-covered'], 'c');
  assert.equal(out.coverage['live.residual-risk'], 'c');
  assert.equal(out.coverage['live.environment-reproducible'], 'c');
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

test('round-trip: tier critical exits 0 with correct coverage', () => {
  const r = runCli([], CRITICAL_CRITIQUE_14);
  assert.equal(r.status, 0, `Expected exit 0 but got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '', `Expected empty stderr but got: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tier, 'critical');
  // Must include live.residual-risk key (not critical.residual-risk — Phase E uses live.*)
  assert.ok(
    typeof out.coverage['live.residual-risk'] === 'string' &&
      out.coverage['live.residual-risk'].length > 0,
    'Expected non-empty coverage["live.residual-risk"]'
  );
  // Spot-check a few other required keys
  assert.equal(out.coverage['live.scenarios-covered'], 'full suite run');
  assert.equal(out.coverage['live.environment-reproducible'], 'Docker-based, confirmed reproducible');
  // tier key must NOT be in coverage
  assert.equal(out.coverage['tier'], undefined);
});
