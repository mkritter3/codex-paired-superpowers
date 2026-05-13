// v0.10.0 slice-8 — merger-agent.js
//
// Resolves merge conflicts in an integration worktree by dispatching a merger
// implementer, conducting a double-SHIP paired review, and committing on
// unanimous SHIP.
//
// Halt codes used:
//   merger-integration-not-a-git-repo, merger-integration-busy,
//   merger-conflict-state-mismatch, merger-prompt-too-large,
//   merger-dispatch-failed, merger-out-of-scope,
//   merger-unresolved-conflicts, merge-review-dispatch-failed,
//   merge-review-malformed, merge-conflict-double-ship-failed,
//   merger-commit-failed, merger-audit-divergence.

/* eslint-disable no-await-in-loop */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';

import { appendImplementerEventLocked } from '../sidecar.js';

// ── default git exec wrapper ─────────────────────────────────────────────────

function defaultGitExec(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

// ── path safety ───────────────────────────────────────────────────────────────

/**
 * Returns true if the path entry is safe:
 *   - no `..` components
 *   - no leading `/`
 *   - no `\`
 */
function isPathSafe(p) {
  if (typeof p !== 'string') return false;
  if (p.includes('..')) return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  return true;
}

/**
 * Resolve a repo-relative path inside integrationWorktree using realpathSync.
 * Returns the resolved absolute path, or null if it escapes the worktree or
 * realpathSync throws.
 */
function resolveInsideWorktree(integrationWorktree, relPath) {
  const joined = join(integrationWorktree, relPath);
  let real;
  try {
    real = realpathSync(joined);
  } catch {
    return null;
  }
  // The realpath of the worktree itself (so we can compare prefixes properly).
  let wtReal;
  try {
    wtReal = realpathSync(integrationWorktree);
  } catch {
    return null;
  }
  const sep = '/';
  const wtPrefix = wtReal.endsWith(sep) ? wtReal : wtReal + sep;
  const realWithSep = real.endsWith(sep) ? real : real + sep;
  if (!realWithSep.startsWith(wtPrefix)) return null;
  return real;
}

// ── lock path helpers ────────────────────────────────────────────────────────

function lockSlug(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

function buildLockPath(repoRoot, integrationWorktreePath) {
  const slug = lockSlug(integrationWorktreePath);
  const dir = join(repoRoot, '.codex-paired');
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `merger-agent.${slug}.lock`);
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '');
  }
  return lockPath;
}

// ── event helpers ─────────────────────────────────────────────────────────────

function payloadHash(payload) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function buildEvent({ eventType, memberId, runtimeKind, worktreeId, implementerRunId, sliceId, payload }) {
  return {
    event_type: eventType,
    implementer_run_id: implementerRunId,
    slice_id: sliceId,
    member_id: memberId,
    runtime_kind: runtimeKind,
    worktree_id: worktreeId,
    payload_hash: payloadHash(payload),
    payload,
  };
}

// ── conflict marker detection ─────────────────────────────────────────────────

// Anchored multiline regexes for git conflict markers.
const CONFLICT_OPEN_RE = /^<{7}\s/m;
const CONFLICT_SEP_RE = /^={7}\s*$/m;
const CONFLICT_CLOSE_RE = /^>{7}\s/m;

function fileHasConflictMarkers(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    // If file is unreadable, treat as having markers (conservative).
    return true;
  }
  return CONFLICT_OPEN_RE.test(content) || CONFLICT_SEP_RE.test(content) || CONFLICT_CLOSE_RE.test(content);
}

// ── input validation (sync, throws before Promise) ───────────────────────────

function validateInputs({
  integrationWorktree,
  conflictedFiles,
  mergeContext,
  dispatchFn,
  claudeReviewFn,
  codexReviewFn,
  specPath,
  sliceId,
  implementerRunId,
  mergerMemberId,
  mergerRuntimeKind,
  mergerWorktreeId,
  allowlist,
}) {
  if (typeof integrationWorktree !== 'string' || integrationWorktree.length === 0) {
    throw new TypeError('runMergerAgent: integrationWorktree must be a non-empty string');
  }
  if (!Array.isArray(conflictedFiles) || conflictedFiles.length === 0) {
    throw new TypeError('runMergerAgent: conflictedFiles must be a non-empty array');
  }
  if (mergeContext === null || mergeContext === undefined || typeof mergeContext !== 'object' || Array.isArray(mergeContext)) {
    throw new TypeError('runMergerAgent: mergeContext must be a plain object');
  }
  const requiredContextFields = ['planRef', 'baseSha', 'mergeOrder', 'diffstats', 'conflictDiffs', 'mailboxNotes'];
  for (const field of requiredContextFields) {
    if (!(field in mergeContext) || mergeContext[field] === undefined || mergeContext[field] === null) {
      throw new TypeError(`runMergerAgent: mergeContext.${field} is required`);
    }
  }
  if (typeof dispatchFn !== 'function') {
    throw new TypeError('runMergerAgent: dispatchFn must be a function');
  }
  if (typeof claudeReviewFn !== 'function') {
    throw new TypeError('runMergerAgent: claudeReviewFn must be a function');
  }
  if (typeof codexReviewFn !== 'function') {
    throw new TypeError('runMergerAgent: codexReviewFn must be a function');
  }
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new TypeError('runMergerAgent: specPath must be a non-empty string');
  }
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new TypeError('runMergerAgent: sliceId must be a non-empty string');
  }
  if (typeof implementerRunId !== 'string' || implementerRunId.length === 0) {
    throw new TypeError('runMergerAgent: implementerRunId must be a non-empty string');
  }
  if (typeof mergerMemberId !== 'string' || mergerMemberId.length === 0) {
    throw new TypeError('runMergerAgent: mergerMemberId must be a non-empty string');
  }
  if (typeof mergerRuntimeKind !== 'string' || mergerRuntimeKind.length === 0) {
    throw new TypeError('runMergerAgent: mergerRuntimeKind must be a non-empty string');
  }
  if (typeof mergerWorktreeId !== 'string' || mergerWorktreeId.length === 0) {
    throw new TypeError('runMergerAgent: mergerWorktreeId must be a non-empty string');
  }

  // Path safety on conflictedFiles
  for (const f of conflictedFiles) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new TypeError('runMergerAgent: conflictedFiles must contain non-empty strings');
    }
    if (!isPathSafe(f)) {
      throw new TypeError(`runMergerAgent: conflictedFiles entry "${f}" is unsafe (contains .., leading /, or \\)`);
    }
  }

  // Symlink / containment check on conflictedFiles — synchronous, throws before Promise.
  // Each entry must resolve (via realpathSync) to a path inside integrationWorktree.
  // Only runs when integrationWorktree itself can be resolved (non-existent worktrees
  // are caught later by the git rev-parse --git-dir pre-flight check).
  {
    let wtReal;
    try {
      wtReal = realpathSync(integrationWorktree);
    } catch {
      // integrationWorktree doesn't exist yet — skip symlink check here;
      // the async phase will halt with merger-integration-not-a-git-repo.
      wtReal = null;
    }
    if (wtReal !== null) {
      const sep = '/';
      const wtPrefix = wtReal.endsWith(sep) ? wtReal : wtReal + sep;
      for (const f of conflictedFiles) {
        const joined = join(integrationWorktree, f);
        let real;
        try {
          real = realpathSync(joined);
        } catch {
          // File doesn't exist or dangling symlink — cannot escape the worktree
          // through containment. Skip; the async git conflict-state-mismatch
          // check will catch genuinely absent files.
          continue;
        }
        const realWithSep = real.endsWith(sep) ? real : real + sep;
        if (!realWithSep.startsWith(wtPrefix)) {
          throw new TypeError(
            `runMergerAgent: conflictedFiles[${conflictedFiles.indexOf(f)}] "${f}" escapes integrationWorktree`
          );
        }
      }
    }
  }

  // Path safety on allowlist
  if (allowlist !== undefined && allowlist !== null) {
    if (!Array.isArray(allowlist)) {
      throw new TypeError('runMergerAgent: allowlist must be an array when provided');
    }
    for (const f of allowlist) {
      if (typeof f !== 'string' || f.length === 0) {
        throw new TypeError('runMergerAgent: allowlist must contain non-empty strings');
      }
      if (!isPathSafe(f)) {
        throw new TypeError(`runMergerAgent: allowlist entry "${f}" is unsafe (contains .., leading /, or \\)`);
      }
    }
  }
}

// ── prompt composition ────────────────────────────────────────────────────────

/**
 * Build the merger prompt. Each conflictDiff is capped at 32KB.
 * Returns { prompt, promptBytes }.
 */
function composePrompt({ mergeContext, conflictedFiles, allowlist, promptByteCap }) {
  const { planRef, baseSha, mergeOrder, diffstats, conflictDiffs, mailboxNotes } = mergeContext;

  const PER_FILE_CAP = 32 * 1024; // 32KB

  const parts = [];
  parts.push(`# Merger Agent: Conflict Resolution\n`);
  parts.push(`Plan reference: ${planRef}\n`);
  parts.push(`Base SHA: ${baseSha}\n`);
  parts.push(`Merge order: ${JSON.stringify(mergeOrder)}\n`);
  parts.push(`\n## Diffstats\n${typeof diffstats === 'string' ? diffstats : JSON.stringify(diffstats, null, 2)}\n`);
  parts.push(`\n## Conflicted files\n${conflictedFiles.map(f => `  - ${f}`).join('\n')}\n`);

  if (allowlist && allowlist.length > 0) {
    parts.push(`\n## Allowlisted files (you may also edit these)\n${allowlist.map(f => `  - ${f}`).join('\n')}\n`);
  }

  parts.push(`\n**Do not edit any file other than the conflicted files and allowlisted files listed above.** Do not run commands outside the worktree.\n`);
  parts.push(`\n## Per-file conflict diffs\n`);

  // Add per-file diffs, capped at PER_FILE_CAP each
  if (Array.isArray(conflictDiffs)) {
    for (const diff of conflictDiffs) {
      const diffStr = typeof diff === 'string' ? diff : JSON.stringify(diff);
      const capped = diffStr.length > PER_FILE_CAP
        ? diffStr.slice(0, PER_FILE_CAP) + '\n[... truncated at 32KB ...]\n'
        : diffStr;
      parts.push(capped + '\n');
    }
  } else if (typeof conflictDiffs === 'string') {
    const capped = conflictDiffs.length > PER_FILE_CAP
      ? conflictDiffs.slice(0, PER_FILE_CAP) + '\n[... truncated at 32KB ...]\n'
      : conflictDiffs;
    parts.push(capped + '\n');
  }

  if (mailboxNotes) {
    parts.push(`\n## Mailbox notes\n${typeof mailboxNotes === 'string' ? mailboxNotes : JSON.stringify(mailboxNotes, null, 2)}\n`);
  }

  const prompt = parts.join('');
  const promptBytes = Buffer.byteLength(prompt, 'utf8');

  return { prompt, promptBytes };
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Run the merger agent to resolve merge conflicts in the integration worktree.
 *
 * @param {{
 *   integrationWorktree: string,
 *   conflictedFiles: string[],
 *   mergeContext: {planRef, baseSha, mergeOrder, diffstats, conflictDiffs, mailboxNotes},
 *   dispatchFn: async function,
 *   claudeReviewFn: async function,
 *   codexReviewFn: async function,
 *   specPath: string,
 *   sliceId: string,
 *   implementerRunId: string,
 *   mergerMemberId: string,
 *   mergerRuntimeKind: string,
 *   mergerWorktreeId: string,
 *   allowlist?: string[],
 *   promptByteCap?: number,
 *   _deps?: object,
 * }} opts
 *
 * @returns {Promise<{
 *   halted: boolean,
 *   halt?: string,
 *   mergerCommitSha?: string,
 *   claudeVerdict?: string,
 *   codexVerdict?: string,
 *   outOfScopeFiles?: string[],
 * }>}
 */
export function runMergerAgent({
  integrationWorktree,
  conflictedFiles,
  mergeContext,
  dispatchFn,
  claudeReviewFn,
  codexReviewFn,
  specPath,
  sliceId,
  implementerRunId,
  mergerMemberId,
  mergerRuntimeKind,
  mergerWorktreeId,
  allowlist = [],
  promptByteCap = 200_000,
  _deps = {},
}) {
  // ── 1. Sync input validation (throws before returning Promise) ──────────────
  // This runs SYNCHRONOUSLY and throws TypeError for invalid inputs.
  // No Promise is created until validation passes.
  validateInputs({
    integrationWorktree,
    conflictedFiles,
    mergeContext,
    dispatchFn,
    claudeReviewFn,
    codexReviewFn,
    specPath,
    sliceId,
    implementerRunId,
    mergerMemberId,
    mergerRuntimeKind,
    mergerWorktreeId,
    allowlist,
  });

  // Validation passed — delegate to the async implementation.
  return runMergerAgentAsync({
    integrationWorktree,
    conflictedFiles,
    mergeContext,
    dispatchFn,
    claudeReviewFn,
    codexReviewFn,
    specPath,
    sliceId,
    implementerRunId,
    mergerMemberId,
    mergerRuntimeKind,
    mergerWorktreeId,
    allowlist,
    promptByteCap,
    _deps,
  });
}

async function runMergerAgentAsync({
  integrationWorktree,
  conflictedFiles,
  mergeContext,
  dispatchFn,
  claudeReviewFn,
  codexReviewFn,
  specPath,
  sliceId,
  implementerRunId,
  mergerMemberId,
  mergerRuntimeKind,
  mergerWorktreeId,
  allowlist,
  promptByteCap,
  _deps,
}) {
  // Resolve DI.
  const git = _deps.git || { exec: defaultGitExec };
  const appendEvent = _deps.appendImplementerEventLocked || appendImplementerEventLocked;
  const lf = _deps.lockfile || lockfile;

  // Symlink resolution check on allowlist entries — done after validation but
  // before any async work. Paths must resolve inside integrationWorktree.
  for (const f of allowlist) {
    const resolved = resolveInsideWorktree(integrationWorktree, f);
    if (resolved === null) {
      // Path escapes the worktree (symlink or non-existent) — treat as
      // conflict-state-mismatch (closest registered safe halt code).
      return {
        halted: true,
        halt: 'merger-conflict-state-mismatch',
        diagnostic: `allowlist entry "${f}" resolves outside integrationWorktree or cannot be resolved`,
      };
    }
  }

  // ── 2. Pre-flight: is the integration worktree a git repo? ──────────────────
  {
    const r = git.exec(['rev-parse', '--git-dir'], integrationWorktree);
    if (r.status !== 0) {
      return { halted: true, halt: 'merger-integration-not-a-git-repo' };
    }
  }

  // ── 3. Get repoRoot for lock path ────────────────────────────────────────────
  const repoRootResult = git.exec(['rev-parse', '--show-toplevel'], integrationWorktree);
  if (repoRootResult.status !== 0) {
    return { halted: true, halt: 'merger-integration-not-a-git-repo' };
  }
  const repoRoot = repoRootResult.stdout.trim();

  // ── 4. Acquire lock (retries: 0 — single-flight) ────────────────────────────
  const lockPath = buildLockPath(repoRoot, integrationWorktree);
  let releaseLock;
  try {
    releaseLock = await lf.lock(lockPath, { retries: 0 });
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      return { halted: true, halt: 'merger-integration-busy' };
    }
    throw err;
  }

  try {
    return await _doMerge({
      integrationWorktree,
      conflictedFiles,
      mergeContext,
      dispatchFn,
      claudeReviewFn,
      codexReviewFn,
      specPath,
      sliceId,
      implementerRunId,
      mergerMemberId,
      mergerRuntimeKind,
      mergerWorktreeId,
      allowlist,
      promptByteCap,
      git,
      appendEvent,
    });
  } finally {
    try { await releaseLock(); } catch { /* best-effort */ }
  }
}

/**
 * Internal: do the actual merger work (called inside the lock).
 */
async function _doMerge({
  integrationWorktree,
  conflictedFiles,
  mergeContext,
  dispatchFn,
  claudeReviewFn,
  codexReviewFn,
  specPath,
  sliceId,
  implementerRunId,
  mergerMemberId,
  mergerRuntimeKind,
  mergerWorktreeId,
  allowlist,
  promptByteCap,
  git,
  appendEvent,
}) {
  // ── 5. Conflict state check ──────────────────────────────────────────────────
  {
    const r = git.exec(['diff', '--name-only', '--diff-filter=U'], integrationWorktree);
    if (r.status !== 0) {
      return { halted: true, halt: 'merger-conflict-state-mismatch', diagnostic: r.stderr };
    }
    const actualConflicted = new Set(
      (r.stdout || '').trim().split('\n').filter(Boolean)
    );
    const expectedConflicted = new Set(conflictedFiles);

    // Compare sets: must be equal
    if (actualConflicted.size !== expectedConflicted.size) {
      return {
        halted: true,
        halt: 'merger-conflict-state-mismatch',
        diagnostic: `expected ${expectedConflicted.size} conflicted files, got ${actualConflicted.size}`,
        expectedConflictedFiles: [...expectedConflicted].sort(),
        actualConflictedFiles: [...actualConflicted].sort(),
      };
    }
    for (const f of expectedConflicted) {
      if (!actualConflicted.has(f)) {
        return {
          halted: true,
          halt: 'merger-conflict-state-mismatch',
          diagnostic: `expected file "${f}" to be conflicted but it is not`,
          expectedConflictedFiles: [...expectedConflicted].sort(),
          actualConflictedFiles: [...actualConflicted].sort(),
        };
      }
    }
  }

  // ── 6. Compose prompt ────────────────────────────────────────────────────────
  const { prompt, promptBytes } = composePrompt({
    mergeContext,
    conflictedFiles,
    allowlist,
    promptByteCap,
  });

  if (promptBytes > promptByteCap) {
    return {
      halted: true,
      halt: 'merger-prompt-too-large',
      promptBytes,
      promptByteCap,
      diagnostic: `Prompt is ${promptBytes} bytes, exceeds cap of ${promptByteCap} bytes`,
    };
  }

  // ── 7. Emit merger_started ───────────────────────────────────────────────────
  const mergerStartedPayload = {
    merger_member_id: mergerMemberId,
    conflicted_files: conflictedFiles,
    allowlist,
    prompt_bytes: promptBytes,
  };
  // If this throws, reject without dispatching.
  await appendEvent(specPath, buildEvent({
    eventType: 'merger_started',
    memberId: mergerMemberId,
    runtimeKind: mergerRuntimeKind,
    worktreeId: mergerWorktreeId,
    implementerRunId,
    sliceId,
    payload: mergerStartedPayload,
  }));

  // ── 8. Dispatch merger ───────────────────────────────────────────────────────
  const mergerAbortController = new AbortController();
  let dispatchResult;
  try {
    dispatchResult = await dispatchFn({
      sliceId,
      implementerRunId,
      memberId: mergerMemberId,
      runtimeKind: mergerRuntimeKind,
      worktreePath: integrationWorktree,
      branchName: 'merger-resolve',
      baseSha: mergeContext.baseSha,
      claimedFiles: [...conflictedFiles, ...allowlist],
      prompt,
      abortSignal: mergerAbortController.signal,
      env: {},
    });
  } catch (err) {
    // Emit merger_completed with outcome: 'failed' before returning the halt.
    // If this append throws, propagate — no retry on the dispatch-failure path.
    await appendEvent(specPath, buildEvent({
      eventType: 'merger_completed',
      memberId: mergerMemberId,
      runtimeKind: mergerRuntimeKind,
      worktreeId: mergerWorktreeId,
      implementerRunId,
      sliceId,
      payload: {
        merger_member_id: mergerMemberId,
        outcome: 'failed',
        diagnostic: err && err.message ? err.message : String(err),
      },
    }));
    return {
      halted: true,
      halt: 'merger-dispatch-failed',
      diagnostic: err && err.message ? err.message : String(err),
    };
  }

  if (!dispatchResult || dispatchResult.outcome !== 'completed') {
    // Emit merger_completed with the actual outcome before returning the halt.
    // If this append throws, propagate — no retry on the dispatch-failure path.
    const failOutcome = (dispatchResult && dispatchResult.outcome) || 'failed';
    await appendEvent(specPath, buildEvent({
      eventType: 'merger_completed',
      memberId: mergerMemberId,
      runtimeKind: mergerRuntimeKind,
      worktreeId: mergerWorktreeId,
      implementerRunId,
      sliceId,
      payload: {
        merger_member_id: mergerMemberId,
        outcome: failOutcome,
        diagnostic: `dispatchFn returned outcome "${failOutcome}"`,
      },
    }));
    return {
      halted: true,
      halt: 'merger-dispatch-failed',
      diagnostic: `dispatchFn returned outcome "${dispatchResult && dispatchResult.outcome}"`,
      dispatchResult,
    };
  }

  // ── 9. Post-merger validation ────────────────────────────────────────────────

  // a. Collect all modified paths (tracked + untracked, excluding internal dirs).
  // We include untracked paths (lines starting with '??') so that newly-created
  // out-of-scope files are caught. We exclude the .codex-paired/ directory that
  // we create for locking — it is an implementation detail, not a merger edit.
  // We also exclude '!!' (ignored files).
  const statusResult = git.exec(['status', '--porcelain'], integrationWorktree);
  const modifiedPaths = (statusResult.stdout || '')
    .split('\n')
    .filter(Boolean)
    .filter(line => !line.startsWith('!!'))
    .map(line => line.slice(3).trim())
    // Strip trailing '/' from directory entries (e.g. '.codex-paired/')
    .map(p => p.endsWith('/') ? p.slice(0, -1) : p)
    .filter(Boolean)
    // Exclude the .codex-paired directory (internal lock mechanism)
    .filter(p => p !== '.codex-paired' && !p.startsWith('.codex-paired/'));

  // b. Out-of-scope check FIRST
  const allowedSet = new Set([...conflictedFiles, ...allowlist]);
  const outOfScopeFiles = modifiedPaths.filter(p => !allowedSet.has(p));
  if (outOfScopeFiles.length > 0) {
    // Emit merger_completed with outcome: 'out-of-scope' (best-effort)
    try {
      await appendEvent(specPath, buildEvent({
        eventType: 'merger_completed',
        memberId: mergerMemberId,
        runtimeKind: mergerRuntimeKind,
        worktreeId: mergerWorktreeId,
        implementerRunId,
        sliceId,
        payload: {
          merger_member_id: mergerMemberId,
          outcome: 'out-of-scope',
          out_of_scope_files: outOfScopeFiles,
        },
      }));
    } catch { /* best-effort */ }

    return {
      halted: true,
      halt: 'merger-out-of-scope',
      outOfScopeFiles,
    };
  }

  // c. Marker-string check (pre-stage) — for each conflicted file
  for (const f of conflictedFiles) {
    const filePath = join(integrationWorktree, f);
    if (fileHasConflictMarkers(filePath)) {
      return {
        halted: true,
        halt: 'merger-unresolved-conflicts',
        diagnostic: `Conflict markers found in file: ${f}`,
        fileWithMarkers: f,
      };
    }
  }

  // d. Stage: git add -- <touched conflictedFiles + allowlist>
  const filesToStage = [...conflictedFiles, ...allowlist];
  const stageResult = git.exec(['add', '--', ...filesToStage], integrationWorktree);
  if (stageResult.status !== 0) {
    return {
      halted: true,
      halt: 'merger-unresolved-conflicts',
      diagnostic: `git add failed: ${stageResult.stderr}`,
    };
  }

  // e. Post-stage U-check: git diff --name-only --diff-filter=U must be empty
  {
    const postStageCheck = git.exec(['diff', '--name-only', '--diff-filter=U'], integrationWorktree);
    const remaining = (postStageCheck.stdout || '').trim().split('\n').filter(Boolean);
    if (remaining.length > 0) {
      return {
        halted: true,
        halt: 'merger-unresolved-conflicts',
        diagnostic: `Unmerged paths remain after git add: ${remaining.join(', ')}`,
        remainingConflicts: remaining,
      };
    }
  }

  // ── 10. Emit merger_completed (pre-commit, outcome: 'completed') ─────────────
  const touchedFiles = modifiedPaths.slice().sort();
  await appendEvent(specPath, buildEvent({
    eventType: 'merger_completed',
    memberId: mergerMemberId,
    runtimeKind: mergerRuntimeKind,
    worktreeId: mergerWorktreeId,
    implementerRunId,
    sliceId,
    payload: {
      merger_member_id: mergerMemberId,
      outcome: 'completed',
      files_touched: touchedFiles,
    },
  }));

  // ── 11. Paired review ────────────────────────────────────────────────────────

  // Get the staged diff for reviewers
  const stagedDiffResult = git.exec(['diff', '--cached'], integrationWorktree);
  const mergerDiff = stagedDiffResult.stdout || '';

  const [claudeSettled, codexSettled] = await Promise.allSettled([
    claudeReviewFn({ integrationWorktree, mergerDiff, mergeContext }),
    codexReviewFn({ integrationWorktree, mergerDiff, mergeContext }),
  ]);

  // Check for rejections
  if (claudeSettled.status === 'rejected' || codexSettled.status === 'rejected') {
    const failedReviewers = [];
    if (claudeSettled.status === 'rejected') failedReviewers.push('claude');
    if (codexSettled.status === 'rejected') failedReviewers.push('codex');
    return {
      halted: true,
      halt: 'merge-review-dispatch-failed',
      failedReviewers,
      claudeError: claudeSettled.status === 'rejected'
        ? (claudeSettled.reason && claudeSettled.reason.message) || String(claudeSettled.reason)
        : undefined,
      codexError: codexSettled.status === 'rejected'
        ? (codexSettled.reason && codexSettled.reason.message) || String(codexSettled.reason)
        : undefined,
    };
  }

  // Parse verdicts
  const claudeRaw = claudeSettled.value;
  const codexRaw = codexSettled.value;

  function parseVerdict(raw, side) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: `${side} reviewer returned non-object` };
    }
    if (raw.verdict !== 'SHIP' && raw.verdict !== 'REVISE') {
      return { ok: false, reason: `${side} verdict must be exactly "SHIP" or "REVISE", got "${raw.verdict}"` };
    }
    if (typeof raw.rationale !== 'string' || raw.rationale.length === 0) {
      return { ok: false, reason: `${side} rationale must be a non-empty string` };
    }
    return { ok: true, verdict: raw.verdict, rationale: raw.rationale };
  }

  const claudeParsed = parseVerdict(claudeRaw, 'claude');
  const codexParsed = parseVerdict(codexRaw, 'codex');

  if (!claudeParsed.ok || !codexParsed.ok) {
    return {
      halted: true,
      halt: 'merge-review-malformed',
      claudeError: !claudeParsed.ok ? claudeParsed.reason : undefined,
      codexError: !codexParsed.ok ? codexParsed.reason : undefined,
    };
  }

  // Append merge_review_claude event
  await appendEvent(specPath, buildEvent({
    eventType: 'merge_review_claude',
    memberId: mergerMemberId,
    runtimeKind: mergerRuntimeKind,
    worktreeId: mergerWorktreeId,
    implementerRunId,
    sliceId,
    payload: {
      verdict: claudeParsed.verdict,
      rationale: claudeParsed.rationale,
      member_id: 'claude',
    },
  }));

  // Append merge_review_codex event
  await appendEvent(specPath, buildEvent({
    eventType: 'merge_review_codex',
    memberId: mergerMemberId,
    runtimeKind: mergerRuntimeKind,
    worktreeId: mergerWorktreeId,
    implementerRunId,
    sliceId,
    payload: {
      verdict: codexParsed.verdict,
      rationale: codexParsed.rationale,
      member_id: 'codex',
    },
  }));

  // ── 12. Both SHIP required ───────────────────────────────────────────────────
  if (claudeParsed.verdict !== 'SHIP' || codexParsed.verdict !== 'SHIP') {
    return {
      halted: true,
      halt: 'merge-conflict-double-ship-failed',
      claudeVerdict: claudeParsed.verdict,
      codexVerdict: codexParsed.verdict,
      claudeRationale: claudeParsed.rationale,
      codexRationale: codexParsed.rationale,
    };
  }

  // ── 13. Commit on double-SHIP ────────────────────────────────────────────────
  const sliceNum = sliceId.replace(/^slice-/, '');
  const conflictsSummary = conflictedFiles.join(', ').slice(0, 60);
  const commitMessage = [
    `merge-resolution(slice:${sliceNum}): ${conflictsSummary}`,
    '',
    `Merger-Member-Id: ${mergerMemberId}`,
    `Slice-Id: ${sliceId}`,
    `Implementer-Run-Id: ${implementerRunId}`,
    `Claude-Review: SHIP`,
    `Codex-Review: SHIP`,
  ].join('\n');

  const commitResult = git.exec(['commit', '-m', commitMessage], integrationWorktree);
  if (commitResult.status !== 0) {
    return {
      halted: true,
      halt: 'merger-commit-failed',
      diagnostic: `git commit failed: ${commitResult.stderr}`,
    };
  }

  // Capture commit SHA
  const headResult = git.exec(['rev-parse', 'HEAD'], integrationWorktree);
  const mergerCommitSha = headResult.stdout.trim();

  // ── 14. Post-commit audit finalize ──────────────────────────────────────────
  const auditPayload = {
    merger_member_id: mergerMemberId,
    outcome: 'committed',
    merger_commit_sha: mergerCommitSha,
    claude_verdict: 'SHIP',
    codex_verdict: 'SHIP',
    files_touched: touchedFiles,
  };
  const auditEvent = buildEvent({
    eventType: 'merger_completed',
    memberId: mergerMemberId,
    runtimeKind: mergerRuntimeKind,
    worktreeId: mergerWorktreeId,
    implementerRunId,
    sliceId,
    payload: auditPayload,
  });

  let auditError;
  try {
    await appendEvent(specPath, auditEvent);
    auditError = null;
  } catch (err) {
    auditError = err;
  }

  if (auditError) {
    // Retry once with same payload
    try {
      await appendEvent(specPath, auditEvent);
      auditError = null;
    } catch (err) {
      auditError = err;
    }
  }

  if (auditError) {
    return {
      halted: true,
      halt: 'merger-audit-divergence',
      mergerCommitSha,
      diagnostic: `Post-commit sidecar audit failed after retry: ${auditError.message || auditError}`,
    };
  }

  return {
    halted: false,
    mergerCommitSha,
    claudeVerdict: 'SHIP',
    codexVerdict: 'SHIP',
  };
}
