// Tests for v0.7.3 mailbox module — file-based inbox with proper-lockfile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeToMailbox,
  readMailbox,
  readUnreadMessages,
  markAsRead,
  markManyAsRead,
  archiveAndReset,
  cleanupArchives,
  inboxSizeBytes,
  MailboxError,
} from '../../lib/codex-bridge/mailbox.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-mailbox-test-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function inboxPath(root, recipient) {
  return join(root, '.codex-paired', 'mailboxes', `${recipient}.json`);
}

function archiveDir(root) {
  return join(root, '.codex-paired', 'mailboxes', 'archive');
}

// ── recipient/from validation ───────────────────────────────────────────────

test('writeToMailbox rejects malformed recipient', async () => {
  const root = makeRepo();
  await assert.rejects(
    () => writeToMailbox(root, '../etc/passwd', { from: 'orchestrator', text: 'pwn' }),
    err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
  );
  cleanup(root);
});

test('writeToMailbox rejects malformed from', async () => {
  const root = makeRepo();
  await assert.rejects(
    () => writeToMailbox(root, 'orchestrator', { from: 'admin', text: 'hi' }),
    err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
  );
  cleanup(root);
});

test('writeToMailbox accepts orchestrator and slice-N recipients', async () => {
  const root = makeRepo();
  const r1 = await writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 'hi orch' });
  const r2 = await writeToMailbox(root, 'slice-5', { from: 'slice-3', text: 'hi slice5' });
  assert.match(r1.id, /^msg-\d{4}/);
  assert.match(r2.id, /^msg-\d{4}/);
  cleanup(root);
});

test('writeToMailbox: message text must be a string', async () => {
  const root = makeRepo();
  await assert.rejects(
    () => writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 42 }),
    err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
  );
  cleanup(root);
});

// ── basic write/read ────────────────────────────────────────────────────────

test('writeToMailbox + readMailbox roundtrip preserves message', async () => {
  const root = makeRepo();
  const { id } = await writeToMailbox(root, 'orchestrator', {
    from: 'slice-3',
    text: 'progress: 30%',
    summary: 'p3',
  });
  const messages = await readMailbox(root, 'orchestrator');
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.id, id);
  assert.equal(m.from, 'slice-3');
  assert.equal(m.to, 'orchestrator');
  assert.equal(m.text, 'progress: 30%');
  assert.equal(m.summary, 'p3');
  assert.equal(m.color, null);
  assert.equal(m.read_at, null);
  assert.match(m.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  cleanup(root);
});

test('readMailbox returns empty array for missing inbox', async () => {
  const root = makeRepo();
  const messages = await readMailbox(root, 'slice-3');
  assert.deepEqual(messages, []);
  cleanup(root);
});

test('writeToMailbox appends to existing inbox', async () => {
  const root = makeRepo();
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'first' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-2', text: 'second' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 'third' });
  const messages = await readMailbox(root, 'orchestrator');
  assert.equal(messages.length, 3);
  assert.equal(messages[0].text, 'first');
  assert.equal(messages[2].text, 'third');
  // IDs must be unique
  const ids = new Set(messages.map(m => m.id));
  assert.equal(ids.size, 3);
  cleanup(root);
});

// ── unread + mark read ──────────────────────────────────────────────────────

test('readUnreadMessages filters by read_at === null', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'm1' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'm2' });
  await markAsRead(root, 'orchestrator', id1);
  const unread = await readUnreadMessages(root, 'orchestrator');
  assert.equal(unread.length, 1);
  assert.equal(unread[0].text, 'm2');
  cleanup(root);
});

test('markAsRead is idempotent', async () => {
  const root = makeRepo();
  const { id } = await writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 'hi' });
  const r1 = await markAsRead(root, 'orchestrator', id);
  assert.equal(r1.alreadyRead, false);
  const r2 = await markAsRead(root, 'orchestrator', id);
  assert.equal(r2.alreadyRead, true);
  cleanup(root);
});

test('markAsRead throws for unknown id', async () => {
  const root = makeRepo();
  await writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 'hi' });
  await assert.rejects(
    () => markAsRead(root, 'orchestrator', 'msg-nonexistent'),
    err => err instanceof MailboxError && err.code === 'mailbox-corrupt' && /not found/.test(err.message)
  );
  cleanup(root);
});

// ── corrupt inbox handling ──────────────────────────────────────────────────

test('readMailbox on malformed JSON throws mailbox-corrupt + best-effort archive move', async () => {
  const root = makeRepo();
  const path = inboxPath(root, 'orchestrator');
  mkdirSync(join(root, '.codex-paired', 'mailboxes'), { recursive: true });
  writeFileSync(path, '{not json');
  await assert.rejects(
    () => readMailbox(root, 'orchestrator'),
    err => err instanceof MailboxError && err.code === 'mailbox-corrupt'
  );
  // Original file should be moved to archive
  assert.equal(existsSync(path), false, 'corrupt file should have been moved');
  // Archive dir should exist with the corrupt file
  const archive = archiveDir(root);
  assert.ok(existsSync(archive));
  const archived = readdirSync(archive);
  assert.ok(archived.some(n => n.includes('corrupt')));
  cleanup(root);
});

test('readMailbox on non-array top-level value throws mailbox-corrupt', async () => {
  const root = makeRepo();
  const path = inboxPath(root, 'orchestrator');
  mkdirSync(join(root, '.codex-paired', 'mailboxes'), { recursive: true });
  writeFileSync(path, '{"hello":"world"}');
  await assert.rejects(
    () => readMailbox(root, 'orchestrator'),
    err => err instanceof MailboxError && err.code === 'mailbox-corrupt'
  );
  cleanup(root);
});

// ── archive rotation ────────────────────────────────────────────────────────

test('archiveAndReset rotates read messages and carries unread forward', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'old1' });
  const { id: id2 } = await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'old2' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'unread1' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'unread2' });
  await markAsRead(root, 'orchestrator', id1);
  await markAsRead(root, 'orchestrator', id2);

  const result = await archiveAndReset(root, 'orchestrator');
  assert.equal(result.archivedCount, 2);
  assert.equal(result.carriedForwardCount, 2);
  assert.ok(result.archivedPath);
  assert.ok(existsSync(result.archivedPath));

  const remaining = await readMailbox(root, 'orchestrator');
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].text, 'unread1');
  assert.equal(remaining[1].text, 'unread2');

  const archived = JSON.parse(readFileSync(result.archivedPath, 'utf8'));
  assert.equal(archived.length, 2);
  assert.equal(archived[0].text, 'old1');
  cleanup(root);
});

test('archiveAndReset throws mailbox-overflow-unread when all messages are unread', async () => {
  const root = makeRepo();
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'a' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'b' });
  await assert.rejects(
    () => archiveAndReset(root, 'orchestrator'),
    err => err instanceof MailboxError && err.code === 'mailbox-overflow-unread'
  );
  cleanup(root);
});

test('archiveAndReset with archive_policy=drop drops read messages without archive file', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'old' });
  await writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: 'fresh' });
  await markAsRead(root, 'orchestrator', id1);

  const result = await archiveAndReset(root, 'orchestrator', { archive_policy: 'drop' });
  assert.equal(result.archivedPath, null);
  assert.equal(result.archivedCount, 1);
  assert.equal(result.carriedForwardCount, 1);

  const remaining = await readMailbox(root, 'orchestrator');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, 'fresh');
  cleanup(root);
});

// ── concurrent writes ──────────────────────────────────────────────────────

test('concurrent writes do not lose messages (lockfile serializes)', async () => {
  const root = makeRepo();
  const N = 20;
  const writes = [];
  for (let i = 0; i < N; i++) {
    writes.push(
      writeToMailbox(root, 'orchestrator', { from: 'slice-1', text: `concurrent-${i}` })
    );
  }
  await Promise.all(writes);
  const messages = await readMailbox(root, 'orchestrator');
  assert.equal(messages.length, N, `expected ${N} messages; got ${messages.length}`);
  // All ids unique
  const ids = new Set(messages.map(m => m.id));
  assert.equal(ids.size, N);
  // All texts present
  const texts = new Set(messages.map(m => m.text));
  for (let i = 0; i < N; i++) {
    assert.ok(texts.has(`concurrent-${i}`), `missing concurrent-${i}`);
  }
  cleanup(root);
});

// ── inbox size + cleanup ──────────────────────────────────────────────────

test('inboxSizeBytes returns 0 for missing, byte count for existing', async () => {
  const root = makeRepo();
  assert.equal(await inboxSizeBytes(root, 'slice-3'), 0);
  await writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'x' });
  const size = await inboxSizeBytes(root, 'slice-3');
  assert.ok(size > 0);
  cleanup(root);
});

test('cleanupArchives deletes by retention_count', async () => {
  const root = makeRepo();
  // Manually create 5 archive files
  const dir = archiveDir(root);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const ts = new Date(2026, 4, 10 - i).toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `slice-3-${ts}.json`), '[]');
  }
  // Keep at most 2 → delete 3
  const result = await cleanupArchives(root, { retention_count: 2, retention_days: 365 });
  assert.equal(result.deleted, 3);
  cleanup(root);
});

test('cleanupArchives returns 0 deleted when archive dir missing', async () => {
  const root = makeRepo();
  const result = await cleanupArchives(root);
  assert.equal(result.deleted, 0);
  cleanup(root);
});

// ── markManyAsRead (v0.7.3.1 §4.5) ─────────────────────────────────────────

test('markManyAsRead marks multiple unread messages atomically', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  const { id: id3 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'c' });
  const result = await markManyAsRead(root, 'slice-1', [id1, id2, id3]);
  assert.deepEqual(result, { marked: [id1, id2, id3], skipped: [] });
  const msgs = await readMailbox(root, 'slice-1');
  for (const m of msgs) {
    assert.ok(m.read_at !== null && typeof m.read_at === 'string', `${m.id} should have ISO read_at`);
  }
  cleanup(root);
});

test('markManyAsRead skips unknown ids, marks known ids', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  const result = await markManyAsRead(root, 'slice-1', [id1, 'msg-fake-0001', id2]);
  assert.deepEqual(result, { marked: [id1, id2], skipped: ['msg-fake-0001'] });
  cleanup(root);
});

test('markManyAsRead preserves prior read_at for already-read ids (idempotent re-delivery)', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  await markAsRead(root, 'slice-1', id1);
  const before = await readMailbox(root, 'slice-1');
  const id1ReadAtBefore = before.find(m => m.id === id1).read_at;
  assert.ok(id1ReadAtBefore !== null);

  // Sleep 5ms so any erroneous overwrite would produce a different timestamp
  await new Promise(r => setTimeout(r, 5));

  const result = await markManyAsRead(root, 'slice-1', [id1, id2]);
  assert.deepEqual(result, { marked: [id1, id2], skipped: [] });

  const after = await readMailbox(root, 'slice-1');
  const id1ReadAtAfter = after.find(m => m.id === id1).read_at;
  const id2ReadAtAfter = after.find(m => m.id === id2).read_at;
  assert.equal(id1ReadAtAfter, id1ReadAtBefore, 'id1 read_at must not be overwritten');
  assert.ok(id2ReadAtAfter !== null, 'id2 must be newly marked');
  cleanup(root);
});

test('markManyAsRead dedupes by first occurrence', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  const result = await markManyAsRead(root, 'slice-1', [
    id1, id1, 'msg-fake-0001', 'msg-fake-0001', id2,
  ]);
  assert.deepEqual(result, { marked: [id1, id2], skipped: ['msg-fake-0001'] });
  cleanup(root);
});

test('markManyAsRead preserves input order in result arrays', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  const { id: id3 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'c' });
  // Input order is id3, fake, id1 — id2 not requested
  const result = await markManyAsRead(root, 'slice-1', [id3, 'msg-fake-0001', id1]);
  assert.deepEqual(result, { marked: [id3, id1], skipped: ['msg-fake-0001'] });
  // id2 untouched
  const after = await readMailbox(root, 'slice-1');
  assert.equal(after.find(m => m.id === id2).read_at, null);
  cleanup(root);
});

test('markManyAsRead with empty list is a no-op (no file mutation)', async () => {
  const root = makeRepo();
  await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const path = inboxPath(root, 'slice-1');
  const contentBefore = readFileSync(path, 'utf8');
  const result = await markManyAsRead(root, 'slice-1', []);
  assert.deepEqual(result, { marked: [], skipped: [] });
  const contentAfter = readFileSync(path, 'utf8');
  assert.equal(contentAfter, contentBefore, 'inbox content must be byte-identical');
  cleanup(root);
});

test('markManyAsRead with empty list does not create missing inbox file', async () => {
  const root = makeRepo();
  const path = inboxPath(root, 'slice-1');
  assert.equal(existsSync(path), false);
  const result = await markManyAsRead(root, 'slice-1', []);
  assert.deepEqual(result, { marked: [], skipped: [] });
  assert.equal(existsSync(path), false, 'empty-list call must not create inbox file');
  cleanup(root);
});

test('markManyAsRead on missing inbox with non-empty ids: all skipped, file created as []', async () => {
  const root = makeRepo();
  const path = inboxPath(root, 'slice-1');
  assert.equal(existsSync(path), false);
  const result = await markManyAsRead(root, 'slice-1', ['msg-fake-0001', 'msg-fake-0002']);
  assert.deepEqual(result, { marked: [], skipped: ['msg-fake-0001', 'msg-fake-0002'] });
  // Existing withInboxLock behavior creates the file to support proper-lockfile.
  assert.equal(existsSync(path), true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), []);
  cleanup(root);
});

test('markManyAsRead on corrupt inbox throws mailbox-corrupt and does not rewrite as valid JSON', async () => {
  const root = makeRepo();
  const path = inboxPath(root, 'slice-1');
  mkdirSync(join(root, '.codex-paired', 'mailboxes'), { recursive: true });
  writeFileSync(path, '{not json');
  await assert.rejects(
    () => markManyAsRead(root, 'slice-1', ['msg-fake-0001']),
    err => err instanceof MailboxError && err.code === 'mailbox-corrupt'
  );
  // No silent rewrite: either the file was archived (best-effort) or it remains corrupt;
  // it must NOT have been replaced with valid JSON.
  if (existsSync(path)) {
    const remaining = readFileSync(path, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(remaining); } catch { /* still corrupt — ok */ }
    assert.equal(parsed, null, 'corrupt inbox must not be silently rewritten as valid JSON');
  }
  cleanup(root);
});

test('markManyAsRead validates sliceId', async () => {
  const root = makeRepo();
  for (const bad of ['../etc/passwd', 'orchestrator/x', '', null, undefined, 42, {}]) {
    await assert.rejects(
      () => markManyAsRead(root, bad, ['msg-fake-0001']),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed',
      `expected rejection for sliceId=${JSON.stringify(bad)}`
    );
  }
  cleanup(root);
});

test('markManyAsRead validates messageIds shape (array of non-empty strings only)', async () => {
  const root = makeRepo();
  await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  // Non-array inputs
  for (const bad of [null, undefined, 'msg-x', 42, {}]) {
    await assert.rejects(
      () => markManyAsRead(root, 'slice-1', bad),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed',
      `expected rejection for messageIds=${JSON.stringify(bad)}`
    );
  }
  // Array containing non-string or empty-string element
  for (const bad of [['msg-x', null], ['msg-x', undefined], ['msg-x', 42], ['msg-x', ''], ['msg-x', {}]]) {
    await assert.rejects(
      () => markManyAsRead(root, 'slice-1', bad),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed',
      `expected rejection for messageIds=${JSON.stringify(bad)}`
    );
  }
  cleanup(root);
});

test('markManyAsRead concurrent with writeToMailbox: no deadlock, no data loss', async () => {
  const root = makeRepo();
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'a' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'b' });
  const { id: id3 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'c' });

  const [batchResult] = await Promise.all([
    markManyAsRead(root, 'slice-1', [id1, id2, id3]),
    writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'new' }),
  ]);
  assert.deepEqual(batchResult, { marked: [id1, id2, id3], skipped: [] });

  const after = await readMailbox(root, 'slice-1');
  assert.equal(after.length, 4, 'should retain 3 originals + 1 new message');
  for (const id of [id1, id2, id3]) {
    const m = after.find(x => x.id === id);
    assert.ok(m && m.read_at !== null, `${id} should be marked read`);
  }
  const fresh = after.find(m => m.text === 'new');
  assert.ok(fresh, 'new message present');
  assert.equal(fresh.read_at, null);
  cleanup(root);
});
