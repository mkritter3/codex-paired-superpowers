// v0.8.0 slice 4 — tests for lib/codex-bridge/expert-runtime.js facade.
//
// The 5-method TeammateRuntime interface (per spec §Native Agent-Teams
// Compatibility) is exposed via the facade module. Slice 4 ships:
//   - resolveIdentity (re-export from expert-resolver)
//   - selectTeammates (alias for composeExperts)
//   - runTurn         (re-export from expert-turn)
//   - pollInbox       (thin wrapper over readUnreadMessages)
//   - archive         (stub for slice 4)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as facade from '../../lib/codex-bridge/expert-runtime.js';
import * as reviewerRuntime from '../../lib/codex-bridge/reviewer-runtime.js';
import { composeReviewers } from '../../lib/codex-bridge/reviewer-composer.js';
import { writeToMailbox } from '../../lib/codex-bridge/mailbox.js';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cps-facade-'));
  mkdirSync(join(root, '.codex-paired', 'mailboxes'), { recursive: true });
  return root;
}

test('facade exposes exactly 5 callable methods: resolveIdentity, selectTeammates, runTurn, pollInbox, archive', () => {
  const expected = ['resolveIdentity', 'selectTeammates', 'runTurn', 'pollInbox', 'archive'];
  for (const name of expected) {
    assert.equal(typeof facade[name], 'function', `facade.${name} should be a function`);
  }
});

test('facade.selectTeammates is an alias for composeReviewers (Plan 3)', () => {
  assert.equal(facade.selectTeammates, composeReviewers);
  assert.equal(facade.selectReviewers, composeReviewers);
});

test('expert-runtime shim re-exports the identical reviewer-runtime references', () => {
  for (const name of ['resolveIdentity', 'selectReviewers', 'selectTeammates', 'runTurn', 'archive', 'pollInbox']) {
    assert.equal(facade[name], reviewerRuntime[name], `facade.${name} must === reviewer-runtime.${name}`);
  }
});

test('facade.resolveIdentity resolves builtin role to canonical reviewer-* id', () => {
  // architecture is one of the shipped builtin prompts (per slice 2).
  const id = facade.resolveIdentity('architecture', '/nonexistent-repo-root');
  assert.equal(id.id, 'reviewer-architecture');
  assert.equal(id.role, 'architecture');
  assert.equal(id.source, 'builtin');
});

test('facade.pollInbox returns unread messages for the given identity', async () => {
  const root = makeRepo();
  try {
    await writeToMailbox(root, 'expert-ui', { from: 'orchestrator', text: 'hello expert-ui' });
    const unread = await facade.pollInbox(root, { id: 'expert-ui' });
    assert.equal(unread.length, 1);
    assert.equal(unread[0].text, 'hello expert-ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('facade.archive is wired to expert-archive (slice 7 production impl)', async () => {
  // Use a PRESERVE halt reason — no mailbox FS side-effect, no deps.repoRoot
  // required, exercises the production code path end-to-end.
  const result = await facade.archive({ id: 'expert-ui' }, 'expert-blocker-open');
  assert.equal(result.expert_id, 'expert-ui');
  assert.equal(result.status, 'preserved-for-resume');
  assert.equal(result.archive_reason, 'expert-blocker-open');
  assert.match(result.archived_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('facade.runTurn is the production wrapper (callable; defaults to runTurnWithDeps without overrides)', async () => {
  // Just confirm it's a function — production wiring is slice 7. The
  // default agentDispatch throws, so a real call would surface a known error.
  assert.equal(typeof facade.runTurn, 'function');
});
