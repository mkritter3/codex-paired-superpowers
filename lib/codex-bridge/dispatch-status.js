// @ts-check

/** @typedef {import('./types.js').StatusFile} StatusFile */
/** @typedef {{model_role: import('./types.js').ModelRole, model: string, effort: string}} ModelSnapshot */
/** @typedef {{state: string, terminal: boolean, haltReason: string | null, snapshot: ModelSnapshot | null}} StatusClassification */
/** @typedef {{action: string, haltReason: string | null, nextRung: number | null}} ImplementDecision */

/** @param {StatusFile | null | undefined} statusFile @returns {ModelSnapshot | null} */
function modelSnapshot(statusFile) {
  if (!statusFile || typeof statusFile !== 'object') return null;
  const { model_role, model, effort } = statusFile;
  if (model_role == null || model == null || effort == null) return null;
  return { model_role, model, effort };
}

/**
 * @param {string} state
 * @param {boolean} terminal
 * @param {string | null} haltReason
 * @param {StatusFile | null | undefined} statusFile
 * @returns {StatusClassification}
 */
function classification(state, terminal, haltReason, statusFile) {
  return { state, terminal, haltReason, snapshot: modelSnapshot(statusFile) };
}

/**
 * Classify durable implementer status using the ordered rules in the v0.16.0
 * model-roles design §4 (Codex writes the code / status-file lifecycle).
 * @param {{statusFile?: StatusFile | null, taskAlive?: boolean, runtimeMs?: number, maxRuntimeMs?: number, halts?: {timeout?: string, blocked?: string, needsContext?: string, failed?: string, lost?: string}}} input
 * @returns {StatusClassification}
 */
export function classifyStatusFile({ statusFile, taskAlive, runtimeMs, maxRuntimeMs, halts = {} }) {
  if (typeof runtimeMs === 'number' && typeof maxRuntimeMs === 'number' && runtimeMs > maxRuntimeMs) {
    return classification('timeout', true, halts.timeout ?? null, statusFile);
  }

  const present = statusFile !== null && typeof statusFile === 'object' && !Array.isArray(statusFile);
  if (present && statusFile.status === 'blocked') {
    return classification('blocked', true, halts.blocked ?? 'codex-blocked', statusFile);
  }
  if (present && statusFile.status === 'needs-context') {
    return classification('needs-context', true, halts.needsContext ?? 'codex-needs-context', statusFile);
  }
  if (present && statusFile.exit_code === 78) {
    return classification('config-error', true, statusFile.error ?? 'model-role-resolution-failed', statusFile);
  }
  if (present && statusFile.transient === true) {
    return classification('transient', false, null, statusFile);
  }
  if (present && statusFile.exit_code === 0) {
    return classification('completed', false, null, statusFile);
  }
  if (present && typeof statusFile.exit_code === 'number' && statusFile.exit_code !== 0) {
    return classification('failed', true, halts.failed ?? null, statusFile);
  }
  if (present) {
    return taskAlive
      ? classification('transient', false, null, statusFile)
      : classification('lost', true, halts.lost ?? null, statusFile);
  }
  return taskAlive
    ? classification('transient', false, null, null)
    : classification('lost', true, halts.lost ?? null, null);
}

/**
 * Identify wrapper EX_CONFIG evidence (v0.16.0 model-roles design §4).
 * @param {StatusFile | null | undefined} statusFile
 * @returns {boolean}
 */
export function isConfigErrorStatus(statusFile) {
  return Boolean(statusFile && typeof statusFile === 'object' && statusFile.exit_code === 78);
}

/** @param {string} action @param {string | null} [haltReason] @param {number | null} [nextRung] @returns {ImplementDecision} */
function decision(action, haltReason = null, nextRung = null) {
  return { action, haltReason, nextRung };
}

/**
 * Choose the next single-implementer ladder action from v0.16.0 design §4.
 * @param {{classification: StatusClassification, rung: number, maxRung?: number, reconciled?: {commit_count: number, non_conforming_subjects: string[]} | null}} input
 * @returns {ImplementDecision}
 */
export function decideImplementAction({ classification: current, rung, maxRung = 3, reconciled }) {
  switch (current.state) {
    case 'transient':
      return decision('poll');
    case 'completed': {
      if (reconciled == null) return decision('reconcile');
      const conforming = reconciled.commit_count > 0
        && Array.isArray(reconciled.non_conforming_subjects)
        && reconciled.non_conforming_subjects.length === 0;
      if (conforming) return decision('ship');
      break;
    }
    case 'failed':
      break;
    case 'blocked':
    case 'needs-context':
    case 'config-error':
    case 'timeout':
    case 'lost':
      return decision('halt', current.haltReason);
    default:
      return decision('halt', current.haltReason ?? 'implementer-unavailable');
  }

  if (rung < maxRung) return decision('fallback', null, rung + 1);
  return decision('halt', 'implementer-unavailable');
}

/**
 * Execute a single ladder decision with reset-before-fallback safety from
 * v0.16.0 model-roles design §4.
 * @param {ImplementDecision} current
 * @param {{reset: () => any, dispatchNextRung: (rung: number | null) => any, halt: (reason: string | null) => any, reconcile: () => any, ship: () => any, poll: () => any}} callbacks
 * @returns {Promise<any>}
 */
export async function applyImplementDecision(
  current,
  { reset, dispatchNextRung, halt, reconcile, ship, poll },
) {
  switch (current.action) {
    case 'poll':
      return poll();
    case 'reconcile':
      return reconcile();
    case 'ship':
      return ship();
    case 'halt':
      return halt(current.haltReason);
    case 'fallback': {
      let resetResult;
      try {
        resetResult = await reset();
      } catch {
        return halt('worktree-reset-failed');
      }
      if (resetResult && resetResult.ok === false) return halt('worktree-reset-failed');
      return dispatchNextRung(current.nextRung);
    }
    default:
      throw new TypeError(`unknown implement decision action: ${String(current.action)}`);
  }
}
