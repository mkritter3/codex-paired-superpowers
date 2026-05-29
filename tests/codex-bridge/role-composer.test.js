// Tests for v0.8.0 role-composer — deterministic reviewer-selection from
// phase, signals, and repo overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeExperts } from '../../lib/codex-bridge/role-composer.js';
import { composeReviewers } from '../../lib/codex-bridge/reviewer-composer.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-role-composer-test-'));
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function ids(result) {
  return result.selected.map((e) => e.id);
}

test('UI signals select reviewer-ui and reviewer-ux plus default architecture+test', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['UI', 'visual editor', 'review panel'] },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), `missing reviewer-ui: ${selected}`);
    assert.ok(selected.includes('reviewer-ux'), `missing reviewer-ux: ${selected}`);
    assert.ok(
      selected.includes('reviewer-architecture'),
      `missing reviewer-architecture: ${selected}`
    );
    assert.ok(
      selected.includes('reviewer-test'),
      `missing reviewer-test: ${selected}`
    );
  } finally {
    cleanup(root);
  }
});

test('AI/provider signals select reviewer-ai-harness', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['model selection', 'prompt structure', 'MCP integration'] },
      repoRoot: root,
    });
    assert.ok(
      ids(result).includes('reviewer-ai-harness'),
      `missing reviewer-ai-harness: ${ids(result)}`
    );
  } finally {
    cleanup(root);
  }
});

test('Security/credential signals select reviewer-security', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['credential storage', 'auth token', 'permission boundary'] },
      repoRoot: root,
    });
    assert.ok(
      ids(result).includes('reviewer-security'),
      `missing reviewer-security: ${ids(result)}`
    );
  } finally {
    cleanup(root);
  }
});

test('No strong signal falls back to architecture+test only', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: {},
      repoRoot: root,
    });
    assert.deepEqual(ids(result).sort(), ['reviewer-architecture', 'reviewer-test']);
  } finally {
    cleanup(root);
  }
});

test('**Experts:** directive merges with inferred signals', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: {
        specHas: ['UI', 'visual panel'],
        explicitDirective: 'ui, architecture',
      },
      repoRoot: root,
    });
    const selected = ids(result);
    // ui from directive (and inferred), ux inferred, architecture from directive (and default), test default
    assert.ok(selected.includes('reviewer-ui'), `missing reviewer-ui: ${selected}`);
    assert.ok(selected.includes('reviewer-ux'), `missing reviewer-ux: ${selected}`);
    assert.ok(
      selected.includes('reviewer-architecture'),
      `missing reviewer-architecture: ${selected}`
    );
    assert.ok(
      selected.includes('reviewer-test'),
      `missing reviewer-test: ${selected}`
    );
  } finally {
    cleanup(root);
  }
});

test('>5 selected experts WITHOUT fanOutRationale throws role-composer-fan-out-unjustified', () => {
  const root = makeRepo();
  try {
    // Combine signals across all domains plus an explicit directive to push >5.
    let caught;
    try {
      composeExperts({
        phase: 'spec-review',
        signals: {
          specHas: [
            'UI component',
            'visual editor',
            'model prompt',
            'credential token',
            'database migration api',
          ],
          explicitDirective: 'ui, ux, architecture, test, security, ai-harness, backend',
        },
        repoRoot: root,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected throw');
    assert.equal(caught.code, 'role-composer-fan-out-unjustified');
  } finally {
    cleanup(root);
  }
});

test('>5 selected WITH fanOutRationale returns successfully', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: {
        specHas: [
          'UI component',
          'visual editor',
          'model prompt',
          'credential token',
          'database migration api',
        ],
        explicitDirective:
          'ui, ux, architecture, test, security, ai-harness, backend',
        fanOutRationale:
          'feature touches UI/UX/architecture/security/AI/backend simultaneously',
      },
      repoRoot: root,
    });
    assert.ok(
      result.selected.length > 5,
      `expected >5 selected, got ${result.selected.length}`
    );
    assert.equal(
      result.fanOutRationale,
      'feature touches UI/UX/architecture/security/AI/backend simultaneously'
    );
  } finally {
    cleanup(root);
  }
});

test('selectionReasons is populated for every selected expert', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['UI', 'visual panel'] },
      repoRoot: root,
    });
    for (const identity of result.selected) {
      const reason = result.selectionReasons[identity.id];
      assert.ok(
        typeof reason === 'string' && reason.length > 0,
        `expected non-empty reason for ${identity.id}, got: ${reason}`
      );
    }
  } finally {
    cleanup(root);
  }
});

test('composer filters out roles whose resolveIdentity throws (defensive)', () => {
  const root = makeRepo();
  try {
    // "totally-nonexistent" has no builtin and no override; composer should
    // skip it without throwing, and drop its selection reason.
    const result = composeExperts({
      phase: 'spec-review',
      signals: { explicitDirective: 'ui, totally-nonexistent' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), `missing reviewer-ui: ${selected}`);
    assert.ok(
      !selected.includes('reviewer-totally-nonexistent'),
      `unresolvable role should be filtered: ${selected}`
    );
    assert.ok(
      !('reviewer-totally-nonexistent' in result.selectionReasons),
      'unresolvable selectionReason should be dropped'
    );
  } finally {
    cleanup(root);
  }
});

test('composer filters malformed directive roles (path-traversal / invalid identity)', () => {
  const root = makeRepo();
  try {
    // Directive with mix of valid + malformed (path-traversal, uppercase,
    // underscore). The malformed ones cause resolveIdentity to throw
    // invalid-role-name; composer's defensive filter must skip them.
    const result = composeExperts({
      phase: 'spec-review',
      signals: { explicitDirective: 'ui, ../evil, UI, a_thing, architecture' },
      repoRoot: root,
    });
    const selected = ids(result);
    // Valid directive roles + phase defaults survive.
    assert.ok(selected.includes('reviewer-ui'));
    assert.ok(selected.includes('reviewer-architecture'));
    assert.ok(selected.includes('reviewer-test')); // phase default
    // Malformed roles are filtered.
    assert.ok(!selected.some(id => id.includes('..')), `traversal leaked: ${selected}`);
    assert.ok(!selected.some(id => /[A-Z_]/.test(id)), `bad-char leaked: ${selected}`);
    for (const id of selected) {
      assert.match(id, /^reviewer-[a-z][a-z0-9-]{0,47}$/, `bad identity: ${id}`);
    }
  } finally {
    cleanup(root);
  }
});

// ── Plan 3: composeExperts is a faithful wrapper of composeReviewers ─────────

test('composeExperts(args) returns deep-equal output to composeReviewers(args)', () => {
  const root = makeRepo();
  try {
    const args = {
      phase: 'spec-review',
      signals: { specHas: ['UI', 'visual panel'], explicitDirective: 'ui, architecture' },
      repoRoot: root,
    };
    assert.deepEqual(composeExperts(args), composeReviewers(args));
  } finally {
    cleanup(root);
  }
});
