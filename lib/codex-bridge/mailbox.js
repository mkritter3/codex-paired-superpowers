// v0.7.3 mailbox module — file-based inter-agent + orchestrator messaging.
//
// Per spec rev5 §4. Each recipient (orchestrator or slice-N) has a JSON inbox at:
//   <repo>/.codex-paired/mailboxes/<recipient>.json
//
// Atomic writes via proper-lockfile (50 retries, jittered exp backoff up to 250ms,
// total ~10s; stale 60s; liveness refresh 10s).
//
// Permissions are enforced at the CLI layer (see cli.js mailbox-* subcommands).
// This module trusts its caller; it validates only the recipient/from format
// (path-traversal guard) and message schema.
//
// Errors thrown are MailboxError instances with .code matching the spec's
// halt reasons:
//   - mailbox-recipient-malformed
//   - mailbox-corrupt
//   - mailbox-overflow-unread
//   - mailbox-lock-timeout
//   - mailbox-permission-denied  (CLI enforces; module surfaces if asked)

import { readFile, writeFile, mkdir, rename, stat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as lockfile from 'proper-lockfile';
import { memberIdSlug, parseMemberId } from './implementer/member-id.js';
import { containsCanary } from './implementer/secret-redaction.js';

const RECIPIENT_RE = /^(orchestrator|slice-\d+|expert-[a-z][a-z0-9-]{0,47}|impl-[a-z0-9][a-z0-9-]{0,60})$/;

const VALID_KINDS = new Set(['progress', 'blocker', 'merge_note', 'system', 'contract']);
const VALID_PRIORITIES = new Set(['normal', 'urgent']);
const BODY_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Compute the mailbox recipient string for an implementer member ID.
 * Format: "impl-" + slug body (at most 61 chars = 52 prefix + "-" + 8-char hash).
 * Preserves the 8-char hash suffix from memberIdSlug for collision resistance.
 *
 * RECIPIENT_RE allows impl-[a-z0-9][a-z0-9-]{0,60} → body 1..61 chars → total ≤ 66.
 * Normal slugs fit; for oversized slugs the prefix is truncated to 52 chars.
 *
 * @param {string} memberIdString — raw member ID (e.g. "expert-implementer@claude:kimi-k2.6:cloud#0")
 * @returns {string} — e.g. "impl-expert-implementer-claude-kimi-k2-6-cloud-0-<hash8>"
 */
export function recipientForMember(memberIdString) {
  // Validate that memberIdString is a proper member ID (throws on malformed input).
  parseMemberId(memberIdString);
  const slug = memberIdSlug(memberIdString); // e.g. "expert-implementer-claude-kimi-k2-6-cloud-0-abcd1234"
  // slug always ends with "-" + 8-char hex hash
  const lastDash = slug.lastIndexOf('-');
  const hashSuffix = slug.slice(lastDash + 1); // 8-char hex
  const prefixBody = slug.slice(0, lastDash);  // everything before the hash

  // body = prefixBody + "-" + hashSuffix; must be ≤ 61 chars
  const slugBody = prefixBody + '-' + hashSuffix;
  if (slugBody.length <= 61) {
    return 'impl-' + slugBody;
  }
  // Truncate prefix to 52 chars so body = 52 + 1 + 8 = 61 chars exactly.
  const truncatedPrefix = prefixBody.slice(0, 52);
  return 'impl-' + truncatedPrefix + '-' + hashSuffix;
}

const LOCK_OPTIONS = {
  retries: {
    retries: 50,
    minTimeout: 5,
    maxTimeout: 250,
    factor: 1.5,
    randomize: true,
  },
  stale: 60000,    // 60s — process holding lock past this is considered stale
  update: 10000,   // 10s — refresh interval to prove liveness
};

export class MailboxError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'MailboxError';
    this.code = code;
    this.detail = detail;
  }
}

function validateRecipient(value, fieldName) {
  if (typeof value !== 'string' || !RECIPIENT_RE.test(value)) {
    throw new MailboxError(
      'mailbox-recipient-malformed',
      `${fieldName} must match /^(orchestrator|slice-\\d+|expert-[a-z][a-z0-9-]{0,47}|impl-[a-z0-9][a-z0-9-]{0,60})$/; got ${JSON.stringify(value)}`
    );
  }
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new MailboxError('mailbox-recipient-malformed', 'message must be an object');
  }
  validateRecipient(message.from, 'message.from');
  if (typeof message.text !== 'string') {
    throw new MailboxError(
      'mailbox-recipient-malformed',
      `message.text must be a string; got ${typeof message.text}`
    );
  }
  for (const optKey of ['summary', 'color']) {
    if (optKey in message && message[optKey] !== null && typeof message[optKey] !== 'string') {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.${optKey} must be a string or null; got ${typeof message[optKey]}`
      );
    }
  }
  // v0.10.0 optional fields: kind, priority, implementer_run_id, slice_id, body_hash
  if ('kind' in message && message.kind !== null && message.kind !== undefined) {
    if (!VALID_KINDS.has(message.kind)) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.kind must be one of ${[...VALID_KINDS].join(', ')} when present; got ${JSON.stringify(message.kind)}`
      );
    }
  }
  if ('priority' in message && message.priority !== null && message.priority !== undefined) {
    if (!VALID_PRIORITIES.has(message.priority)) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.priority must be one of ${[...VALID_PRIORITIES].join(', ')} when present; got ${JSON.stringify(message.priority)}`
      );
    }
  }
  if ('implementer_run_id' in message && message.implementer_run_id !== null && message.implementer_run_id !== undefined) {
    if (typeof message.implementer_run_id !== 'string' || message.implementer_run_id.length === 0) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.implementer_run_id must be a non-empty string when present; got ${JSON.stringify(message.implementer_run_id)}`
      );
    }
  }
  if ('slice_id' in message && message.slice_id !== null && message.slice_id !== undefined) {
    if (typeof message.slice_id !== 'string' || message.slice_id.length === 0) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.slice_id must be a non-empty string when present; got ${JSON.stringify(message.slice_id)}`
      );
    }
  }
  if ('body_hash' in message && message.body_hash !== null && message.body_hash !== undefined) {
    if (typeof message.body_hash !== 'string' || !BODY_HASH_RE.test(message.body_hash)) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `message.body_hash must match ^sha256:[0-9a-f]{64}$ when present; got ${JSON.stringify(message.body_hash)}`
      );
    }
  }
}

function inboxPath(repoRoot, recipient) {
  validateRecipient(recipient, 'recipient');
  return join(repoRoot, '.codex-paired', 'mailboxes', `${recipient}.json`);
}

function archiveDir(repoRoot) {
  return join(repoRoot, '.codex-paired', 'mailboxes', 'archive');
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

// Monotonic id generation. Generated under lock so no collisions across processes.
let lastTimestampForSeq = '';
let seqWithinTimestamp = 0;

function generateMessageId() {
  // Format: msg-<ISO-timestamp-with-dashes>-<4-digit-seq>
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  if (ts === lastTimestampForSeq) {
    seqWithinTimestamp++;
  } else {
    lastTimestampForSeq = ts;
    seqWithinTimestamp = 1;
  }
  const seq = String(seqWithinTimestamp).padStart(4, '0');
  return `msg-${ts}-${seq}`;
}

async function readInboxRaw(path) {
  // Returns parsed array, or [] on ENOENT. Throws mailbox-corrupt on malformed JSON
  // (with best-effort archive of the corrupt file).
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new MailboxError('mailbox-corrupt', `failed to read inbox ${path}: ${e.message}`);
  }
  if (content.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Best-effort: move corrupt file to archive/<recipient>-corrupt-<ts>.json
    let moveErr = null;
    try {
      const repoRoot = path.split('.codex-paired')[0].replace(/\/$/, '');
      const recipient = path.split('/').pop().replace(/\.json$/, '');
      await ensureDir(archiveDir(repoRoot));
      const corruptPath = join(
        archiveDir(repoRoot),
        `${recipient}-corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      );
      await rename(path, corruptPath);
    } catch (mErr) {
      moveErr = mErr.message;
    }
    throw new MailboxError(
      'mailbox-corrupt',
      `inbox ${path} contains malformed JSON: ${e.message}${moveErr ? `; archive-move also failed: ${moveErr}` : ''}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new MailboxError('mailbox-corrupt', `inbox ${path} top-level value must be an array`);
  }
  return parsed;
}

async function withInboxLock(path, fn) {
  // Ensure file exists (proper-lockfile requires the target file to exist).
  // Create empty array if missing; idempotent.
  await ensureDir(dirname(path));
  try {
    await writeFile(path, '[]', { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw new MailboxError('mailbox-corrupt', `failed to ensure inbox file at ${path}: ${e.message}`);
    }
  }
  let release;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
  } catch (e) {
    throw new MailboxError(
      'mailbox-lock-timeout',
      `failed to acquire lock on ${path}: ${e.message}`
    );
  }
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch (e) {
      // Lock may already be stale-cleared; surface as a warning but don't mask the primary error.
      // (Module callers will see the primary result/throw; release-error logs go to stderr.)
      if (process.env.CPS_MAILBOX_DEBUG) {
        console.error(`[mailbox] lock release failed for ${path}: ${e.message}`);
      }
    }
  }
}

/**
 * Append a message to recipient's inbox. Atomic via proper-lockfile.
 * Generates a stable id under lock and appends with read_at: null.
 *
 * Throws MailboxError on:
 *  - mailbox-recipient-malformed: bad recipient/from format or message shape
 *  - mailbox-corrupt: inbox file unparseable
 *  - mailbox-lock-timeout: 50-retry budget exhausted
 *
 * @param {string} repoRoot
 * @param {string} recipient — "orchestrator" or "slice-N"
 * @param {object} message — { from, text, summary?, color? }; id/timestamp/read_at generated
 * @returns {Promise<{id: string}>}
 */
export async function writeToMailbox(repoRoot, recipient, message) {
  validateRecipient(recipient, 'recipient');
  validateMessage(message);

  // Canary scan: reject messages containing secret patterns before any write.
  // Checked on text + summary (the two string fields callers supply as content).
  const textHasCanary = typeof message.text === 'string' && containsCanary(message.text);
  const summaryHasCanary = typeof message.summary === 'string' && containsCanary(message.summary);
  if (textHasCanary || summaryHasCanary) {
    throw new MailboxError(
      'mailbox-recipient-malformed',
      'writeToMailbox: message contains a redacted-secret pattern; sanitize at the call site'
    );
  }

  const path = inboxPath(repoRoot, recipient);

  return await withInboxLock(path, async () => {
    const messages = await readInboxRaw(path);
    const id = generateMessageId();
    const timestamp = new Date().toISOString();
    const newMessage = {
      id,
      from: message.from,
      to: recipient,
      text: message.text,
      timestamp,
      summary: message.summary ?? null,
      color: message.color ?? null,
      read_at: null,
    };
    // v0.14.0: persist already-validated optional metadata only when supplied,
    // so legacy messages stay byte-identical and older readers ignore absent keys.
    for (const key of ['kind', 'priority', 'implementer_run_id', 'slice_id', 'body_hash']) {
      if (message[key] !== null && message[key] !== undefined) {
        newMessage[key] = message[key];
      }
    }
    messages.push(newMessage);
    await writeFile(path, JSON.stringify(messages, null, 2), 'utf8');
    return { id };
  });
}

/**
 * Read full inbox as an array. Returns [] for missing inbox.
 * Throws mailbox-corrupt on malformed JSON (corrupt file is archive-moved best-effort).
 *
 * NOTE: caller is responsible for permission checks (CLI layer enforces actor model).
 */
export async function readMailbox(repoRoot, sliceId) {
  validateRecipient(sliceId, 'sliceId');
  const path = inboxPath(repoRoot, sliceId);
  return await readInboxRaw(path);
}

/**
 * Read only unread messages (read_at === null).
 */
export async function readUnreadMessages(repoRoot, sliceId) {
  const all = await readMailbox(repoRoot, sliceId);
  return all.filter(m => m && m.read_at === null);
}

/**
 * Mark a specific message as read by id. Atomic via lock.
 * Throws if id not found in inbox.
 */
export async function markAsRead(repoRoot, sliceId, messageId) {
  validateRecipient(sliceId, 'sliceId');
  if (typeof messageId !== 'string' || messageId.length === 0) {
    throw new MailboxError('mailbox-recipient-malformed', 'messageId must be a non-empty string');
  }
  const path = inboxPath(repoRoot, sliceId);

  return await withInboxLock(path, async () => {
    const messages = await readInboxRaw(path);
    const idx = messages.findIndex(m => m && m.id === messageId);
    if (idx < 0) {
      throw new MailboxError(
        'mailbox-corrupt',
        `message id "${messageId}" not found in ${path}`
      );
    }
    if (messages[idx].read_at !== null) {
      // Idempotent: already read.
      return { alreadyRead: true };
    }
    messages[idx].read_at = new Date().toISOString();
    await writeFile(path, JSON.stringify(messages, null, 2), 'utf8');
    return { alreadyRead: false };
  });
}

/**
 * Mark many messages as read in a single lockfile acquisition (v0.7.3.1 §4.5).
 *
 * Semantics:
 *  - Validates `sliceId` and that `messageIds` is an array of non-empty strings.
 *    Format-regex validation (msg-<ISO>-NNNN) is intentionally left to the CLI
 *    boundary; malformed-looking strings here are treated as unknown ids and
 *    returned in `skipped` (idempotency contract).
 *  - Empty `messageIds` short-circuits before any fs/lock activity, so callers
 *    can pass `[]` without creating an inbox file.
 *  - Duplicates in `messageIds` are deduped by first occurrence; result arrays
 *    preserve input order.
 *  - Unknown ids are silently skipped (idempotent — supports re-delivery after
 *    a crashed hook fire).
 *  - Already-read ids end up in `marked` with their original `read_at`
 *    preserved (no overwrite — re-delivery must not lose the original mark
 *    timestamp).
 *  - All transitions within the batch share one timestamp, reflecting the
 *    atomic mark moment.
 *
 * @param {string} repoRoot
 * @param {string} sliceId   — "orchestrator" or "slice-N"
 * @param {string[]} messageIds
 * @returns {Promise<{marked: string[], skipped: string[]}>}
 */
export async function markManyAsRead(repoRoot, sliceId, messageIds) {
  validateRecipient(sliceId, 'sliceId');
  if (!Array.isArray(messageIds)) {
    throw new MailboxError(
      'mailbox-recipient-malformed',
      `messageIds must be an array; got ${typeof messageIds}`
    );
  }
  for (const id of messageIds) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new MailboxError(
        'mailbox-recipient-malformed',
        `messageIds must contain only non-empty strings; got ${JSON.stringify(id)}`
      );
    }
  }

  // Dedupe by first occurrence (preserves input order).
  const seen = new Set();
  const unique = [];
  for (const id of messageIds) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }

  if (unique.length === 0) {
    // Short-circuit: avoid creating an inbox file just to no-op.
    return { marked: [], skipped: [] };
  }

  const path = inboxPath(repoRoot, sliceId);

  return await withInboxLock(path, async () => {
    const messages = await readInboxRaw(path);
    const marked = [];
    const skipped = [];
    const now = new Date().toISOString();
    let mutated = false;

    for (const id of unique) {
      const idx = messages.findIndex(m => m && m.id === id);
      if (idx < 0) {
        skipped.push(id);
        continue;
      }
      if (messages[idx].read_at === null) {
        messages[idx].read_at = now;
        mutated = true;
      }
      // Already-read ids: keep prior read_at intact, still report as marked.
      marked.push(id);
    }

    if (mutated) {
      await writeFile(path, JSON.stringify(messages, null, 2), 'utf8');
    }
    return { marked, skipped };
  });
}

/**
 * On size-exceedance: split inbox into read (archived) + unread (carried forward).
 * If ALL messages are unread → throws mailbox-overflow-unread (no silent loss).
 *
 * archive_policy: "rotate" (default) writes archived messages to a timestamped file.
 * archive_policy: "drop" discards read messages with no archive file (still preserves unread).
 *
 * @returns {Promise<{archivedPath: string|null, archivedCount: number, carriedForwardCount: number}>}
 */
export async function archiveAndReset(repoRoot, sliceId, opts = {}) {
  validateRecipient(sliceId, 'sliceId');
  const archivePolicy = opts.archive_policy ?? 'rotate';
  const path = inboxPath(repoRoot, sliceId);

  return await withInboxLock(path, async () => {
    const messages = await readInboxRaw(path);
    const unread = messages.filter(m => m.read_at === null);
    const read = messages.filter(m => m.read_at !== null);

    if (read.length === 0 && messages.length > 0) {
      throw new MailboxError(
        'mailbox-overflow-unread',
        `inbox ${path} exceeds size cap but every message is unread (${messages.length} total). ` +
          `Read messages or raise mailbox.max_bytes before continuing.`
      );
    }

    let archivedPath = null;
    if (archivePolicy === 'rotate' && read.length > 0) {
      await ensureDir(archiveDir(repoRoot));
      const archiveTs = new Date().toISOString().replace(/[:.]/g, '-');
      archivedPath = join(archiveDir(repoRoot), `${sliceId}-${archiveTs}.json`);
      await writeFile(archivedPath, JSON.stringify(read, null, 2), 'utf8');
    }
    // archive_policy: "drop" → read messages are simply not persisted.

    // Write fresh inbox containing only unread.
    await writeFile(path, JSON.stringify(unread, null, 2), 'utf8');
    return {
      archivedPath,
      archivedCount: read.length,
      carriedForwardCount: unread.length,
    };
  });
}

/**
 * Get current inbox file size in bytes. 0 for missing.
 */
export async function inboxSizeBytes(repoRoot, sliceId) {
  validateRecipient(sliceId, 'sliceId');
  const path = inboxPath(repoRoot, sliceId);
  try {
    const s = await stat(path);
    return s.size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

/**
 * Apply retention policy to archives. Deletes archives older than retentionDays
 * AND beyond retentionCount per recipient (whichever bound triggers first).
 *
 * @returns {Promise<{deleted: number}>}
 */
export async function cleanupArchives(repoRoot, opts = {}) {
  const retentionDays = opts.retention_days ?? 30;
  const retentionCount = opts.retention_count ?? 100;
  const dir = archiveDir(repoRoot);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { deleted: 0 };
    throw e;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Group by recipient: <recipient>-<ISO-timestamp>.json or <recipient>-corrupt-<ts>.json
  const byRecipient = new Map();
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    // Extract recipient prefix: everything up to the first ISO-like segment
    const m = name.match(/^(.+?)-(\d{4}-\d{2}-\d{2}T)/);
    if (!m) continue;
    const recipient = m[1];
    const filePath = join(dir, name);
    let mtimeMs;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    if (!byRecipient.has(recipient)) byRecipient.set(recipient, []);
    byRecipient.get(recipient).push({ name, filePath, mtimeMs });
  }

  let deleted = 0;
  for (const [, files] of byRecipient) {
    // Newest-first
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const tooOld = f.mtimeMs < cutoff;
      const beyondCount = i >= retentionCount;
      if (tooOld || beyondCount) {
        try {
          await unlink(f.filePath);
          deleted++;
        } catch {
          // Best-effort
        }
      }
    }
  }
  return { deleted };
}
