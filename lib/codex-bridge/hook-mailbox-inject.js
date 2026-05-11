// v0.7.3.1 PostToolUse hook injection logic. Reads hook stdin, identifies the
// slice actor from cwd, reads the actor's unread mailbox, emits a
// `hookSpecificOutput.additionalContext` JSON payload on stdout, then marks the
// delivered messages as read AFTER the stdout flush completes.
//
// Always exits with code 0 on logic failures so Claude Code does not wrap a
// non-zero status as `hook_blocking_error` / `hook_non_blocking_error` and
// inject it into the subagent context. Infrastructure errors (corruption, lock
// contention) are written to <repoRoot>/.codex-paired/diagnostics/hook-failures.jsonl
// as best-effort breadcrumbs. The orchestrator's Phase B.6.5 polling remains
// the authoritative halt path.
//
// Order of operations: read → emit additionalContext → AWAIT stdout flush →
// mark read. The flush is callback-based so mark-read only fires after Claude
// Code has the bytes.
//
// `mainWithDeps(stdinJson, deps)` is the dependency-injection seam used by unit
// tests. Production wrapper `main(stdinJson)` delegates with empty overrides.

import { readUnreadMessages, markManyAsRead } from './mailbox.js';
import { realpathSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const WORKTREE_SEGMENT = '.git-worktrees';
const SLICE_RX = /^slice-\d+$/;

function canonicalizePath(p) {
  try { return realpathSync.native(p); }
  catch { return p; }
}

export function inferActorAndRepoRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  if (!isAbsolute(cwd)) return null;
  const canonical = canonicalizePath(cwd);
  if (typeof canonical !== 'string' || canonical.length === 0) return null;
  const segments = canonical.split('/');
  // Right-to-left scan: inner-most valid `.git-worktrees/slice-N` wins.
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i] !== WORKTREE_SEGMENT) continue;
    const sliceCandidate = segments[i + 1];
    if (!SLICE_RX.test(sliceCandidate)) continue;
    const candidateRoot = segments.slice(0, i).join('/');
    if (!candidateRoot) continue;
    if (!existsSync(join(candidateRoot, '.codex-paired'))) continue;
    return { actor: sliceCandidate, repoRoot: candidateRoot };
  }
  return null;
}

export function writeBreadcrumb(repoRoot, sliceId, errMsg) {
  try {
    const dir = join(repoRoot, '.codex-paired', 'diagnostics');
    mkdirSync(dir, { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      slice: sliceId,
      error: errMsg,
    }) + '\n';
    appendFileSync(join(dir, 'hook-failures.jsonl'), entry);
  } catch {
    // Best-effort: diagnostic breadcrumb must not crash the hook.
  }
}

export function flushStdout(payload) {
  return new Promise((resolve) => {
    process.stdout.write(payload, () => resolve());
  });
}

export function formatContext(recipient, msgs) {
  // Escape `"` too so attribute values stay well-formed even for pathological
  // ids/from/timestamps that contain a double quote.
  const esc = (t) => String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const tags = msgs.map(m =>
    `  <pending-message id="${esc(m.id)}" from="${esc(m.from)}" timestamp="${esc(m.timestamp)}">\n` +
    `  ${esc(m.text)}\n` +
    `  </pending-message>`
  ).join('\n');
  return `<codex-paired-pending-messages recipient="${esc(recipient)}">\n${tags}\n</codex-paired-pending-messages>\n\n` +
         `(Messages above were just delivered to your mailbox. They have been marked read.)`;
}

const realDeps = { readUnreadMessages, markManyAsRead, writeOutput: flushStdout, writeBreadcrumb };

function safeBreadcrumb(bc, root, slice, msg) {
  try { bc(root, slice, msg); } catch { /* best-effort */ }
}

export async function mainWithDeps(stdinJson, deps = {}) {
  const d = { ...realDeps, ...deps };

  let input;
  try { input = JSON.parse(stdinJson); } catch { return { exit: 0 }; }
  if (!input || typeof input !== 'object') return { exit: 0 };
  if (!input.agent_id) return { exit: 0 };

  const ident = inferActorAndRepoRoot(input.cwd);
  if (!ident) return { exit: 0 };
  const { actor, repoRoot } = ident;

  let unread;
  try {
    unread = await d.readUnreadMessages(repoRoot, actor);
  } catch (err) {
    safeBreadcrumb(d.writeBreadcrumb, repoRoot, actor, `read failed: ${err.code || err.message}`);
    return { exit: 0 };
  }
  if (!Array.isArray(unread) || unread.length === 0) return { exit: 0 };

  const context = formatContext(actor, unread);
  const output = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } };
  await d.writeOutput(JSON.stringify(output));

  try {
    await d.markManyAsRead(repoRoot, actor, unread.map(m => m.id));
  } catch (err) {
    safeBreadcrumb(d.writeBreadcrumb, repoRoot, actor, `mark-read failed: ${err.code || err.message}`);
    // Acceptable: messages stay unread → duplicate-delivered next fire.
  }
  return { exit: 0 };
}

export async function main(stdinJson) {
  return await mainWithDeps(stdinJson, {});
}

// CLI entry-point: when invoked as `node hook-mailbox-inject.js` (from the
// bash wrapper at hooks/mailbox-inject.sh), read stdin and call main(). On any
// throw, still exit 0 per spec §5.4 — non-zero exits would inject as
// hook_*_error attachments into the subagent context.
//
// The argv[1]-vs-import.meta.url comparison must canonicalize via realpath:
// on macOS, plugin install paths often live under `/var/folders/...` (a
// symlink to `/private/var/folders/...`). `process.argv[1]` is whatever
// path the shell handed Node (often symlinked); `import.meta.url` always
// reflects the canonical realpath. Without normalization the equality check
// silently fails and the CLI entry-point never fires, producing the
// pathological "hook exits 0, emits nothing" symptom in marketplace installs.
import { fileURLToPath } from 'node:url';
const __isCliEntry = (() => {
  if (!process.argv[1]) return false;
  const moduleUrl = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === moduleUrl;
  } catch {
    return process.argv[1] === moduleUrl;
  }
})();
if (__isCliEntry) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', async () => {
    try { await main(stdin); } catch { /* swallow per §5.4 */ }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
