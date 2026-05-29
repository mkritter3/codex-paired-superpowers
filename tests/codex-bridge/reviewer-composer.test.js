// Plan 3 (reviewer naming migration) — canonical reviewer-composer.
//
// composeReviewers is the canonical selection function. selected[].id and
// selectionReasons keys are reviewer-*; the return includes directiveWarning
// (null until Slice 7 populates it). The fan-out error code literal is
// preserved (decision 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeReviewers } from '../../lib/codex-bridge/reviewer-composer.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-reviewer-composer-test-'));
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

test('composeReviewers returns reviewer-keyed selection with directiveWarning null', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({ phase: 'spec-review', signals: {}, repoRoot: root });
    assert.deepEqual(ids(result).sort(), ['reviewer-architecture', 'reviewer-test']);
    for (const id of ids(result)) {
      assert.match(id, /^reviewer-/, `id should be reviewer-*: ${id}`);
    }
    for (const key of Object.keys(result.selectionReasons)) {
      assert.match(key, /^reviewer-/, `selectionReason key should be reviewer-*: ${key}`);
    }
    assert.equal(result.directiveWarning, null);
  } finally {
    cleanup(root);
  }
});

test('composeReviewers infers reviewer-ui/ux + ai-harness + security from signals', () => {
  const root = makeRepo();
  try {
    const ui = composeReviewers({
      phase: 'spec-review',
      signals: { specHas: ['UI', 'visual editor', 'review panel'] },
      repoRoot: root,
    });
    assert.ok(ids(ui).includes('reviewer-ui'), ids(ui));
    assert.ok(ids(ui).includes('reviewer-ux'), ids(ui));

    const ai = composeReviewers({
      phase: 'spec-review',
      signals: { specHas: ['model selection', 'MCP integration'] },
      repoRoot: root,
    });
    assert.ok(ids(ai).includes('reviewer-ai-harness'), ids(ai));

    const sec = composeReviewers({
      phase: 'spec-review',
      signals: { specHas: ['credential storage', 'auth token'] },
      repoRoot: root,
    });
    assert.ok(ids(sec).includes('reviewer-security'), ids(sec));
  } finally {
    cleanup(root);
  }
});

test('composeReviewers selectionReasons populated for every selected reviewer', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
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

test('composeReviewers filters unresolvable directive roles defensively', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: { explicitDirective: 'ui, ../evil, UI, a_thing, totally-nonexistent, architecture' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), selected);
    assert.ok(selected.includes('reviewer-architecture'), selected);
    for (const id of selected) {
      assert.match(id, /^reviewer-[a-z][a-z0-9-]{0,47}$/, `bad identity: ${id}`);
    }
    assert.ok(!('reviewer-totally-nonexistent' in result.selectionReasons));
  } finally {
    cleanup(root);
  }
});

test('>5 selected reviewers WITHOUT fanOutRationale throws role-composer-fan-out-unjustified', () => {
  const root = makeRepo();
  try {
    let caught;
    try {
      composeReviewers({
        phase: 'spec-review',
        signals: {
          specHas: ['UI component', 'visual editor', 'model prompt', 'credential token', 'database migration api'],
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

// ── Slice 7: **Reviewers:** canonical directive + **Experts:** deprecated alias ──

test('reviewersDirective selects roles with canonical reason; directiveWarning null', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: { reviewersDirective: 'ui, test' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), selected);
    assert.ok(selected.includes('reviewer-test'), selected);
    assert.equal(result.selectionReasons['reviewer-ui'], 'from **Reviewers:** directive');
    assert.equal(result.directiveWarning, null);
  } finally {
    cleanup(root);
  }
});

test('expertsDirective alone selects roles + emits deprecation directiveWarning', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: { expertsDirective: 'ui' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), selected);
    assert.equal(result.selectionReasons['reviewer-ui'], 'from **Experts:** directive');
    assert.ok(result.directiveWarning, 'expected a directiveWarning');
    assert.match(result.directiveWarning, /deprecat/i);
  } finally {
    cleanup(root);
  }
});

test('both reviewersDirective and expertsDirective present → Reviewers wins + precedence warning', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: { reviewersDirective: 'ui', expertsDirective: 'security' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), selected);
    // experts-only role NOT added when reviewers directive is present.
    assert.ok(!selected.includes('reviewer-security'), selected);
    assert.equal(result.selectionReasons['reviewer-ui'], 'from **Reviewers:** directive');
    assert.ok(result.directiveWarning, 'expected a directiveWarning');
    assert.match(
      result.directiveWarning,
      /\*\*Reviewers:\*\* takes precedence over deprecated \*\*Experts:\*\*/,
    );
  } finally {
    cleanup(root);
  }
});

test('legacy explicitDirective alias behaves exactly like expertsDirective', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: { explicitDirective: 'ui' },
      repoRoot: root,
    });
    const selected = ids(result);
    assert.ok(selected.includes('reviewer-ui'), selected);
    assert.equal(result.selectionReasons['reviewer-ui'], 'from **Experts:** directive');
    assert.ok(result.directiveWarning, 'expected a deprecation directiveWarning');
    assert.match(result.directiveWarning, /deprecat/i);
  } finally {
    cleanup(root);
  }
});

test('>5 selected reviewers WITH fanOutRationale returns successfully', () => {
  const root = makeRepo();
  try {
    const result = composeReviewers({
      phase: 'spec-review',
      signals: {
        specHas: ['UI component', 'visual editor', 'model prompt', 'credential token', 'database migration api'],
        explicitDirective: 'ui, ux, architecture, test, security, ai-harness, backend',
        fanOutRationale: 'feature touches every domain simultaneously',
      },
      repoRoot: root,
    });
    assert.ok(result.selected.length > 5, `expected >5, got ${result.selected.length}`);
    assert.equal(result.fanOutRationale, 'feature touches every domain simultaneously');
  } finally {
    cleanup(root);
  }
});
