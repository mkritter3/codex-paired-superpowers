// v0.10.0 implementer-experts — merge coordinator.
//
// Merges per-implementer branches into the integration worktree in the order
// specified by `memberOrder`. Emits sidecar events for audit.
//
// Halt codes used:
//   merge-integration-not-a-git-repo, merge-integration-dirty,
//   merge-integration-busy, merge-branch-unknown, merge-git-failure,
//   merge-commit-failed, merge-audit-divergence, merge-conflict.

/* eslint-disable no-await-in-loop */

// Note: execFileSync is used here (not exec/execFile) — no shell injection risk.
// All git args are passed as an array, not a shell string.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';

import { appendImplementerEventLocked, readImplementerRun } from '../sidecar.js';
import { wrapAsHaltEnvelope } from '../halt-envelope.js';

// ── default git exec wrapper ─────────────────────────────────────────────────

/**
 * Default git exec wrapper. Returns { stdout, stderr, status }.
 * Uses execFileSync (not exec/shell) — args are an array; no injection risk.
 */
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

// ── input validation (sync, throws before any I/O) ──────────────────────────

function validateInputs({ integrationWorktree, members, memberOrder, specPath, sliceId, implementerRunId }) {
  if (typeof integrationWorktree !== 'string' || integrationWorktree.length === 0) {
    throw new TypeError('mergeImplementerBranches: integrationWorktree must be a non-empty string');
  }
  if (!(members instanceof Map)) {
    throw new TypeError('mergeImplementerBranches: members must be a Map');
  }
  if (!Array.isArray(memberOrder) || memberOrder.length === 0) {
    throw new TypeError('mergeImplementerBranches: memberOrder must be a non-empty array');
  }
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new TypeError('mergeImplementerBranches: specPath must be a non-empty string');
  }
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new TypeError('mergeImplementerBranches: sliceId must be a non-empty string');
  }
  if (typeof implementerRunId !== 'string' || implementerRunId.length === 0) {
    throw new TypeError('mergeImplementerBranches: implementerRunId must be a non-empty string');
  }

  // memberOrder must equal [...members.keys()].sort()
  const sortedKeys = [...members.keys()].sort();
  if (memberOrder.length !== sortedKeys.length ||
      !memberOrder.every((v, i) => v === sortedKeys[i])) {
    throw new TypeError(
      'mergeImplementerBranches: memberOrder must equal [...members.keys()].sort()'
    );
  }

  // Validate each member entry.
  for (const memberId of memberOrder) {
    if (!members.has(memberId)) {
      throw new TypeError(`mergeImplementerBranches: memberOrder contains "${memberId}" which is not in members`);
    }
    const m = members.get(memberId);
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new TypeError(`mergeImplementerBranches: members["${memberId}"] must be a plain object`);
    }
    if (typeof m.branchName !== 'string' || m.branchName.length === 0) {
      throw new TypeError(`mergeImplementerBranches: members["${memberId}"].branchName must be a non-empty string`);
    }
    if (typeof m.runtimeKind !== 'string' || m.runtimeKind.length === 0) {
      throw new TypeError(`mergeImplementerBranches: members["${memberId}"].runtimeKind must be a non-empty string`);
    }
    if (typeof m.worktreeId !== 'string' || m.worktreeId.length === 0) {
      throw new TypeError(`mergeImplementerBranches: members["${memberId}"].worktreeId must be a non-empty string`);
    }
    // Branch name must not start with '-' (would be interpreted as a git flag).
    if (m.branchName.startsWith('-')) {
      throw new TypeError(
        `mergeImplementerBranches: members["${memberId}"].branchName must not start with "-"`
      );
    }
    // Branch name must not contain whitespace or control characters.
    if (/[\s\x00-\x1f\x7f]/.test(m.branchName)) {
      throw new TypeError(
        `mergeImplementerBranches: members["${memberId}"].branchName must not contain whitespace or control characters`
      );
    }
  }
}

// ── lock path helpers ────────────────────────────────────────────────────────

/**
 * Compute a 16-hex slug of the absolute path for use in the lock file name.
 */
function lockSlug(absPath) {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

/**
 * Build the lock file path:
 *   <repoRoot>/.codex-paired/merge-coordinator.<slug>.lock
 * Creates .codex-paired/ dir and the lock target file if needed.
 */
function buildLockPath(repoRoot, integrationWorktree) {
  const slug = lockSlug(integrationWorktree);
  const dir = join(repoRoot, '.codex-paired');
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, `merge-coordinator.${slug}.lock`);
  // proper-lockfile requires the lock target to exist on disk.
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '');
  }
  return lockPath;
}

// ── event helpers ────────────────────────────────────────────────────────────

/**
 * Compute a deterministic sha256 payload hash for an event payload.
 */
function payloadHash(payload) {
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Build the base event fields required by appendImplementerEventLocked.
 */
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

// ── recovery scan parser ─────────────────────────────────────────────────────

/**
 * Parse `git log` output (format: `%H%n%B%n--END-CPS-COMMIT--`) for commits
 * carrying `Member-Id: <member>` trailers. Returns Map<memberId, commitSha>.
 * Subject text is NOT used — only trailer lines after a blank line.
 */
function parseCommitTrailers(gitLogOutput) {
  const result = new Map();
  if (!gitLogOutput || !gitLogOutput.trim()) return result;

  // Split on the end-sentinel (including the trailing newline before it).
  const segments = gitLogOutput.split('\n--END-CPS-COMMIT--\n');
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const lines = trimmed.split('\n');
    if (lines.length < 1) continue;
    const commitSha = lines[0].trim();
    if (!commitSha || commitSha.length < 7) continue;
    const body = lines.slice(1).join('\n');
    // Only trailer-shaped lines (after the last blank line in the body) count.
    // Simple regex over the body is fine per plan spec.
    const match = /^Member-Id:\s*(.+)$/m.exec(body);
    if (match) {
      const memberId = match[1].trim();
      if (memberId && !result.has(memberId)) {
        result.set(memberId, commitSha);
      }
    }
  }
  return result;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Merge implementer branches into the integration worktree.
 *
 * @param {{
 *   integrationWorktree: string,
 *   members: Map<string, {branchName: string, runtimeKind: string, worktreeId: string}>,
 *   memberOrder: string[],
 *   specPath: string,
 *   sliceId: string,
 *   implementerRunId: string,
 *   _deps?: {
 *     appendImplementerEventLocked?: Function,
 *     git?: { exec(args: string[], cwd: string): {stdout:string, stderr:string, status:number} },
 *     lockfile?: { lock(path:string, opts:object): Promise<Function> },
 *   }
 * }} opts
 * @returns {Promise<{
 *   halted: boolean,
 *   halt?: string,
 *   merged: string[],
 *   conflictedMemberId?: string,
 *   conflictedFiles?: string[],
 *   conflictedFilesTotal?: number,
 *   conflictedFilesTruncated?: boolean,
 *   mergedSoFar: number,
 *   integrationHeadSha: string,
 * }>}
 */
export async function mergeImplementerBranches({
  integrationWorktree,
  members,
  memberOrder,
  specPath,
  sliceId,
  implementerRunId,
  _deps = {},
}) {
  // ── 1. Sync validation (throws before returning the Promise) ──────────────
  validateInputs({ integrationWorktree, members, memberOrder, specPath, sliceId, implementerRunId });

  // Resolve DI.
  const git = _deps.git || { exec: defaultGitExec };
  const appendEvent = _deps.appendImplementerEventLocked || appendImplementerEventLocked;
  const lf = _deps.lockfile || lockfile;

  // ── 2. Pre-flight: is the integration worktree a git repo? ────────────────
  {
    const r = git.exec(['rev-parse', '--git-dir'], integrationWorktree);
    if (r.status !== 0) {
      return {
        halted: true,
        halt: 'merge-integration-not-a-git-repo',
        merged: [],
        mergedSoFar: 0,
        integrationHeadSha: '',
      };
    }
  }

  // ── 3. Pre-flight: clean integration worktree ─────────────────────────────
  //
  // Only tracked changes (staged or unstaged) count as dirty.
  // Untracked files (lines starting with '??') are not dirty — the coordinator
  // creates a .codex-paired/ lockfile dir, which is untracked, and that must
  // not cause subsequent calls to fail the pre-flight check.
  {
    const r = git.exec(['status', '--porcelain'], integrationWorktree);
    if (r.status !== 0) {
      return {
        halted: true,
        halt: 'merge-integration-dirty',
        merged: [],
        mergedSoFar: 0,
        integrationHeadSha: '',
      };
    }
    const trackedChanges = (r.stdout || '')
      .split('\n')
      .filter(line => line.length >= 2 && !line.startsWith('??') && !line.startsWith('!!'));
    if (trackedChanges.length > 0) {
      return {
        halted: true,
        halt: 'merge-integration-dirty',
        merged: [],
        mergedSoFar: 0,
        integrationHeadSha: '',
      };
    }
  }

  // ── 4. Get repoRoot for lock path ─────────────────────────────────────────
  const repoRootResult = git.exec(['rev-parse', '--show-toplevel'], integrationWorktree);
  if (repoRootResult.status !== 0) {
    return {
      halted: true,
      halt: 'merge-integration-not-a-git-repo',
      merged: [],
      mergedSoFar: 0,
      integrationHeadSha: '',
    };
  }
  const repoRoot = repoRootResult.stdout.trim();

  // ── 5. Acquire lock (retries: 0 → single-flight, fails immediately) ───────
  const lockPath = buildLockPath(repoRoot, integrationWorktree);
  let releaseLock;
  try {
    releaseLock = await lf.lock(lockPath, { retries: 0 });
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      return {
        halted: true,
        halt: 'merge-integration-busy',
        merged: [],
        mergedSoFar: 0,
        integrationHeadSha: '',
      };
    }
    throw err;
  }

  try {
    return await _doMerge({
      integrationWorktree,
      members,
      memberOrder,
      specPath,
      sliceId,
      implementerRunId,
      git,
      appendEvent,
    });
  } finally {
    try { await releaseLock(); } catch { /* best-effort */ }
  }
}

/**
 * Internal: do the actual git merge work (called inside the lock).
 */
async function _doMerge({
  integrationWorktree,
  members,
  memberOrder,
  specPath,
  sliceId,
  implementerRunId,
  git,
  appendEvent,
}) {
  // Capture pre-merge HEAD.
  const preMergeHeadResult = git.exec(['rev-parse', 'HEAD'], integrationWorktree);
  const preMergeHead = preMergeHeadResult.stdout.trim();

  // Determine the first member (for merge_started event fields).
  const firstMemberId = memberOrder[0];
  const firstMember = members.get(firstMemberId);

  // ── Emit merge_started event (ONCE, before any git work) ─────────────────
  const mergeStartedPayload = {
    member_order: memberOrder,
    integration_head_sha: preMergeHead,
  };
  // If this throws, reject — no git work has happened.
  await appendEvent(specPath, buildEvent({
    eventType: 'merge_started',
    memberId: firstMemberId,
    runtimeKind: firstMember.runtimeKind,
    worktreeId: firstMember.worktreeId,
    implementerRunId,
    sliceId,
    payload: mergeStartedPayload,
  }));

  // ── Per-member merge loop ─────────────────────────────────────────────────
  const merged = [];
  let integrationHeadSha = preMergeHead;

  // Determine the scan base for trailer-based recovery. We use the sidecar's
  // base_sha (the SHA at the start of the entire run) so that recovery works
  // even when we re-run after a crash and preMergeHead is already past the
  // committed merges. Falls back to preMergeHead if base_sha is unavailable.
  const runRecord = readImplementerRun(specPath, sliceId);
  const trailerScanBase = (runRecord && runRecord.base_sha && runRecord.base_sha.length > 0)
    ? runRecord.base_sha
    : preMergeHead;

  for (const memberId of memberOrder) {
    const member = members.get(memberId);
    const { branchName, runtimeKind, worktreeId } = member;

    // a. Resolve branch SHA: ensures the branch exists.
    const branchResolveResult = git.exec(
      ['rev-parse', '--verify', `${branchName}^{commit}`],
      integrationWorktree
    );
    if (branchResolveResult.status !== 0) {
      return {
        halted: true,
        halt: 'merge-branch-unknown',
        merged,
        mergedSoFar: merged.length,
        integrationHeadSha,
      };
    }

    // b. Idempotency check #1 (sidecar): skip if already merged.
    const run = readImplementerRun(specPath, sliceId);
    const alreadyMergedInSidecar = run && Array.isArray(run.events) &&
      run.events.some(
        e => e.event_type === 'merge_resolved' && e.member_id === memberId
      );

    if (alreadyMergedInSidecar) {
      merged.push(memberId);
      const headResult = git.exec(['rev-parse', 'HEAD'], integrationWorktree);
      if (headResult.status === 0) integrationHeadSha = headResult.stdout.trim();
      continue;
    }

    // c. Recovery scan (trailer-based): check for commit with Member-Id trailer
    //    in commits since trailerScanBase but NOT in sidecar events.
    //    Use trailerScanBase (sidecar.base_sha) rather than preMergeHead so
    //    that re-runs after a crash can find commits from the previous (crashed) run.
    const logResult = git.exec(
      ['log', '--format=%H%n%B%n--END-CPS-COMMIT--', `${trailerScanBase}..HEAD`],
      integrationWorktree
    );
    const trailerMap = logResult.status === 0
      ? parseCommitTrailers(logResult.stdout)
      : new Map();

    if (trailerMap.has(memberId)) {
      // Commit exists with correct Member-Id trailer, but no merge_resolved event.
      // Re-append merge_resolved with discovered commit SHA (catch-up).
      const discoveredSha = trailerMap.get(memberId);
      integrationHeadSha = discoveredSha;

      await appendEvent(specPath, buildEvent({
        eventType: 'merge_resolved',
        memberId,
        runtimeKind,
        worktreeId,
        implementerRunId,
        sliceId,
        payload: {
          member_id: memberId,
          branch_name: branchName,
          merge_commit_sha: discoveredSha,
          prior_head_sha: preMergeHead,
        },
      }));
      merged.push(memberId);
      continue;
    }

    // d. Merge: git merge --no-ff --no-commit -- <branchName>
    //    The '--' separator prevents branchName from being interpreted as a flag,
    //    providing defense-in-depth even though validateBranchName rejects leading '-'.
    const priorHeadForMerge = integrationHeadSha;
    const mergeResult = git.exec(
      ['merge', '--no-ff', '--no-commit', '--', branchName],
      integrationWorktree
    );

    // e. Detect conflict: git diff --name-only --diff-filter=U
    const conflictResult = git.exec(
      ['diff', '--name-only', '--diff-filter=U'],
      integrationWorktree
    );
    const conflictedRaw = conflictResult.status === 0
      ? (conflictResult.stdout || '').trim().split('\n').filter(Boolean)
      : [];

    if (conflictedRaw.length > 0) {
      const conflictedFilesTotal = conflictedRaw.length;
      const conflictedFilesTruncated = conflictedFilesTotal > 100;
      const conflictedFiles = conflictedRaw.slice(0, 100);

      // Append merge_conflict event (best-effort — halt is the primary signal).
      try {
        await appendEvent(specPath, buildEvent({
          eventType: 'merge_conflict',
          memberId,
          runtimeKind,
          worktreeId,
          implementerRunId,
          sliceId,
          payload: {
            member_id: memberId,
            branch_name: branchName,
            conflicted_files: conflictedFiles,
            conflicted_files_total: conflictedFilesTotal,
            conflicted_files_truncated: conflictedFilesTruncated,
          },
        }));
      } catch {
        // best-effort
      }

      // Do NOT abort the merge. The conflict state (markers + unmerged index) must
      // be preserved in the integration worktree so that slice 8's merger agent can
      // resolve conflicts in place.
      // See: docs/architecture/2026-05-12-v0.10.0-implementer-experts-design.md:309
      //   "Preserve conflict markers in the integration worktree."

      return {
        halted: true,
        halt: 'merge-conflict',
        merged,
        conflictedMemberId: memberId,
        conflictedFiles,
        conflictedFilesTotal,
        conflictedFilesTruncated,
        mergedSoFar: merged.length,
        integrationHeadSha,
      };
    }

    // Check for non-zero merge exit with no conflict files — generic git failure.
    if (mergeResult.status !== 0) {
      // Abort any in-progress merge state.
      git.exec(['merge', '--abort'], integrationWorktree);
      return {
        halted: true,
        halt: 'merge-git-failure',
        merged,
        mergedSoFar: merged.length,
        integrationHeadSha,
      };
    }

    // f. Clean merge: commit.
    const sliceNum = sliceId.replace(/^slice-/, '');
    const commitMessage = [
      `merge(slice:${sliceNum}): ${memberId}`,
      '',
      `Member-Id: ${memberId}`,
      `Slice-Id: ${sliceId}`,
      `Branch-Name: ${branchName}`,
      `Implementer-Run-Id: ${implementerRunId}`,
    ].join('\n');

    const commitResult = git.exec(
      ['commit', '-m', commitMessage],
      integrationWorktree
    );

    if (commitResult.status !== 0) {
      return {
        halted: true,
        halt: 'merge-commit-failed',
        merged,
        mergedSoFar: merged.length,
        integrationHeadSha,
      };
    }

    // g. Capture commit SHA.
    const headAfterResult = git.exec(['rev-parse', 'HEAD'], integrationWorktree);
    const mergeCommitSha = headAfterResult.stdout.trim();
    integrationHeadSha = mergeCommitSha;

    // h. Append merge_resolved event with one retry on failure.
    const resolvedPayload = {
      member_id: memberId,
      branch_name: branchName,
      merge_commit_sha: mergeCommitSha,
      prior_head_sha: priorHeadForMerge,
    };
    const resolvedEvent = buildEvent({
      eventType: 'merge_resolved',
      memberId,
      runtimeKind,
      worktreeId,
      implementerRunId,
      sliceId,
      payload: resolvedPayload,
    });

    let appendError;
    try {
      await appendEvent(specPath, resolvedEvent);
      appendError = null;
    } catch (err) {
      appendError = err;
    }

    if (appendError) {
      // Retry once with same payload.
      try {
        await appendEvent(specPath, resolvedEvent);
        appendError = null;
      } catch (err) {
        appendError = err;
      }
    }

    if (appendError) {
      return {
        halted: true,
        halt: 'merge-audit-divergence',
        merged,
        mergedSoFar: merged.length,
        integrationHeadSha,
      };
    }

    merged.push(memberId);
  }

  return {
    halted: false,
    merged,
    mergedSoFar: merged.length,
    integrationHeadSha,
  };
}
