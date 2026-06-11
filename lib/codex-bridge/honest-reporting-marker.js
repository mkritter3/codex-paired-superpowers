// v0.8.1 honest-reporting activation marker.
//
// The honest-reporting Stop/PreToolUse hook activates ONLY when this marker
// file exists at <repo-root>/.codex-paired/honest-reporting-active.json AND
// its `expiresAt` is in the future. Existence of `.codex-paired/` alone is
// insufficient — many repos have that directory from mailbox usage without
// wanting always-on honesty enforcement.
//
// Marker shape:
//   {
//     "skillName": "autopilot",
//     "sessionStartedAt": "2026-05-11T14:30:00.000Z",
//     "expiresAt":         "2026-05-11T22:30:00.000Z",  // default sessionStartedAt + TTL_HOURS
//     "specPath":          "/abs/path/to/spec.md"        // optional
//   }
//
// TTL is the contract. No explicit cleanup is needed — the hook treats an
// expired marker as inactive. Skill entry blocks may GC stale (>24h) markers
// on each invocation.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_TTL_HOURS = 8;

// Slice-implementer worktrees live at <main-repo>/.git-worktrees/slice-N.
// `git rev-parse --show-toplevel` inside one returns the WORKTREE root,
// where no marker exists — which silently deactivated the hook exactly for
// the implementer subagents whose unverified "tests pass" reports it most
// needs to police. Walk up to the main repo root, mirroring the mailbox
// hook's inferActorAndRepoRoot. (v0.15.0)
const WORKTREE_SEGMENT = '/.git-worktrees/';

export class HonestReportingMarkerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HonestReportingMarkerError';
    this.code = code;
  }
}

/**
 * Resolve the marker file path for a given starting directory.
 * Uses `git rev-parse --show-toplevel` (matching sidecar.js pattern).
 * Falls back to `startDir` itself if git lookup fails — that allows the
 * caller to use the helper in non-repo directories during testing.
 */
export function markerPath(startDir) {
  let repoRoot = startDir;
  try {
    // v0.8.1.1: bound the git invocation with `timeout` so a slow or
    // hung git process (corrupted `.git/`, network-mounted repo, test
    // fixtures that create `.git/` without initializing) cannot stall
    // the Stop hook past Claude Code's hook deadline. Codex slice-review
    // caught a 10s+ stall in tests that used a fake `.git/` directory.
    // The 2s budget is generous for a normal `git rev-parse`.
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    });
    repoRoot = raw.trim() || startDir;
  } catch {
    // Not a git repo, git unavailable, OR timeout exceeded — fall back to startDir.
  }
  // Slice worktree → main repo root (see WORKTREE_SEGMENT note above).
  const wtIdx = repoRoot.indexOf(WORKTREE_SEGMENT);
  if (wtIdx > 0) repoRoot = repoRoot.slice(0, wtIdx);
  return join(repoRoot, '.codex-paired', 'honest-reporting-active.json');
}

/**
 * Compute an ISO timestamp `ttlHours` from `nowIso`.
 */
function plusHoursIso(nowIso, ttlHours) {
  const t = new Date(nowIso).getTime();
  return new Date(t + ttlHours * 60 * 60 * 1000).toISOString();
}

/**
 * Write the activation marker.
 *
 * @param {string} startDir — usually cwd; repo root is derived via git.
 * @param {{skillName: string, specPath?: string, ttlHours?: number, now?: string}} opts
 * @returns {{path: string, marker: object}}
 */
export function writeMarker(startDir, opts) {
  if (!opts || typeof opts.skillName !== 'string' || opts.skillName.length === 0) {
    throw new HonestReportingMarkerError(
      'invalid-skill-name',
      'writeMarker: opts.skillName is required',
    );
  }
  const ttlHours = typeof opts.ttlHours === 'number' && opts.ttlHours > 0
    ? opts.ttlHours
    : DEFAULT_TTL_HOURS;
  const nowIso = opts.now || new Date().toISOString();
  const expiresAt = plusHoursIso(nowIso, ttlHours);

  const marker = {
    skillName: opts.skillName,
    sessionStartedAt: nowIso,
    expiresAt,
  };
  if (typeof opts.specPath === 'string' && opts.specPath.length > 0) {
    marker.specPath = opts.specPath;
  }

  const path = markerPath(startDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2), 'utf8');
  return { path, marker };
}

/**
 * Remove the activation marker. Idempotent — clearing an absent marker is a
 * no-op. Workflow skills call this on completion/halt (mirroring autopilot's
 * anchor-clear) so the hook stops policing unrelated work in the same repo;
 * the TTL remains the backstop for sessions that die without cleanup. (v0.15.0)
 *
 * @param {string} startDir
 * @returns {{path: string, cleared: boolean}}
 */
export function clearMarker(startDir) {
  const path = markerPath(startDir);
  const existed = existsSync(path);
  if (existed) {
    try {
      rmSync(path);
    } catch {
      return { path, cleared: false };
    }
  }
  return { path, cleared: existed };
}

/**
 * Read marker from the given path (or via startDir → markerPath). Returns
 * null if absent or malformed. Caller distinguishes via `isActive` which
 * also checks expiry.
 */
export function readMarker(startDir) {
  const path = markerPath(startDir);
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Determine whether the honesty hook should activate.
 *
 * The marker is active iff:
 *  - it exists,
 *  - it parses as a non-null JSON object,
 *  - it has a string `expiresAt`,
 *  - `Date.parse(expiresAt)` is valid AND in the future relative to `now`.
 *
 * Missing/malformed/expired all return false (fail-open from the hook's
 * perspective: don't block when activation is unclear).
 *
 * @param {string} startDir
 * @param {Date} [now] — for testing; defaults to current time.
 * @returns {{active: boolean, reason: string, marker: object|null}}
 */
export function isActive(startDir, now) {
  const marker = readMarker(startDir);
  if (marker === null) {
    return { active: false, reason: 'marker-absent-or-malformed', marker: null };
  }
  if (typeof marker.expiresAt !== 'string' || marker.expiresAt.length === 0) {
    return { active: false, reason: 'expiresAt-missing-or-invalid', marker };
  }
  const expiresMs = Date.parse(marker.expiresAt);
  if (Number.isNaN(expiresMs)) {
    return { active: false, reason: 'expiresAt-unparseable', marker };
  }
  const nowMs = now ? now.getTime() : Date.now();
  if (expiresMs <= nowMs) {
    return { active: false, reason: 'expired', marker };
  }
  return { active: true, reason: 'active', marker };
}
