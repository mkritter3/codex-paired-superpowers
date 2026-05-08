import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseValidationCoverage } from '../../lib/codex-bridge/validation-coverage.js';

// Shared constant: a complete tier:standard critique with all 13 required keys + tier
const STANDARD_FULL = [
  'tier: standard',
  'happy: passes with valid input',
  'edge.zero-null-empty: N/A — no nullable params',
  'edge.boundary: handles boundary conditions',
  'edge.large-input: not triggered',
  'edge.concurrent: not triggered',
  'edge.adversarial: not triggered',
  'fail.dependency: mocked dependency injected',
  'fail.malformed-input: returns error object',
  'fail.exception-path: caught and re-thrown',
  'integration.cross-module: covered by integration suite',
  'stress.scale: not triggered',
  'perf.slo: not triggered',
  'compat.breaking: not triggered',
];

// ─── Happy-path tests ──────────────────────────────────────────────────────────

test('happy: complete tier:standard critique with all 13 keys parses ok', () => {
  const result = parseValidationCoverage(STANDARD_FULL);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
  assert.ok(result.coverage['happy'], 'coverage.happy should be populated');
  assert.ok(result.coverage['stress.scale'], 'coverage[stress.scale] should be populated');
});

test('happy: tier:light with 14 bullets parses ok', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: light'));
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'light');
});

test('happy: tier:critical with 14 bullets + critical.residual-risk parses ok', () => {
  const bullets = [
    ...STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: critical')),
    'critical.residual-risk: edge case under adversarial load acknowledged',
  ];
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'critical');
  assert.ok(result.coverage['critical.residual-risk'], 'coverage[critical.residual-risk] should be populated');
  assert.match(result.coverage['critical.residual-risk'], /adversarial/);
});

test('happy: whitespace tolerance — leading/trailing spaces around keys and values', () => {
  const bullets = STANDARD_FULL.map(b => `   ${b}   `);
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
});

test('happy: value tolerance — emoji + arbitrary text in value', () => {
  const bullets = STANDARD_FULL.map((b, i) => {
    if (i === 0) return b; // keep tier: standard unchanged
    const [key] = b.split(':');
    return `${key}: ✅ covered! see test #${i} for details 🎉`;
  });
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
});

// ─── Defect tests ─────────────────────────────────────────────────────────────

test('defect: tier-missing when no tier bullet', () => {
  const bullets = STANDARD_FULL.filter(b => !b.startsWith('tier:'));
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-missing');
});

test('defect: tier-invalid:foo when value not in allowed set', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: foo'));
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-invalid:foo');
});

test('defect: tier-mismatch when opts.tier differs from bullet tier', () => {
  // bullets say tier: standard, caller says critical
  const result = parseValidationCoverage(STANDARD_FULL, { tier: 'critical' });
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-mismatch');
});

test('defect: missing-key:critical.residual-risk when tier:critical but bullet absent', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: critical'));
  // No critical.residual-risk bullet added
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'missing-key:critical.residual-risk');
});

test('defect: missing-key:edge.boundary when standard critique omits edge.boundary', () => {
  const bullets = STANDARD_FULL.filter(b => !b.startsWith('edge.boundary:'));
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'missing-key:edge.boundary');
});

test('defect: duplicate-key:happy when key appears twice', () => {
  const bullets = [
    ...STANDARD_FULL,
    'happy: a duplicate happy bullet',
  ];
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'duplicate-key:happy');
});

test('defect: unknown-key:foo for unrecognized keys', () => {
  const bullets = [
    ...STANDARD_FULL,
    'foo: some unrecognized key',
  ];
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'unknown-key:foo');
});

test('defect: malformed-bullet:N when a bullet has no colon separator', () => {
  // Insert a malformed bullet at index 3 (0-indexed)
  const bullets = [...STANDARD_FULL];
  bullets.splice(3, 0, 'this bullet has no colon at all');
  // The malformed bullet is now at index 3
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.match(result.defect, /^malformed-bullet:\d+$/);
});

test('defect: empty-value:happy when value after colon is whitespace-only', () => {
  const bullets = STANDARD_FULL.map(b => {
    if (b.startsWith('happy:')) return 'happy:    ';
    return b;
  });
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'empty-value:happy');
});

test('defect: not-array when input is a string, not array', () => {
  const result = parseValidationCoverage('not an array');
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'not-array');
});

test('defect: non-string-element:N when array contains a non-string', () => {
  const bullets = [...STANDARD_FULL];
  // Insert a number at index 5
  bullets.splice(5, 0, 42);
  const result = parseValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.match(result.defect, /^non-string-element:\d+$/);
});

// ─── Sanity check: tier is NOT in coverage map ────────────────────────────────

test('sanity: coverage map does NOT include the tier key', () => {
  const result = parseValidationCoverage(STANDARD_FULL);
  assert.equal(result.ok, true);
  assert.ok(!('tier' in result.coverage), 'tier must not appear in coverage map');
});
