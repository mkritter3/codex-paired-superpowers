// Tests for v0.7.3 plan-parsers (Files + DependsOn block parsing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractSliceSection,
  enumerateSliceIds,
  parseFilesBlock,
  parseDependsOnBlock,
  parseSliceMetadata,
  parseSliceHighStakes,
  PlanParseError,
} from '../../lib/codex-bridge/plan-parsers.js';

// ── extractSliceSection ─────────────────────────────────────────────────────

const PLAN_FIXTURE = `# Plan

## Slice 1: First

text 1

## Slice 2: Second

**Files:**
- a.js
- b.js

text 2

## Slice 3: Third

**DependsOn:**
- slice-1
- slice-2

**Files:**
- c.js
`;

test('extractSliceSection returns the slice text', () => {
  const s = extractSliceSection(PLAN_FIXTURE, 2);
  assert.match(s, /## Slice 2:/);
  assert.match(s, /a\.js/);
  assert.doesNotMatch(s, /## Slice 3:/);
});

test('extractSliceSection accepts both numeric and slice-N forms', () => {
  assert.equal(extractSliceSection(PLAN_FIXTURE, 'slice-2'), extractSliceSection(PLAN_FIXTURE, 2));
});

test('extractSliceSection returns null for missing slice', () => {
  assert.equal(extractSliceSection(PLAN_FIXTURE, 99), null);
});

test('enumerateSliceIds returns slice ids in declaration order', () => {
  assert.deepEqual(enumerateSliceIds(PLAN_FIXTURE), ['slice-1', 'slice-2', 'slice-3']);
});

// ── parseFilesBlock ─────────────────────────────────────────────────────────

test('parseFilesBlock returns paths from valid block', () => {
  const s = extractSliceSection(PLAN_FIXTURE, 2);
  assert.deepEqual(parseFilesBlock(s), ['a.js', 'b.js']);
});

test('parseFilesBlock returns [] when block absent', () => {
  assert.deepEqual(parseFilesBlock('## Slice 1\n\ntext only'), []);
});

test('parseFilesBlock rejects empty block', () => {
  const s = '## Slice 1\n\n**Files:**\n\ntext';
  assert.throws(
    () => parseFilesBlock(s),
    err => err instanceof PlanParseError && err.code === 'parallel-files-malformed'
  );
});

test('parseFilesBlock rejects inline form', () => {
  const s = '## Slice 1\n\n**Files:** a.js\n';
  assert.throws(
    () => parseFilesBlock(s),
    err => err.code === 'parallel-files-malformed' && /inline/.test(err.message)
  );
});

test('parseFilesBlock rejects glob, absolute, traversal, backslash, trailing-slash, duplicate', () => {
  const cases = [
    ['glob', '## Slice 1\n\n**Files:**\n- lib/*.js\n'],
    ['absolute', '## Slice 1\n\n**Files:**\n- /etc/passwd\n'],
    ['traversal', '## Slice 1\n\n**Files:**\n- ../foo.js\n'],
    ['backslash', '## Slice 1\n\n**Files:**\n- lib\\foo.js\n'],
    ['trailing-slash', '## Slice 1\n\n**Files:**\n- lib/\n'],
  ];
  for (const [name, plan] of cases) {
    assert.throws(
      () => parseFilesBlock(plan),
      err => err.code === 'parallel-files-malformed',
      `${name} should throw`
    );
  }
  // duplicate
  assert.throws(
    () => parseFilesBlock('## Slice 1\n\n**Files:**\n- a.js\n- a.js\n'),
    err => err.code === 'parallel-files-malformed' && /duplicate/.test(err.message)
  );
});

test('parseFilesBlock terminates block at blank line or next bold directive', () => {
  // Files followed by Tasks bold block — should not consume Tasks bullets
  const s = '## Slice 1\n\n**Files:**\n- a.js\n- b.js\n\n**DependsOn:**\n- slice-2\n';
  const files = parseFilesBlock(s);
  assert.deepEqual(files, ['a.js', 'b.js']);
});

// ── parseDependsOnBlock ────────────────────────────────────────────────────

test('parseDependsOnBlock returns slice ids from valid block', () => {
  const s = extractSliceSection(PLAN_FIXTURE, 3);
  assert.deepEqual(parseDependsOnBlock(s), ['slice-1', 'slice-2']);
});

test('parseDependsOnBlock returns [] when block absent', () => {
  assert.deepEqual(parseDependsOnBlock('## Slice 1\n\ntext only'), []);
});

test('parseDependsOnBlock rejects malformed entries (not slice-N)', () => {
  const cases = [
    'slice_3',
    'sliceabc',
    '3',
    'foo',
  ];
  for (const bad of cases) {
    const s = `## Slice 5\n\n**DependsOn:**\n- ${bad}\n`;
    assert.throws(
      () => parseDependsOnBlock(s),
      err => err instanceof PlanParseError && err.code === 'dep-block-malformed',
      `"${bad}" should throw`
    );
  }
});

test('parseDependsOnBlock rejects self-reference when ownSliceId provided', () => {
  const s = '## Slice 3\n\n**DependsOn:**\n- slice-3\n';
  assert.throws(
    () => parseDependsOnBlock(s, 'slice-3'),
    err => err.code === 'dep-self-reference'
  );
});

test('parseDependsOnBlock rejects duplicate entries', () => {
  const s = '## Slice 5\n\n**DependsOn:**\n- slice-3\n- slice-3\n';
  assert.throws(
    () => parseDependsOnBlock(s),
    err => err.code === 'dep-block-malformed' && /duplicate/.test(err.message)
  );
});

test('parseDependsOnBlock rejects empty block', () => {
  const s = '## Slice 5\n\n**DependsOn:**\n\ntext';
  assert.throws(
    () => parseDependsOnBlock(s),
    err => err.code === 'dep-block-malformed'
  );
});

test('parseDependsOnBlock rejects inline form', () => {
  const s = '## Slice 5\n\n**DependsOn:** slice-3\n';
  assert.throws(
    () => parseDependsOnBlock(s),
    err => err.code === 'dep-block-malformed'
  );
});

// ── parseSliceMetadata convenience ─────────────────────────────────────────

test('parseSliceMetadata reads a plan file and returns files+dependsOn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-plan-'));
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, PLAN_FIXTURE);
  const r = parseSliceMetadata(planPath, 'slice-3');
  assert.deepEqual(r.files, ['c.js']);
  assert.deepEqual(r.dependsOn, ['slice-1', 'slice-2']);
  rmSync(dir, { recursive: true, force: true });
});

test('parseSliceMetadata throws dep-unknown-slice for missing slice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-plan-'));
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, PLAN_FIXTURE);
  assert.throws(
    () => parseSliceMetadata(planPath, 'slice-99'),
    err => err.code === 'dep-unknown-slice'
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── parseSliceHighStakes ──────────────────────────────────────────────────────

test('parseSliceHighStakes returns true for exact **high_stakes: true** literal', () => {
  const s = '## Slice 3: Auth token refresh\n**high_stakes: true**\n**Validation:** critical\n\n[task list...]';
  assert.equal(parseSliceHighStakes(s), true);
});

test('parseSliceHighStakes returns false for **high_stakes: false** explicit opt-out', () => {
  const s = '## Slice 4: Non-sensitive slice\n**high_stakes: false**\n**Validation:** standard\n\ntext';
  assert.equal(parseSliceHighStakes(s), false);
});

test('parseSliceHighStakes returns false when no high_stakes line is present (default false)', () => {
  const s = '## Slice 1: First\n\nSome text with no frontmatter at all.\n';
  assert.equal(parseSliceHighStakes(s), false);
});

test('parseSliceHighStakes rejects malformed variants (strict parser)', () => {
  const malformedCases = [
    // No bold markers
    '## Slice 5\nhigh_stakes: true\n',
    // Missing space after colon
    '## Slice 5\n**high_stakes:true**\n',
    // Wrong value token
    '## Slice 5\n**high_stakes: yes**\n',
    // Uppercase value
    '## Slice 5\n**high_stakes: TRUE**\n',
    // Extra trailing text
    '## Slice 5\n**high_stakes: true** (see below)\n',
    // Quoted value
    '## Slice 5\n**high_stakes: "true"**\n',
  ];
  for (const section of malformedCases) {
    assert.equal(
      parseSliceHighStakes(section),
      false,
      `Expected false for malformed input: ${JSON.stringify(section.slice(0, 60))}`
    );
  }
});
