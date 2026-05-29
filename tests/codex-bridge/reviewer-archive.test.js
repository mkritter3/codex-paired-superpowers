// Plan 3 (reviewer naming migration) — reviewer-archive canonical module.
//
// Smoke + one-window-compat assertions:
//   - canonical `archive`, `ReviewerArchiveError`, halt sets are present;
//   - `ExpertArchiveError` (alias) === `ReviewerArchiveError` (same class);
//   - the expert-archive.js shim re-exports the identical references.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archive,
  ReviewerArchiveError,
  ExpertArchiveError,
  HALT_REASONS_ARCHIVE,
  HALT_REASONS_PRESERVE,
} from '../../lib/codex-bridge/reviewer-archive.js';
import * as expertShim from '../../lib/codex-bridge/expert-archive.js';

test('reviewer-archive exposes the canonical API', () => {
  assert.equal(typeof archive, 'function');
  assert.equal(typeof ReviewerArchiveError, 'function');
  assert.ok(HALT_REASONS_ARCHIVE instanceof Set);
  assert.ok(HALT_REASONS_PRESERVE instanceof Set);
});

test('ExpertArchiveError is the SAME class object as ReviewerArchiveError', () => {
  assert.equal(ExpertArchiveError, ReviewerArchiveError);
});

test('expert-archive shim re-exports the identical reviewer-archive references', () => {
  assert.equal(expertShim.archive, archive);
  assert.equal(expertShim.ExpertArchiveError, ReviewerArchiveError);
  assert.equal(expertShim.HALT_REASONS_ARCHIVE, HALT_REASONS_ARCHIVE);
  assert.equal(expertShim.HALT_REASONS_PRESERVE, HALT_REASONS_PRESERVE);
});

test('archive() works for a reviewer-* identity on a PRESERVE reason', async () => {
  const result = await archive({ id: 'reviewer-architecture' }, 'expert-blocker-open');
  assert.equal(result.expert_id, 'reviewer-architecture');
  assert.equal(result.status, 'preserved-for-resume');
});

test('unknown halt reason throws ReviewerArchiveError (caught via ExpertArchiveError alias too)', async () => {
  await assert.rejects(
    () => archive({ id: 'reviewer-ui' }, 'no-such-halt-reason'),
    (err) =>
      err instanceof ReviewerArchiveError &&
      err instanceof ExpertArchiveError &&
      err.code === 'unknown-halt-reason'
  );
});
