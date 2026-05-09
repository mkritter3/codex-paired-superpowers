/**
 * Unit tests for parseSkipFrontmatter — the skip-frontmatter validator
 * that reads `live-verification: skip - <reason>` from plan slice markdown.
 *
 * Covers:
 *   1. Valid skip with single-line justification → {skip: true, reason}
 *   2. skip without justification            → {error: {code: 'skip-justification-missing'}}
 *   3. skip with empty-string justification  → {error: {code: 'skip-justification-empty'}}
 *   4. skip with whitespace-only justification → {error: {code: 'skip-justification-empty'}}
 *   5. Wrong casing                          → {error: {code: 'skip-malformed'}}
 *   6. Absent directive                      → {skip: false}
 *   7. Multiple live-verification: lines     → {error: {code: 'skip-duplicate'}}
 *   8. Non-skip values                       → {error: {code: 'skip-unknown-value'}}
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkipFrontmatter } from '../../lib/codex-bridge/skip-frontmatter.js';

// ─── Test 1: Valid skip with single-line justification ────────────────────────

test('valid skip with single-line justification returns {skip: true, reason}', () => {
  const slice = `## Slice 3 — Rename helper function
This slice renames \`buildPath\` to \`resolvePath\` across the module.
live-verification: skip - pure refactor, no behavior change
No logic is altered; all call sites updated mechanically.`;

  const result = parseSkipFrontmatter(slice);
  assert.deepEqual(result, { skip: true, reason: 'pure refactor, no behavior change' });
});

// ─── Test 2: skip without justification ──────────────────────────────────────

test('skip without justification returns skip-justification-missing error', () => {
  const slice = `## Slice 5 — Remove dead code
Deletes unused \`legacyExport\` function.
live-verification: skip
No observable behavior change expected.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-justification-missing');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

// ─── Test 3: skip with empty-string justification ────────────────────────────

test('skip with empty justification (dash + nothing) returns skip-justification-empty error', () => {
  const slice = `## Slice 2 — Move constants
Moves constants to a shared file.
live-verification: skip -
Constants are unchanged in value.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-justification-empty');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

// ─── Test 4: skip with whitespace-only justification ─────────────────────────

test('skip with whitespace-only justification returns skip-justification-empty error', () => {
  const slice = `## Slice 7 — Reorder imports
Alphabetises import statements.
live-verification: skip -
No runtime impact.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-justification-empty');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

// ─── Test 5: Wrong casing ─────────────────────────────────────────────────────

test('wrong casing (Live-Verification: SKIP - foo) returns skip-malformed error', () => {
  const slice = `## Slice 4 — Lint cleanup
Removes trailing whitespace.
Live-Verification: SKIP - cosmetic lint fix
No logic changes.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-malformed');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

// ─── Test 6: Absent directive ─────────────────────────────────────────────────

test('absent live-verification directive returns {skip: false}', () => {
  const slice = `## Slice 1 — Add input validation
Adds range checks to the \`parseConfig\` function.
Preconditions: config file present, schema v2+ loaded.
Expected outcome: invalid configs rejected with structured errors.`;

  const result = parseSkipFrontmatter(slice);
  assert.deepEqual(result, { skip: false });
});

// ─── Test 7: Multiple live-verification: lines ────────────────────────────────

test('multiple live-verification: lines returns skip-duplicate error', () => {
  const slice = `## Slice 6 — Merge two helpers
Combines \`formatA\` and \`formatB\` into \`format\`.
live-verification: skip - pure rename
live-verification: skip - also a refactor
Only one directive is allowed per slice.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-duplicate');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

// ─── Test 8: Non-skip values ──────────────────────────────────────────────────

test('non-skip value "maybe" returns skip-unknown-value error', () => {
  const slice = `## Slice 8 — Update README
Updates installation instructions.
live-verification: maybe
Author uncertain about whether verification applies.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-unknown-value');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});

test('non-skip value "yes" returns skip-unknown-value error', () => {
  const slice = `## Slice 9 — Format dates
Switches date format to ISO 8601.
live-verification: yes
Expecting auto-verification.`;

  const result = parseSkipFrontmatter(slice);
  assert.ok(result.error, 'Expected an error object');
  assert.equal(result.error.code, 'skip-unknown-value');
  assert.ok(typeof result.error.detail === 'string' && result.error.detail.length > 0,
    'Expected non-empty detail');
});
