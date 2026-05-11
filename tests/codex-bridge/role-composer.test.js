// Tests for v0.8.0 role-composer — deterministic expert-selection from
// phase, signals, and repo overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeExperts } from '../../lib/codex-bridge/role-composer.js';

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

test('UI signals select expert-ui and expert-ux plus default architecture+test', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['UI', 'visual editor', 'review panel'] },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('expert-ui'), `missing expert-ui: ${selected}`);
    assert.ok(selected.includes('expert-ux'), `missing expert-ux: ${selected}`);
    assert.ok(
      selected.includes('expert-architecture'),
      `missing expert-architecture: ${selected}`
    );
    assert.ok(
      selected.includes('expert-test'),
      `missing expert-test: ${selected}`
    );
  } finally {
    cleanup(root);
  }
});

test('AI/provider signals select expert-ai-harness', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['model selection', 'prompt structure', 'MCP integration'] },
      repoRoot: root,
    });
    assert.ok(
      ids(result).includes('expert-ai-harness'),
      `missing expert-ai-harness: ${ids(result)}`
    );
  } finally {
    cleanup(root);
  }
});

test('Security/credential signals select expert-security', () => {
  const root = makeRepo();
  try {
    const result = composeExperts({
      phase: 'spec-review',
      signals: { specHas: ['credential storage', 'auth token', 'permission boundary'] },
      repoRoot: root,
    });
    assert.ok(
      ids(result).includes('expert-security'),
      `missing expert-security: ${ids(result)}`
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
    assert.deepEqual(ids(result).sort(), ['expert-architecture', 'expert-test']);
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
    assert.ok(selected.includes('expert-ui'), `missing expert-ui: ${selected}`);
    assert.ok(selected.includes('expert-ux'), `missing expert-ux: ${selected}`);
    assert.ok(
      selected.includes('expert-architecture'),
      `missing expert-architecture: ${selected}`
    );
    assert.ok(
      selected.includes('expert-test'),
      `missing expert-test: ${selected}`
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
    assert.ok(selected.includes('expert-ui'), `missing expert-ui: ${selected}`);
    assert.ok(
      !selected.includes('expert-totally-nonexistent'),
      `unresolvable role should be filtered: ${selected}`
    );
    assert.ok(
      !('expert-totally-nonexistent' in result.selectionReasons),
      'unresolvable selectionReason should be dropped'
    );
  } finally {
    cleanup(root);
  }
});
