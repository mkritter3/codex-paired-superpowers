// Plan 3 (reviewer naming migration) — mailbox RECIPIENT_RE accepts reviewer-*
// recipients (round-3 finding) while still accepting expert-* (one-window
// regression guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeToMailbox,
  readUnreadMessages,
  MailboxError,
} from '../../lib/codex-bridge/mailbox.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-reviewer-mailbox-'));
}

test('reviewer-* recipient is accepted and round-trips through the mailbox', async () => {
  const root = makeRepo();
  try {
    await writeToMailbox(root, 'reviewer-ui', { from: 'orchestrator', text: 'hi reviewer-ui' });
    const unread = await readUnreadMessages(root, 'reviewer-ui');
    assert.equal(unread.length, 1);
    assert.equal(unread[0].text, 'hi reviewer-ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reviewer-* is accepted as a message.from sender too', async () => {
  const root = makeRepo();
  try {
    await writeToMailbox(root, 'reviewer-architecture', {
      from: 'reviewer-ui',
      text: 'peer note',
    });
    const unread = await readUnreadMessages(root, 'reviewer-architecture');
    assert.equal(unread.length, 1);
    assert.equal(unread[0].from, 'reviewer-ui');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('expert-* recipients are still accepted (one-window regression guard)', async () => {
  const root = makeRepo();
  try {
    await writeToMailbox(root, 'expert-ui', { from: 'orchestrator', text: 'hi expert-ui' });
    const unread = await readUnreadMessages(root, 'expert-ui');
    assert.equal(unread.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed recipients are still rejected', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'reviewer-UI', { from: 'orchestrator', text: 'x' }),
      (err) => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
    await assert.rejects(
      () => writeToMailbox(root, '../evil', { from: 'orchestrator', text: 'x' }),
      (err) => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
