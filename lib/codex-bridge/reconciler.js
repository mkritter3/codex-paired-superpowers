/**
 * reconciler.js
 *
 * v0.7.0 reconciler module. Per spec §7 ("Reconciler Is Truth"), the
 * authoritative implementation result for a slice comes from git state in
 * the worktree, NOT from subagent self-report.
 *
 * Public API:
 *
 *   reconcileWorktree({worktreePath, sliceStartSha, sliceId})
 *     -> {ok:true, commits, head_sha, commit_count, non_conforming_subjects}
 *      | {ok:false, halt:{reason:"reconciler-failed", detail}}
 *
 * Behavior (spec §7):
 *   - Reads `git -C <worktreePath> log <sliceStartSha>..HEAD`.
 *   - Returns commits as `[{sha, subject}]` ordered oldest → newest.
 *   - `head_sha` from `git rev-parse HEAD` in the worktree.
 *   - `commit_count` = commits.length.
 *   - Each commit's subject is verified against:
 *       ^(feat|test|fix|docs|refactor|chore)\(slice:<N>\): <description>
 *     where `<N>` is the numeric slice number derived from `sliceId`.
 *     Subjects that don't match the basic shape get reason `wrong-format`.
 *     Subjects that match the type+scope shape but with the wrong slice number
 *     get reason `wrong-slice-number`.
 *   - Empty range (HEAD === sliceStartSha): returns commits=[], commit_count=0,
 *     non_conforming_subjects=[], head_sha=<HEAD>.
 *   - Reconciler git failure (bad sha, missing worktree, etc.): returns
 *     `{ok:false, halt:{reason:"reconciler-failed", detail}}`.
 *
 * `sliceId` accepts either the bare numeric form (`"3"`) or the conventional
 * `slice-<N>` form (`"slice-3"`). The first run of decimal digits is used as
 * `<N>`. If no digits are present, the call halts as `reconciler-failed`.
 *
 * Style: zero npm deps. ES modules. All git shell-outs go through
 * `execFileSync` with argv arrays (no shell, no injection risk). Pattern
 * follows `lib/codex-bridge/worktree.js`.
 */

import { execFileSync } from 'node:child_process';

// ── helpers ───────────────────────────────────────────────────────────────────

function halt(detail) {
  return { ok: false, halt: { reason: 'reconciler-failed', detail } };
}

/**
 * Run git with argv array. Returns `{ok:true, stdout}` on exit 0 or
 * `{ok:false, stderr}` otherwise. Never throws on nonzero exit.
 */
function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true, stdout };
  } catch (e) {
    const stderr = (e.stderr && e.stderr.toString()) || (e.stdout && e.stdout.toString()) || e.message;
    return { ok: false, stderr };
  }
}

/**
 * Extract the numeric slice number from a `sliceId` like `"slice-3"` or `"3"`.
 * Returns the digit string, or `null` if no digits are present.
 */
function extractSliceNumber(sliceId) {
  if (typeof sliceId !== 'string') return null;
  const m = sliceId.match(/\d+/);
  return m ? m[0] : null;
}

const ALLOWED_TYPES = ['feat', 'test', 'fix', 'docs', 'refactor', 'chore'];

/**
 * Classify a commit subject relative to the slice number.
 * Returns `null` if conforming, or a non-conforming reason string:
 *   - `'wrong-format'`        — subject does not match the type(scope): shape.
 *   - `'wrong-slice-number'`  — type(scope): shape matches but slice number differs.
 */
function classifySubject(subject, sliceNumber) {
  // First, the strict conforming pattern for THIS slice number.
  // Per spec §7: ^(feat|test|fix|docs|refactor|chore)\(slice:<N>\): <description>
  const types = ALLOWED_TYPES.join('|');
  const conforming = new RegExp(`^(?:${types})\\(slice:${sliceNumber}\\): .+`);
  if (conforming.test(subject)) return null;

  // Wrong-slice-number check: same type+scope shape but a different slice number
  // (or any digits in the slice scope different from sliceNumber).
  const wrongSlice = new RegExp(`^(?:${types})\\(slice:(\\d+)\\): .+`);
  const m = subject.match(wrongSlice);
  if (m && m[1] !== sliceNumber) {
    return 'wrong-slice-number';
  }

  return 'wrong-format';
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Reconcile authoritative slice state from a worktree's git history.
 *
 * @param {object} args
 * @param {string} args.worktreePath
 * @param {string} args.sliceStartSha
 * @param {string} args.sliceId        — `"3"` or `"slice-3"` style; numeric portion used.
 * @returns {{ok:true, commits:Array<{sha:string, subject:string}>,
 *            head_sha:string, commit_count:number,
 *            non_conforming_subjects:Array<{sha:string, subject:string, reason:string}>}
 *           | {ok:false, halt:{reason:"reconciler-failed", detail:string}}}
 */
export function reconcileWorktree({ worktreePath, sliceStartSha, sliceId }) {
  if (typeof worktreePath !== 'string' || !worktreePath) {
    return halt('worktreePath is required');
  }
  if (typeof sliceStartSha !== 'string' || !sliceStartSha) {
    return halt('sliceStartSha is required');
  }
  const sliceNumber = extractSliceNumber(sliceId);
  if (!sliceNumber) {
    return halt(`sliceId ${JSON.stringify(sliceId)} contains no numeric slice identifier`);
  }

  // Resolve HEAD first. If this fails, the worktree is unusable.
  const headRes = runGit(['-C', worktreePath, 'rev-parse', 'HEAD'], undefined);
  if (!headRes.ok) {
    return halt(`git rev-parse HEAD failed in ${worktreePath}: ${headRes.stderr.trim()}`);
  }
  const headSha = headRes.stdout.trim();

  // Read the commit range. Use a unit-separator + record-separator delimiter
  // so multi-line subjects (rare but possible if author embeds %x00) cannot
  // collide with our parser. We only request `%H` and `%s` (subject = first
  // line of the commit message), so a record per commit is two fields.
  //
  // Format: %H<US>%s<RS>
  const FIELD = '\x1f'; // unit separator
  const RECORD = '\x1e'; // record separator
  const fmt = `--format=%H${FIELD}%s${RECORD}`;
  const range = `${sliceStartSha}..HEAD`;

  // `--reverse` gives oldest → newest (default `git log` is newest first).
  const logRes = runGit(
    ['-C', worktreePath, 'log', '--reverse', fmt, range],
    undefined,
  );
  if (!logRes.ok) {
    return halt(`git log ${range} failed in ${worktreePath}: ${logRes.stderr.trim()}`);
  }

  const commits = [];
  const nonConforming = [];

  // Split on record separator. Trailing separator yields an empty final chunk.
  const records = logRes.stdout.split(RECORD);
  for (const raw of records) {
    if (!raw) continue;
    // Trim only leading/trailing newline that git appends between records.
    const rec = raw.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!rec) continue;
    const idx = rec.indexOf(FIELD);
    if (idx === -1) continue; // malformed record; skip defensively
    const sha = rec.slice(0, idx);
    const subject = rec.slice(idx + 1);
    commits.push({ sha, subject });

    const reason = classifySubject(subject, sliceNumber);
    if (reason !== null) {
      nonConforming.push({ sha, subject, reason });
    }
  }

  return {
    ok: true,
    commits,
    head_sha: headSha,
    commit_count: commits.length,
    non_conforming_subjects: nonConforming,
  };
}
