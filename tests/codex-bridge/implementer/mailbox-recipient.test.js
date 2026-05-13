// v0.10.0 slice 6 — mailbox recipient regex extension + recipientForMember tests.
//
// Tests:
//  - compat existing recipients (orchestrator, slice-*, expert-*) still pass
//  - new impl-* recipient format passes
//  - 4 malformed recipient rejections
//  - recipientForMember for a known memberId produces a valid passing recipient
//  - edge.boundary truncation: synthetic long member id → 66-char recipient

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeToMailbox,
  readMailbox,
  MailboxError,
  recipientForMember,
} from '../../../lib/codex-bridge/mailbox.js';
import { memberIdSlug } from '../../../lib/codex-bridge/implementer/member-id.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-recip-test-'));
}

// ── compat: existing recipients still pass ──────────────────────────────────

test('compat: orchestrator recipient still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'orchestrator', { from: 'slice-3', text: 'hi' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: slice-3 recipient still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-3', { from: 'orchestrator', text: 'hi' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: slice-99 recipient still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'slice-99', { from: 'orchestrator', text: 'hi' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: expert-architecture recipient still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'expert-architecture', { from: 'orchestrator', text: 'hi' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compat: expert-test-coverage recipient still passes', async () => {
  const root = makeRepo();
  try {
    const r = await writeToMailbox(root, 'expert-test-coverage', { from: 'orchestrator', text: 'hi' });
    assert.match(r.id, /^msg-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── happy: new impl-* recipient ─────────────────────────────────────────────

test('happy: impl-<slug> recipient passes', async () => {
  const root = makeRepo();
  const memberId = 'expert-implementer@claude:kimi-k2.6:cloud#0';
  const recipient = recipientForMember(memberId);
  assert.match(recipient, /^impl-[a-z0-9][a-z0-9-]{0,60}$/, `recipient "${recipient}" must match impl- pattern`);
  try {
    const r = await writeToMailbox(root, recipient, { from: 'orchestrator', text: 'impl msg' });
    assert.match(r.id, /^msg-/);
    const inbox = await readMailbox(root, recipient);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, 'orchestrator');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── malformed recipient rejections ──────────────────────────────────────────

test('rejects: impl- without suffix (just impl-)', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'impl-', { from: 'orchestrator', text: 'x' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects: impl- starting with uppercase', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'impl-ABC', { from: 'orchestrator', text: 'x' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects: impl- with path traversal', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'impl-../../etc/passwd', { from: 'orchestrator', text: 'x' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects: impl- with underscore', async () => {
  const root = makeRepo();
  try {
    await assert.rejects(
      () => writeToMailbox(root, 'impl-expert_impl', { from: 'orchestrator', text: 'x' }),
      err => err instanceof MailboxError && err.code === 'mailbox-recipient-malformed'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── recipientForMember: known member id ─────────────────────────────────────

test('recipientForMember: expert-implementer@claude:kimi-k2.6:cloud#0 → valid passing recipient', async () => {
  const root = makeRepo();
  const memberId = 'expert-implementer@claude:kimi-k2.6:cloud#0';
  const recipient = recipientForMember(memberId);

  // Must start with impl-
  assert.ok(recipient.startsWith('impl-'), `expected impl- prefix, got: ${recipient}`);

  // Must match RECIPIENT_RE (validated by writeToMailbox)
  const r = await writeToMailbox(root, recipient, { from: 'orchestrator', text: 'test' });
  assert.match(r.id, /^msg-/);

  // Deterministic
  assert.equal(recipientForMember(memberId), recipient, 'must be deterministic');

  rmSync(root, { recursive: true, force: true });
});

// ── edge.boundary: truncation ────────────────────────────────────────────────

test('edge.boundary truncation: synthetic long member id → 66-char recipient with preserved 8-char hash', () => {
  // Construct a member id whose slug body exceeds 61 chars.
  // memberIdSlug lowercases and replaces non-alnum with '-', then trims.
  // We need: prefixBody.length + 1 + 8 > 61, i.e. prefixBody.length > 52.
  // Use a roleId with many chars: "expert-implementer-longrole-extension" + @claude:model#0
  // That translates to slug "expert-implementer-longrole-extension-claude-model-0-<hash8>"
  // which is 55 chars prefix + 1 + 8 = 64 > 61.
  const memberId = 'expert-implementer-longrole-extension@claude:model#0';
  const recipient = recipientForMember(memberId);

  // Must be exactly 66 chars ("impl-" = 5 + 61 body)
  assert.equal(recipient.length, 66, `expected length 66, got ${recipient.length}: "${recipient}"`);

  // Must start with impl-
  assert.ok(recipient.startsWith('impl-'), `must start with impl-`);

  // Must end with the 8-char hash from the slug
  const slug = memberIdSlug(memberId);
  const hashSuffix = slug.slice(slug.lastIndexOf('-') + 1);
  assert.ok(recipient.endsWith('-' + hashSuffix), `must end with -${hashSuffix}, got: ${recipient}`);

  // Must match the RECIPIENT_RE pattern
  assert.match(recipient, /^impl-[a-z0-9][a-z0-9-]{0,60}$/);
});
