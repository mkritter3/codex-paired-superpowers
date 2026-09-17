import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  initSidecar,
  loadSidecar,
  appendReviewerTurnLocked,
} from '../../lib/codex-bridge/sidecar.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-sidecar-model-role-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
  return { dir, spec };
}

function turn(overrides = {}) {
  return {
    expert_id: 'reviewer-ai-harness',
    phase: 'spec-review',
    mailbox_message_ids_injected: [],
    started_at: '2026-09-17T00:00:00.000Z',
    completed_at: '2026-09-17T00:00:01.000Z',
    result_summary: 'SHIP',
    verdict: 'SHIP',
    failure_reason: null,
    ...overrides,
  };
}

test('appendReviewerTurnLocked persists model role audit fields', async () => {
  const { dir, spec } = fixture();
  try {
    await appendReviewerTurnLocked(spec, turn({
      model_role: 'planning',
      model_role_warning: 'unknown phase "x"',
    }));
    const saved = loadSidecar(spec).reviewer_teammates.turns[0];
    assert.equal(saved.model_role, 'planning');
    assert.equal(saved.model_role_warning, 'unknown phase "x"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendReviewerTurnLocked rejects an unknown model role', async () => {
  const { dir, spec } = fixture();
  try {
    await assert.rejects(() => appendReviewerTurnLocked(spec, turn({ model_role: 'nope' })), /model_role/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendReviewerTurnLocked rejects an empty model role warning', async () => {
  const { dir, spec } = fixture();
  try {
    await assert.rejects(() => appendReviewerTurnLocked(spec, turn({ model_role_warning: '' })), /model_role_warning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendReviewerTurnLocked leaves legacy turns without model role fields unchanged', async () => {
  const { dir, spec } = fixture();
  try {
    await appendReviewerTurnLocked(spec, turn());
    const saved = loadSidecar(spec).reviewer_teammates.turns[0];
    assert.equal('model_role' in saved, false);
    assert.equal('model_role_warning' in saved, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
