// Tests for lib/codex-bridge/implementer/frontmatter.js (v0.10.0 slice 1).
// Validation tier: standard.
// All assertions are result-oriented (return values, thrown error codes).
// Mock-vs-integration: pure parsing tests, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImplementersBlock } from '../../../lib/codex-bridge/implementer/frontmatter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal plan markdown with optional frontmatter.
 *
 * @param {{ high_cost?: boolean, high_cost_rationale?: string }} [fm]
 * @returns {string}
 */
function buildPlan({ high_cost, high_cost_rationale } = {}) {
  const lines = ['---', 'slice_id: test-slice'];
  if (high_cost !== undefined) lines.push(`high_cost: ${high_cost}`);
  if (high_cost_rationale !== undefined) lines.push(`high_cost_rationale: ${high_cost_rationale}`);
  lines.push('---', '', '## Slice 1: Test', '');
  return lines.join('\n');
}

/**
 * Build a slice section with an Implementers block.
 *
 * @param {Array<{member_id: string, adapter?: string, model?: string, required?: boolean, files?: string[], overlap_rationale?: string}>} members
 * @returns {string}
 */
function buildSliceSection(members) {
  const lines = ['## Slice 1: Test', '', '**Implementers:**'];
  for (const m of members) {
    lines.push(`- member_id: ${m.member_id}`);
    lines.push(`  adapter: ${m.adapter ?? 'claude-cli'}`);
    lines.push(`  model: ${m.model ?? 'kimi-k2.6:cloud'}`);
    lines.push(`  required: ${m.required ?? true}`);
    if (m.files && m.files.length > 0) {
      lines.push('  files:');
      for (const f of m.files) {
        lines.push(`    - ${f}`);
      }
    }
    if (m.overlap_rationale) {
      lines.push(`  overlap_rationale: ${m.overlap_rationale}`);
    }
  }
  lines.push('', '**Commit:** ...');
  return lines.join('\n');
}

// ── Returns null when no Implementers block present ───────────────────────────

test('parseImplementersBlock: returns null when no **Implementers:** block', () => {
  const plan = buildPlan();
  const sliceSection = '## Slice 1: Test\n\nSome text without implementers.\n';
  const result = parseImplementersBlock(plan, sliceSection);
  assert.equal(result, null);
});

test('parseImplementersBlock: returns null for empty slice section', () => {
  const plan = buildPlan();
  const result = parseImplementersBlock(plan, '');
  assert.equal(result, null);
});

// ── 3 implementers allowed without high_cost ──────────────────────────────────

test('parseImplementersBlock: 3 implementers allowed without high_cost', () => {
  const plan = buildPlan(); // no high_cost field → defaults to false
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers.length, 3);
  assert.equal(result.high_cost, false);
});

test('parseImplementersBlock: 1 implementer allowed without high_cost', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers.length, 1);
});

// ── 4 implementers require high_cost: true + non-empty rationale ──────────────

test('parseImplementersBlock: 4 implementers with high_cost: true + rationale → allowed', () => {
  const plan = buildPlan({
    high_cost: true,
    high_cost_rationale: 'Large parallel workload — four partitioned modules',
  });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers.length, 4);
  assert.equal(result.high_cost, true);
});

test('parseImplementersBlock: 4 implementers without high_cost throws implementer-cap-exceeded', () => {
  const plan = buildPlan(); // high_cost: false
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'implementer-cap-exceeded');
      return true;
    }
  );
});

test('parseImplementersBlock: 4 implementers with high_cost: true but empty rationale throws', () => {
  const plan = buildPlan({ high_cost: true, high_cost_rationale: '' });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'implementer-high-cost-rationale-missing');
      return true;
    }
  );
});

test('parseImplementersBlock: empty-string high_cost_rationale treated as missing', () => {
  // Confirm that a whitespace-only rationale is also treated as missing.
  const plan = buildPlan({ high_cost: true, high_cost_rationale: '   ' });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.equal(err.code, 'implementer-high-cost-rationale-missing');
      return true;
    }
  );
});

// ── 6 implementers always throws role-composer-fan-out-unjustified ────────────

test('parseImplementersBlock: 6 implementers always throws role-composer-fan-out-unjustified', () => {
  // Even with high_cost: true + rationale, >5 is always rejected.
  const plan = buildPlan({
    high_cost: true,
    high_cost_rationale: 'Extremely large parallel workload, very justified',
  });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#2', files: ['lib/e.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#3', files: ['lib/f.js'] },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'role-composer-fan-out-unjustified');
      return true;
    }
  );
});

test('parseImplementersBlock: 5 implementers with high_cost + rationale → allowed', () => {
  const plan = buildPlan({
    high_cost: true,
    high_cost_rationale: 'Five large partitioned modules',
  });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#2', files: ['lib/e.js'] },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers.length, 5);
});

// ── Duplicate member_id throws ────────────────────────────────────────────────

test('parseImplementersBlock: duplicate member_id throws implementer-member-id-invalid', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/b.js'] }, // duplicate
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'implementer-member-id-invalid');
      return true;
    }
  );
});

// ── Missing files throws ──────────────────────────────────────────────────────

test('parseImplementersBlock: missing files throws implementer-claimed-files-missing', () => {
  const plan = buildPlan();
  // Manually build a section without a files list for one member.
  const sliceSection = [
    '## Slice 1: Test',
    '',
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  adapter: claude-cli',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    // no files: block
    '',
  ].join('\n');
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'implementer-claimed-files-missing');
      return true;
    }
  );
});

// ── Overlapping files without overlap_rationale throws ────────────────────────

test('parseImplementersBlock: overlapping files without overlap_rationale throws', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    // Both members claim the same file; neither has overlap_rationale.
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/shared.js', 'lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/shared.js', 'lib/b.js'] },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.ok(err instanceof Error);
      // The code should be the claimed-files-missing code (overlap without rationale).
      assert.equal(err.code, 'implementer-claimed-files-missing');
      return true;
    }
  );
});

test('parseImplementersBlock: overlapping files with overlap_rationale on BOTH members → allowed', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    {
      member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0',
      files: ['lib/shared.js', 'lib/a.js'],
      overlap_rationale: 'shared types file, both members extend it',
    },
    {
      member_id: 'expert-implementer@codex:gpt-5.5#0',
      files: ['lib/shared.js', 'lib/b.js'],
      overlap_rationale: 'shared types file, both members extend it',
    },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers.length, 2);
  // Both members should retain overlap_rationale in the output.
  for (const impl of result.implementers) {
    assert.ok(typeof impl.overlap_rationale === 'string' && impl.overlap_rationale.length > 0);
  }
});

test('parseImplementersBlock: overlapping files with overlap_rationale only on ONE member throws', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    {
      member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0',
      files: ['lib/shared.js', 'lib/a.js'],
      overlap_rationale: 'I have rationale',
    },
    {
      // No overlap_rationale — this should trigger the throw.
      member_id: 'expert-implementer@codex:gpt-5.5#0',
      files: ['lib/shared.js', 'lib/b.js'],
    },
  ]);
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.equal(err.code, 'implementer-claimed-files-missing');
      return true;
    }
  );
});

// ── Return shape ──────────────────────────────────────────────────────────────

test('parseImplementersBlock: returned implementer entries have expected shape', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    {
      member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0',
      adapter: 'claude-cli',
      model: 'kimi-k2.6:cloud',
      required: true,
      files: ['lib/a.js', 'lib/b.js'],
    },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  const [impl] = result.implementers;
  assert.equal(impl.member_id, 'expert-implementer@claude:kimi-k2.6:cloud#0');
  assert.equal(impl.adapter, 'claude-cli');
  assert.equal(impl.model, 'kimi-k2.6:cloud');
  assert.equal(impl.required, true);
  assert.deepEqual(impl.files, ['lib/a.js', 'lib/b.js']);
});

test('parseImplementersBlock: required: false is preserved', () => {
  const plan = buildPlan();
  const sliceSection = buildSliceSection([
    {
      member_id: 'expert-implementer@codex:gpt-5.5#0',
      required: false,
      files: ['lib/optional.js'],
    },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.implementers[0].required, false);
});

test('parseImplementersBlock: high_cost and high_cost_rationale reflected in return value', () => {
  const plan = buildPlan({
    high_cost: true,
    high_cost_rationale: 'Needed for large parallel load',
  });
  const sliceSection = buildSliceSection([
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0', files: ['lib/a.js'] },
    { member_id: 'expert-implementer@codex:gpt-5.5#0', files: ['lib/b.js'] },
    { member_id: 'expert-implementer@claude:glm-4.7:cloud#0', files: ['lib/c.js'] },
    { member_id: 'expert-implementer@claude:kimi-k2.6:cloud#1', files: ['lib/d.js'] },
  ]);
  const result = parseImplementersBlock(plan, sliceSection);
  assert.ok(result !== null);
  assert.equal(result.high_cost, true);
  assert.equal(result.high_cost_rationale, 'Needed for large parallel load');
});

// ── Invalid member_id in block throws ────────────────────────────────────────

test('parseImplementersBlock: invalid member_id in block throws implementer-member-id-invalid', () => {
  const plan = buildPlan();
  // Build manually with a bad member_id.
  const sliceSection = [
    '## Slice 1: Test',
    '',
    '**Implementers:**',
    '- member_id: this-is-not-valid-no-at-sign',
    '  adapter: claude-cli',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - lib/a.js',
  ].join('\n');
  assert.throws(
    () => parseImplementersBlock(plan, sliceSection),
    (err) => {
      assert.equal(err.code, 'implementer-member-id-invalid');
      return true;
    }
  );
});
