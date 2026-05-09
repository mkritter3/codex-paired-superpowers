/**
 * worktree-integrate.js
 *
 * v0.7.0 ordered cherry-pick integration with patch-id resume detection.
 * See spec §12 ("Patch-ID Resume And Integration Recovery") and plan slice 6.
 *
 * Public API:
 *
 *   integrate({repoRoot, integrationBranch, slices: [{sliceId, branchName, sliceStartSha}]})
 *     -> {ok:true, head_sha, commit_count, resumed_slices:[sliceId, ...]}
 *      | {ok:false, halt:{reason, detail}}
 *
 * Halt reasons:
 *   - worktree-integration-empty   — slice's source range is empty (broken
 *                                    upstream invariant; defensive halt).
 *   - worktree-merge-conflict      — `git cherry-pick` failed; we abort and
 *                                    return conflicting paths in detail.
 *   - worktree-resume-ambiguous    — partial / order-broken patch-id match on
 *                                    the integration branch.
 *
 * Algorithm (per spec §12):
 *
 *   For each slice in input order:
 *     1. Enumerate source commits via:
 *          git log --reverse --format=... <sliceStartSha>..<branchName>
 *        Build [{sha, subject, patch_id}].
 *
 *     2. Empty range → halt `worktree-integration-empty`.
 *
 *     3. Resume detection: scan integration branch backward from HEAD, up to
 *        100 commits OR until sliceStartSha is encountered (whichever first).
 *        - Skip merge commits (parent count > 1) — they cannot match the
 *          patch-id of a slice commit.
 *        - For each non-merge integration commit, compute (patch_id, subject).
 *        - The slice is "fully resumed" iff the last N non-merge entries in
 *          the scan window (chronological order, N = source-commit count)
 *          equal the source (patch_id, subject) tuples in order.
 *        - 0 of source patch-ids appear anywhere in the scan window → cherry-pick.
 *        - All present in correct trailing order → resumed; skip.
 *        - Otherwise (partial / order broken / present-but-not-trailing)
 *          → halt `worktree-resume-ambiguous`.
 *
 *     4. Cherry-pick (if not resumed):
 *        For each source commit in order, run `git cherry-pick <sha>` on the
 *        integration branch (caller must have integration branch checked out
 *        in `repoRoot`, which is the integration worktree). On nonzero exit:
 *          - Read `git diff --name-only --diff-filter=U` for conflicting paths.
 *          - Run `git cherry-pick --abort`.
 *          - Halt `worktree-merge-conflict`.
 *
 * Style: zero npm deps. ES modules. All git shell-outs go through
 * `execFileSync` with argv arrays (no shell, no injection). For `patch-id`,
 * we run `git diff` separately and pipe its stdout into a `git patch-id
 * --stable` child via Node `spawnSync` with `input`.
 */

import { execFileSync, spawnSync } from 'node:child_process';

// ── helpers ───────────────────────────────────────────────────────────────────

const SCAN_LIMIT = 100;

function ok(data) {
  return { ok: true, ...data };
}

function halt(reason, detail) {
  return { ok: false, halt: { reason, detail } };
}

/**
 * Run git with argv array. Returns `{ok:true, stdout}` or `{ok:false, stderr}`.
 * Never throws on nonzero exit.
 */
function runGit(repoRoot, args) {
  try {
    const stdout = execFileSync('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString())
      || (e.stdout && e.stdout.toString())
      || e.message;
    return { ok: false, stderr, status: e.status };
  }
}

/**
 * Compute a stable patch-id for a single commit. Pipes `git diff <sha>~..<sha>`
 * into `git patch-id --stable` via Node, captures the first whitespace token
 * of patch-id's stdout.
 *
 * For a root commit (no parent), `git diff <sha>~..<sha>` fails. Root commits
 * cannot meaningfully be cherry-picked across branches the way mid-history
 * commits are; in practice slice branches are always rooted at sliceStartSha
 * which itself has parents, so this case shouldn't arise. We surface it as
 * a halt (`patch-id-failed`) under reconciler-style detail if it does.
 */
function patchIdFor(repoRoot, sha) {
  // git diff <sha>~..<sha>
  const diff = spawnSync('git', ['-C', repoRoot, 'diff', `${sha}~..${sha}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (diff.status !== 0) {
    return { ok: false, stderr: (diff.stderr || '').toString() };
  }
  const pid = spawnSync('git', ['-C', repoRoot, 'patch-id', '--stable'], {
    input: diff.stdout,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (pid.status !== 0) {
    return { ok: false, stderr: (pid.stderr || '').toString() };
  }
  // Output shape: `<patch_id> <commit_sha>\n` (or empty for empty patch).
  const line = (pid.stdout || '').toString().trim();
  if (!line) {
    // Empty diff (e.g., a no-op commit). Use a sentinel that's unlikely to
    // collide with real patch-ids; same-subject same-empty-patch commits will
    // still match each other, which is the correct semantics.
    return { ok: true, patchId: '<empty-patch>' };
  }
  const token = line.split(/\s+/)[0];
  return { ok: true, patchId: token };
}

/**
 * Enumerate source commits on a slice branch in the range
 * `<sliceStartSha>..<branchName>`, oldest → newest. Returns
 * `[{sha, subject, patch_id, parent_count}]`.
 *
 * Slice branches should never contain merge commits (created from a fresh
 * worktree at sliceStartSha, then linear commits), but we record parent_count
 * defensively.
 */
function enumerateSourceCommits(repoRoot, sliceStartSha, branchName) {
  const FIELD = '\x1f';
  const RECORD = '\x1e';
  const fmt = `--format=%H${FIELD}%P${FIELD}%s${RECORD}`;
  const range = `${sliceStartSha}..${branchName}`;
  const log = runGit(repoRoot, ['log', '--reverse', fmt, range]);
  if (!log.ok) {
    return { ok: false, error: `git log ${range} failed: ${log.stderr.trim()}` };
  }
  const records = log.stdout.split(RECORD);
  const commits = [];
  for (const raw of records) {
    if (!raw) continue;
    const rec = raw.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!rec) continue;
    const parts = rec.split(FIELD);
    if (parts.length < 3) continue;
    const [sha, parents, subject] = parts;
    const parentCount = parents.trim() ? parents.trim().split(/\s+/).length : 0;
    const pid = patchIdFor(repoRoot, sha);
    if (!pid.ok) {
      return { ok: false, error: `git patch-id for ${sha} failed: ${pid.stderr.trim()}` };
    }
    commits.push({
      sha,
      subject,
      patch_id: pid.patchId,
      parent_count: parentCount,
    });
  }
  return { ok: true, commits };
}

/**
 * Scan the integration branch backward from HEAD, up to SCAN_LIMIT commits OR
 * until sliceStartSha is encountered (exclusive). Returns
 * `[{sha, subject, patch_id, is_merge}]` in chronological order (oldest first
 * within the window). Merge commits get `is_merge: true` and a null patch_id.
 */
function scanIntegrationWindow(repoRoot, integrationBranch, sliceStartSha) {
  const FIELD = '\x1f';
  const RECORD = '\x1e';
  const fmt = `--format=%H${FIELD}%P${FIELD}%s${RECORD}`;
  // Newest-first; we'll reverse at the end.
  const log = runGit(repoRoot, [
    'log',
    `-n`, String(SCAN_LIMIT),
    fmt,
    integrationBranch,
  ]);
  if (!log.ok) {
    return { ok: false, error: `git log ${integrationBranch} failed: ${log.stderr.trim()}` };
  }
  const records = log.stdout.split(RECORD);
  const newestFirst = [];
  for (const raw of records) {
    if (!raw) continue;
    const rec = raw.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!rec) continue;
    const parts = rec.split(FIELD);
    if (parts.length < 3) continue;
    const [sha, parents, subject] = parts;
    if (sha === sliceStartSha) break;
    const parentCount = parents.trim() ? parents.trim().split(/\s+/).length : 0;
    const isMerge = parentCount > 1;
    let patchId = null;
    if (!isMerge) {
      const pid = patchIdFor(repoRoot, sha);
      if (!pid.ok) {
        return { ok: false, error: `git patch-id for ${sha} failed: ${pid.stderr.trim()}` };
      }
      patchId = pid.patchId;
    }
    newestFirst.push({ sha, subject, patch_id: patchId, is_merge: isMerge });
  }
  // Chronological: oldest first.
  return { ok: true, window: newestFirst.reverse() };
}

/**
 * Resume classification. Given source commits and the integration window
 * (chronological), returns one of:
 *   - {kind:'resumed'}       — the source sequence is the trailing non-merge
 *                              subsequence of the window in order.
 *   - {kind:'not-integrated'} — none of the source patch-ids appear in the
 *                              window (and no source subject matches a
 *                              window subject with a different patch-id in a
 *                              way that constitutes partial integration).
 *   - {kind:'ambiguous', integratedSubjects, missingSubjects}
 *                              — partial / order-broken / non-trailing.
 *
 * Spec rules:
 *   - "Same subject + different patch-id → treat as NOT integrated."
 *     This means subject-only matches do not count as "integrated"; we use
 *     (patch_id, subject) tuple equality as the integration test.
 *   - All match in order → resumed.
 *   - None match → not-integrated.
 *   - Partial / order broken → ambiguous.
 */
function classifyResume(sourceCommits, integrationWindow) {
  const sourceTuples = sourceCommits.map((c) => ({
    patch_id: c.patch_id,
    subject: c.subject,
  }));

  // Non-merge integration tuples in chronological order.
  const intTuples = integrationWindow
    .filter((c) => !c.is_merge)
    .map((c) => ({ patch_id: c.patch_id, subject: c.subject }));

  // Build a set of all integration (patch_id, subject) tuple keys for O(1)
  // membership tests. Use a delimiter unlikely to appear in patch-ids/subjects.
  const SEP = '\x1f';
  const intKeySet = new Set(intTuples.map((t) => `${t.patch_id}${SEP}${t.subject}`));

  // Count how many source tuples have an exact (patch_id, subject) match
  // anywhere in the integration window.
  let matchedCount = 0;
  for (const t of sourceTuples) {
    if (intKeySet.has(`${t.patch_id}${SEP}${t.subject}`)) matchedCount += 1;
  }

  if (matchedCount === 0) {
    return { kind: 'not-integrated' };
  }

  // Full match? Verify the source sequence equals the trailing N non-merge
  // entries of the integration window in order.
  if (matchedCount === sourceTuples.length) {
    const N = sourceTuples.length;
    if (intTuples.length < N) {
      // Defensive: shouldn't happen given matchedCount === N, but treat as
      // ambiguous since the trailing-window check is impossible.
      return resumeAmbiguousFrom(sourceCommits, intTuples);
    }
    const trailing = intTuples.slice(intTuples.length - N);
    let inOrder = true;
    for (let i = 0; i < N; i += 1) {
      if (
        trailing[i].patch_id !== sourceTuples[i].patch_id
        || trailing[i].subject !== sourceTuples[i].subject
      ) {
        inOrder = false;
        break;
      }
    }
    if (inOrder) return { kind: 'resumed' };
    return resumeAmbiguousFrom(sourceCommits, intTuples);
  }

  // Partial match.
  return resumeAmbiguousFrom(sourceCommits, intTuples);
}

function resumeAmbiguousFrom(sourceCommits, intTuples) {
  const SEP = '\x1f';
  const intKeySet = new Set(intTuples.map((t) => `${t.patch_id}${SEP}${t.subject}`));
  const integratedSubjects = [];
  const missingSubjects = [];
  for (const c of sourceCommits) {
    const key = `${c.patch_id}${SEP}${c.subject}`;
    if (intKeySet.has(key)) integratedSubjects.push(c.subject);
    else missingSubjects.push(c.subject);
  }
  return {
    kind: 'ambiguous',
    integratedSubjects,
    missingSubjects,
  };
}

/**
 * Cherry-pick a single source commit onto the currently-checked-out branch
 * in `repoRoot`. On nonzero exit, returns conflicting paths captured BEFORE
 * `git cherry-pick --abort` is run.
 */
function cherryPickOne(repoRoot, sha) {
  const cp = runGit(repoRoot, ['cherry-pick', sha]);
  if (cp.ok) return { ok: true };
  // Capture conflicting paths BEFORE aborting (abort clears the index state).
  const conflicting = readConflictingPaths(repoRoot);
  // Try to abort; ignore failure of abort itself (we'll surface the original).
  runGit(repoRoot, ['cherry-pick', '--abort']);
  return {
    ok: false,
    stderr: cp.stderr,
    conflicting_paths: conflicting,
  };
}

function readConflictingPaths(repoRoot) {
  const r = runGit(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Integrate one or more slice branches onto the integration branch via
 * ordered cherry-pick with patch-id resume detection.
 *
 * The caller must have the integration branch checked out in `repoRoot`
 * (which is the integration worktree). Cherry-picks are applied to whatever
 * branch is currently checked out there.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.integrationBranch
 * @param {Array<{sliceId:string, branchName:string, sliceStartSha:string}>} args.slices
 */
export function integrate({ repoRoot, integrationBranch, slices }) {
  if (typeof repoRoot !== 'string' || !repoRoot) {
    return halt('worktree-integration-empty', 'repoRoot is required');
  }
  if (typeof integrationBranch !== 'string' || !integrationBranch) {
    return halt('worktree-integration-empty', 'integrationBranch is required');
  }
  if (!Array.isArray(slices) || slices.length === 0) {
    return halt('worktree-integration-empty', 'slices must be a non-empty array');
  }

  const resumedSlices = [];
  let appliedCount = 0;

  for (const slice of slices) {
    const { sliceId, branchName, sliceStartSha } = slice;
    if (!sliceId || !branchName || !sliceStartSha) {
      return halt(
        'worktree-integration-empty',
        `slice missing required fields: ${JSON.stringify(slice)}`,
      );
    }

    // 1. Enumerate source commits.
    const src = enumerateSourceCommits(repoRoot, sliceStartSha, branchName);
    if (!src.ok) {
      return halt('worktree-integration-empty', src.error);
    }
    if (src.commits.length === 0) {
      return halt('worktree-integration-empty', {
        slice_id: sliceId,
        branch_name: branchName,
        slice_start_sha: sliceStartSha,
        detail: `source range ${sliceStartSha}..${branchName} is empty`,
      });
    }

    // 2. Resume detection.
    const scan = scanIntegrationWindow(repoRoot, integrationBranch, sliceStartSha);
    if (!scan.ok) {
      return halt('worktree-resume-ambiguous', {
        slice_id: sliceId,
        branch_name: branchName,
        detail: scan.error,
      });
    }

    const classification = classifyResume(src.commits, scan.window);

    if (classification.kind === 'resumed') {
      resumedSlices.push(sliceId);
      continue;
    }

    if (classification.kind === 'ambiguous') {
      const integrationHead = runGit(repoRoot, ['rev-parse', integrationBranch]);
      const headSha = integrationHead.ok ? integrationHead.stdout.trim() : null;
      return halt('worktree-resume-ambiguous', {
        slice_id: sliceId,
        branch_name: branchName,
        integrated_subjects: classification.integratedSubjects,
        missing_subjects: classification.missingSubjects,
        integration_branch_head: headSha,
      });
    }

    // 3. Cherry-pick each source commit in order.
    for (const sc of src.commits) {
      const cp = cherryPickOne(repoRoot, sc.sha);
      if (!cp.ok) {
        return halt('worktree-merge-conflict', {
          slice_id: sliceId,
          branch_name: branchName,
          conflicting_paths: cp.conflicting_paths,
          source_sha: sc.sha,
          source_subject: sc.subject,
          stderr: (cp.stderr || '').trim(),
        });
      }
      appliedCount += 1;
    }
  }

  // Resolve final HEAD.
  const headRes = runGit(repoRoot, ['rev-parse', integrationBranch]);
  if (!headRes.ok) {
    return halt('worktree-resume-ambiguous', {
      detail: `git rev-parse ${integrationBranch} failed after integration: ${headRes.stderr.trim()}`,
    });
  }

  return ok({
    head_sha: headRes.stdout.trim(),
    commit_count: appliedCount,
    resumed_slices: resumedSlices,
  });
}
