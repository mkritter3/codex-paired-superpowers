// v0.10.0 slice 6 — mailbox validator extension tests.
//
// Verifies the optional v0.10.0 fields: kind, priority, implementer_run_id,
// slice_id, body_hash. Old messages without these fields still pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeToMailbox,
  MailboxError,
} from '../../../lib/codex-bridge/mailbox.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-mailbox-ext-'));
}

// ── compat: existing v0.8.x messages still pass ─────────────────────────────

test('compat: message without any v0.10.0 fields still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'old style' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: message with summary and color (v0.7.x fields) still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', {
      from: 'orchestrator',
      text: 'legacy style',
      summary: 'brief',
      color: 'green',
    });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── happy: new v0.10.0 optional fields ────────────────────────────────────────

test('happy: message with kind: merge_note, priority: urgent passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', {
      from: 'orchestrator',
      text: 'merge note',
      kind: 'merge_note',
      priority: 'urgent',
    });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy: message with all optional v0.10.0 fields passes', async () => {
  const root = makeRepo();
  try {
    const VALID_HASH = 'sha256:' + 'a'.repeat(64);
    const r = await writeToMailbox(root, 'slice-3', {
      from: 'orchestrator',
      text: 'full optional fields',
      kind: 'progress',
      priority: 'normal',
      implementer_run_id: 'run-abc123',
      slice_id: 'slice-3',
      body_hash: VALID_HASH,
    });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy: all valid kinds pass', async () => {
  const root = makeRepo();
  try {
    for (const kind of ['progress', 'blocker', 'merge_note', 'system']) {
      const r = await writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: `kind: ${kind}`,
        kind,
      });
      assert.match(r.id, /^msg-/, `kind '${kind}' should pass`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy: both valid priorities pass', async () => {
  const root = makeRepo();
  try {
    for (const priority of ['normal', 'urgent']) {
      const r = await writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: `priority: ${priority}`,
        priority,
      });
      assert.match(r.id, /^msg-/, `priority '${priority}' should pass`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reject: invalid kind ──────────────────────────────────────────────────────

test('reject: invalid kind: foo → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'bad kind', kind: 'foo' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reject: invalid kind: PROGRESS (wrong case) → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'bad kind', kind: 'PROGRESS' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reject: invalid priority ──────────────────────────────────────────────────

test('reject: invalid priority: low → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'bad priority', priority: 'low' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reject: invalid body_hash ─────────────────────────────────────────────────

test('reject: body_hash with wrong prefix → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: 'bad hash',
        body_hash: 'md5:abcdef1234',
      }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reject: body_hash too short → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: 'bad hash',
        body_hash: 'sha256:short',
      }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reject: invalid implementer_run_id (non-string) ──────────────────────────

test('reject: non-string implementer_run_id → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: 'bad run id',
        implementer_run_id: 42,
      }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reject: empty implementer_run_id → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: 'bad run id',
        implementer_run_id: '',
      }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── reject: invalid slice_id (non-string) ────────────────────────────────────

test('reject: non-string slice_id → mailbox-recipient-malformed', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'slice-3', {
        from: 'orchestrator',
        text: 'bad slice id',
        slice_id: { invalid: true },
      }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── compat: null optional fields are ignored (treated as absent) ──────────────

test('compat: null kind is ignored (treated as absent)', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', {
      from: 'orchestrator',
      text: 'null kind',
      kind: null,
    });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: null priority is ignored (treated as absent)', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', {
      from: 'orchestrator',
      text: 'null priority',
      priority: null,
    });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
