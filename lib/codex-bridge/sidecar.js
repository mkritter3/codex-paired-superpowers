import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  realpathSync,
  statSync,
  rmdirSync,
} from 'node:fs';
import { dirname, basename, join, relative, sep, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as lockfile from 'proper-lockfile';
import { containsCanary } from './implementer/secret-redaction.js';

// Module-scoped Set for one-time-per-process deprecation warning deduplication.
const warnedPaths = new Set();

export class SidecarLockError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message);
    this.name = 'SidecarLockError';
    this.code = code || 'sidecar-lock-failed';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Find the git repo root starting from startDir.
 * Returns the realpath'd root string, or null if not in a git repo or on error.
 */
function findRepoRoot(startDir) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return realpathSync(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Check whether `child` is contained under `parent`.
 * Both paths must already be realpath'd. Uses sep-anchored prefix match to
 * prevent /repo-old from matching /repo.
 */
function isContained(child, parent) {
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  const childWithSep = child.endsWith(sep) ? child : child + sep;
  return childWithSep.startsWith(parentWithSep);
}

export function sidecarPathFor(specPath) {
  // 1. Resolve to absolute path.
  const absSpec = isAbsolute(specPath) ? specPath : resolve(specPath);

  // 2. Try realpath (file may not exist yet on first-write; fall back to absSpec).
  let realSpec;
  try {
    realSpec = realpathSync(absSpec);
  } catch {
    realSpec = absSpec;
  }

  // 3. Legacy path (used as fallback and during transition).
  const legacy = absSpec + '.codex.json';

  // 4. Find the repo root from the spec's directory.
  const repoRoot = findRepoRoot(dirname(realSpec));

  // 5. Fall back to legacy if not in a repo or spec is not contained in it.
  if (!repoRoot || !isContained(realSpec, repoRoot)) {
    return legacy;
  }

  // 6. Compute the hidden-dir path.
  const hidden = join(repoRoot, '.superpowers-codex-paired', relative(repoRoot, realSpec) + '.json');

  // 7. Discovery rule: hidden wins; legacy-only emits a one-time deprecation warning.
  if (existsSync(hidden)) {
    return hidden;
  } else if (existsSync(legacy)) {
    if (!warnedPaths.has(legacy)) {
      process.stderr.write(
        `[codex-paired-superpowers] DEPRECATION WARNING: sidecar at legacy path ${legacy}; ` +
        `move to ${hidden} via scripts/migrate-sidecars-to-hidden-dir.sh\n`
      );
      warnedPaths.add(legacy);
    }
    return legacy;
  } else {
    // First write: target is the hidden-dir path.
    return hidden;
  }
}

export function initSidecar(specPath, { feature, codexSession, model, reasoningEffort }) {
  const data = {
    version: 1,
    feature,
    codex_session: codexSession,
    model,
    reasoning_effort: reasoningEffort,
    created_at: new Date().toISOString(),
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  };
  saveSidecar(specPath, data);
  return data;
}

export function loadSidecar(specPath) {
  const sc = JSON.parse(readFileSync(sidecarPathFor(specPath), 'utf8'));
  // v0.9.0 — silent on-load schema upgrade for v0.8.x sidecars (spec §5).
  // The migration is silent (no stderr), idempotent (only runs when
  // `codex_session` exists and `role_sessions` is absent), and persists a
  // migration record into the sidecar itself as the audit trail. The legacy
  // `codex_session` field is PRESERVED for three releases (removed in v0.12.0)
  // so older tooling reading the file continues to work.
  migrateIfNeeded(sc, specPath);
  return sc;
}

/**
 * v0.9.0 — silent, idempotent on-load migration from v0.8.x's singular
 * `codex_session` to v0.9.0's `role_sessions` map (spec §5).
 *
 * Migration trigger: sidecar has `codex_session` AND no `role_sessions` map.
 * Effect:
 *   1. role_sessions = { "paired-reviewer": <codex_session> }
 *   2. Append a migration record to sidecar.migrations[].
 *   3. codex_session is PRESERVED (three-release back-compat; removal in v0.12.0).
 *   4. Atomic write-back to disk via saveSidecar.
 *
 * No stderr output — the migration record is the audit trail (per Codex round-2).
 *
 * @param {object} sidecarData — parsed sidecar JSON (mutated in place)
 * @param {string} specPath — used to atomically write the upgraded sidecar back
 * @returns {{migrated: boolean}}
 */
function migrateIfNeeded(sidecarData, specPath) {
  if (sidecarData.codex_session && !sidecarData.role_sessions) {
    sidecarData.role_sessions = {
      'paired-reviewer': sidecarData.codex_session,
    };
    if (!Array.isArray(sidecarData.migrations)) {
      sidecarData.migrations = [];
    }
    sidecarData.migrations.push({
      from_schema: 'v0.8.x',
      to_schema: 'v0.9.0',
      action: 'codex_session → role_sessions.paired-reviewer',
      migrated_at: new Date().toISOString(),
    });
    saveSidecar(specPath, sidecarData);
    return { migrated: true };
  }
  return { migrated: false };
}

/**
 * v0.9.0 — read a codex thread id by role, honoring both the v0.9.0
 * `role_sessions` map and the v0.8.x legacy `codex_session` field.
 *
 * Resolution order:
 *   1. role_sessions[role] if present (any role)
 *   2. codex_session as fallback ONLY when role === 'paired-reviewer'
 *   3. undefined otherwise
 *
 * The legacy fallback exists because v0.8.x always wrote `codex_session` to mean
 * "the paired-reviewer thread". For non-paired-reviewer roles we never fall
 * back — those roles only exist post-v0.9.0 and require an explicit
 * role_sessions entry.
 *
 * @param {object} sidecarData — already-loaded sidecar JSON
 * @param {string} role — role id, defaults to "paired-reviewer"
 * @returns {string | undefined}
 */
export function getCodexThreadId(sidecarData, role = 'paired-reviewer') {
  if (sidecarData && sidecarData.role_sessions && sidecarData.role_sessions[role]) {
    return sidecarData.role_sessions[role];
  }
  if (role === 'paired-reviewer' && sidecarData && sidecarData.codex_session) {
    return sidecarData.codex_session;
  }
  return undefined;
}

function saveSidecar(specPath, data) {
  // Atomic write: mkdir-p the parent, write to temp file, then rename.
  // mkdir-p is required for nested hidden paths (e.g. .superpowers-codex-paired/docs/a/b/c/).
  const target = sidecarPathFor(specPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, target);
}

// v0.9.1 hardening (Codex round-1 critique): the sidecar is the
// release-gate audit truth. `saveSidecar` is atomic at the WRITE step
// (temp + rename), but the load → modify → save window of the
// audit-critical append paths has no cross-process lock. Two
// concurrent processes can lose updates (P2 loads stale, P1 saves,
// P2 saves overwriting P1).
//
// `withSidecarLock(specPath, fn)` wraps the load → modify → save
// window with a proper-lockfile lock (50 retries, jittered exp
// backoff, same config as mailbox.js). Callers that need cross-
// process safety wrap their mutate-then-save logic in this helper.
//
// Retry/backoff matches lib/codex-bridge/mailbox.js. Lock file lives
// alongside the sidecar JSON; proper-lockfile creates a sibling
// `<file>.lock` directory atomically.
function sidecarLockOptions(deps) {
  const defaults = {
    retries: {
      // 100 retries with maxTimeout 500ms gives ~50s total budget for
      // contention. Sidecar audit writes are the most-critical path
      // (release-gate truth depends on every turn surviving); we'd
      // rather wait long than lose a write. Note: mailbox.js uses 50
      // retries but its contention pattern is lower (one mailbox per
      // recipient, not one sidecar per spec).
      retries: 100,
      factor: 1.5,
      minTimeout: 20,
      maxTimeout: 500,
      randomize: true,
    },
    // Stale lock detection: if a process crashed mid-write, the lock
    // dir would be left behind. 30s matches mailbox.js.
    stale: 30_000,
  };
  const overrides = deps && deps.lockOptions && typeof deps.lockOptions === 'object'
    ? deps.lockOptions
    : null;
  if (!overrides) return defaults;

  const options = { ...defaults, ...overrides };
  if (typeof overrides.retries === 'number') {
    const retryOptions = { retries: overrides.retries };
    for (const key of ['factor', 'minTimeout', 'maxTimeout', 'randomize']) {
      if (key in overrides) retryOptions[key] = overrides[key];
    }
    options.retries = retryOptions;
  }
  return options;
}

function recoverTestStaleLockIfNeeded(target, options) {
  const stale = options && Number.isFinite(options.stale) ? options.stale : null;
  if (stale === null || stale <= 0) return;
  const lockPath = `${target}.lock`;
  if (!existsSync(lockPath)) return;
  try {
    const stat = statSync(lockPath);
    if (stat.mtime.getTime() < Date.now() - stale) {
      rmdirSync(lockPath);
    }
  } catch {
    // proper-lockfile will surface any real acquisition failure below.
  }
}

export async function withSidecarLock(specPath, fn, deps = {}) {
  const target = sidecarPathFor(specPath);
  mkdirSync(dirname(target), { recursive: true });
  // proper-lockfile requires the lock target to exist on disk.
  if (!existsSync(target)) {
    writeFileSync(target, '{}');
  }
  const options = sidecarLockOptions(deps);
  recoverTestStaleLockIfNeeded(target, options);
  let release;
  try {
    release = await lockfile.lock(target, options);
  } catch (err) {
    if (err && err.code === 'ELOCKED') {
      throw new SidecarLockError('sidecar lock acquisition failed', {
        code: 'sidecar-lock-failed',
        cause: err,
      });
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    try { await release(); } catch { /* best-effort */ }
  }
}

export function appendRound(specPath, round) {
  const sc = loadSidecar(specPath);
  sc.rounds.push(round);
  saveSidecar(specPath, sc);
}

export function setSlice(specPath, sliceId, sliceState) {
  const sc = loadSidecar(specPath);
  sc.slice_reviews[sliceId] = sliceState;
  saveSidecar(specPath, sc);
}

export function setPhase(specPath, sliceId, phaseName, phaseState) {
  const sc = loadSidecar(specPath);
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  sc.slice_reviews[sliceId].phases[phaseName] = phaseState;
  saveSidecar(specPath, sc);
}

/**
 * Set a key in the live-verification phase block for a given slice.
 * Creates intermediate objects as needed (lazy-init pattern matching setPhase).
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-6"
 * @param {string} key — e.g. "shipped", "scenarios", "scenario_generation"
 * @param {unknown} value
 */
export function setLiveVerification(specPath, sliceId, key, value) {
  const sc = loadSidecar(specPath);
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  if (!sc.slice_reviews[sliceId].phases['live-verification']) {
    sc.slice_reviews[sliceId].phases['live-verification'] = {};
  }
  sc.slice_reviews[sliceId].phases['live-verification'][key] = value;
  saveSidecar(specPath, sc);
}

/**
 * Get the live-verification phase block for a given slice.
 * Returns null when absent (no slice, no phases, or no live-verification block).
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-6"
 * @returns {object | null}
 */
export function getLiveVerification(specPath, sliceId) {
  const sc = loadSidecar(specPath);
  return sc.slice_reviews?.[sliceId]?.phases?.['live-verification'] ?? null;
}

/**
 * Append a round object to the live-verification phase block's `rounds` array.
 * Lazy-inits the live-verification block and the rounds array if absent.
 * Atomic write (read-modify-write via saveSidecar).
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-10"
 * @param {object} round — arbitrary round payload (round number, outcome, etc.)
 */
export function appendLiveVerificationRound(specPath, sliceId, round) {
  const sc = loadSidecar(specPath);
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  if (!sc.slice_reviews[sliceId].phases['live-verification']) {
    sc.slice_reviews[sliceId].phases['live-verification'] = {};
  }
  const lv = sc.slice_reviews[sliceId].phases['live-verification'];
  if (!Array.isArray(lv.rounds)) lv.rounds = [];
  lv.rounds.push(round);
  saveSidecar(specPath, sc);
}

/**
 * Record a scenario attempt result in the live-verification phase block.
 * Writes to `phases.live-verification.scenarios[scenarioId][attemptKey]`.
 * Lazy-inits all intermediate objects.
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-10"
 * @param {string} scenarioId — e.g. "lv-001"
 * @param {string} attemptKey — e.g. "attempt-1"
 * @param {object} result — result payload (status, assertions_failed, etc.)
 */
export function recordScenarioResult(specPath, sliceId, scenarioId, attemptKey, result) {
  const sc = loadSidecar(specPath);
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  if (!sc.slice_reviews[sliceId].phases['live-verification']) {
    sc.slice_reviews[sliceId].phases['live-verification'] = {};
  }
  const lv = sc.slice_reviews[sliceId].phases['live-verification'];
  if (!lv.scenarios) lv.scenarios = {};
  if (!lv.scenarios[scenarioId]) lv.scenarios[scenarioId] = {};
  lv.scenarios[scenarioId][attemptKey] = result;
  saveSidecar(specPath, sc);
}

// --- Implement-phase persistence (v0.7.0 spec §14) -------------------------

const VALID_IMPLEMENT_AGENTS = new Set(['codex', 'sonnet']);
const VALID_IMPLEMENT_OUTCOMES = new Set([
  'shipped',
  'failed-fallback-pending',
  'failed-halted',
  'in-progress',  // v0.7.2 — codex-background-bash dispatched but not yet reconciled
]);
const VALID_IMPLEMENT_TRANSPORTS = new Set([
  'claude-subagent',
  'codex-background-bash',  // v0.7.2 — codex via orchestrator-level background Bash
]);
const REQUIRED_DISPATCH_FIELDS = [
  'slice_id',
  'agent',
  'dispatched_at',
  'worktree',
  'outcome',
];

function ensureImplementBlock(sc, sliceId) {
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  if (!sc.slice_reviews[sliceId].phases.implement) {
    sc.slice_reviews[sliceId].phases.implement = {};
  }
  return sc.slice_reviews[sliceId].phases.implement;
}

/**
 * Set implement-phase routing/parallel/worktree metadata for a slice.
 * Overwrite-on-write semantics: replaces preferred_implementer,
 * fallback_implementer, parallel_group, parallel_suppressed_reason, worktree.
 * Other implement-phase fields (dispatches, bootstrap, shipped, etc.) are preserved.
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-3"
 * @param {{preferred_implementer:string, fallback_implementer:string, parallel_group:string|null, parallel_suppressed_reason:string|null, worktree:string}} meta
 */
export function setImplementMeta(specPath, sliceId, meta) {
  const sc = loadSidecar(specPath);
  const impl = ensureImplementBlock(sc, sliceId);
  impl.preferred_implementer = meta.preferred_implementer;
  impl.fallback_implementer = meta.fallback_implementer;
  impl.parallel_group = meta.parallel_group;
  impl.parallel_suppressed_reason = meta.parallel_suppressed_reason;
  impl.worktree = meta.worktree;
  // v0.7.1 — resolved domain is part of dispatch provenance per spec §14.
  // Optional for backward compatibility with v0.7.0 callers that don't pass it.
  if (meta.domain !== undefined) impl.domain = meta.domain;
  saveSidecar(specPath, sc);
}

/**
 * Set implement-phase bootstrap record for a slice.
 * Overwrite-on-write semantics: replaces phases.implement.bootstrap entirely.
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-3"
 * @param {{symlinks:string[], completed_at:string}} bootstrap
 */
export function setImplementBootstrap(specPath, sliceId, bootstrap) {
  const sc = loadSidecar(specPath);
  const impl = ensureImplementBlock(sc, sliceId);
  impl.bootstrap = {
    symlinks: bootstrap.symlinks,
    completed_at: bootstrap.completed_at,
  };
  saveSidecar(specPath, sc);
}

/**
 * Append a dispatch record to phases.implement.dispatches[].
 * Append-only: two calls produce two entries; never overwrites.
 *
 * Validates the dispatch payload before any write:
 *   - required (always): slice_id, agent, dispatched_at, worktree, outcome
 *   - agent ∈ {"codex","sonnet"}
 *   - outcome ∈ {"shipped","failed-fallback-pending","failed-halted","in-progress"}
 *   - transport (v0.7.2, optional) ∈ {"claude-subagent","codex-background-bash"}
 *   - task_id, output_file, status_file (v0.7.2, optional) — strings if present.
 *     Required for transport=codex-background-bash with outcome=in-progress.
 *   - thread_id is optional (nullable for codex-background-bash and Sonnet paths)
 *   - completed_at, head_sha, commit_count are absent/null while outcome=in-progress
 *
 * Throws synchronously on validation failure; sidecar file is not modified.
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-3"
 * @param {object} dispatch
 */
export function appendImplementDispatch(specPath, sliceId, dispatch) {
  if (dispatch === null || typeof dispatch !== 'object') {
    throw new Error('appendImplementDispatch: dispatch must be an object');
  }
  for (const field of REQUIRED_DISPATCH_FIELDS) {
    if (!(field in dispatch) || dispatch[field] === undefined || dispatch[field] === null) {
      throw new Error(`appendImplementDispatch: missing required field "${field}"`);
    }
  }
  if (!VALID_IMPLEMENT_AGENTS.has(dispatch.agent)) {
    throw new Error(
      `appendImplementDispatch: invalid agent "${dispatch.agent}" — must be "codex" or "sonnet"`
    );
  }
  if (!VALID_IMPLEMENT_OUTCOMES.has(dispatch.outcome)) {
    throw new Error(
      `appendImplementDispatch: invalid outcome "${dispatch.outcome}" — must be one of ` +
        `"shipped", "failed-fallback-pending", "failed-halted", "in-progress"`
    );
  }
  // v0.7.2 — transport is optional but when present must be valid.
  if (dispatch.transport !== undefined && dispatch.transport !== null) {
    if (!VALID_IMPLEMENT_TRANSPORTS.has(dispatch.transport)) {
      throw new Error(
        `appendImplementDispatch: invalid transport "${dispatch.transport}" — must be one of ` +
          `"claude-subagent", "codex-background-bash"`
      );
    }
  }
  // v0.7.2 — codex-background-bash + in-progress requires task_id + output_file + status_file
  // for crash recovery. Other combinations may have these fields but they are not enforced.
  if (
    dispatch.transport === 'codex-background-bash' &&
    dispatch.outcome === 'in-progress'
  ) {
    for (const f of ['task_id', 'output_file', 'status_file']) {
      const v = dispatch[f];
      if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
          `appendImplementDispatch: codex-background-bash + in-progress requires non-empty string "${f}"`
        );
      }
    }
  }
  // task_id, output_file, status_file: if present in any dispatch, must be non-empty strings.
  for (const f of ['task_id', 'output_file', 'status_file', 'thread_id']) {
    if (f in dispatch && dispatch[f] !== null && dispatch[f] !== undefined) {
      if (typeof dispatch[f] !== 'string' || dispatch[f].length === 0) {
        throw new Error(
          `appendImplementDispatch: field "${f}" must be a non-empty string when present (got ${JSON.stringify(dispatch[f])})`
        );
      }
    }
  }
  // v0.7.3.1 — injected_message_ids: orchestrator records which mailbox message
  // ids were pre-injected into the dispatch prompt (spec §4.2 + §8). Must be
  // an array of non-empty strings when present; null/undefined treated as
  // "field absent" for back-compat with pre-0.7.3.1 records.
  if ('injected_message_ids' in dispatch &&
      dispatch.injected_message_ids !== null &&
      dispatch.injected_message_ids !== undefined) {
    if (!Array.isArray(dispatch.injected_message_ids)) {
      throw new Error(
        `appendImplementDispatch: injected_message_ids must be an array of strings when present (got ${typeof dispatch.injected_message_ids})`
      );
    }
    for (const id of dispatch.injected_message_ids) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
          `appendImplementDispatch: injected_message_ids elements must be non-empty strings (got ${JSON.stringify(id)})`
        );
      }
    }
  }

  // v0.8.0 — optional experts_selected / expert_turn_ids / expert_blockers.
  // Null/undefined treated as "field absent" for back-compat with pre-0.8.0
  // records. Empty arrays allowed.
  for (const field of ['experts_selected', 'expert_turn_ids']) {
    if (field in dispatch && dispatch[field] !== null && dispatch[field] !== undefined) {
      if (!Array.isArray(dispatch[field])) {
        throw new Error(
          `appendImplementDispatch: ${field} must be an array of strings when present (got ${typeof dispatch[field]})`
        );
      }
      for (const v of dispatch[field]) {
        if (typeof v !== 'string' || v.length === 0) {
          throw new Error(
            `appendImplementDispatch: ${field} elements must be non-empty strings (got ${JSON.stringify(v)})`
          );
        }
      }
    }
  }
  if ('expert_blockers' in dispatch &&
      dispatch.expert_blockers !== null &&
      dispatch.expert_blockers !== undefined) {
    if (!Array.isArray(dispatch.expert_blockers)) {
      throw new Error(
        `appendImplementDispatch: expert_blockers must be an array when present (got ${typeof dispatch.expert_blockers})`
      );
    }
    for (const b of dispatch.expert_blockers) {
      if (b === null || typeof b !== 'object' || Array.isArray(b)) {
        throw new Error(
          `appendImplementDispatch: expert_blockers elements must be objects (got ${JSON.stringify(b)})`
        );
      }
      for (const required of ['expert_id', 'finding_id', 'summary', 'location', 'disposition']) {
        if (typeof b[required] !== 'string' || b[required].length === 0) {
          throw new Error(
            `appendImplementDispatch: expert_blockers element missing required string field "${required}"`
          );
        }
      }
      if (b.disposition !== 'open') {
        throw new Error(
          `appendImplementDispatch: expert_blockers element disposition must be "open" on initial write (got "${b.disposition}"). ` +
            `Use updateDispatchExpertBlocker to transition.`
        );
      }
    }
  }

  const sc = loadSidecar(specPath);
  const impl = ensureImplementBlock(sc, sliceId);
  if (!Array.isArray(impl.dispatches)) impl.dispatches = [];
  impl.dispatches.push(dispatch);
  saveSidecar(specPath, sc);
}

// --- v0.8.0 expert_teammates persistence (spec §Rehydration State) ---------

const VALID_EXPERT_SOURCES = new Set(['builtin', 'repo-override']);
const VALID_EXPERT_STATUSES = new Set(['active', 'waiting', 'done', 'failed', 'archived']);
const VALID_EXPERT_VERDICTS = new Set(['SHIP', 'REVISE']);
const VALID_BLOCKER_DISPOSITIONS = new Set([
  'open',
  'resolved',
  'technical-override',
  'needs-user',
  'deferred',
]);

function ensureExpertTeammatesBlock(sc) {
  if (!sc.expert_teammates) {
    sc.expert_teammates = {
      selected: [],
      turns: [],
      fan_out_rationales: [],
    };
  }
  if (!Array.isArray(sc.expert_teammates.selected)) sc.expert_teammates.selected = [];
  if (!Array.isArray(sc.expert_teammates.turns)) sc.expert_teammates.turns = [];
  if (!Array.isArray(sc.expert_teammates.fan_out_rationales)) {
    sc.expert_teammates.fan_out_rationales = [];
  }
  return sc.expert_teammates;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Append an expert selection record to expert_teammates.selected[].
 * Initial status is "active". Source must be in {builtin, repo-override}.
 *
 * @param {string} specPath
 * @param {{id:string, role:string, source:string, phase:string, selectionReason:string}} sel
 */
export function appendExpertSelection(specPath, sel) {
  if (!sel || typeof sel !== 'object') {
    throw new Error('appendExpertSelection: selection must be an object');
  }
  if (!nonEmptyString(sel.id)) {
    throw new Error('appendExpertSelection: id must be a non-empty string');
  }
  if (!nonEmptyString(sel.role)) {
    throw new Error('appendExpertSelection: role must be a non-empty string');
  }
  if (!VALID_EXPERT_SOURCES.has(sel.source)) {
    throw new Error(
      `appendExpertSelection: invalid source "${sel.source}" — must be "builtin" or "repo-override"`
    );
  }
  if (!nonEmptyString(sel.phase)) {
    throw new Error('appendExpertSelection: phase must be a non-empty string');
  }
  if (!nonEmptyString(sel.selectionReason)) {
    throw new Error('appendExpertSelection: selectionReason must be a non-empty string');
  }
  const sc = loadSidecar(specPath);
  const block = ensureExpertTeammatesBlock(sc);
  block.selected.push({
    id: sel.id,
    role: sel.role,
    source: sel.source,
    selected_at_phase: sel.phase,
    selection_reason: sel.selectionReason,
    status: 'active',
  });
  saveSidecar(specPath, sc);
}

/**
 * Append a turn record to expert_teammates.turns[].
 *
 * @param {string} specPath
 * @param {object} turn
 */
export function appendExpertTurn(specPath, turn) {
  if (!turn || typeof turn !== 'object') {
    throw new Error('appendExpertTurn: turn must be an object');
  }
  if (!nonEmptyString(turn.expert_id)) {
    throw new Error('appendExpertTurn: expert_id must be a non-empty string');
  }
  if (!nonEmptyString(turn.phase)) {
    throw new Error('appendExpertTurn: phase must be a non-empty string');
  }
  if (!Array.isArray(turn.mailbox_message_ids_injected)) {
    throw new Error(
      `appendExpertTurn: mailbox_message_ids_injected must be an array (got ${typeof turn.mailbox_message_ids_injected})`
    );
  }
  for (const id of turn.mailbox_message_ids_injected) {
    if (!nonEmptyString(id)) {
      throw new Error(
        `appendExpertTurn: mailbox_message_ids_injected elements must be non-empty strings (got ${JSON.stringify(id)})`
      );
    }
  }
  if (!nonEmptyString(turn.started_at)) {
    throw new Error('appendExpertTurn: started_at must be a non-empty string');
  }
  if (!nonEmptyString(turn.completed_at)) {
    throw new Error('appendExpertTurn: completed_at must be a non-empty string');
  }
  if (typeof turn.result_summary !== 'string') {
    throw new Error('appendExpertTurn: result_summary must be a string');
  }
  if (!VALID_EXPERT_VERDICTS.has(turn.verdict)) {
    throw new Error(
      `appendExpertTurn: invalid verdict "${turn.verdict}" — must be "SHIP" or "REVISE"`
    );
  }
  if (turn.failure_reason !== null && !nonEmptyString(turn.failure_reason)) {
    throw new Error(
      `appendExpertTurn: failure_reason must be null or a non-empty string (got ${JSON.stringify(turn.failure_reason)})`
    );
  }
  // slice_id: optional. Required string for autopilot phases
  // (post-implementation-review, pre-dispatch); null/absent for spec-review.
  // We accept null/absent universally and persist as null; validate type only.
  let sliceId = null;
  if ('slice_id' in turn && turn.slice_id !== undefined && turn.slice_id !== null) {
    if (!nonEmptyString(turn.slice_id)) {
      throw new Error(
        `appendExpertTurn: slice_id must be a non-empty string when present (got ${JSON.stringify(turn.slice_id)})`
      );
    }
    sliceId = turn.slice_id;
  }

  // v0.8.1 — optional peer-DM audit fields. Validate shape if present; absent
  // is back-compat (pre-0.8.1 records did not carry these fields).
  let peerEnqueued = null;
  if ('peer_messages_enqueued' in turn && turn.peer_messages_enqueued !== undefined && turn.peer_messages_enqueued !== null) {
    if (!Array.isArray(turn.peer_messages_enqueued)) {
      throw new Error(
        `appendExpertTurn: peer_messages_enqueued must be an array when present (got ${typeof turn.peer_messages_enqueued})`
      );
    }
    for (const e of turn.peer_messages_enqueued) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        throw new Error(
          `appendExpertTurn: peer_messages_enqueued elements must be objects (got ${JSON.stringify(e)})`
        );
      }
      if (!nonEmptyString(e.to)) {
        throw new Error(
          `appendExpertTurn: peer_messages_enqueued element missing required string field "to"`
        );
      }
      if (!nonEmptyString(e.message_id)) {
        throw new Error(
          `appendExpertTurn: peer_messages_enqueued element missing required string field "message_id"`
        );
      }
    }
    peerEnqueued = turn.peer_messages_enqueued.slice();
  }
  let peerFailed = null;
  if ('peer_messages_failed' in turn && turn.peer_messages_failed !== undefined && turn.peer_messages_failed !== null) {
    if (!Array.isArray(turn.peer_messages_failed)) {
      throw new Error(
        `appendExpertTurn: peer_messages_failed must be an array when present (got ${typeof turn.peer_messages_failed})`
      );
    }
    for (const e of turn.peer_messages_failed) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        throw new Error(
          `appendExpertTurn: peer_messages_failed elements must be objects (got ${JSON.stringify(e)})`
        );
      }
      if (!nonEmptyString(e.reason)) {
        throw new Error(
          `appendExpertTurn: peer_messages_failed element missing required string field "reason"`
        );
      }
      // `to` may be null for malformed-item entries where the recipient
      // string itself was missing/invalid; that's intentional. Validate only
      // that, when present, it's a non-empty string.
      if (e.to !== null && e.to !== undefined && !nonEmptyString(e.to)) {
        throw new Error(
          `appendExpertTurn: peer_messages_failed element "to" must be a non-empty string or null (got ${JSON.stringify(e.to)})`
        );
      }
      // v0.8.1.1 — optional overflow-audit fields for count-cap-exceeded
      // entries. Narrow validation: types must match if present, but
      // absence is allowed (regular per-item failures don't carry them).
      if ('overflow_count' in e && e.overflow_count !== undefined && e.overflow_count !== null) {
        if (typeof e.overflow_count !== 'number' || !Number.isFinite(e.overflow_count) || e.overflow_count < 0) {
          throw new Error(
            `appendExpertTurn: peer_messages_failed element "overflow_count" must be a non-negative finite number when present (got ${JSON.stringify(e.overflow_count)})`
          );
        }
      }
      if ('max_allowed' in e && e.max_allowed !== undefined && e.max_allowed !== null) {
        if (typeof e.max_allowed !== 'number' || !Number.isFinite(e.max_allowed) || e.max_allowed < 0) {
          throw new Error(
            `appendExpertTurn: peer_messages_failed element "max_allowed" must be a non-negative finite number when present (got ${JSON.stringify(e.max_allowed)})`
          );
        }
      }
      if ('sample_to' in e && e.sample_to !== undefined && e.sample_to !== null) {
        if (!Array.isArray(e.sample_to)) {
          throw new Error(
            `appendExpertTurn: peer_messages_failed element "sample_to" must be an array when present (got ${typeof e.sample_to})`
          );
        }
        for (const t of e.sample_to) {
          if (!nonEmptyString(t)) {
            throw new Error(
              `appendExpertTurn: peer_messages_failed element "sample_to" entries must be non-empty strings (got ${JSON.stringify(t)})`
            );
          }
        }
      }
    }
    peerFailed = turn.peer_messages_failed.slice();
  }

  // v0.9.0 slice 5b — raw findings preservation + panel coordination + suppression audit.
  //
  // blocking_findings + nonblocking_findings: arrays when present; each entry
  //   an object. Field-level finding shape is the ROLE's contract, not the
  //   sidecar validator's — this slice intentionally only pins the array-of-
  //   objects shape per spec § 4 "Findings preservation: sidecar records
  //   each panelist's blocking_findings + nonblocking_findings arrays verbatim".
  let blockingFindings = null;
  if ('blocking_findings' in turn && turn.blocking_findings !== undefined && turn.blocking_findings !== null) {
    if (!Array.isArray(turn.blocking_findings)) {
      throw new Error(
        `appendExpertTurn: blocking_findings must be an array when present (got ${typeof turn.blocking_findings})`
      );
    }
    for (const f of turn.blocking_findings) {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        throw new Error(
          `appendExpertTurn: blocking_findings elements must be objects (got ${JSON.stringify(f)})`
        );
      }
    }
    blockingFindings = turn.blocking_findings.slice();
  }
  let nonblockingFindings = null;
  if ('nonblocking_findings' in turn && turn.nonblocking_findings !== undefined && turn.nonblocking_findings !== null) {
    if (!Array.isArray(turn.nonblocking_findings)) {
      throw new Error(
        `appendExpertTurn: nonblocking_findings must be an array when present (got ${typeof turn.nonblocking_findings})`
      );
    }
    for (const f of turn.nonblocking_findings) {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        throw new Error(
          `appendExpertTurn: nonblocking_findings elements must be objects (got ${JSON.stringify(f)})`
        );
      }
    }
    nonblockingFindings = turn.nonblocking_findings.slice();
  }

  // panel coordination fields (panel-dispatcher in slice 6 will populate; slice
  // 5b only validates when present). Cross-field consistency
  // (panel_id ↔ panel_member_index ↔ panel_size) is slice 6's contract.
  let panelId = null;
  if ('panel_id' in turn && turn.panel_id !== undefined && turn.panel_id !== null) {
    if (!nonEmptyString(turn.panel_id)) {
      throw new Error(
        `appendExpertTurn: panel_id must be a non-empty string when present (got ${JSON.stringify(turn.panel_id)})`
      );
    }
    panelId = turn.panel_id;
  }
  let panelMemberIndex = null;
  if ('panel_member_index' in turn && turn.panel_member_index !== undefined && turn.panel_member_index !== null) {
    if (
      typeof turn.panel_member_index !== 'number' ||
      !Number.isInteger(turn.panel_member_index) ||
      turn.panel_member_index < 0
    ) {
      throw new Error(
        `appendExpertTurn: panel_member_index must be a non-negative integer when present (got ${JSON.stringify(turn.panel_member_index)})`
      );
    }
    panelMemberIndex = turn.panel_member_index;
  }
  let panelSize = null;
  if ('panel_size' in turn && turn.panel_size !== undefined && turn.panel_size !== null) {
    if (
      typeof turn.panel_size !== 'number' ||
      !Number.isInteger(turn.panel_size) ||
      turn.panel_size < 1
    ) {
      throw new Error(
        `appendExpertTurn: panel_size must be a positive integer when present (got ${JSON.stringify(turn.panel_size)})`
      );
    }
    panelSize = turn.panel_size;
  }

  // panel_peer_messages_suppressed: array of {to: string|null, body_hash: string, summary_hash?: string}
  // body_hash + summary_hash must match /^sha256:[a-f0-9]{64}$/ when present.
  const PANEL_HASH_RE = /^sha256:[a-f0-9]{64}$/;
  // v0.9.0 slice 5b round-1 fix: same regex used to validate replay/response hashes.
  const SHA256_RE = PANEL_HASH_RE;
  const RESPONSE_REF_VALIDATE_RE = /^responses\/sha256-[a-f0-9]{64}\.txt$/;
  let panelSuppressed = null;
  if (
    'panel_peer_messages_suppressed' in turn &&
    turn.panel_peer_messages_suppressed !== undefined &&
    turn.panel_peer_messages_suppressed !== null
  ) {
    if (!Array.isArray(turn.panel_peer_messages_suppressed)) {
      throw new Error(
        `appendExpertTurn: panel_peer_messages_suppressed must be an array when present (got ${typeof turn.panel_peer_messages_suppressed})`
      );
    }
    for (const e of turn.panel_peer_messages_suppressed) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        throw new Error(
          `appendExpertTurn: panel_peer_messages_suppressed elements must be objects (got ${JSON.stringify(e)})`
        );
      }
      // `to`: string OR null (Codex round-7 SHIP: accept null for unaddressed
      // peer drafts where the recipient field itself was missing).
      if (e.to !== null && !nonEmptyString(e.to)) {
        throw new Error(
          `appendExpertTurn: panel_peer_messages_suppressed element "to" must be a non-empty string or null (got ${JSON.stringify(e.to)})`
        );
      }
      if (!nonEmptyString(e.body_hash) || !PANEL_HASH_RE.test(e.body_hash)) {
        throw new Error(
          `appendExpertTurn: panel_peer_messages_suppressed element "body_hash" must match sha256:<64-hex> (got ${JSON.stringify(e.body_hash)})`
        );
      }
      if ('summary_hash' in e && e.summary_hash !== undefined && e.summary_hash !== null) {
        if (!nonEmptyString(e.summary_hash) || !PANEL_HASH_RE.test(e.summary_hash)) {
          throw new Error(
            `appendExpertTurn: panel_peer_messages_suppressed element "summary_hash" must match sha256:<64-hex> when present (got ${JSON.stringify(e.summary_hash)})`
          );
        }
      }
    }
    panelSuppressed = turn.panel_peer_messages_suppressed.slice();
  }

  // v0.9.0 slice 5b round-1 fix: replay / response-audit field validation.
  // These fields are OPTIONAL (turns predating slice 5b have none). When
  // present, they must satisfy strict shape / format rules so downstream
  // readResponse() and replayTurn() can rely on them.

  // response_text_inline / response_ref are mutually exclusive.
  const hasInline =
    'response_text_inline' in turn &&
    turn.response_text_inline !== undefined &&
    turn.response_text_inline !== null;
  const hasRef =
    'response_ref' in turn &&
    turn.response_ref !== undefined &&
    turn.response_ref !== null;
  if (hasInline && hasRef) {
    throw new Error(
      'appendExpertTurn: response_text_inline and response_ref are mutually exclusive — supply exactly one',
    );
  }
  let responseTextInline = null;
  if (hasInline) {
    if (typeof turn.response_text_inline !== 'string') {
      throw new Error(
        `appendExpertTurn: response_text_inline must be a string when present (got ${typeof turn.response_text_inline})`,
      );
    }
    responseTextInline = turn.response_text_inline;
  }
  let responseRef = null;
  if (hasRef) {
    if (!nonEmptyString(turn.response_ref) || !RESPONSE_REF_VALIDATE_RE.test(turn.response_ref)) {
      throw new Error(
        `appendExpertTurn: response_ref must match "responses/sha256-<64-hex>.txt" (got ${JSON.stringify(turn.response_ref)})`,
      );
    }
    responseRef = turn.response_ref;
  }

  // Hash fields: each optional; when present, must match sha256:<64-hex>.
  function validateSha256Field(fieldName) {
    if (fieldName in turn && turn[fieldName] !== undefined && turn[fieldName] !== null) {
      if (!nonEmptyString(turn[fieldName]) || !SHA256_RE.test(turn[fieldName])) {
        throw new Error(
          `appendExpertTurn: ${fieldName} must match sha256:<64-hex> when present (got ${JSON.stringify(turn[fieldName])})`,
        );
      }
      return turn[fieldName];
    }
    return null;
  }
  const responseHash = validateSha256Field('response_hash');
  const inputsHash = validateSha256Field('inputs_hash');
  const rolePromptHash = validateSha256Field('role_prompt_hash');
  const specSnippetHash = validateSha256Field('spec_snippet_hash');

  // String passthrough fields.
  function validateStringField(fieldName) {
    if (fieldName in turn && turn[fieldName] !== undefined && turn[fieldName] !== null) {
      if (!nonEmptyString(turn[fieldName])) {
        throw new Error(
          `appendExpertTurn: ${fieldName} must be a non-empty string when present (got ${JSON.stringify(turn[fieldName])})`,
        );
      }
      return turn[fieldName];
    }
    return null;
  }
  const rolePromptVersion = validateStringField('role_prompt_version');
  const specPath2 = validateStringField('spec_path');
  const adapter = validateStringField('adapter');
  const requestedRole = validateStringField('requested_role');
  const taskText = validateStringField('task');

  // v0.9.0 slice 8 follow-up: resolution-audit block (spec § 7 Tier 1
  // requires these per turn — persistence must match the gate contract).
  const resolvedCli = validateStringField('resolved_cli');
  const resolutionSource = validateStringField('resolution_source');
  // preference_index: integer, may be -1 (override path) or >=0 (ladder match)
  let preferenceIndex = null;
  if ('preference_index' in turn && turn.preference_index !== undefined && turn.preference_index !== null) {
    if (typeof turn.preference_index !== 'number' || !Number.isInteger(turn.preference_index)) {
      throw new Error(
        `appendExpertTurn: preference_index must be an integer when present (got ${JSON.stringify(turn.preference_index)})`,
      );
    }
    preferenceIndex = turn.preference_index;
  }
  // preference_ladder: array of non-empty strings ('codex', 'ollama{kimi-k2.6}', etc.)
  let preferenceLadder = null;
  if ('preference_ladder' in turn && turn.preference_ladder !== undefined && turn.preference_ladder !== null) {
    if (!Array.isArray(turn.preference_ladder)) {
      throw new Error(
        `appendExpertTurn: preference_ladder must be an array when present (got ${typeof turn.preference_ladder})`,
      );
    }
    for (const e of turn.preference_ladder) {
      if (!nonEmptyString(e)) {
        throw new Error(
          `appendExpertTurn: preference_ladder elements must be non-empty strings (got ${JSON.stringify(e)})`,
        );
      }
    }
    preferenceLadder = turn.preference_ladder.slice();
  }
  // unavailable_candidates: array of strings; may be empty
  let unavailableCandidates = null;
  if ('unavailable_candidates' in turn && turn.unavailable_candidates !== undefined && turn.unavailable_candidates !== null) {
    if (!Array.isArray(turn.unavailable_candidates)) {
      throw new Error(
        `appendExpertTurn: unavailable_candidates must be an array when present (got ${typeof turn.unavailable_candidates})`,
      );
    }
    for (const e of turn.unavailable_candidates) {
      if (!nonEmptyString(e)) {
        throw new Error(
          `appendExpertTurn: unavailable_candidates elements must be non-empty strings (got ${JSON.stringify(e)})`,
        );
      }
    }
    unavailableCandidates = turn.unavailable_candidates.slice();
  }
  // fallback_reason: nullable string (null when no fallback occurred)
  let fallbackReason = null;
  let fallbackReasonPresent = false;
  if ('fallback_reason' in turn) {
    fallbackReasonPresent = true;
    if (turn.fallback_reason === null) {
      fallbackReason = null;
    } else if (!nonEmptyString(turn.fallback_reason)) {
      throw new Error(
        `appendExpertTurn: fallback_reason must be null or a non-empty string when present (got ${JSON.stringify(turn.fallback_reason)})`,
      );
    } else {
      fallbackReason = turn.fallback_reason;
    }
  }

  // mailbox_message_ids: optional; when present, array of non-empty strings.
  // (Distinct from mailbox_message_ids_injected which is required; this
  // plain-name variant is what the replay spec uses.)
  let mailboxMessageIds = null;
  if (
    'mailbox_message_ids' in turn &&
    turn.mailbox_message_ids !== undefined &&
    turn.mailbox_message_ids !== null
  ) {
    if (!Array.isArray(turn.mailbox_message_ids)) {
      throw new Error(
        `appendExpertTurn: mailbox_message_ids must be an array when present (got ${typeof turn.mailbox_message_ids})`,
      );
    }
    for (const id of turn.mailbox_message_ids) {
      if (!nonEmptyString(id)) {
        throw new Error(
          `appendExpertTurn: mailbox_message_ids elements must be non-empty strings (got ${JSON.stringify(id)})`,
        );
      }
    }
    mailboxMessageIds = turn.mailbox_message_ids.slice();
  }

  const sc = loadSidecar(specPath);
  const block = ensureExpertTeammatesBlock(sc);
  const turnRecord = {
    expert_id: turn.expert_id,
    phase: turn.phase,
    slice_id: sliceId,
    mailbox_message_ids_injected: turn.mailbox_message_ids_injected.slice(),
    started_at: turn.started_at,
    completed_at: turn.completed_at,
    result_summary: turn.result_summary,
    verdict: turn.verdict,
    failure_reason: turn.failure_reason,
  };
  if (peerEnqueued !== null) turnRecord.peer_messages_enqueued = peerEnqueued;
  if (peerFailed !== null) turnRecord.peer_messages_failed = peerFailed;
  if (blockingFindings !== null) turnRecord.blocking_findings = blockingFindings;
  if (nonblockingFindings !== null) turnRecord.nonblocking_findings = nonblockingFindings;
  if (panelId !== null) turnRecord.panel_id = panelId;
  if (panelMemberIndex !== null) turnRecord.panel_member_index = panelMemberIndex;
  if (panelSize !== null) turnRecord.panel_size = panelSize;
  if (panelSuppressed !== null) turnRecord.panel_peer_messages_suppressed = panelSuppressed;
  // v0.9.0 slice 5b round-1 fix: persist replay/response audit fields.
  if (responseTextInline !== null) turnRecord.response_text_inline = responseTextInline;
  if (responseRef !== null) turnRecord.response_ref = responseRef;
  if (responseHash !== null) turnRecord.response_hash = responseHash;
  if (inputsHash !== null) turnRecord.inputs_hash = inputsHash;
  if (rolePromptHash !== null) turnRecord.role_prompt_hash = rolePromptHash;
  if (rolePromptVersion !== null) turnRecord.role_prompt_version = rolePromptVersion;
  if (specPath2 !== null) turnRecord.spec_path = specPath2;
  if (specSnippetHash !== null) turnRecord.spec_snippet_hash = specSnippetHash;
  if (mailboxMessageIds !== null) turnRecord.mailbox_message_ids = mailboxMessageIds;
  if (adapter !== null) turnRecord.adapter = adapter;
  if (requestedRole !== null) turnRecord.requested_role = requestedRole;
  if (taskText !== null) turnRecord.task = taskText;
  // v0.9.0 slice 8 follow-up: resolution-audit fields per spec § 7 Tier 1.
  if (resolvedCli !== null) turnRecord.resolved_cli = resolvedCli;
  if (resolutionSource !== null) turnRecord.resolution_source = resolutionSource;
  if (preferenceIndex !== null) turnRecord.preference_index = preferenceIndex;
  if (preferenceLadder !== null) turnRecord.preference_ladder = preferenceLadder;
  if (unavailableCandidates !== null) turnRecord.unavailable_candidates = unavailableCandidates;
  // fallback_reason is null-valued when no fallback occurred — persist null
  // explicitly so the gate's `f in t` presence check passes.
  if (fallbackReasonPresent) turnRecord.fallback_reason = fallbackReason;
  block.turns.push(turnRecord);
  saveSidecar(specPath, sc);
}

/**
 * Async, cross-process-safe variant of `appendExpertTurn` (v0.9.1).
 *
 * The release-gate audit truth depends on every expert turn surviving the
 * load → modify → save window. The sync `appendExpertTurn` is safe within
 * a single Node event loop (calls serialize naturally) but is NOT safe
 * across processes: two concurrent processes can lose updates as P2 loads
 * the pre-P1 state and overwrites P1's save (Codex round-1 critique).
 *
 * `appendExpertTurnLocked` wraps the same logic in `withSidecarLock` so
 * concurrent callers (across processes or async event loops) serialize.
 * Same validation contract; same return shape.
 *
 * Use this from production audit-write paths (e.g. expert-turn.js). The
 * sync `appendExpertTurn` remains for orchestrator-only paths and tests
 * that assert synchronous validation failures.
 *
 * @param {string} specPath
 * @param {object} turn — same shape as `appendExpertTurn`
 * @returns {Promise<void>}
 */
export async function appendExpertTurnLocked(specPath, turn, deps = {}) {
  return withSidecarLock(specPath, async () => {
    return appendExpertTurn(specPath, turn);
  }, deps);
}

/**
 * Update an expert's status in expert_teammates.selected[].
 * Throws if expert not present, or status not in the enum.
 *
 * @param {string} specPath
 * @param {string} expertId
 * @param {string} status — active|waiting|done|failed|archived
 */
export function updateExpertStatus(specPath, expertId, status) {
  if (!nonEmptyString(expertId)) {
    throw new Error('updateExpertStatus: expertId must be a non-empty string');
  }
  if (!VALID_EXPERT_STATUSES.has(status)) {
    throw new Error(
      `updateExpertStatus: invalid status "${status}" — must be one of ` +
        `${Array.from(VALID_EXPERT_STATUSES).join(', ')}`
    );
  }
  const sc = loadSidecar(specPath);
  const block = ensureExpertTeammatesBlock(sc);
  const entry = block.selected.find((e) => e.id === expertId);
  if (!entry) {
    throw new Error(`updateExpertStatus: expert "${expertId}" not found in selected[]`);
  }
  entry.status = status;
  saveSidecar(specPath, sc);
}

/**
 * Append a fan-out rationale entry. Only used for broad fan-outs
 * (selected_count >= 6 per spec).
 *
 * @param {string} specPath
 * @param {{phase:string, selected_count:number, rationale:string}} rec
 */
export function appendFanOutRationale(specPath, rec) {
  if (!rec || typeof rec !== 'object') {
    throw new Error('appendFanOutRationale: record must be an object');
  }
  if (!nonEmptyString(rec.phase)) {
    throw new Error('appendFanOutRationale: phase must be a non-empty string');
  }
  if (typeof rec.selected_count !== 'number' || !Number.isFinite(rec.selected_count)) {
    throw new Error('appendFanOutRationale: selected_count must be a finite number');
  }
  if (rec.selected_count <= 5) {
    throw new Error(
      `appendFanOutRationale: selected_count must be > 5 (got ${rec.selected_count}); ` +
        `fan_out_rationales only record broad fan-outs (>5 experts)`
    );
  }
  if (!nonEmptyString(rec.rationale)) {
    throw new Error('appendFanOutRationale: rationale must be a non-empty string');
  }
  const sc = loadSidecar(specPath);
  const block = ensureExpertTeammatesBlock(sc);
  block.fan_out_rationales.push({
    phase: rec.phase,
    selected_count: rec.selected_count,
    rationale: rec.rationale,
    recorded_at: new Date().toISOString(),
  });
  saveSidecar(specPath, sc);
}

/**
 * Thin reader. Returns expert_teammates.turns[] filtered by exact phase
 * match and (optional) exact slice_id match. Pure read; no mutation.
 *
 * @param {string} specPath
 * @param {{phase:string, sliceId?:string}} filter
 * @returns {object[]}
 */
export function readExpertTurns(specPath, filter = {}) {
  if (!filter || typeof filter !== 'object') {
    throw new Error('readExpertTurns: filter must be an object');
  }
  if (!nonEmptyString(filter.phase)) {
    throw new Error('readExpertTurns: filter.phase must be a non-empty string');
  }
  const sc = loadSidecar(specPath);
  const turns = sc.expert_teammates?.turns;
  if (!Array.isArray(turns)) return [];
  return turns.filter((t) => {
    if (t.phase !== filter.phase) return false;
    if (filter.sliceId !== undefined && filter.sliceId !== null) {
      if (t.slice_id !== filter.sliceId) return false;
    }
    return true;
  });
}

/**
 * Mutate an expert_blocker's disposition inside a specific dispatch record.
 *
 * locator = { sliceId, dispatched_at } — both required to disambiguate the
 * exact dispatch entry (a slice can have multiple dispatches across fallback /
 * retry flows).
 *
 * Disposition rules:
 *  - "technical-override" requires non-empty rationale AND non-empty evidence array.
 *  - "needs-user" requires non-empty rationale.
 *  - "deferred" requires non-empty rationale.
 *  - "resolved" requires nothing extra.
 *  - Throws on unknown disposition, missing dispatch, or missing finding.
 *
 * @param {string} specPath
 * @param {{sliceId:string, dispatched_at:string}} locator
 * @param {string} findingId
 * @param {{disposition:string, rationale?:string, evidence?:string[]}} update
 */
export function updateDispatchExpertBlocker(specPath, locator, findingId, update) {
  if (!locator || typeof locator !== 'object') {
    throw new Error('updateDispatchExpertBlocker: locator must be an object');
  }
  if (!nonEmptyString(locator.sliceId)) {
    throw new Error('updateDispatchExpertBlocker: locator.sliceId must be a non-empty string');
  }
  if (!nonEmptyString(locator.dispatched_at)) {
    throw new Error('updateDispatchExpertBlocker: locator.dispatched_at must be a non-empty string');
  }
  if (!nonEmptyString(findingId)) {
    throw new Error('updateDispatchExpertBlocker: findingId must be a non-empty string');
  }
  if (!update || typeof update !== 'object') {
    throw new Error('updateDispatchExpertBlocker: update must be an object');
  }
  if (!VALID_BLOCKER_DISPOSITIONS.has(update.disposition) || update.disposition === 'open') {
    throw new Error(
      `updateDispatchExpertBlocker: invalid disposition "${update.disposition}" — must be one of ` +
        `resolved, technical-override, needs-user, deferred`
    );
  }

  // Disposition-specific requirements.
  const requiresRationale = ['technical-override', 'needs-user', 'deferred'].includes(update.disposition);
  if (requiresRationale && !nonEmptyString(update.rationale)) {
    throw new Error(
      `updateDispatchExpertBlocker: disposition "${update.disposition}" requires a non-empty rationale`
    );
  }
  if (update.disposition === 'technical-override') {
    if (!Array.isArray(update.evidence) || update.evidence.length === 0) {
      throw new Error(
        `updateDispatchExpertBlocker: disposition "technical-override" requires a non-empty evidence array`
      );
    }
    for (const e of update.evidence) {
      if (!nonEmptyString(e)) {
        throw new Error(
          `updateDispatchExpertBlocker: evidence array elements must be non-empty strings`
        );
      }
    }
  }

  const sc = loadSidecar(specPath);
  const dispatches = sc.slice_reviews?.[locator.sliceId]?.phases?.implement?.dispatches;
  if (!Array.isArray(dispatches)) {
    throw new Error(
      `updateDispatchExpertBlocker: no dispatches recorded for ${locator.sliceId}`
    );
  }
  const target = dispatches.find((d) => d.dispatched_at === locator.dispatched_at);
  if (!target) {
    throw new Error(
      `updateDispatchExpertBlocker: no dispatch with dispatched_at="${locator.dispatched_at}" for ${locator.sliceId}`
    );
  }
  if (!Array.isArray(target.expert_blockers)) {
    throw new Error(
      `updateDispatchExpertBlocker: dispatch has no expert_blockers array`
    );
  }
  const blocker = target.expert_blockers.find((b) => b.finding_id === findingId);
  if (!blocker) {
    throw new Error(
      `updateDispatchExpertBlocker: finding "${findingId}" not found in dispatch expert_blockers`
    );
  }
  blocker.disposition = update.disposition;
  if (update.rationale !== undefined) blocker.rationale = update.rationale;
  if (update.evidence !== undefined) blocker.evidence = update.evidence.slice();
  blocker.dispositioned_at = new Date().toISOString();
  saveSidecar(specPath, sc);
}

/**
 * v0.7.2 — finalize an in-progress codex-background-bash dispatch.
 * Locates the most recent dispatch entry for the given slice with
 * outcome=in-progress and the matching task_id, then mutates it in place
 * with the terminal outcome + completion fields. Atomic write.
 *
 * Throws if no matching in-progress entry is found (orchestrator bug).
 *
 * @param {string} specPath
 * @param {string} sliceId
 * @param {string} taskId
 * @param {{outcome:string, head_sha?:string, commit_count?:number, completed_at:string, concerns?:string[]}} terminal
 */
export function finalizeImplementDispatch(specPath, sliceId, taskId, terminal) {
  if (!terminal || typeof terminal !== 'object') {
    throw new Error('finalizeImplementDispatch: terminal must be an object');
  }
  if (!VALID_IMPLEMENT_OUTCOMES.has(terminal.outcome) || terminal.outcome === 'in-progress') {
    throw new Error(
      `finalizeImplementDispatch: terminal.outcome must be a non-in-progress outcome ` +
        `(got "${terminal.outcome}")`
    );
  }
  if (typeof terminal.completed_at !== 'string' || terminal.completed_at.length === 0) {
    throw new Error('finalizeImplementDispatch: terminal.completed_at must be a non-empty string');
  }

  const sc = loadSidecar(specPath);
  const impl = sc.slice_reviews?.[sliceId]?.phases?.implement;
  if (!impl || !Array.isArray(impl.dispatches)) {
    throw new Error(`finalizeImplementDispatch: no dispatches recorded for ${sliceId}`);
  }
  // Walk backward to find the matching in-progress entry.
  let target = -1;
  for (let i = impl.dispatches.length - 1; i >= 0; i--) {
    const d = impl.dispatches[i];
    if (d.outcome === 'in-progress' && d.task_id === taskId) {
      target = i;
      break;
    }
  }
  if (target < 0) {
    throw new Error(
      `finalizeImplementDispatch: no in-progress dispatch with task_id="${taskId}" for ${sliceId}`
    );
  }
  const d = impl.dispatches[target];
  d.outcome = terminal.outcome;
  d.completed_at = terminal.completed_at;
  if (terminal.head_sha !== undefined) d.head_sha = terminal.head_sha;
  if (terminal.commit_count !== undefined) d.commit_count = terminal.commit_count;
  if (Array.isArray(terminal.concerns)) d.concerns = terminal.concerns;
  saveSidecar(specPath, sc);
}

export function setAutopilot(specPath, autopilotBlock) {
  const sc = loadSidecar(specPath);
  sc.autopilot = autopilotBlock;
  saveSidecar(specPath, sc);
}

/**
 * v0.7.3 — set autopilot.dependency_graph block. Used by Phase B.PRE on first
 * autopilot session start. Atomic via existing temp+rename helper.
 *
 * @param {string} specPath
 * @param {{digest: string, dag: object}} graphBlock
 */
export function setDependencyGraph(specPath, graphBlock) {
  if (!graphBlock || typeof graphBlock !== 'object') {
    throw new Error('setDependencyGraph: graphBlock must be an object');
  }
  if (typeof graphBlock.digest !== 'string' || graphBlock.digest.length === 0) {
    throw new Error('setDependencyGraph: graphBlock.digest must be a non-empty string');
  }
  if (!graphBlock.dag || typeof graphBlock.dag !== 'object') {
    throw new Error('setDependencyGraph: graphBlock.dag must be an object');
  }
  const sc = loadSidecar(specPath);
  if (!sc.autopilot) sc.autopilot = {};
  sc.autopilot.dependency_graph = {
    digest: graphBlock.digest,
    dag: graphBlock.dag,
    persisted_at: new Date().toISOString(),
  };
  saveSidecar(specPath, sc);
}

/**
 * v0.7.3 — get the persisted dependency_graph block, or null if absent.
 * Phase B.PRE uses this to decide whether to persist (first call) vs
 * verify (subsequent calls).
 */
export function getDependencyGraph(specPath) {
  const sc = loadSidecar(specPath);
  return sc.autopilot?.dependency_graph ?? null;
}

export function getAutopilot(specPath) {
  const sc = loadSidecar(specPath);
  return sc.autopilot ?? null;
}

// --- v0.10.1: goals block + audit log -------------------------------------
//
// Goals: the user-outcome block extracted from the spec / user intent. Pinned
// once in brainstorming, re-read on every round of writing-plans + the spec
// revision loop so Codex critiques against the right target. See
// skills/brainstorming/SKILL.md "Goal extraction" and skills/writing-plans/
// SKILL.md "Goals extraction" sections.
//
// Audits: every codebase audit Codex (or Claude) performs becomes a structured,
// replayable event. The audit array is append-only and indexed by (phase, round,
// side) so a SHIP verdict can be cross-checked against its evidence.

/**
 * v0.10.1 — set the goals block (overwrites prior value; goals are invariant
 * within a session but the user MAY revise them, so we don't append-only here).
 *
 * @param {string} specPath
 * @param {{block: string}} goalsBlock — `block` is the verbatim
 *   `<<<GOALS>>>...<<<END_GOALS>>>` text. Stored as-is so downstream prompt
 *   composition is byte-deterministic.
 */
export function setGoals(specPath, goalsBlock) {
  if (!goalsBlock || typeof goalsBlock !== 'object') {
    throw new Error('setGoals: goalsBlock must be an object');
  }
  if (typeof goalsBlock.block !== 'string' || goalsBlock.block.length === 0) {
    throw new Error('setGoals: goalsBlock.block must be a non-empty string');
  }
  if (!goalsBlock.block.includes('<<<GOALS>>>') || !goalsBlock.block.includes('<<<END_GOALS>>>')) {
    throw new Error('setGoals: goalsBlock.block must contain <<<GOALS>>> and <<<END_GOALS>>> delimiters');
  }
  const sc = loadSidecar(specPath);
  sc.goals = {
    block: goalsBlock.block,
    persisted_at: new Date().toISOString(),
  };
  saveSidecar(specPath, sc);
}

/**
 * v0.10.1 — get the persisted goals block, or null if absent.
 */
export function getGoals(specPath) {
  const sc = loadSidecar(specPath);
  return sc.goals ?? null;
}

/**
 * v0.11.0 — app-autopilot state. An app-scoped spec rolls out across many
 * plans; this block tracks which goals have been audited as shipped (by which
 * plan), and which plans have shipped so far. Lazily initialized — sidecars
 * without an `app_state` block continue to work for single-plan flows.
 *
 * Schema:
 *   app_state.goals : Array<{ id, text, audited_shipped: boolean, shipped_by_plan: string|null, shipped_at: ISO|null }>
 *   app_state.plans : Array<{ path, shipped: boolean, audited_goals: string[], shipped_at: ISO|null }>
 *   app_state.active_plan : string|null   (path of the plan autopilot is currently executing)
 *   app_state.initialized_at : ISO string
 *
 * Goal ids: short slugs derived from the goal text by the caller (e.g. "goal-1",
 * "goal-user-signup"). The caller chooses; this module just stores them.
 */
export function initAppState(specPath, { goals }) {
  if (!Array.isArray(goals) || goals.length === 0) {
    throw new Error('initAppState: goals must be a non-empty array');
  }
  for (const [i, g] of goals.entries()) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      throw new Error(`initAppState: goals[${i}] must be a plain object`);
    }
    if (typeof g.id !== 'string' || g.id.length === 0) {
      throw new Error(`initAppState: goals[${i}].id must be a non-empty string`);
    }
    if (typeof g.text !== 'string' || g.text.length === 0) {
      throw new Error(`initAppState: goals[${i}].text must be a non-empty string`);
    }
  }
  const sc = loadSidecar(specPath);
  sc.app_state = {
    initialized_at: new Date().toISOString(),
    goals: goals.map((g) => ({
      id: g.id,
      text: g.text,
      audited_shipped: false,
      shipped_by_plan: null,
      shipped_at: null,
    })),
    plans: [],
    active_plan: null,
  };
  saveSidecar(specPath, sc);
  return sc.app_state;
}

export function getAppState(specPath) {
  const sc = loadSidecar(specPath);
  return sc.app_state ?? null;
}

/**
 * Mark a goal as audited-shipped by a specific plan. Idempotent: a second call
 * with the same (goalId, planPath) is a no-op. Throws if goalId is unknown.
 */
export function markGoalShipped(specPath, { goalId, planPath }) {
  if (typeof goalId !== 'string' || goalId.length === 0) {
    throw new Error('markGoalShipped: goalId must be a non-empty string');
  }
  if (typeof planPath !== 'string' || planPath.length === 0) {
    throw new Error('markGoalShipped: planPath must be a non-empty string');
  }
  const sc = loadSidecar(specPath);
  if (!sc.app_state || !Array.isArray(sc.app_state.goals)) {
    throw new Error('markGoalShipped: app_state not initialized; call initAppState first');
  }
  const g = sc.app_state.goals.find((x) => x.id === goalId);
  if (!g) {
    throw new Error(`markGoalShipped: unknown goalId ${JSON.stringify(goalId)}`);
  }
  if (g.audited_shipped && g.shipped_by_plan === planPath) {
    return sc.app_state; // idempotent
  }
  g.audited_shipped = true;
  g.shipped_by_plan = planPath;
  g.shipped_at = new Date().toISOString();
  // Mirror onto the plan record if present.
  const planRec = sc.app_state.plans.find((p) => p.path === planPath);
  if (planRec) {
    if (!planRec.audited_goals.includes(goalId)) planRec.audited_goals.push(goalId);
  }
  saveSidecar(specPath, sc);
  return sc.app_state;
}

/**
 * Record that a plan has started executing (active_plan pointer) or has
 * finished (shipped: true). Either or both fields may be supplied.
 */
export function setAppPlan(specPath, { planPath, started, shipped }) {
  if (typeof planPath !== 'string' || planPath.length === 0) {
    throw new Error('setAppPlan: planPath must be a non-empty string');
  }
  const sc = loadSidecar(specPath);
  if (!sc.app_state) {
    throw new Error('setAppPlan: app_state not initialized; call initAppState first');
  }
  let rec = sc.app_state.plans.find((p) => p.path === planPath);
  if (!rec) {
    rec = { path: planPath, shipped: false, audited_goals: [], shipped_at: null };
    sc.app_state.plans.push(rec);
  }
  if (started === true) {
    sc.app_state.active_plan = planPath;
  }
  if (shipped === true) {
    rec.shipped = true;
    rec.shipped_at = new Date().toISOString();
    if (sc.app_state.active_plan === planPath) {
      sc.app_state.active_plan = null;
    }
  }
  saveSidecar(specPath, sc);
  return sc.app_state;
}

/**
 * v0.10.1 — append a structured audit-log entry. Used by writing-plans /
 * brainstorming when Codex (or Claude) reports the commands it ran to audit
 * the artifact against the codebase.
 *
 * Schema (all required unless noted):
 *   phase:    'spec' | 'plan' | 'slice:N'
 *   round:    positive integer
 *   side:     'claude' | 'codex'
 *   commands: Array<{ cmd: string, summary: string, ran_at?: string }>
 *             (summary is a short prose result; full output should be stored
 *             elsewhere — see storeResponse — and referenced if needed)
 *   verdict_basis?: string  — one-line summary of how the audit informed the
 *                             verdict
 *
 * @param {string} specPath
 * @param {object} audit
 */
export function appendAuditLog(specPath, audit) {
  // v0.13.0: validation/normalization is shared with appendRoundWithAudits via normalizeAuditEntry.
  const entry = normalizeAuditEntry(audit);
  const sc = loadSidecar(specPath);
  if (!Array.isArray(sc.audits)) sc.audits = [];
  sc.audits.push(entry);
  saveSidecar(specPath, sc);
}

/**
 * v0.10.1 — list audits, optionally filtered by phase / round / side.
 * Returns a fresh array; mutations to the result do not affect the sidecar.
 *
 * @param {string} specPath
 * @param {{phase?: string, round?: number, side?: 'claude'|'codex'}} [filter]
 */
export function listAudits(specPath, filter = {}) {
  const sc = loadSidecar(specPath);
  const all = Array.isArray(sc.audits) ? sc.audits : [];
  return all.filter((a) => {
    if (filter.phase !== undefined && a.phase !== filter.phase) return false;
    if (filter.round !== undefined && a.round !== filter.round) return false;
    if (filter.side !== undefined && a.side !== filter.side) return false;
    return true;
  }).map((a) => ({ ...a, commands: a.commands.map((c) => ({ ...c })) }));
}

/**
 * v0.10.1 — has the (phase, round, side) triple been audited? Used by the
 * honest-reporting Stop-gate to decide whether a SHIP verdict has evidence.
 */
export function hasAuditFor(specPath, { phase, round, side }) {
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new Error('hasAuditFor: phase must be a non-empty string');
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('hasAuditFor: round must be a positive integer');
  }
  if (side !== 'claude' && side !== 'codex') {
    throw new Error(`hasAuditFor: side must be 'claude' or 'codex'; got ${JSON.stringify(side)}`);
  }
  const sc = loadSidecar(specPath);
  if (!Array.isArray(sc.audits)) return false;
  return sc.audits.some((a) => a.phase === phase && a.round === round && a.side === side);
}

// v0.13.0 — audit command kinds. `verification` means an executed test/build (carries exit_code);
// `inspection` is a read-only codebase audit (grep/find/git log); `other` is anything else.
const VALID_AUDIT_KINDS = new Set(['inspection', 'verification', 'other']);

// v0.13.0 — code-bearing phases require EXECUTED verification before a SHIP can be logged.
// Design phases (spec, plan, plan-slice:<id>) keep the v0.10.1 inspection-audit gate.
// Unknown phases default to inspection-only unless added to this allowlist.
const CODE_BEARING_PHASE_RE = /^(implement|review-slice|live-verification|post-merge-review):/;

/**
 * v0.13.0 — does this phase require an executed-verification audit (not just inspection)?
 * @param {string} phase
 * @returns {boolean}
 */
export function requiresExecutedVerification(phase) {
  return typeof phase === 'string' && CODE_BEARING_PHASE_RE.test(phase);
}

/**
 * v0.13.0 — has the (phase, round, side) triple recorded at least one successfully EXECUTED
 * verification command (kind: 'verification', exit_code: 0)? Used by the SHIP gate for
 * code-bearing phases. Legacy audits without `kind` never satisfy this.
 */
export function hasExecutedVerificationFor(specPath, { phase, round, side }) {
  if (typeof phase !== 'string' || phase.length === 0) {
    throw new Error('hasExecutedVerificationFor: phase must be a non-empty string');
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('hasExecutedVerificationFor: round must be a positive integer');
  }
  if (side !== 'claude' && side !== 'codex') {
    throw new Error(`hasExecutedVerificationFor: side must be 'claude' or 'codex'; got ${JSON.stringify(side)}`);
  }
  const sc = loadSidecar(specPath);
  if (!Array.isArray(sc.audits)) return false;
  return sc.audits.some((a) =>
    a.phase === phase && a.round === round && a.side === side &&
    Array.isArray(a.commands) && a.commands.some(isExecutedVerificationCommand),
  );
}

/**
 * v0.13.0 — is this command valid executed-verification evidence?
 * A passing verification command counts UNLESS it carries a test-impact-analysis `selection` that
 * shows zero tests actually ran (mode 'none' or ran 0). This stops "I ran the affected subset, which
 * was empty → SHIP" from satisfying the code-bearing floor. A 'selected' run is sufficient (it is
 * fullyCovered by construction); an 'all' run is the safe default.
 */
export function isExecutedVerificationCommand(c) {
  if (!c || c.kind !== 'verification' || c.exit_code !== 0) return false;
  const s = c.selection;
  if (!s) return true; // non-TIA verification (e.g. a raw `npm test`) — trusted as before.
  // TIA-bearing verification must have actually run tests, and a selected subset must be complete.
  if (typeof s.ran !== 'number' || s.ran <= 0) return false; // ran nothing (or malformed)
  if (s.mode === 'all') return true;
  // A selected subset counts only when it provably covered every changed source: fullyCovered AND an
  // explicitly empty uncovered array (missing/non-array/non-empty all fail closed).
  if (s.mode === 'selected') return s.fullyCovered === true && Array.isArray(s.uncovered) && s.uncovered.length === 0;
  return false; // 'none' or unknown mode
}

// ── v0.13.0 Slice 3 — Codex thread-loss recovery (Goal 3) ──────────────────

/**
 * Rotate the persisted Codex thread id after a stale-thread recovery. Updates the legacy
 * `codex_session` field (for paired-reviewer) AND `role_sessions[role]`, and appends a
 * `thread_rotations[]` audit entry — all under the sidecar lock in one save.
 */
export async function setCodexThreadId(
  specPath,
  { role = 'paired-reviewer', oldThreadId, newThreadId, reason, phase, round } = {},
) {
  if (typeof newThreadId !== 'string' || newThreadId.length === 0) {
    throw new Error('setCodexThreadId: newThreadId must be a non-empty string');
  }
  return withSidecarLock(specPath, () => {
    const sc = loadSidecar(specPath);
    if (!sc.role_sessions || typeof sc.role_sessions !== 'object') sc.role_sessions = {};
    sc.role_sessions[role] = newThreadId;
    if (role === 'paired-reviewer') sc.codex_session = newThreadId;
    if (!Array.isArray(sc.thread_rotations)) sc.thread_rotations = [];
    sc.thread_rotations.push({
      old_thread_id: oldThreadId ?? null,
      new_thread_id: newThreadId,
      role,
      reason: reason ?? null,
      phase: phase ?? null,
      round: Number.isInteger(round) ? round : null,
      rotated_at: new Date().toISOString(),
    });
    saveSidecar(specPath, sc);
    return sc;
  });
}

/**
 * Classify a Codex MCP response as a stale-thread failure ("Session not found for thread_id").
 * @param {{isError?: boolean, content?: any}} resp
 * @returns {boolean}
 */
export function isStaleThreadResponse(resp) {
  if (!resp || resp.isError !== true) return false;
  const text = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content ?? resp);
  return /Session not found for thread_id:/.test(text);
}

/**
 * Extract the `<<<GOALS>>>...<<<END_GOALS>>>` block directly from the spec file.
 * Used as the fallback when goals were never persisted to the sidecar (spec §5.3 step 1).
 */
export function extractGoalsBlockFromSpec(specPath) {
  let text;
  try { text = readFileSync(specPath, 'utf8'); } catch { return null; }
  const m = /<<<GOALS>>>[\s\S]*?<<<END_GOALS>>>/.exec(text);
  return m ? m[0] : null;
}

/**
 * Build a compact replay context for re-seeding a fresh Codex thread after loss.
 * NOTE: distinct from lib/codex-bridge/replay.js (turn-integrity replay) — this is a
 * sidecar-summary builder for thread recovery.
 */
export function buildReplayContext(specPath) {
  const sc = loadSidecar(specPath);
  const persisted = getGoals(specPath); // { block, persisted_at } | null
  const goalsBlock = (persisted && persisted.block) || extractGoalsBlockFromSpec(specPath);
  return {
    feature: sc.feature ?? null,
    artifact: specPath,
    goals: goalsBlock ?? null,
    rounds: (sc.rounds ?? []).map((r) => ({ phase: r.phase, round: r.round, claude: r.claude, codex: r.codex })),
    open_contentions: sc.open_contentions ?? [],
    thread_rotations: sc.thread_rotations ?? [],
  };
}

// ── v0.13.0 Slice 4 — atomic round+audit logging (Goal 4) ──────────────────

// Shared audit validation/normalization — single source of truth for appendAuditLog AND
// appendRoundWithAudits so the schema rules cannot drift between the two paths.
function normalizeAuditEntry(audit) {
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    throw new Error('audit entry must be a plain object');
  }
  if (typeof audit.phase !== 'string' || audit.phase.length === 0) {
    throw new Error('audit entry: phase must be a non-empty string');
  }
  if (!Number.isInteger(audit.round) || audit.round < 1) {
    throw new Error('audit entry: round must be a positive integer');
  }
  if (audit.side !== 'claude' && audit.side !== 'codex') {
    throw new Error(`audit entry: side must be 'claude' or 'codex'; got ${JSON.stringify(audit.side)}`);
  }
  if (!Array.isArray(audit.commands) || audit.commands.length === 0) {
    throw new Error('audit entry: commands must be a non-empty array');
  }
  for (const [i, c] of audit.commands.entries()) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`audit entry: commands[${i}] must be a plain object`);
    }
    if (typeof c.cmd !== 'string' || c.cmd.length === 0) {
      throw new Error(`audit entry: commands[${i}].cmd must be a non-empty string`);
    }
    if (typeof c.summary !== 'string' || c.summary.length === 0) {
      throw new Error(`audit entry: commands[${i}].summary must be a non-empty string`);
    }
    if (!VALID_AUDIT_KINDS.has(c.kind)) {
      throw new Error(`audit entry: commands[${i}].kind must be one of inspection|verification|other`);
    }
    if (c.kind === 'verification' && !Number.isInteger(c.exit_code)) {
      throw new Error(`audit entry: commands[${i}].exit_code must be an integer for kind "verification"`);
    }
    // Optional v0.13.0 TIA selection record: when present it is gate-relevant evidence, so require a
    // string `mode` AND a non-negative integer `ran` (how many tests actually ran). This closes the
    // "selection without ran silently counts" gate bypass.
    if (c.selection !== undefined) {
      const s = c.selection;
      if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.mode !== 'string') {
        throw new Error(`audit entry: commands[${i}].selection must be an object with a string "mode"`);
      }
      if (!Number.isInteger(s.ran) || s.ran < 0) {
        throw new Error(`audit entry: commands[${i}].selection.ran must be a non-negative integer`);
      }
      if (s.uncovered !== undefined && !Array.isArray(s.uncovered)) {
        throw new Error(`audit entry: commands[${i}].selection.uncovered must be an array when present`);
      }
      // Reject contradictory provenance: a selection.exit must match the command's exit_code.
      if (s.exit !== undefined && s.exit !== c.exit_code) {
        throw new Error(`audit entry: commands[${i}].selection.exit (${s.exit}) contradicts exit_code (${c.exit_code})`);
      }
    }
  }
  if (audit.verdict_basis !== undefined && (typeof audit.verdict_basis !== 'string' || audit.verdict_basis.length === 0)) {
    throw new Error('audit entry: verdict_basis must be a non-empty string when present');
  }
  return {
    phase: audit.phase,
    round: audit.round,
    side: audit.side,
    commands: audit.commands.map((c) => ({
      cmd: c.cmd,
      summary: c.summary,
      kind: c.kind,
      ...(c.kind === 'verification' ? { exit_code: c.exit_code } : {}),
      ...(c.selection !== undefined ? { selection: c.selection } : {}),
      ran_at: typeof c.ran_at === 'string' && c.ran_at.length > 0 ? c.ran_at : new Date().toISOString(),
    })),
    verdict_basis: audit.verdict_basis ?? null,
    appended_at: new Date().toISOString(),
  };
}

const SHIP_VERDICT_RE = /^\s*SHIP(?![A-Z0-9_])/;

// Validate that every side claiming SHIP in `round` is backed by audit evidence in `scope`
// (existing + incoming audits). Design phases need an audit entry; code-bearing phases need a
// successful executed verification command. Throws (with the offending side) if unsatisfied.
function assertRoundShipBacked(round, scope) {
  const codeBearing = requiresExecutedVerification(round.phase);
  for (const side of ['claude', 'codex']) {
    const verdict = round[side];
    if (typeof verdict !== 'string' || !SHIP_VERDICT_RE.test(verdict)) continue;
    const entries = scope.filter((a) => a.phase === round.phase && a.round === round.round && a.side === side);
    if (codeBearing) {
      const ok = entries.some((a) => Array.isArray(a.commands) && a.commands.some(isExecutedVerificationCommand));
      if (!ok) {
        throw new Error(`appendRoundWithAudits: ${side} SHIP in code-bearing phase ${round.phase} requires a successful kind:"verification" command (exit_code 0) that actually ran tests`);
      }
    } else if (entries.length === 0) {
      throw new Error(`appendRoundWithAudits: ${side} SHIP in ${round.phase} requires an audit entry for that side`);
    }
  }
}

/**
 * v0.13.0 — atomically append audits AND the round in a single locked mutation. Validates all
 * audits and the round's SHIP-backing against in-memory state BEFORE writing; if anything fails,
 * nothing is persisted. This is the happy-path replacement for separate sidecar-append-audit then
 * sidecar-append-round, removing the runtime mis-order that surfaced as PreToolUse hook errors.
 */
export async function appendRoundWithAudits(specPath, { audits, round } = {}) {
  if (!Array.isArray(audits)) throw new Error('appendRoundWithAudits: audits must be an array');
  if (!round || typeof round !== 'object' || Array.isArray(round)) {
    throw new Error('appendRoundWithAudits: round must be a plain object');
  }
  return withSidecarLock(specPath, () => {
    const sc = loadSidecar(specPath);
    if (!Array.isArray(sc.audits)) sc.audits = [];
    if (!Array.isArray(sc.rounds)) sc.rounds = [];
    const normalized = audits.map((a) => normalizeAuditEntry(a)); // throws → nothing saved
    assertRoundShipBacked(round, sc.audits.concat(normalized));    // throws → nothing saved
    for (const a of normalized) sc.audits.push(a);
    sc.rounds.push(round);
    saveSidecar(specPath, sc);
    return sc;
  });
}

// --- v0.10.0 slice 2: implementer_experts schema + locked event append ------
//
// Spec: docs/architecture/2026-05-12-v0.10.0-implementer-experts-design.md
// §L405-423 (block shape), §L431-449 (event shape), §L451-468 (required + optional
// fields), §L470 (monotonic event_seq per sidecar file), §L474-488 (event_type enum).
//
// Contract:
//   - startImplementerRun, appendImplementerEventLocked, completeImplementerRun
//     are all async + wrap withSidecarLock. Validation runs to completion BEFORE
//     any mutation of sidecar state so a rejected call leaves events[] byte-
//     equivalent (no partial writes).
//   - event_seq is monotonic GLOBAL across slice_reviews[*].phases.implementer_experts.events[].
//     The value is computed by scanning every slice's events array under the lock.
//   - Cross-field validation: events must reference an active run on the named
//     slice, and (member_id, runtime_kind, worktree_id) must match the run's
//     registered member entry.
//   - Legacy sibling phases.implement is preserved (slice 2 must not regress
//     v0.7.x behavior).

const IMPLEMENTER_EVENT_TYPES = new Set([
  'started',
  'mailbox_poll',
  'mailbox_delivered',
  'mailbox_sent',
  'checkpoint',
  'completed',
  'failed',
  'cancelled',
  'halted',
  'merge_started',
  'merge_conflict',
  'merge_resolved',
  'post_merge_review',
  // v0.10.0 slice-8 merger-agent event types
  'merger_started',
  'merger_completed',
  'merge_review_claude',
  'merge_review_codex',
]);

const REQUIRED_IMPLEMENTER_EVENT_FIELDS = [
  'event_type',
  'implementer_run_id',
  'slice_id',
  'member_id',
  'runtime_kind',
  'worktree_id',
  'payload_hash',
  'payload',
];

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function ensureImplementerExpertsBlock(sc, sliceId) {
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  return sc.slice_reviews[sliceId].phases;
}

function validateStartRun(sliceId, run) {
  if (!nonEmptyString(sliceId)) {
    throw new Error('startImplementerRun: sliceId must be a non-empty string');
  }
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new Error('startImplementerRun: run must be a plain object');
  }
  if (!nonEmptyString(run.base_sha)) {
    throw new Error('startImplementerRun: run.base_sha must be a non-empty string');
  }
  if (!run.members || typeof run.members !== 'object' || Array.isArray(run.members)) {
    throw new Error('startImplementerRun: run.members must be a plain object');
  }
  const memberIds = Object.keys(run.members);
  if (memberIds.length === 0) {
    throw new Error('startImplementerRun: run.members must have at least one entry');
  }
  for (const memberId of memberIds) {
    const m = run.members[memberId];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new Error(
        `startImplementerRun: members[${memberId}] must be a plain object`
      );
    }
    if (!nonEmptyString(m.adapter)) {
      throw new Error(`startImplementerRun: members[${memberId}].adapter must be non-empty`);
    }
    if (!nonEmptyString(m.model)) {
      throw new Error(`startImplementerRun: members[${memberId}].model must be non-empty`);
    }
    if (typeof m.required !== 'boolean') {
      throw new Error(`startImplementerRun: members[${memberId}].required must be boolean`);
    }
    if (!nonEmptyString(m.worktree_id)) {
      throw new Error(`startImplementerRun: members[${memberId}].worktree_id must be non-empty`);
    }
    if (!nonEmptyString(m.branch)) {
      throw new Error(`startImplementerRun: members[${memberId}].branch must be non-empty`);
    }
    if (!Array.isArray(m.claimed_files)) {
      throw new Error(`startImplementerRun: members[${memberId}].claimed_files must be an array`);
    }
  }
}

/**
 * Initialize the phases.implementer_experts block on a slice.
 * Async + locked: concurrent start↔append cannot lose the freshly-initialized
 * block. Preserves any sibling phases.implement object unchanged.
 *
 * @param {string} specPath
 * @param {string} sliceId — e.g. "slice-3"
 * @param {{base_sha:string, members:{[memberId:string]:{adapter,model,required,worktree_id,branch,claimed_files}}}} run
 * @param {object} deps — optional dep injection (lockfile override for tests)
 * @returns {Promise<{implementer_run_id:string}>}
 */
export async function startImplementerRun(specPath, sliceId, run, deps = {}) {
  validateStartRun(sliceId, run);
  return withSidecarLock(specPath, async () => {
    const sc = loadSidecar(specPath);
    const phases = ensureImplementerExpertsBlock(sc, sliceId);
    if (phases.implementer_experts && phases.implementer_experts.status === 'running') {
      throw new Error(
        `startImplementerRun: slice "${sliceId}" already has a running implementer_experts run ` +
          `(${phases.implementer_experts.implementer_run_id})`
      );
    }
    const implementerRunId = randomUUID();
    const members = {};
    for (const [memberId, m] of Object.entries(run.members)) {
      members[memberId] = {
        adapter: m.adapter,
        model: m.model,
        required: m.required,
        worktree_id: m.worktree_id,
        branch: m.branch,
        claimed_files: [...m.claimed_files],
      };
    }
    phases.implementer_experts = {
      implementer_run_id: implementerRunId,
      base_sha: run.base_sha,
      started_at: new Date().toISOString(),
      completed_at: null,
      status: 'running',
      members,
      events: [],
      merge: null,
      post_merge_review: null,
    };
    saveSidecar(specPath, sc);
    return { implementer_run_id: implementerRunId };
  }, deps);
}

function validateEventShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('appendImplementerEventLocked: event must be a plain object');
  }
  if ('event_seq' in event) {
    throw new Error(
      'appendImplementerEventLocked: callers must not set event_seq — assigned inside the lock'
    );
  }
  for (const field of REQUIRED_IMPLEMENTER_EVENT_FIELDS) {
    if (!(field in event)) {
      throw new Error(`appendImplementerEventLocked: missing required field "${field}"`);
    }
    const v = event[field];
    if (field === 'payload') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('appendImplementerEventLocked: payload must be a plain object');
      }
      continue;
    }
    if (!nonEmptyString(v)) {
      throw new Error(
        `appendImplementerEventLocked: ${field} must be a non-empty string`
      );
    }
  }
  if (!IMPLEMENTER_EVENT_TYPES.has(event.event_type)) {
    throw new Error(
      `appendImplementerEventLocked: invalid event_type "${event.event_type}" — must be one of ` +
        Array.from(IMPLEMENTER_EVENT_TYPES).join(', ')
    );
  }
  if (!SHA256_RE.test(event.payload_hash)) {
    throw new Error(
      `appendImplementerEventLocked: payload_hash must match ^sha256:[0-9a-f]{64}$ (got "${event.payload_hash}")`
    );
  }
  // Enforce the hash invariant: payload_hash must equal sha256(JSON.stringify(payload)).
  // A caller could supply a well-formed but wrong hash — we reject that here, before
  // lock acquisition, so malformed calls never touch state.
  {
    const expectedHash = 'sha256:' + createHash('sha256').update(JSON.stringify(event.payload)).digest('hex');
    if (event.payload_hash !== expectedHash) {
      throw new Error(
        `appendImplementerEventLocked: payload_hash mismatch — expected ${expectedHash} but got ${event.payload_hash}`
      );
    }
  }
  if ('inputs_hash' in event && event.inputs_hash !== undefined && event.inputs_hash !== null) {
    if (!nonEmptyString(event.inputs_hash) || !SHA256_RE.test(event.inputs_hash)) {
      throw new Error(
        `appendImplementerEventLocked: inputs_hash must match ^sha256:[0-9a-f]{64}$ when present (got "${event.inputs_hash}")`
      );
    }
  }
  if ('turn_id' in event && event.turn_id !== undefined && event.turn_id !== null) {
    if (!nonEmptyString(event.turn_id)) {
      throw new Error('appendImplementerEventLocked: turn_id must be a non-empty string when present');
    }
  }
  if ('mailbox_message_id' in event && event.mailbox_message_id !== undefined && event.mailbox_message_id !== null) {
    if (!nonEmptyString(event.mailbox_message_id)) {
      throw new Error('appendImplementerEventLocked: mailbox_message_id must be a non-empty string when present');
    }
  }
  if ('parent_event_seq' in event && event.parent_event_seq !== undefined && event.parent_event_seq !== null) {
    const p = event.parent_event_seq;
    if (!Number.isInteger(p) || p <= 0) {
      throw new Error(
        `appendImplementerEventLocked: parent_event_seq must be a positive integer when present (got ${p})`
      );
    }
  }
}

function computeGlobalMaxEventSeq(sc) {
  let max = 0;
  const slices = sc.slice_reviews || {};
  for (const sliceId of Object.keys(slices)) {
    const events = slices[sliceId]?.phases?.implementer_experts?.events;
    if (!Array.isArray(events)) continue;
    for (const e of events) {
      if (typeof e.event_seq === 'number' && e.event_seq > max) max = e.event_seq;
    }
  }
  return max;
}

/**
 * Append an event to the implementer_experts.events[] of a slice.
 * Async + locked. Assigns event_seq globally monotonic across all slices in this
 * sidecar file (spec § L470). Validation runs to completion before any state
 * mutation; rejected calls leave events[] byte-equivalent.
 *
 * Cross-field validation against the active run on the named slice:
 *   - the slice must have a running implementer_experts run
 *   - event.implementer_run_id must match the run's implementer_run_id
 *   - event.member_id must be a registered member of the run
 *   - event.runtime_kind must equal members[member_id].adapter
 *   - event.worktree_id must equal members[member_id].worktree_id
 *   - parent_event_seq (if set) must be ≤ current global max event_seq
 *
 * @param {string} specPath
 * @param {object} event
 * @param {object} deps — optional dep injection (lockfile override for tests)
 * @returns {Promise<{event_seq:number}>}
 */
export async function appendImplementerEventLocked(specPath, event, deps = {}) {
  validateEventShape(event);
  // Canary scan: reject payloads containing secret patterns BEFORE lock acquisition.
  // This preserves the audit-hash invariant: payload_hash === sha256(JSON.stringify(payload))
  // for every persisted event. Secrets must be redacted at the call site.
  if (containsCanary(event.payload)) {
    throw new Error(
      'appendImplementerEventLocked: payload contains a redacted-secret pattern; sanitize at the call site'
    );
  }
  return withSidecarLock(specPath, async () => {
    const sc = loadSidecar(specPath);
    const run = sc.slice_reviews?.[event.slice_id]?.phases?.implementer_experts;
    if (!run) {
      throw new Error(
        `appendImplementerEventLocked: slice "${event.slice_id}" has no implementer_experts run`
      );
    }
    if (run.implementer_run_id !== event.implementer_run_id) {
      throw new Error(
        `appendImplementerEventLocked: event.implementer_run_id "${event.implementer_run_id}" ` +
          `does not match the active run "${run.implementer_run_id}" on slice "${event.slice_id}"`
      );
    }
    const member = run.members?.[event.member_id];
    if (!member) {
      throw new Error(
        `appendImplementerEventLocked: member "${event.member_id}" is not registered on slice "${event.slice_id}"`
      );
    }
    if (member.adapter !== event.runtime_kind) {
      throw new Error(
        `appendImplementerEventLocked: event.runtime_kind "${event.runtime_kind}" does not match ` +
          `members["${event.member_id}"].adapter "${member.adapter}"`
      );
    }
    if (member.worktree_id !== event.worktree_id) {
      throw new Error(
        `appendImplementerEventLocked: event.worktree_id "${event.worktree_id}" does not match ` +
          `members["${event.member_id}"].worktree_id "${member.worktree_id}"`
      );
    }
    const globalMax = computeGlobalMaxEventSeq(sc);
    if (event.parent_event_seq !== undefined && event.parent_event_seq !== null) {
      if (event.parent_event_seq > globalMax) {
        throw new Error(
          `appendImplementerEventLocked: parent_event_seq ${event.parent_event_seq} ` +
            `exceeds current global max event_seq ${globalMax}`
        );
      }
    }
    const nextSeq = globalMax + 1;
    const stored = {
      event_seq: nextSeq,
      event_type: event.event_type,
      implementer_run_id: event.implementer_run_id,
      slice_id: event.slice_id,
      member_id: event.member_id,
      runtime_kind: event.runtime_kind,
      worktree_id: event.worktree_id,
      payload_hash: event.payload_hash,
      payload: event.payload,
    };
    if (event.turn_id !== undefined && event.turn_id !== null) stored.turn_id = event.turn_id;
    if (event.parent_event_seq !== undefined && event.parent_event_seq !== null) {
      stored.parent_event_seq = event.parent_event_seq;
    }
    if (event.mailbox_message_id !== undefined && event.mailbox_message_id !== null) {
      stored.mailbox_message_id = event.mailbox_message_id;
    }
    if (event.inputs_hash !== undefined && event.inputs_hash !== null) {
      stored.inputs_hash = event.inputs_hash;
    }
    run.events.push(stored);
    saveSidecar(specPath, sc);
    return { event_seq: nextSeq };
  }, deps);
}

const VALID_IMPLEMENTER_RUN_STATUSES = new Set([
  'running',
  'completed',
  'failed',
  'cancelled',
  'halted',
]);

/**
 * Complete an implementer run on a slice. Async + locked so concurrent appends
 * cannot be lost via a load-modify-save race with this call. Throws if the run
 * id doesn't match the active run on the slice.
 *
 * @param {string} specPath
 * @param {string} sliceId
 * @param {string} implementerRunId
 * @param {{status:string, completed_at?:string, merge?:object|null, post_merge_review?:object|null}} result
 * @param {object} deps — optional dep injection (lockfile override for tests)
 */
export async function completeImplementerRun(specPath, sliceId, implementerRunId, result, deps = {}) {
  if (!nonEmptyString(sliceId)) {
    throw new Error('completeImplementerRun: sliceId must be a non-empty string');
  }
  if (!nonEmptyString(implementerRunId)) {
    throw new Error('completeImplementerRun: implementerRunId must be a non-empty string');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('completeImplementerRun: result must be a plain object');
  }
  if (!VALID_IMPLEMENTER_RUN_STATUSES.has(result.status)) {
    throw new Error(
      `completeImplementerRun: invalid status "${result.status}" — must be one of ` +
        Array.from(VALID_IMPLEMENTER_RUN_STATUSES).join(', ')
    );
  }
  return withSidecarLock(specPath, async () => {
    const sc = loadSidecar(specPath);
    const run = sc.slice_reviews?.[sliceId]?.phases?.implementer_experts;
    if (!run) {
      throw new Error(
        `completeImplementerRun: slice "${sliceId}" has no implementer_experts run`
      );
    }
    if (run.implementer_run_id !== implementerRunId) {
      throw new Error(
        `completeImplementerRun: implementerRunId "${implementerRunId}" does not match ` +
          `the active run "${run.implementer_run_id}" on slice "${sliceId}"`
      );
    }
    run.status = result.status;
    run.completed_at = result.completed_at ?? new Date().toISOString();
    if (result.merge !== undefined) run.merge = result.merge;
    if (result.post_merge_review !== undefined) run.post_merge_review = result.post_merge_review;
    saveSidecar(specPath, sc);
  }, deps);
}

/**
 * Read the implementer_experts block for a slice. Synchronous (no lock held).
 * Returns null for missing slice or when the slice has only legacy phases.implement.
 *
 * @param {string} specPath
 * @param {string} sliceId
 * @returns {object|null}
 */
export function readImplementerRun(specPath, sliceId) {
  const sc = loadSidecar(specPath);
  return sc.slice_reviews?.[sliceId]?.phases?.implementer_experts ?? null;
}

export function addOpenContention(specPath, contention) {
  const sc = loadSidecar(specPath);
  sc.open_contentions.push(contention);
  saveSidecar(specPath, sc);
}

// Slice-id converters. The sidecar stores slice keys in the human-readable form
// (`slice-3`) while commits and the autopilot block use the numeric form (`3`).
// These helpers keep the conversion in one place — the spec mandates them.
export function sliceIdToNumber(sliceKey) {
  // "slice-3" → "3"
  const m = String(sliceKey).match(/^slice-(\d+)$/);
  if (!m) throw new Error(`invalid slice key: ${sliceKey}`);
  return m[1];
}

export function sliceIdToDisplayName(sliceNumber) {
  // "3" → "slice-3"
  const n = String(sliceNumber);
  if (!/^\d+$/.test(n)) throw new Error(`invalid slice number: ${sliceNumber}`);
  return `slice-${n}`;
}

// --- v0.9.0 slice 5b: response overflow storage + inputs_hash --------------
//
// Per spec § 5: verbatim text inline up to 50KB
// (`sidecar.max_inline_response_bytes`, configurable). Overflow goes to
// content-addressed `responses/sha256-<hash>.txt` under
// `.superpowers-codex-paired/` in the repo root. Content addressing dedupes
// identical responses across turns.

const DEFAULT_MAX_INLINE_RESPONSE_BYTES = 51200; // 50 KiB
const RESPONSES_SUBDIR = 'responses';
const HIDDEN_DIR = '.superpowers-codex-paired';
const RESPONSE_REF_RE = /^responses\/sha256-[0-9a-f]{64}\.txt$/;

function sha256HexBuf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sha256HexUtf8(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Store a response. Inline below the cap, content-addressed file above it.
 *
 * Returns one of:
 *   { response_text_inline: <text>, response_hash: 'sha256:<hex>' }       (inline path)
 *   { response_ref: 'responses/sha256-<hex>.txt', response_hash: 'sha256:<hex>' }  (overflow path)
 *
 * @param {string} repoRoot — absolute path to the repo root containing the
 *   `.superpowers-codex-paired/` directory.
 * @param {string} responseText — UTF-8 string.
 * @param {{maxInlineBytes?: number}} [options]
 */
export function storeResponse(repoRoot, responseText, options = {}) {
  if (typeof responseText !== 'string') {
    throw new Error('storeResponse: responseText must be a string');
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('storeResponse: repoRoot must be a non-empty string');
  }
  const cap = typeof options.maxInlineBytes === 'number' && options.maxInlineBytes >= 0
    ? options.maxInlineBytes
    : DEFAULT_MAX_INLINE_RESPONSE_BYTES;
  const byteLen = Buffer.byteLength(responseText, 'utf8');
  const hashHex = sha256HexUtf8(responseText);
  const responseHash = `sha256:${hashHex}`;
  if (byteLen <= cap) {
    return {
      response_text_inline: responseText,
      response_hash: responseHash,
    };
  }
  // Overflow path: atomic temp+rename, dedupe by filename.
  const responsesDir = join(repoRoot, HIDDEN_DIR, RESPONSES_SUBDIR);
  mkdirSync(responsesDir, { recursive: true });
  const filename = `sha256-${hashHex}.txt`;
  const finalPath = join(responsesDir, filename);
  if (!existsSync(finalPath)) {
    const tmp = join(responsesDir, `.${filename}.tmp.${process.pid}`);
    writeFileSync(tmp, responseText, 'utf8');
    renameSync(tmp, finalPath);
  }
  return {
    response_ref: `${RESPONSES_SUBDIR}/${filename}`,
    response_hash: responseHash,
  };
}

/**
 * Read a response given a turn entry (either inline or overflow). Verifies
 * the hash on read; throws on mismatch.
 *
 * @param {string} repoRoot
 * @param {{response_text_inline?:string, response_ref?:string, response_hash?:string}} turnEntry
 * @returns {string}
 */
export function readResponse(repoRoot, turnEntry) {
  if (!turnEntry || typeof turnEntry !== 'object') {
    throw new Error('readResponse: turnEntry must be an object');
  }
  if (typeof turnEntry.response_text_inline === 'string') {
    if (turnEntry.response_hash) {
      const recomputed = `sha256:${sha256HexUtf8(turnEntry.response_text_inline)}`;
      if (recomputed !== turnEntry.response_hash) {
        throw new Error(
          `readResponse: inline response_hash mismatch (recorded=${turnEntry.response_hash} recomputed=${recomputed})`
        );
      }
    }
    return turnEntry.response_text_inline;
  }
  if (typeof turnEntry.response_ref !== 'string' || turnEntry.response_ref.length === 0) {
    throw new Error(
      'readResponse: turnEntry has neither response_text_inline nor response_ref'
    );
  }
  if (!RESPONSE_REF_RE.test(turnEntry.response_ref)) {
    throw new Error(
      `readResponse: response_ref must match "responses/sha256-<hex>.txt" (got ${JSON.stringify(turnEntry.response_ref)})`
    );
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('readResponse: repoRoot must be a non-empty string when response_ref is used');
  }
  const path = join(repoRoot, HIDDEN_DIR, turnEntry.response_ref);
  const text = readFileSync(path, 'utf8');
  if (turnEntry.response_hash) {
    const recomputed = `sha256:${sha256HexUtf8(text)}`;
    if (recomputed !== turnEntry.response_hash) {
      throw new Error(
        `readResponse: response_ref hash mismatch at ${path} (recorded=${turnEntry.response_hash} recomputed=${recomputed})`
      );
    }
  }
  return text;
}

/**
 * Compute the canonical inputs_hash domain over a turn's recorded inputs.
 * Used by both the dispatcher (at write time) and replayTurn (at audit time).
 *
 * The hash is deterministic: same inputs → same hex digest. Order matters.
 * Fields are joined with a NUL separator to prevent accidental collisions.
 *
 * @param {{rolePromptHash:string, specSnippetHash:string, mailboxMessageIds:string[], phase:string, task:string, roleId:string}} parts
 * @returns {string} `sha256:<hex>`
 */
export function computeInputsHash(parts) {
  if (!parts || typeof parts !== 'object') {
    throw new Error('computeInputsHash: parts must be an object');
  }
  const ids = Array.isArray(parts.mailboxMessageIds) ? parts.mailboxMessageIds.slice() : [];
  const domain = [
    `role:${parts.roleId ?? ''}`,
    `role_prompt:${parts.rolePromptHash ?? ''}`,
    `spec_snippet:${parts.specSnippetHash ?? ''}`,
    `phase:${parts.phase ?? ''}`,
    `task:${parts.task ?? ''}`,
    `mailbox:${ids.join(',')}`,
  ].join(' ');
  return `sha256:${sha256HexUtf8(domain)}`;
}

// Exposed for tests + sidecar callers that want to know the default cap.
export const SIDECAR_DEFAULTS = {
  MAX_INLINE_RESPONSE_BYTES: DEFAULT_MAX_INLINE_RESPONSE_BYTES,
};
