// v0.8.0 slice 7 — expert-archive tests.
//
// Enumerate ALL 10 halt reasons from spec §Mailbox Archival:
//   ARCHIVE (drain + rotate):  completed, abandoned-by-user
//   PRESERVE (keep for resume): external-commit-detected,
//     slice-blocker-from-mailbox, expert-blocker-open,
//     expert-peer-dm-drain-cap-exceeded, subagent-dispatch-failed,
//     reconcile-failed, validation-failed, user-input-required
//   Unknown halt reason: throws ExpertArchiveError code unknown-halt-reason.
//
// API:
//   archive(identity, haltReason, deps)
//     deps = { repoRoot, archiveAndReset, writeBreadcrumb }
//     - For ARCHIVE reasons: calls deps.archiveAndReset(repoRoot, identity.id)
//       and returns {expert_id, status: "archived", archive_reason, archived_at}.
//     - For PRESERVE reasons: does NOT call archiveAndReset; returns
//       {expert_id, status: "preserved-for-resume", archive_reason, archived_at}.
//     - Unknown haltReason: throws ExpertArchiveError code unknown-halt-reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archive,
  ExpertArchiveError,
  HALT_REASONS_ARCHIVE,
  HALT_REASONS_PRESERVE,
} from '../../lib/codex-bridge/expert-archive.js';

const IDENTITY = { id: 'expert-ui', role: 'ui', source: 'builtin' };
const REPO_ROOT = '/tmp/fake-repo';

function makeStubDeps() {
  const calls = { archiveAndReset: [], writeBreadcrumb: [] };
  return {
    calls,
    deps: {
      repoRoot: REPO_ROOT,
      archiveAndReset: async (repoRoot, sliceId) => {
        calls.archiveAndReset.push({ repoRoot, sliceId });
        return { archivedPath: '/fake', archivedCount: 2, carriedForwardCount: 0 };
      },
      writeBreadcrumb: (repoRoot, sliceId, msg) => {
        calls.writeBreadcrumb.push({ repoRoot, sliceId, msg });
      },
    },
  };
}

// --- ARCHIVE cases ---------------------------------------------------------

for (const reason of ['completed', 'abandoned-by-user']) {
  test(`archive(): halt reason "${reason}" archives mailbox + records archived status`, async () => {
    const { calls, deps } = makeStubDeps();
    const result = await archive(IDENTITY, reason, deps);

    assert.equal(calls.archiveAndReset.length, 1, 'archiveAndReset must be called once');
    assert.deepEqual(calls.archiveAndReset[0], {
      repoRoot: REPO_ROOT,
      sliceId: 'expert-ui',
    });
    assert.equal(result.expert_id, 'expert-ui');
    assert.equal(result.status, 'archived');
    assert.equal(result.archive_reason, reason);
    assert.match(result.archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
}

// --- PRESERVE cases --------------------------------------------------------

const PRESERVE_REASONS = [
  'external-commit-detected',
  'slice-blocker-from-mailbox',
  'expert-blocker-open',
  'expert-peer-dm-drain-cap-exceeded',
  'expert-peer-dm-enqueue-failed', // v0.8.1
  'subagent-dispatch-failed',
  'reconcile-failed',
  'validation-failed',
  'user-input-required',
  // v0.9.0 slice 6 — panel mode halt reasons (spec § 4 + § 5).
  'panel-quorum-unavailable',
  'panel-disagreement',
  'panel-quorum-lost',
  'cli-dispatch-failed',
];

for (const reason of PRESERVE_REASONS) {
  test(`archive(): halt reason "${reason}" preserves mailbox + records preserved-for-resume status`, async () => {
    const { calls, deps } = makeStubDeps();
    const result = await archive(IDENTITY, reason, deps);

    assert.equal(
      calls.archiveAndReset.length,
      0,
      'archiveAndReset MUST NOT be called for preserve reasons'
    );
    assert.equal(result.expert_id, 'expert-ui');
    assert.equal(result.status, 'preserved-for-resume');
    assert.equal(result.archive_reason, reason);
    assert.match(result.archived_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
}

// --- Unknown halt reason ---------------------------------------------------

test('archive(): unknown halt reason throws ExpertArchiveError code unknown-halt-reason', async () => {
  const { deps } = makeStubDeps();
  await assert.rejects(
    () => archive(IDENTITY, 'no-such-halt-reason', deps),
    (err) => {
      assert.ok(err instanceof ExpertArchiveError, 'expected ExpertArchiveError');
      assert.equal(err.code, 'unknown-halt-reason');
      assert.match(err.message, /no-such-halt-reason/);
      return true;
    }
  );
});

// --- Validation cases ------------------------------------------------------

test('archive(): invalid identity throws ExpertArchiveError code invalid-identity', async () => {
  const { deps } = makeStubDeps();
  await assert.rejects(
    () => archive(null, 'completed', deps),
    (err) => err instanceof ExpertArchiveError && err.code === 'invalid-identity'
  );
  await assert.rejects(
    () => archive({}, 'completed', deps),
    (err) => err instanceof ExpertArchiveError && err.code === 'invalid-identity'
  );
});

test('archive(): empty halt reason throws ExpertArchiveError code invalid-halt-reason', async () => {
  const { deps } = makeStubDeps();
  await assert.rejects(
    () => archive(IDENTITY, '', deps),
    (err) => err instanceof ExpertArchiveError && err.code === 'invalid-halt-reason'
  );
  await assert.rejects(
    () => archive(IDENTITY, null, deps),
    (err) => err instanceof ExpertArchiveError && err.code === 'invalid-halt-reason'
  );
});

test('archive(): ARCHIVE case without deps.repoRoot throws missing-repo-root', async () => {
  const { deps } = makeStubDeps();
  const noRoot = { ...deps, repoRoot: undefined };
  await assert.rejects(
    () => archive(IDENTITY, 'completed', noRoot),
    (err) => err instanceof ExpertArchiveError && err.code === 'missing-repo-root'
  );
});

// --- Set-shape sanity ------------------------------------------------------

test('HALT_REASONS_ARCHIVE contains exactly {completed, abandoned-by-user}', () => {
  assert.deepEqual([...HALT_REASONS_ARCHIVE].sort(), ['abandoned-by-user', 'completed']);
});

test('HALT_REASONS_PRESERVE contains exactly the specd preserve reasons (v0.8.0 + v0.8.1 + v0.9.0 slice 6)', () => {
  assert.deepEqual([...HALT_REASONS_PRESERVE].sort(), [...PRESERVE_REASONS].sort());
});

test('archive(): defaults deps from real impls (real archiveAndReset is wired when override absent)', async () => {
  // Just verify the function is callable without explicit deps for a preserve
  // case (no FS side-effect on the preserve path).
  const result = await archive(IDENTITY, 'expert-blocker-open');
  assert.equal(result.status, 'preserved-for-resume');
  assert.equal(result.archive_reason, 'expert-blocker-open');
});
