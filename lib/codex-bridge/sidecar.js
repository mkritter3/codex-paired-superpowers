import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, basename, join, relative, sep, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Module-scoped Set for one-time-per-process deprecation warning deduplication.
const warnedPaths = new Set();

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
  return JSON.parse(readFileSync(sidecarPathFor(specPath), 'utf8'));
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
 *   - required: slice_id, agent, dispatched_at, worktree, outcome
 *   - agent ∈ {"codex","sonnet"}
 *   - outcome ∈ {"shipped","failed-fallback-pending","failed-halted"}
 *   - thread_id is optional (nullable for the Sonnet path)
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
        `"shipped", "failed-fallback-pending", "failed-halted"`
    );
  }
  // thread_id is optional and nullable; nothing to validate.

  const sc = loadSidecar(specPath);
  const impl = ensureImplementBlock(sc, sliceId);
  if (!Array.isArray(impl.dispatches)) impl.dispatches = [];
  impl.dispatches.push(dispatch);
  saveSidecar(specPath, sc);
}

export function setAutopilot(specPath, autopilotBlock) {
  const sc = loadSidecar(specPath);
  sc.autopilot = autopilotBlock;
  saveSidecar(specPath, sc);
}

export function getAutopilot(specPath) {
  const sc = loadSidecar(specPath);
  return sc.autopilot ?? null;
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
