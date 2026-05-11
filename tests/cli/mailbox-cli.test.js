// Tests for v0.7.3 mailbox CLI subcommands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PLUGIN_ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'cli.js');

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-mailbox-cli-'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function runCli(args, opts = {}) {
  // Returns { stdout, stderr, status }. Never throws on non-zero exit.
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: opts.input ?? '',
      cwd: opts.cwd,
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      status: e.status ?? 1,
    };
  }
}

// ── mailbox-write ──────────────────────────────────────────────────────────

test('mailbox-write --text simple message', () => {
  const root = makeRepo();
  const r = runCli(['mailbox-write', '--to', 'orchestrator', '--from', 'slice-3', '--text', 'hi', '--repoRoot', root]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.match(result.id, /^msg-\d{4}/);
  cleanup(root);
});

test('mailbox-write --text-stdin reads stdin for multiline content', () => {
  const root = makeRepo();
  const r = runCli(
    ['mailbox-write', '--to', 'orchestrator', '--from', 'slice-3', '--text-stdin', '--repoRoot', root],
    { input: 'line 1\nline 2\nspecial chars: "quote" $shell-expansion `backtick`' }
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // Read back to verify
  const r2 = runCli(['mailbox-read', '--for', 'orchestrator', '--actor', 'orchestrator', '--repoRoot', root]);
  assert.equal(r2.status, 0);
  const messages = JSON.parse(r2.stdout);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /line 1\nline 2\nspecial chars/);
  cleanup(root);
});

test('mailbox-write --message-json-stdin reads structured JSON', () => {
  const root = makeRepo();
  const json = JSON.stringify({
    text: 'json msg',
    summary: 'short',
    color: 'red',
  });
  const r = runCli(
    ['mailbox-write', '--to', 'orchestrator', '--from', 'slice-5', '--message-json-stdin', '--repoRoot', root],
    { input: json }
  );
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const r2 = runCli(['mailbox-read', '--for', 'orchestrator', '--actor', 'orchestrator', '--repoRoot', root]);
  const messages = JSON.parse(r2.stdout);
  assert.equal(messages[0].text, 'json msg');
  assert.equal(messages[0].summary, 'short');
  assert.equal(messages[0].color, 'red');
  assert.equal(messages[0].from, 'slice-5');
  cleanup(root);
});

test('mailbox-write rejects malformed recipient (path traversal)', () => {
  const root = makeRepo();
  const r = runCli(
    ['mailbox-write', '--to', '../etc/passwd', '--from', 'slice-3', '--text', 'pwn', '--repoRoot', root]
  );
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-recipient-malformed');
  cleanup(root);
});

test('mailbox-write missing --to exits 2', () => {
  const r = runCli(['mailbox-write', '--from', 'slice-3', '--text', 'x', '--repoRoot', '/tmp/x']);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'missing-arg');
});

test('mailbox-write missing both text variants exits 2', () => {
  const root = makeRepo();
  const r = runCli(['mailbox-write', '--to', 'orchestrator', '--from', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 2);
  cleanup(root);
});

// ── mailbox-read ──────────────────────────────────────────────────────────

test('mailbox-read returns empty array for missing inbox', () => {
  const root = makeRepo();
  const r = runCli(['mailbox-read', '--for', 'slice-3', '--actor', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
  cleanup(root);
});

test('mailbox-read --unread filters', () => {
  const root = makeRepo();
  // Write 2 messages then mark first as read
  runCli(['mailbox-write', '--to', 'orchestrator', '--from', 'slice-3', '--text', 'old', '--repoRoot', root]);
  runCli(['mailbox-write', '--to', 'orchestrator', '--from', 'slice-3', '--text', 'fresh', '--repoRoot', root]);
  const all = JSON.parse(runCli(['mailbox-read', '--for', 'orchestrator', '--actor', 'orchestrator', '--repoRoot', root]).stdout);
  assert.equal(all.length, 2);
  runCli(['mailbox-mark-read', '--for', 'orchestrator', '--actor', 'orchestrator', '--id', all[0].id, '--repoRoot', root]);
  const unread = JSON.parse(runCli(['mailbox-read', '--for', 'orchestrator', '--actor', 'orchestrator', '--unread', '--repoRoot', root]).stdout);
  assert.equal(unread.length, 1);
  assert.equal(unread[0].text, 'fresh');
  cleanup(root);
});

test('mailbox-read missing --actor exits 2', () => {
  const root = makeRepo();
  const r = runCli(['mailbox-read', '--for', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'missing-arg');
  cleanup(root);
});

test('mailbox-read enforces actor permissions: slice-3 cannot read slice-5 inbox', () => {
  const root = makeRepo();
  runCli(['mailbox-write', '--to', 'slice-5', '--from', 'orchestrator', '--text', 'secret', '--repoRoot', root]);
  const r = runCli(['mailbox-read', '--for', 'slice-5', '--actor', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-permission-denied');
  cleanup(root);
});

test('mailbox-read: orchestrator can read any inbox', () => {
  const root = makeRepo();
  runCli(['mailbox-write', '--to', 'slice-3', '--from', 'slice-7', '--text', 'note', '--repoRoot', root]);
  const r = runCli(['mailbox-read', '--for', 'slice-3', '--actor', 'orchestrator', '--repoRoot', root]);
  assert.equal(r.status, 0);
  const messages = JSON.parse(r.stdout);
  assert.equal(messages.length, 1);
  cleanup(root);
});

test('mailbox-read: slice can read its own inbox', () => {
  const root = makeRepo();
  runCli(['mailbox-write', '--to', 'slice-3', '--from', 'orchestrator', '--text', 'go ahead', '--repoRoot', root]);
  const r = runCli(['mailbox-read', '--for', 'slice-3', '--actor', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 0);
  cleanup(root);
});

// ── mailbox-mark-read ──────────────────────────────────────────────────────

test('mailbox-mark-read sets read_at', () => {
  const root = makeRepo();
  const writeR = runCli(['mailbox-write', '--to', 'slice-3', '--from', 'orchestrator', '--text', 'm', '--repoRoot', root]);
  const id = JSON.parse(writeR.stdout).id;
  const r = runCli(['mailbox-mark-read', '--for', 'slice-3', '--actor', 'slice-3', '--id', id, '--repoRoot', root]);
  assert.equal(r.status, 0);
  const result = JSON.parse(r.stdout);
  assert.equal(result.alreadyRead, false);
  // Second call → idempotent
  const r2 = runCli(['mailbox-mark-read', '--for', 'slice-3', '--actor', 'slice-3', '--id', id, '--repoRoot', root]);
  assert.equal(JSON.parse(r2.stdout).alreadyRead, true);
  cleanup(root);
});

test('mailbox-mark-read enforces permissions', () => {
  const root = makeRepo();
  const writeR = runCli(['mailbox-write', '--to', 'slice-5', '--from', 'orchestrator', '--text', 'm', '--repoRoot', root]);
  const id = JSON.parse(writeR.stdout).id;
  const r = runCli(['mailbox-mark-read', '--for', 'slice-5', '--actor', 'slice-3', '--id', id, '--repoRoot', root]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-permission-denied');
  cleanup(root);
});

test('mailbox-mark-read missing --id exits 2', () => {
  const root = makeRepo();
  const r = runCli(['mailbox-mark-read', '--for', 'slice-3', '--actor', 'slice-3', '--repoRoot', root]);
  assert.equal(r.status, 2);
  cleanup(root);
});

test('mailbox-mark-read unknown id exits 2 with mailbox-corrupt code (id not found)', () => {
  const root = makeRepo();
  // Need at least one message so the inbox exists
  runCli(['mailbox-write', '--to', 'slice-3', '--from', 'orchestrator', '--text', 'm', '--repoRoot', root]);
  const r = runCli(['mailbox-mark-read', '--for', 'slice-3', '--actor', 'slice-3', '--id', 'msg-bogus', '--repoRoot', root]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-corrupt');
  cleanup(root);
});

// ── mailbox-mark-read-batch (v0.7.3.1 §4.5) ────────────────────────────────

function seedMessages(root, recipient, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const r = runCli([
      'mailbox-write', '--to', recipient, '--from', 'orchestrator',
      '--text', `m${i}`, '--repoRoot', root,
    ]);
    ids.push(JSON.parse(r.stdout).id);
  }
  return ids;
}

test('mailbox-mark-read-batch happy path marks all ids', () => {
  const root = makeRepo();
  const [id1, id2, id3] = seedMessages(root, 'slice-3', 3);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', `${id1},${id2},${id3}`,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id1, id2, id3], skipped: [] });
  cleanup(root);
});

test('mailbox-mark-read-batch skips well-formed unknown ids', () => {
  const root = makeRepo();
  const [id1, id2] = seedMessages(root, 'slice-3', 2);
  const fake = 'msg-2026-01-01T00-00-00-000Z-9999';
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', `${id1},${fake},${id2}`,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id1, id2], skipped: [fake] });
  cleanup(root);
});

test('mailbox-mark-read-batch all-unknown well-formed: exit 0, all in skipped', () => {
  const root = makeRepo();
  const fake1 = 'msg-2026-01-01T00-00-00-000Z-9998';
  const fake2 = 'msg-2026-01-01T00-00-00-000Z-9999';
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', `${fake1},${fake2}`,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [], skipped: [fake1, fake2] });
  cleanup(root);
});

test('mailbox-mark-read-batch permission denied when actor != for and != orchestrator', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-5', 1);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-5', '--actor', 'slice-3',
    '--message-ids', id1,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).defect, 'mailbox-permission-denied');
  // No mutation
  const readBack = runCli(['mailbox-read', '--for', 'slice-5', '--actor', 'orchestrator', '--repoRoot', root]);
  const msgs = JSON.parse(readBack.stdout);
  assert.equal(msgs[0].read_at, null);
  cleanup(root);
});

test('mailbox-mark-read-batch orchestrator may mark any inbox', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-3', 1);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'orchestrator',
    '--message-ids', id1,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id1], skipped: [] });
  cleanup(root);
});

test('mailbox-mark-read-batch missing --for exits 2 missing-arg', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-mark-read-batch',
    '--actor', 'slice-3',
    '--message-ids', 'msg-2026-01-01T00-00-00-000Z-0001',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).defect, 'missing-arg');
  cleanup(root);
});

test('mailbox-mark-read-batch missing --actor exits 2 missing-arg', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3',
    '--message-ids', 'msg-2026-01-01T00-00-00-000Z-0001',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).defect, 'missing-arg');
  cleanup(root);
});

test('mailbox-mark-read-batch missing --message-ids exits 2 missing-arg', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).defect, 'missing-arg');
  cleanup(root);
});

test('mailbox-mark-read-batch present-but-empty --message-ids exits 2 invalid-message-ids', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', '',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr).defect, 'invalid-message-ids');
  cleanup(root);
});

test('mailbox-mark-read-batch trim-to-empty CSV parts → invalid-message-ids', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-3', 1);
  const inboxBefore = readFileSync(
    join(root, '.codex-paired', 'mailboxes', 'slice-3.json'), 'utf8'
  );
  for (const csv of [`${id1},,msg-2026-01-01T00-00-00-000Z-9999`, `${id1}, ,msg-2026-01-01T00-00-00-000Z-9999`]) {
    const r = runCli([
      'mailbox-mark-read-batch',
      '--for', 'slice-3', '--actor', 'slice-3',
      '--message-ids', csv,
      '--repoRoot', root,
    ]);
    assert.equal(r.status, 2, `csv=${JSON.stringify(csv)} expected exit 2`);
    assert.equal(JSON.parse(r.stderr).defect, 'invalid-message-ids');
  }
  // No mutation: inbox unchanged
  const inboxAfter = readFileSync(
    join(root, '.codex-paired', 'mailboxes', 'slice-3.json'), 'utf8'
  );
  assert.equal(inboxAfter, inboxBefore, 'inbox must be unchanged when validation fails');
  cleanup(root);
});

test('mailbox-mark-read-batch malformed id rejected before any helper invocation', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-3', 1);
  const inboxBefore = readFileSync(
    join(root, '.codex-paired', 'mailboxes', 'slice-3.json'), 'utf8'
  );
  for (const csv of [`${id1},not-an-id`, `msg-foo`, `msg-2026-9999`, `${id1},msg-bogus-0001`]) {
    const r = runCli([
      'mailbox-mark-read-batch',
      '--for', 'slice-3', '--actor', 'slice-3',
      '--message-ids', csv,
      '--repoRoot', root,
    ]);
    assert.equal(r.status, 2, `csv=${JSON.stringify(csv)} expected exit 2`);
    assert.equal(JSON.parse(r.stderr).defect, 'invalid-message-ids');
  }
  // Even though id1 was real, no inbox mutation on validation failure
  const inboxAfter = readFileSync(
    join(root, '.codex-paired', 'mailboxes', 'slice-3.json'), 'utf8'
  );
  assert.equal(inboxAfter, inboxBefore, 'inbox must be unchanged when any id fails validation');
  cleanup(root);
});

test('mailbox-mark-read-batch trims surrounding whitespace from each CSV part', () => {
  const root = makeRepo();
  const [id1, id2] = seedMessages(root, 'slice-3', 2);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', ` ${id1} , ${id2} `,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id1, id2], skipped: [] });
  cleanup(root);
});

test('mailbox-mark-read-batch preserves duplicate+unknown ordering through CLI', () => {
  const root = makeRepo();
  const [id1, id2] = seedMessages(root, 'slice-3', 2);
  const fake = 'msg-2026-01-01T00-00-00-000Z-9999';
  // Input order: id2, fake, id2 (dup), id1 → expected marked: [id2, id1] (dedupe first occ), skipped: [fake]
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', `${id2},${fake},${id2},${id1}`,
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id2, id1], skipped: [fake] });
  cleanup(root);
});

test('mailbox-mark-read-batch defaults --repoRoot to cwd (back-compat)', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-3', 1);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', id1,
  ], { cwd: root });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: [id1], skipped: [] });
  cleanup(root);
});

test('mailbox-mark-read-batch output shape: keys are exactly marked + skipped (string arrays)', () => {
  const root = makeRepo();
  const [id1] = seedMessages(root, 'slice-3', 1);
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'slice-3', '--actor', 'slice-3',
    '--message-ids', id1,
    '--repoRoot', root,
  ]);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['marked', 'skipped']);
  assert.ok(Array.isArray(out.marked) && out.marked.every(x => typeof x === 'string'));
  assert.ok(Array.isArray(out.skipped) && out.skipped.every(x => typeof x === 'string'));
  cleanup(root);
});

// ── v0.8.0 expert-* recipient identity (CLI surfaces) ──────────────────────

test('mailbox-write accepts expert-* recipient and sender', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-write',
    '--to', 'expert-ui',
    '--from', 'expert-ux',
    '--text', 'x',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.match(result.id, /^msg-\d{4}/);
  cleanup(root);
});

test('mailbox-read --for expert-ui --actor expert-ui --unread exits 0 (self-read)', () => {
  const root = makeRepo();
  // Seed a message
  runCli([
    'mailbox-write',
    '--to', 'expert-ui',
    '--from', 'expert-ux',
    '--text', 'peer DM',
    '--repoRoot', root,
  ]);
  const r = runCli([
    'mailbox-read',
    '--for', 'expert-ui',
    '--actor', 'expert-ui',
    '--unread',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const messages = JSON.parse(r.stdout);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].from, 'expert-ux');
  cleanup(root);
});

test('mailbox-read --for expert-ui --actor orchestrator --unread exits 0 (supervisory)', () => {
  const root = makeRepo();
  runCli([
    'mailbox-write',
    '--to', 'expert-ui',
    '--from', 'expert-ux',
    '--text', 'peer DM',
    '--repoRoot', root,
  ]);
  const r = runCli([
    'mailbox-read',
    '--for', 'expert-ui',
    '--actor', 'orchestrator',
    '--unread',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  cleanup(root);
});

test('mailbox-read --for expert-ui --actor expert-ux exits 2 mailbox-permission-denied', () => {
  const root = makeRepo();
  runCli([
    'mailbox-write',
    '--to', 'expert-ui',
    '--from', 'orchestrator',
    '--text', 'secret',
    '--repoRoot', root,
  ]);
  const r = runCli([
    'mailbox-read',
    '--for', 'expert-ui',
    '--actor', 'expert-ux',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-permission-denied');
  cleanup(root);
});

test('mailbox-mark-read-batch --for expert-ui --actor expert-ui marks expert messages', () => {
  const root = makeRepo();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const w = runCli([
      'mailbox-write',
      '--to', 'expert-ui',
      '--from', 'expert-ux',
      '--text', `m${i}`,
      '--repoRoot', root,
    ]);
    ids.push(JSON.parse(w.stdout).id);
  }
  const r = runCli([
    'mailbox-mark-read-batch',
    '--for', 'expert-ui',
    '--actor', 'expert-ui',
    '--message-ids', ids.join(','),
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), { marked: ids, skipped: [] });
  cleanup(root);
});

test('mailbox-write --to expert-../../x exits 2 mailbox-recipient-malformed', () => {
  const root = makeRepo();
  const r = runCli([
    'mailbox-write',
    '--to', 'expert-../../x',
    '--from', 'expert-ui',
    '--text', 'x',
    '--repoRoot', root,
  ]);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr);
  assert.equal(err.defect, 'mailbox-recipient-malformed');
  cleanup(root);
});
