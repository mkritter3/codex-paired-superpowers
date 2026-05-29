// Plan 3 (reviewer naming migration) — reviewer-runtime canonical façade.
//
// Smoke + one-window-compat: canonical exports present (selectReviewers,
// resolveIdentity, runTurn, archive, pollInbox + selectTeammates alias) and the
// expert-runtime.js shim re-exports the identical references.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as runtime from '../../lib/codex-bridge/reviewer-runtime.js';
import * as expertShim from '../../lib/codex-bridge/expert-runtime.js';
import { composeReviewers } from '../../lib/codex-bridge/reviewer-composer.js';

test('reviewer-runtime exposes the canonical runtime interface', () => {
  for (const name of ['resolveIdentity', 'selectReviewers', 'runTurn', 'archive', 'pollInbox', 'selectTeammates']) {
    assert.equal(typeof runtime[name], 'function', `reviewer-runtime.${name} should be a function`);
  }
});

test('selectReviewers and the selectTeammates alias both === composeReviewers', () => {
  assert.equal(runtime.selectReviewers, composeReviewers);
  assert.equal(runtime.selectTeammates, composeReviewers);
});

test('expert-runtime shim re-exports the identical reviewer-runtime references', () => {
  for (const name of ['resolveIdentity', 'selectReviewers', 'selectTeammates', 'runTurn', 'archive', 'pollInbox']) {
    assert.equal(expertShim[name], runtime[name], `shim.${name} must === reviewer-runtime.${name}`);
  }
});

test('resolveIdentity returns canonical reviewer-* id', () => {
  const id = runtime.resolveIdentity('architecture', '/nonexistent-repo-root');
  assert.equal(id.id, 'reviewer-architecture');
});
