// Tests for v0.7.3.1 PostToolUse hook (lib/codex-bridge/hook-mailbox-inject.js).
// Unit-level against the exported `mainWithDeps(stdinJson, deps)` seam plus
// direct tests for the pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import {
  inferActorAndRepoRoot,
  writeBreadcrumb,
  formatContext,
  mainWithDeps,
} from '../../lib/codex-bridge/hook-mailbox-inject.js';
import { writeToMailbox, MailboxError } from '../../lib/codex-bridge/mailbox.js';

function makeTmp(prefix = 'cps-hook-test-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch {}
}
function makeRepoWithWorktree(slice) {
  const root = makeTmp();
  mkdirSync(join(root, '.codex-paired'), { recursive: true });
  const wt = join(root, '.git-worktrees', slice);
  mkdirSync(wt, { recursive: true });
  return { root, wt };
}

// ── A. inferActorAndRepoRoot ───────────────────────────────────────────────

test('A1: null/undefined/empty cwd → null', () => {
  assert.equal(inferActorAndRepoRoot(null), null);
  assert.equal(inferActorAndRepoRoot(undefined), null);
  assert.equal(inferActorAndRepoRoot(''), null);
});

test('A2: cwd without .git-worktrees segment → null', () => {
  const root = makeTmp();
  assert.equal(inferActorAndRepoRoot(root), null);
  cleanup(root);
});

test('A3: candidate root has no .codex-paired/ → null (spurious match)', () => {
  const root = makeTmp();
  const wt = join(root, '.git-worktrees', 'slice-1');
  mkdirSync(wt, { recursive: true });
  // Intentionally do NOT create .codex-paired/
  assert.equal(inferActorAndRepoRoot(wt), null);
  cleanup(root);
});

test('A4: <root>/.git-worktrees/slice-1 with .codex-paired/ → {slice-1, root}', () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const result = inferActorAndRepoRoot(wt);
  assert.deepEqual(result, { actor: 'slice-1', repoRoot: root });
  cleanup(root);
});

test('A5: nested cwd <root>/.git-worktrees/slice-1/src/foo → same result', () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const nested = join(wt, 'src', 'foo');
  mkdirSync(nested, { recursive: true });
  const result = inferActorAndRepoRoot(nested);
  assert.deepEqual(result, { actor: 'slice-1', repoRoot: root });
  cleanup(root);
});

test('A6: nested valid worktrees, inner-most wins (right-to-left scan)', () => {
  const { root } = makeRepoWithWorktree('slice-1');
  // Build inner: <root>/.git-worktrees/slice-1/sub/.codex-paired/ + .git-worktrees/slice-2/
  const innerRoot = join(root, '.git-worktrees', 'slice-1', 'sub');
  mkdirSync(join(innerRoot, '.codex-paired'), { recursive: true });
  const innerWt = join(innerRoot, '.git-worktrees', 'slice-2', 'x');
  mkdirSync(innerWt, { recursive: true });
  const result = inferActorAndRepoRoot(innerWt);
  assert.deepEqual(result, { actor: 'slice-2', repoRoot: innerRoot });
  cleanup(root);
});

test('A7: symlinked cwd resolves via realpathSync.native', () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const linkParent = makeTmp('cps-hook-link-');
  const link = join(linkParent, 'agent-cwd');
  symlinkSync(wt, link);
  const result = inferActorAndRepoRoot(link);
  assert.deepEqual(result, { actor: 'slice-1', repoRoot: root });
  cleanup(root);
  cleanup(linkParent);
});

test('A8: cwd exactly at worktree root (no trailing subdir) → correct slice', () => {
  const { root, wt } = makeRepoWithWorktree('slice-3');
  const result = inferActorAndRepoRoot(wt);
  assert.deepEqual(result, { actor: 'slice-3', repoRoot: root });
  cleanup(root);
});

test('A9: slice-99 multi-digit returned correctly', () => {
  const { root, wt } = makeRepoWithWorktree('slice-99');
  const result = inferActorAndRepoRoot(wt);
  assert.deepEqual(result, { actor: 'slice-99', repoRoot: root });
  cleanup(root);
});

test('A10: non-SLICE_RX worktree name (feature-x) → null', () => {
  const root = makeTmp();
  mkdirSync(join(root, '.codex-paired'), { recursive: true });
  const wt = join(root, '.git-worktrees', 'feature-x');
  mkdirSync(wt, { recursive: true });
  assert.equal(inferActorAndRepoRoot(wt), null);
  cleanup(root);
});

// ── B. mainWithDeps integration via dep injection ──────────────────────────

function makeRecordingDeps(overrides = {}) {
  const calls = { readUnreadMessages: [], markManyAsRead: [], writeOutput: [], writeBreadcrumb: [] };
  const deps = {
    async readUnreadMessages(...args) { calls.readUnreadMessages.push(args); return []; },
    async markManyAsRead(...args) { calls.markManyAsRead.push(args); return { marked: [], skipped: [] }; },
    async writeOutput(payload) { calls.writeOutput.push(payload); },
    writeBreadcrumb(...args) { calls.writeBreadcrumb.push(args); },
    ...overrides,
  };
  return { deps, calls };
}

function fixtureStdin(opts = {}) {
  const obj = {
    session_id: 'fixture-session',
    transcript_path: '/tmp/fixture.jsonl',
    cwd: opts.cwd,
    permission_mode: 'default',
    agent_type: 'general-purpose',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo test' },
    tool_response: { exit_code: 0, stdout: '', stderr: '' },
  };
  // Only attach agent_id when the caller did not explicitly opt out.
  if (!('agent_id' in opts)) obj.agent_id = 'fixture-agent';
  else if (opts.agent_id !== undefined) obj.agent_id = opts.agent_id;
  return JSON.stringify(obj);
}

test('B1: happy path emits additionalContext and marks read', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { id: id1 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'msg one' });
  const { id: id2 } = await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'msg two' });

  const { deps, calls } = makeRecordingDeps({
    // Use real mailbox functions so we exercise the wiring
    readUnreadMessages: async (r, s) => {
      const { readUnreadMessages } = await import('../../lib/codex-bridge/mailbox.js');
      const v = await readUnreadMessages(r, s);
      calls.readUnreadMessages.push([r, s]);
      return v;
    },
    markManyAsRead: async (r, s, ids) => {
      const { markManyAsRead } = await import('../../lib/codex-bridge/mailbox.js');
      const v = await markManyAsRead(r, s, ids);
      calls.markManyAsRead.push([r, s, ids]);
      return v;
    },
  });

  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 1);
  const parsed = JSON.parse(calls.writeOutput[0]);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id1));
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes(id2));
  assert.equal(calls.markManyAsRead.length, 1);
  assert.deepEqual(calls.markManyAsRead[0][2].sort(), [id1, id2].sort());
  cleanup(root);
});

test('B2: no unread → no output, no mark-read, exit 0', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps, calls } = makeRecordingDeps({ readUnreadMessages: async () => [] });
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 0);
  assert.equal(calls.markManyAsRead.length, 0);
  cleanup(root);
});

test('B3: missing agent_id → exit 0 no calls (main-thread fire)', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps, calls } = makeRecordingDeps();
  const result = await mainWithDeps(fixtureStdin({ cwd: wt, agent_id: undefined }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
  assert.equal(calls.writeOutput.length, 0);
  cleanup(root);
});

test('B4: malformed stdin (non-JSON) → exit 0, no calls, no breadcrumb', async () => {
  const { deps, calls } = makeRecordingDeps();
  const result = await mainWithDeps('this is not json {[}', deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
  assert.equal(calls.writeBreadcrumb.length, 0);
});

test('B5: cwd not in worktree → exit 0, no calls', async () => {
  const root = makeTmp();
  const { deps, calls } = makeRecordingDeps();
  const result = await mainWithDeps(fixtureStdin({ cwd: root }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
  cleanup(root);
});

test('B6: spurious .git-worktrees with no .codex-paired/ → exit 0, no calls', async () => {
  const root = makeTmp();
  const wt = join(root, '.git-worktrees', 'slice-1');
  mkdirSync(wt, { recursive: true });
  const { deps, calls } = makeRecordingDeps();
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
  cleanup(root);
});

test('B7: read failure → breadcrumb appended, no output, exit 0', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps, calls } = makeRecordingDeps({
    readUnreadMessages: async () => { throw new MailboxError('mailbox-corrupt', 'bad inbox'); },
  });
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 0);
  assert.equal(calls.markManyAsRead.length, 0);
  assert.equal(calls.writeBreadcrumb.length, 1);
  const [bcRoot, bcSlice, bcMsg] = calls.writeBreadcrumb[0];
  assert.equal(bcRoot, root);
  assert.equal(bcSlice, 'slice-1');
  assert.match(bcMsg, /read failed/);
  assert.match(bcMsg, /mailbox-corrupt/);
  cleanup(root);
});

test('B8: mark-read failure after emit → output emitted, breadcrumb appended, exit 0', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps, calls } = makeRecordingDeps({
    readUnreadMessages: async () => [{ id: 'msg-x', from: 'orchestrator', text: 'hi', timestamp: 't' }],
    markManyAsRead: async () => { throw new MailboxError('mailbox-lock-timeout', 'lock held'); },
  });
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 1, 'worker still gets the message');
  assert.equal(calls.writeBreadcrumb.length, 1);
  const [, , bcMsg] = calls.writeBreadcrumb[0];
  assert.match(bcMsg, /mark-read failed/);
  assert.match(bcMsg, /mailbox-lock-timeout/);
  cleanup(root);
});

test('B9: symlink cwd at mainWithDeps level → happy path', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  await writeToMailbox(root, 'slice-1', { from: 'orchestrator', text: 'hi' });
  const linkParent = makeTmp('cps-hook-link-');
  const link = join(linkParent, 'agent-cwd');
  symlinkSync(wt, link);
  const { deps, calls } = makeRecordingDeps({
    readUnreadMessages: async (r, s) => {
      const { readUnreadMessages } = await import('../../lib/codex-bridge/mailbox.js');
      const v = await readUnreadMessages(r, s);
      calls.readUnreadMessages.push([r, s]);
      return v;
    },
  });
  const result = await mainWithDeps(fixtureStdin({ cwd: link }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 1);
  assert.equal(calls.markManyAsRead.length, 1);
  assert.equal(calls.markManyAsRead[0][1], 'slice-1');
  cleanup(root);
  cleanup(linkParent);
});

test('B10: cwd at worktree root → happy path', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-7');
  const { deps, calls } = makeRecordingDeps({
    readUnreadMessages: async () => [{ id: 'msg-x', from: 'orchestrator', text: 'hi', timestamp: 't' }],
  });
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(calls.writeOutput.length, 1);
  assert.equal(calls.markManyAsRead.length, 1);
  assert.equal(calls.markManyAsRead[0][1], 'slice-7');
  cleanup(root);
});

test('B11: stdout flush ordering — mark-read only after writeOutput resolves', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  let writeOutputResolved = false;
  let markReadCalledBeforeFlush = null;
  const { deps } = makeRecordingDeps({
    readUnreadMessages: async () => [{ id: 'msg-x', from: 'orchestrator', text: 'hi', timestamp: 't' }],
    writeOutput: async (_payload) => {
      // At the moment we ENTER writeOutput, markManyAsRead must not have fired.
      markReadCalledBeforeFlush = false;
      await new Promise(r => setImmediate(r));  // simulate flush latency
      writeOutputResolved = true;
    },
    markManyAsRead: async () => {
      if (!writeOutputResolved) {
        markReadCalledBeforeFlush = true;
      }
      return { marked: [], skipped: [] };
    },
  });
  const result = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(result, { exit: 0 });
  assert.equal(writeOutputResolved, true, 'writeOutput should have resolved');
  assert.equal(markReadCalledBeforeFlush, false, 'markManyAsRead must fire AFTER writeOutput resolves');
  cleanup(root);
});

test('B12a: agent_id present but cwd missing → exit 0 no-op', async () => {
  const { deps, calls } = makeRecordingDeps();
  const r = await mainWithDeps(fixtureStdin({ cwd: undefined }), deps);
  assert.deepEqual(r, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
});

test('B12b: cwd non-string → exit 0 no-op', async () => {
  const { deps, calls } = makeRecordingDeps();
  const stdin = JSON.stringify({ agent_id: 'x', cwd: 42 });
  const r = await mainWithDeps(stdin, deps);
  assert.deepEqual(r, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
});

test('B12c: cwd empty string → exit 0 no-op', async () => {
  const { deps, calls } = makeRecordingDeps();
  const r = await mainWithDeps(fixtureStdin({ cwd: '' }), deps);
  assert.deepEqual(r, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
});

test('B12d: cwd relative path → exit 0 no-op', async () => {
  const { deps, calls } = makeRecordingDeps();
  const r = await mainWithDeps(fixtureStdin({ cwd: './foo/bar' }), deps);
  assert.deepEqual(r, { exit: 0 });
  assert.equal(calls.readUnreadMessages.length, 0);
});

test('B13: malformed-but-parseable input (missing tool_name) still proceeds if identity OK', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps, calls } = makeRecordingDeps({
    readUnreadMessages: async () => [{ id: 'msg-x', from: 'orchestrator', text: 'hi', timestamp: 't' }],
  });
  // Construct stdin WITHOUT tool_name and with wrong hook_event_name
  const stdin = JSON.stringify({
    agent_id: 'fixture-agent',
    cwd: wt,
    hook_event_name: 'PreToolUse',  // wrong on purpose — hook doesn't gate on this
  });
  const r = await mainWithDeps(stdin, deps);
  assert.deepEqual(r, { exit: 0 });
  assert.equal(calls.writeOutput.length, 1, 'should proceed despite missing tool_name');
  cleanup(root);
});

test('B14: best-effort breadcrumb — failing writeBreadcrumb during read failure does not throw', async () => {
  const { root, wt } = makeRepoWithWorktree('slice-1');
  const { deps } = makeRecordingDeps({
    readUnreadMessages: async () => { throw new MailboxError('mailbox-corrupt', 'bad'); },
    writeBreadcrumb: () => { throw new Error('disk full'); },
  });
  // Must not throw
  const r = await mainWithDeps(fixtureStdin({ cwd: wt }), deps);
  assert.deepEqual(r, { exit: 0 });
  cleanup(root);
});

// ── C. writeBreadcrumb direct ──────────────────────────────────────────────

test('C1: writeBreadcrumb creates diagnostics dir and appends JSONL', () => {
  const root = makeTmp();
  writeBreadcrumb(root, 'slice-1', 'something failed');
  const path = join(root, '.codex-paired', 'diagnostics', 'hook-failures.jsonl');
  assert.equal(existsSync(path), true);
  const content = readFileSync(path, 'utf8');
  const entry = JSON.parse(content.trim());
  assert.equal(entry.slice, 'slice-1');
  assert.equal(entry.error, 'something failed');
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  cleanup(root);
});

test('C2: writeBreadcrumb appends multiple lines (newline-delimited JSON)', () => {
  const root = makeTmp();
  writeBreadcrumb(root, 'slice-1', 'first');
  writeBreadcrumb(root, 'slice-2', 'second');
  const path = join(root, '.codex-paired', 'diagnostics', 'hook-failures.jsonl');
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const e1 = JSON.parse(lines[0]);
  const e2 = JSON.parse(lines[1]);
  assert.equal(e1.error, 'first');
  assert.equal(e2.error, 'second');
  cleanup(root);
});

test('C3: writeBreadcrumb best-effort — nonexistent unwritable root does not throw', () => {
  // /proc on darwin doesn't exist; even on Linux it's not writable for our test paths.
  // Use a path that we know mkdirSync will fail on (file masquerading as dir).
  const root = makeTmp();
  // Create a regular file where the .codex-paired dir would be
  writeFileSync(join(root, '.codex-paired'), 'not a dir');
  // Should NOT throw
  writeBreadcrumb(root, 'slice-1', 'will fail silently');
  cleanup(root);
});

// ── D. formatContext direct ────────────────────────────────────────────────

test('D1: multiple messages render one wrapper + per-message tags', () => {
  const out = formatContext('slice-1', [
    { id: 'msg-a', from: 'orchestrator', text: 'hello', timestamp: 't1' },
    { id: 'msg-b', from: 'orchestrator', text: 'world', timestamp: 't2' },
  ]);
  assert.match(out, /<codex-paired-pending-messages recipient="slice-1">/);
  assert.match(out, /<\/codex-paired-pending-messages>/);
  assert.match(out, /<pending-message id="msg-a"/);
  assert.match(out, /<pending-message id="msg-b"/);
  assert.match(out, /hello/);
  assert.match(out, /world/);
});

test('D2: HTML-special chars in text are escaped', () => {
  const out = formatContext('slice-1', [
    { id: 'msg-a', from: 'orchestrator', text: '<script>alert("x")</script> & more', timestamp: 't' },
  ]);
  assert.ok(!out.includes('<script>'), 'raw <script> must not appear');
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&amp;/);
});

test('D3: HTML-special chars (incl. quotes) in attrs escaped', () => {
  const out = formatContext('slice-1', [
    { id: 'msg-<x>', from: 'or&ch', text: 'safe', timestamp: 't<1>' },
  ]);
  assert.match(out, /id="msg-&lt;x&gt;"/);
  assert.match(out, /from="or&amp;ch"/);
  assert.match(out, /timestamp="t&lt;1&gt;"/);
});

test('D3b: double quotes in attr values are escaped (well-formed XML)', () => {
  const out = formatContext('slice-1', [
    { id: 'msg-"quoted"', from: 'slice-"1"', text: 'body', timestamp: 't"x"' },
  ]);
  assert.match(out, /id="msg-&quot;quoted&quot;"/);
  assert.match(out, /from="slice-&quot;1&quot;"/);
  assert.match(out, /timestamp="t&quot;x&quot;"/);
  // No raw quotes mid-attribute (which would terminate the attr early).
  assert.ok(!out.includes('id="msg-"quoted"'), 'no unescaped quote inside attr');
});

test('D4: closing "marked read" note appears at end', () => {
  const out = formatContext('slice-1', [
    { id: 'msg-a', from: 'orchestrator', text: 'hi', timestamp: 't' },
  ]);
  assert.match(out, /marked read/i);
  // The wrapper closes before the note
  const closeIdx = out.indexOf('</codex-paired-pending-messages>');
  const noteIdx = out.toLowerCase().indexOf('marked read');
  assert.ok(closeIdx > 0 && noteIdx > closeIdx, 'note appears after wrapper close');
});
