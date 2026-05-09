/**
 * Unit tests for plan-parsers — parseImplementerDirective + parseFilesBlock.
 *
 * Spec: docs/specs/2026-05-08-v0.7.0-implementer-routing.md §9
 * Plan: docs/plans/2026-05-08-v0.7.0-implementation.md slice 1
 *
 * parseImplementerDirective(planText):
 *   - Default to codex when directive absent.
 *   - codex / sonnet are the only valid lower-case values.
 *   - Trim surrounding whitespace.
 *   - Case-sensitive: Codex / CODEX / Auto malformed.
 *   - Literal `auto` malformed.
 *   - Any other value malformed.
 *
 * parseFilesBlock(planSliceSection):
 *   - Block absent → {files: null} (informational).
 *   - Block present but empty → defect.
 *   - Block present with valid bullets → {files: [...]}.
 *   - Block ends at blank line, heading, or next bold directive.
 *   - Inline form malformed.
 *   - Reject absolute paths, traversal, globs, directories, backslashes,
 *     duplicates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseImplementerDirective,
  parseFilesBlock,
} from '../../lib/codex-bridge/plan-parsers.js';

// ───────────────────────── parseImplementerDirective ──────────────────────────

test('parseImplementerDirective: codex when **Implementer:** codex present', () => {
  const text = `# Plan\n\n**Implementer:** codex\n\nSome rationale.`;
  assert.deepEqual(parseImplementerDirective(text), { implementer: 'codex' });
});

test('parseImplementerDirective: sonnet when **Implementer:** sonnet present', () => {
  const text = `# Plan\n\n**Implementer:** sonnet\n\nSome rationale.`;
  assert.deepEqual(parseImplementerDirective(text), { implementer: 'sonnet' });
});

test('parseImplementerDirective: defaults to codex when directive absent', () => {
  const text = `# Plan\n\nNo directive here.\n\n## Slice 1: foo`;
  assert.deepEqual(parseImplementerDirective(text), { implementer: 'codex' });
});

test('parseImplementerDirective: trims leading/trailing whitespace around value', () => {
  const text = `**Implementer:**    codex   \n`;
  assert.deepEqual(parseImplementerDirective(text), { implementer: 'codex' });
});

test('parseImplementerDirective: trims around sonnet value too', () => {
  const text = `**Implementer:**\tsonnet\t\n`;
  assert.deepEqual(parseImplementerDirective(text), { implementer: 'sonnet' });
});

test('parseImplementerDirective: case-sensitive — Codex is malformed', () => {
  const text = `**Implementer:** Codex\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
});

test('parseImplementerDirective: case-sensitive — CODEX is malformed', () => {
  const text = `**Implementer:** CODEX\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
});

test('parseImplementerDirective: case-sensitive — Sonnet is malformed', () => {
  const text = `**Implementer:** Sonnet\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
});

test('parseImplementerDirective: case-sensitive — Auto is malformed', () => {
  const text = `**Implementer:** Auto\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
});

test('parseImplementerDirective: literal `auto` is malformed', () => {
  const text = `**Implementer:** auto\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
  assert.ok(/auto/i.test(result.detail));
});

test('parseImplementerDirective: arbitrary value (gpt5) is malformed', () => {
  const text = `**Implementer:** gpt5\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
});

test('parseImplementerDirective: empty value is malformed', () => {
  const text = `**Implementer:**\n`;
  const result = parseImplementerDirective(text);
  assert.equal(result.defect, 'implementer-directive-malformed');
});

// ─────────────────────────── parseFilesBlock ─────────────────────────────────

test('parseFilesBlock: absent block returns {files: null}', () => {
  const section = `## Slice 1: Foo\n\nSome rationale here.\n\n### Tasks\n- do thing\n`;
  assert.deepEqual(parseFilesBlock(section), { files: null });
});

test('parseFilesBlock: present but empty (no bullets) returns defect', () => {
  const section = `## Slice 1: Foo\n\n**Files:**\n\nRationale below.\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/empty/i.test(result.detail));
});

test('parseFilesBlock: present empty followed immediately by heading', () => {
  const section = `**Files:**\n## Next\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
});

test('parseFilesBlock: valid bullets returns array', () => {
  const section = `## Slice 1: Foo\n\n**Files:**\n- lib/foo.js\n- tests/foo.test.js\n\nRationale.`;
  assert.deepEqual(parseFilesBlock(section), {
    files: ['lib/foo.js', 'tests/foo.test.js'],
  });
});

test('parseFilesBlock: single bullet is valid', () => {
  const section = `**Files:**\n- lib/single.js\n`;
  assert.deepEqual(parseFilesBlock(section), { files: ['lib/single.js'] });
});

test('parseFilesBlock: block ends at blank line', () => {
  const section = `**Files:**\n- a.js\n- b.js\n\n- c.js\n`;
  assert.deepEqual(parseFilesBlock(section), { files: ['a.js', 'b.js'] });
});

test('parseFilesBlock: block ends at heading', () => {
  const section = `**Files:**\n- a.js\n## Next slice\n- b.js\n`;
  assert.deepEqual(parseFilesBlock(section), { files: ['a.js'] });
});

test('parseFilesBlock: block ends at next bold directive', () => {
  const section = `**Files:**\n- a.js\n**Implementer:** codex\n- b.js\n`;
  assert.deepEqual(parseFilesBlock(section), { files: ['a.js'] });
});

test('parseFilesBlock: inline form is malformed', () => {
  const section = `**Files:** lib/foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/inline/i.test(result.detail));
});

test('parseFilesBlock: rejects absolute path', () => {
  const section = `**Files:**\n- /abs/path/foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/absolute/i.test(result.detail));
});

test('parseFilesBlock: rejects parent traversal `../foo`', () => {
  const section = `**Files:**\n- ../foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/traversal|relative/i.test(result.detail));
});

test('parseFilesBlock: rejects current-dir prefix `./foo`', () => {
  const section = `**Files:**\n- ./foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/traversal|relative/i.test(result.detail));
});

test('parseFilesBlock: rejects single-star glob `lib/*.js`', () => {
  const section = `**Files:**\n- lib/*.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/glob/i.test(result.detail));
});

test('parseFilesBlock: rejects double-star glob `lib/**`', () => {
  const section = `**Files:**\n- lib/**\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/glob/i.test(result.detail));
});

test('parseFilesBlock: rejects directory (trailing slash)', () => {
  const section = `**Files:**\n- lib/foo/\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/director/i.test(result.detail));
});

test('parseFilesBlock: rejects backslash separator', () => {
  const section = `**Files:**\n- lib\\foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/backslash/i.test(result.detail));
});

test('parseFilesBlock: rejects duplicate paths within block', () => {
  const section = `**Files:**\n- lib/foo.js\n- lib/foo.js\n`;
  const result = parseFilesBlock(section);
  assert.equal(result.defect, 'parallel-files-malformed');
  assert.ok(/duplicate/i.test(result.detail));
});

test('parseFilesBlock: trims surrounding whitespace on bullets', () => {
  const section = `**Files:**\n-   lib/foo.js   \n-\tlib/bar.js\t\n`;
  assert.deepEqual(parseFilesBlock(section), {
    files: ['lib/foo.js', 'lib/bar.js'],
  });
});
