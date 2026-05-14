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

    // 4. Prompt-compose: canary in source data → redacted by redactSecretFields
    for (const canary of ALL_CANARIES) {
      const rawPrompt = `# Merger Prompt\nConflict: ${canary}\nResolve this.`;
      const redactedPrompt = redactSecretFields(rawPrompt);
      assert.ok(
        typeof redactedPrompt === 'string' && !redactedPrompt.includes(canary),
        `Prompt redaction must remove canary: ${canary}`
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
