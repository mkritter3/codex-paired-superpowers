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
  block.turns.push(turnRecord);
  saveSidecar(specPath, sc);
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
