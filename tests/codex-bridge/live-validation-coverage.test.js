import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveValidationCoverage } from '../../lib/codex-bridge/live-validation-coverage.js';

// Shared constant: a complete tier:standard critique with tier + 13 live.* keys
const STANDARD_FULL = [
  'tier: standard',
  'live.scenarios-covered: happy path + 3 edge cases covered',
  'live.preconditions-enforced: DB seeded, env vars set',
  'live.user-takeover-safe: takeover confirmed via manual test',
  'live.evidence-quality: screenshots + log snippets attached',
  'live.assertions-visible: assertions in CI output',
  'live.logs-reviewed: no unexpected errors in run logs',
  'live.flake-triaged: no flakes observed over 5 runs',
  'live.failures-fixed: all failures resolved before merge',
  'live.regressions-rerun: regression suite passed',
  'live.cleanup-recorded: test data cleaned up post-run',
  'live.deferred-justified: no deferred items',
  'live.environment-reproducible: Docker-based env confirmed reproducible',
  'live.residual-risk: low — edge case under adversarial load acknowledged',
];

// ─── Happy-path tests ──────────────────────────────────────────────────────────

test('happy: complete tier:standard critique with all 13 live.* keys + tier parses ok', () => {
  const result = parseLiveValidationCoverage(STANDARD_FULL);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
  assert.ok(result.coverage['live.scenarios-covered'], 'coverage[live.scenarios-covered] should be populated');
  assert.ok(result.coverage['live.residual-risk'], 'coverage[live.residual-risk] should be populated');
});

test('happy: tier:light with all 13 live.* keys parses ok (some N/A-with-evidence)', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: light'));
  // Replace some values with N/A-style text (still non-empty, valid)
  const lightBullets = bullets.map((b, i) => {
    if (i === 0) return b; // keep tier: light
    if (i % 3 === 0) {
      const key = b.split(':')[0];
      return `${key}: N/A — not applicable for this tier`;
    }
    return b;
  });
  const result = parseLiveValidationCoverage(lightBullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'light');
});

test('happy: tier:critical with all 13 live.* keys parses ok', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: critical'));
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'critical');
  assert.ok(result.coverage['live.residual-risk'], 'coverage[live.residual-risk] should be populated for critical');
});

test('happy: whitespace tolerance — leading/trailing spaces around keys and values', () => {
  const bullets = STANDARD_FULL.map(b => `   ${b}   `);
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
});

test('happy: value tolerance — emoji and arbitrary text in value', () => {
  const bullets = STANDARD_FULL.map((b, i) => {
    if (i === 0) return b; // keep tier: standard unchanged
    const [key] = b.split(':');
    return `${key}: ✅ covered! see test #${i} for details 🎉`;
  });
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, true);
  assert.equal(result.tier, 'standard');
});

// ─── Defect tests ─────────────────────────────────────────────────────────────

test('defect: tier-missing when no tier bullet', () => {
  const bullets = STANDARD_FULL.filter(b => !b.startsWith('tier:'));
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-missing');
});

test('defect: tier-invalid:foo when value not in allowed set', () => {
  const bullets = STANDARD_FULL.map(b => b.replace(/^tier: standard/, 'tier: foo'));
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-invalid:foo');
});

test('defect: tier-mismatch when opts.tier differs from bullet tier', () => {
  // bullets say tier: standard, caller says critical
  const result = parseLiveValidationCoverage(STANDARD_FULL, { tier: 'critical' });
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'tier-mismatch');
});

test('defect: missing-key:live.scenarios-covered when key is absent', () => {
  const bullets = STANDARD_FULL.filter(b => !b.startsWith('live.scenarios-covered:'));
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'missing-key:live.scenarios-covered');
});

test('defect: duplicate-key:live.evidence-quality when key appears twice', () => {
  const bullets = [
    ...STANDARD_FULL,
    'live.evidence-quality: a duplicate bullet',
  ];
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'duplicate-key:live.evidence-quality');
});

test('defect: unknown-key:foo for unrecognized keys', () => {
  const bullets = [
    ...STANDARD_FULL,
    'foo: some unrecognized key',
  ];
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'unknown-key:foo');
});

test('defect: malformed-bullet:N when a bullet has no colon separator', () => {
  // Insert a malformed bullet at index 3 (0-indexed)
  const bullets = [...STANDARD_FULL];
  bullets.splice(3, 0, 'this bullet has no colon at all');
  // The malformed bullet is now at index 3
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.match(result.defect, /^malformed-bullet:\d+$/);
});

test('defect: empty-value:live.scenarios-covered when value after colon is whitespace-only', () => {
  const bullets = STANDARD_FULL.map(b => {
    if (b.startsWith('live.scenarios-covered:')) return 'live.scenarios-covered:    ';
    return b;
  });
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'empty-value:live.scenarios-covered');
});

test('defect: not-array when input is a string, not array', () => {
  const result = parseLiveValidationCoverage('not an array');
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'not-array');
});

test('defect: non-string-element:N when array contains a non-string', () => {
  const bullets = [...STANDARD_FULL];
  // Insert a number at index 5
  bullets.splice(5, 0, 42);
  const result = parseLiveValidationCoverage(bullets);
  assert.equal(result.ok, false);
  assert.match(result.defect, /^non-string-element:\d+$/);
});

// ─── Sanity check: tier is NOT in coverage map ────────────────────────────────

test('sanity: coverage map does NOT include the tier key', () => {
  const result = parseLiveValidationCoverage(STANDARD_FULL);
  assert.equal(result.ok, true);
  assert.ok(!('tier' in result.coverage), 'tier must not appear in coverage map');
});
