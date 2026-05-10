// Tests for v0.7.3 mailbox CLI subcommands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
