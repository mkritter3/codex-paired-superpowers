// v0.10.0 slice 10 — end-to-end canary residual-risk test.
//
// Attempts canary injection through all 5 producer paths:
//   1. sidecar (rejected)
//   2. mailbox (rejected)
//   3. diagnostic (redacted)
//   4. prompt-compose (redacted at merger-agent / post-merge-review)
//   5. adapter warning (redacted by slice-5 redactSecretFields)
//
// After all attempts, byte-scans artifact roots for canary leakage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  initSidecar,
  startImplementerRun,
  appendImplementerEventLocked,
  readImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';
import { writeToMailbox } from '../../../lib/codex-bridge/mailbox.js';
import { writeBreadcrumb } from '../../../lib/codex-bridge/hook-mailbox-inject.js';
import { redactSecretFields, containsCanary } from '../../../lib/codex-bridge/implementer/secret-redaction.js';
import { runPostMergeReview } from '../../../lib/codex-bridge/implementer/post-merge-review.js';
import { CANARY_TOKENS, ALL_CANARIES, hasAnyCanary } from './fixtures/canary-tokens.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function payloadHash(payload) {
  return 'sha256:' + sha256Hex(JSON.stringify(payload));
}

function makeRepo(prefix = 'cps-e2e-canary-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, '.codex-paired'), { recursive: true });
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'v0.10.0', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const MEMBER_ID = 'expert-implementer@claude:kimi-k2.6:cloud#0';
const MEMBER = {
  [MEMBER_ID]: {
    adapter: 'claude-cli',
    model: 'kimi-k2.6:cloud',
    required: true,
    worktree_id: 'wt-slice-3-claude-0',
    branch: 'implementer/slice-3/claude-0',
    claimed_files: ['lib/a.js'],
  },
};

/**
 * Recursively collect all files under a directory.
 */
function collectFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

// ── Test: all 5 producer paths, canaries don't leak ──────────────────────────

test('canary end-to-end: all 5 producer paths — no canary leaks to artifact roots', async () => {
  const { dir, spec } = makeRepo();

  try {
    // 1. Sidecar: canary in payload → rejected
    const { implementer_run_id: runId } = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'abc123',
      members: MEMBER,
    });

    for (const canary of ALL_CANARIES) {
      const payload = { secret: canary };
      await assert.rejects(
        () => appendImplementerEventLocked(spec, {
          event_type: 'started',
          implementer_run_id: runId,
          slice_id: 'slice-3',
          member_id: MEMBER_ID,
          runtime_kind: 'claude-cli',
          worktree_id: 'wt-slice-3-claude-0',
          payload_hash: payloadHash(payload),
          payload,
        }),
        /redacted-secret pattern/,
        `Sidecar should reject canary: ${canary}`
      );
    }

    // 2. Mailbox: canary in message text → rejected
    for (const canary of ALL_CANARIES) {
      await assert.rejects(
        () => writeToMailbox(dir, 'orchestrator', {
          from: 'slice-3',
          text: `message with canary ${canary}`,
        }),
        /redacted-secret pattern/,
        `Mailbox should reject canary in text: ${canary}`
      );
    }

    // 3. Diagnostic: canary in error message → redacted (not rejected)
    for (const canary of ALL_CANARIES) {
      writeBreadcrumb(dir, 'slice-3', `error with ${canary}`);
    }

    // 4. Prompt-compose: canary in mergedDiff → redacted by runPostMergeReview
    //    (Critique 3 fix: use actual production path, not redactSecretFields directly)
    {
      const CLAUDE_REVIEWER_ID = 'reviewer@claude-cli:opus-4#0';
      const CODEX_REVIEWER_ID = 'reviewer@codex-cli:gpt-5#0';

      // Set up sidecar run for the reviewer members
      const pmrMembers = {
        [CLAUDE_REVIEWER_ID]: {
          adapter: 'claude-cli',
          model: 'opus-4',
          required: true,
          worktree_id: 'wt-claude-0',
          branch: 'implementer/slice-3/claude-0',
          claimed_files: ['lib/a.js'],
        },
        [CODEX_REVIEWER_ID]: {
          adapter: 'codex-cli',
          model: 'gpt-5',
          required: true,
          worktree_id: 'wt-codex-0',
          branch: 'implementer/slice-3/codex-0',
          claimed_files: ['lib/b.js'],
        },
      };
      const { implementer_run_id: pmrRunId } = await startImplementerRun(spec, 'slice-4', {
        base_sha: 'abc123',
        members: pmrMembers,
      });

      // Test one representative canary (testing each would be slow; 1 proves the path)
      const canary = ALL_CANARIES[0];
      const bigDiff =
        `--- a/lib/a.js\n+++ b/lib/a.js\n@@ -1,1 +1,3 @@\n` +
        `+${'z'.repeat(500)}\n` +
        `+leaked=${canary}\n` +
        `+${'z'.repeat(500)}\n`;

      let capturedPrompt = null;
      const spyDispatchPanel = async (_role, request, _dispatchFns, _opts) => {
        capturedPrompt = request.prompt;
        return {
          panel_id: 'panel-e2e-spy',
          outcome: 'panel-SHIP',
          member_results: [
            {
              member_id: CLAUDE_REVIEWER_ID,
              runtime_kind: 'claude-cli',
              parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] },
              parse_failure_reason: null,
            },
            {
              member_id: CODEX_REVIEWER_ID,
              runtime_kind: 'codex-cli',
              parsed_result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] },
              parse_failure_reason: null,
            },
          ],
          findings_by_member: [],
          skipped_candidates: [],
          consensus_round_ran: false,
          aggregate: {
            outcome: 'panel-SHIP',
            ship_count: 2,
            revise_count: 0,
            parse_failure_count: 0,
            quorum_size: 2,
            has_quorum: true,
            findings_by_member: [],
          },
        };
      };

      const pmrResult = await runPostMergeReview({
        integrationWorktree: spec, // fake worktree path for lock derivation
        slicePlan: 'Implement the feature.',
        mergedDiff: bigDiff,
        dispatchFns: new Map([
          [CLAUDE_REVIEWER_ID, async () => ({ ok: true, result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } })],
          [CODEX_REVIEWER_ID, async () => ({ ok: true, result: { status: 'SHIP', blocking_findings: [], nonblocking_findings: [] } })],
        ]),
        claudeReviewerId: CLAUDE_REVIEWER_ID,
        codexReviewerId: CODEX_REVIEWER_ID,
        specPath: spec,
        sliceId: 'slice-4',
        implementerRunId: pmrRunId,
        reviewerMemberId: CLAUDE_REVIEWER_ID,
        reviewerRuntimeKind: 'claude-cli',
        reviewerWorktreeId: 'wt-claude-0',
        _deps: {
          lockfile: { lock: async (_path, _opts) => async () => {} },
          lockPath: '/tmp/cps-e2e-canary-pmr.lock',
          dispatchPanel: spyDispatchPanel,
        },
      });

      assert.equal(pmrResult.halted, false, `runPostMergeReview should not halt: ${pmrResult.halt}`);
      assert.ok(capturedPrompt !== null, 'dispatchPanel spy must have captured a prompt');

      // Prompt length > 1000 — not collapsed to '<REDACTED>'
      assert.ok(
        capturedPrompt.length > 1000,
        `prompt length ${capturedPrompt.length} — was it collapsed? Prompt-compose must NOT collapse on canary`
      );
      // Canary is not present
      assert.ok(
        capturedPrompt.indexOf(canary) === -1,
        `prompt must not contain canary "${canary}" after redaction`
      );
      // '<REDACTED>' IS present
      assert.ok(
        capturedPrompt.indexOf('<REDACTED>') !== -1,
        'prompt must contain <REDACTED> in place of the canary'
      );
    }

    // 5. Adapter warning: canary in object value → redacted
    for (const canary of ALL_CANARIES) {
      const obj = { warning: `token=${canary}`, status: 'degraded' };
      const redacted = redactSecretFields(obj);
      assert.ok(
        !JSON.stringify(redacted).includes(canary),
        `Adapter warning redaction must remove canary: ${canary}`
      );
    }

    // ── Byte-scan artifact roots ──────────────────────────────────────────────
    const artifactRoots = [
      join(dir, '.superpowers-codex-paired'),
      join(dir, '.codex-paired', 'diagnostics'),
      join(dir, '.codex-paired', 'mailboxes'),
    ];

    for (const root of artifactRoots) {
      const files = collectFiles(root);
      for (const file of files) {
        let content;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const canary of ALL_CANARIES) {
          assert.ok(
            !content.includes(canary),
            `Artifact file ${file} must not contain canary "${canary}"`
          );
        }
      }
    }

    // ── Hash invariant: every persisted sidecar event ────────────────────────
    const run = readImplementerRun(spec, 'slice-3');
    // We rejected all canary appends, so events should be empty (no clean events appended)
    if (run && Array.isArray(run.events)) {
      for (const event of run.events) {
        const expectedHash = 'sha256:' + sha256Hex(JSON.stringify(event.payload));
        assert.equal(
          event.payload_hash,
          expectedHash,
          `Hash invariant violated for event_seq=${event.event_seq}`
        );
      }
    }

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: canary round-trip never reaches disk ────────────────────────────────

test('canary end-to-end: sidecar file byte-scan after rejected appends', async () => {
  const { dir, spec } = makeRepo();
  try {
    const { implementer_run_id: runId } = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'abc123',
      members: MEMBER,
    });

    // Attempt to append all 4 canaries
    await Promise.allSettled(
      ALL_CANARIES.map(canary => {
        const payload = { token: canary };
        return appendImplementerEventLocked(spec, {
          event_type: 'started',
          implementer_run_id: runId,
          slice_id: 'slice-3',
          member_id: MEMBER_ID,
          runtime_kind: 'claude-cli',
          worktree_id: 'wt-slice-3-claude-0',
          payload_hash: payloadHash(payload),
          payload,
        });
      })
    );

    // Byte-scan the entire .superpowers-codex-paired directory
    const sidecarDir = join(dir, '.superpowers-codex-paired');
    const files = collectFiles(sidecarDir);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const canary of ALL_CANARIES) {
        assert.ok(
          !content.includes(canary),
          `Sidecar file ${file} must not contain canary "${canary}"`
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
