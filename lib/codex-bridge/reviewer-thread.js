// @ts-check

// v0.17.0 Slice 4 — Reviewer thread on agy + throwaway checkout.
// Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
// Plan: docs/plans/2026-09-17-v0.17.0-antigravity-transport.md (Slice 4)

import { existsSync } from 'node:fs';
import { isAbsolute, relative, join } from 'node:path';

import { resolveModelRoles } from './models.js';
import { withReviewCheckout } from './worktree.js';
import { dispatch as harnessDispatch } from './cli-harness/harness.js';
import {
  loadSidecar,
  setCodexThreadId,
  getCodexThreadId,
} from './sidecar.js';

/** @typedef {import('./types.js').ReviewerTurnResult} ReviewerTurnResult */
/**
 * @typedef {object} ReviewerOptions
 * @property {string} role
 * @property {string} specPath
 * @property {string} [repoRoot]
 * @property {string} prompt
 * @property {string} [planPath]
 * @property {string} [sha]
 * @property {string[]} [overlayPaths]
 * @property {string} [conversationId]
 * @property {number} [timeout_ms]
 * @property {string} [command]
 * @property {NodeJS.ProcessEnv} [env]
 */
/**
 * @typedef {object} ReviewerDeps
 * @property {Function} [dispatch]
 * @property {Map<string, unknown>} [adapters]
 * @property {typeof withReviewCheckout} [withReviewCheckout]
 */
/** @typedef {Record<string, any>} RawReviewerResult */
/**
 * @typedef {object} PanelMemberOptions
 * @property {string} role
 * @property {string} specPath
 * @property {string} [repoRoot]
 * @property {string} member_id
 * @property {string} model
 * @property {string} version
 * @property {string} replay
 * @property {string} [planPath]
 * @property {string} [sha]
 * @property {string[]} [overlayPaths]
 * @property {number} [timeout_ms]
 * @property {string} [command]
 * @property {NodeJS.ProcessEnv} [env]
 */

/** @param {string} role */
function normalizeRole(role) {
  if (role === 'planning' || role === 'paired-reviewer') {
    return { modelRole: 'planning', sidecarKey: 'paired-reviewer' };
  }
  if (role === 'review' || role === 'execution-reviewer') {
    return { modelRole: 'review', sidecarKey: 'execution-reviewer' };
  }
  throw new Error(`invalid reviewer role: ${JSON.stringify(role)}`);
}

/** @param {string} effectiveRoot @param {string} specPath @param {string | undefined} planPath @param {string[]} extraOverlays */
function resolveOverlays(effectiveRoot, specPath, planPath, extraOverlays) {
  const fullSpec = isAbsolute(specPath) ? specPath : join(effectiveRoot, specPath);
  if (!existsSync(fullSpec)) {
    /** @type {Error & {code?: string}} */
    const err = new Error(`review overlay path does not exist in repo: ${specPath}`);
    err.code = 'review-overlay-invalid';
    throw err;
  }
  const relSpec = isAbsolute(specPath) ? relative(effectiveRoot, specPath) : specPath;
  const overlays = [relSpec];

  if (planPath) {
    const fullPlan = isAbsolute(planPath) ? planPath : join(effectiveRoot, planPath);
    if (existsSync(fullPlan)) {
      overlays.push(isAbsolute(planPath) ? relative(effectiveRoot, planPath) : planPath);
    }
  }

  if (Array.isArray(extraOverlays)) {
    for (const p of extraOverlays) {
      if (typeof p === 'string' && p.length > 0) {
        const fullP = isAbsolute(p) ? p : join(effectiveRoot, p);
        if (existsSync(fullP)) {
          overlays.push(isAbsolute(p) ? relative(effectiveRoot, p) : p);
        }
      }
    }
  }

  return [...new Set(overlays)];
}

/** @param {ReviewerDeps} deps @param {string} prompt @param {Record<string, any>} dispatchOptions @returns {Promise<RawReviewerResult>} */
async function invokeDispatch(deps, prompt, dispatchOptions) {
  if (typeof deps.dispatch === 'function') {
    if (deps.dispatch.length <= 3 && deps.dispatch.length > 0) {
      return deps.dispatch('', prompt, dispatchOptions);
    }
    return deps.dispatch({ cli: 'agy' }, '', prompt, dispatchOptions);
  }
  return harnessDispatch(
    { cli: 'agy' },
    '',
    prompt,
    dispatchOptions,
    deps.adapters instanceof Map ? { adapters: deps.adapters } : {},
  );
}

/**
 * Open a reviewer thread on agy in a throwaway detached checkout with overlaid uncommitted files.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
 *
 * @param {ReviewerOptions} options
 * @param {ReviewerDeps} [deps] Injectable dependencies for unit tests
 * @returns {Promise<ReviewerTurnResult>}
 */
export async function openReviewerThread(options, deps = {}) {
  const {
    role,
    specPath,
    repoRoot,
    prompt,
    planPath,
    sha = 'HEAD',
    overlayPaths = [],
    timeout_ms = 15 * 60 * 1000,
    command,
    env,
  } = options || {};

  const { modelRole, sidecarKey } = normalizeRole(role);
  const effectiveRoot = repoRoot || process.cwd();
  const resolved = resolveModelRoles({ repoRoot: effectiveRoot, env });
  const roleConfig = resolved.roles[modelRole];

  if (roleConfig.cli === 'codex') {
    /** @type {Error & {code?: string}} */
    const err = new Error(
      `role ${modelRole} uses codex; the Codex MCP tool cannot open an agy thread — use reviewer-thread-open`,
    );
    err.code = 'reviewer-thread-codex-uses-mcp';
    throw err;
  }

  const fullSpec = isAbsolute(specPath) ? specPath : join(effectiveRoot, specPath);
  const overlays = resolveOverlays(effectiveRoot, specPath, planPath, overlayPaths);
  const reviewCheckout = deps.withReviewCheckout ?? withReviewCheckout;

  const raw = await reviewCheckout(
    effectiveRoot,
    { sha, overlayPaths: overlays },
    async (checkoutPath) => {
      const dispatchOptions = {
        cwd: checkoutPath,
        model: roleConfig.model,
        execMode: 'reviewer',
        timeout_ms,
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
      };
      return invokeDispatch(deps, prompt, dispatchOptions);
    },
  );

  const threadId =
    raw.sessionId ?? raw.adapterMeta?.conversation_id ?? raw.threadId;
  const content = raw.responseText ?? raw.content ?? '';
  const usage = raw.adapterMeta?.usage ?? raw.usage ?? null;
  const outcome = outcomeFields(raw);

  if (threadId && outcome.ok) {
    await setCodexThreadId(fullSpec, {
      role: sidecarKey,
      newThreadId: threadId,
      reason: 'opened',
      threadConfig: {
        role: modelRole,
        cli: 'agy',
        model: roleConfig.model,
        effort: roleConfig.effort,
      },
    });
  }

  return {
    threadId,
    content,
    usage,
    ...outcome,
  };
}

/**
 * Open one configured agy panel member in a fresh conversation. Unlike the
 * legacy phase-wide open/reply path, this never reads or writes role_sessions.
 * The caller supplies the already bounded replay and the artifact version.
 *
 * @param {PanelMemberOptions} options
 * @param {ReviewerDeps} [deps]
 * @returns {Promise<ReviewerTurnResult>}
 */
export async function openPanelMemberThread(options, deps = {}) {
  const {
    role,
    specPath,
    repoRoot,
    member_id: memberId,
    model,
    version,
    replay,
    planPath,
    sha = 'HEAD',
    overlayPaths = [],
    timeout_ms = 15 * 60 * 1000,
    command,
    env,
  } = options || {};

  normalizeRole(role);
  if (typeof memberId !== 'string' || memberId !== `agy:${model}`) {
    throw new TypeError('openPanelMemberThread: member_id must equal agy:model');
  }
  if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new TypeError('openPanelMemberThread: model must be a safe non-empty token');
  }
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw new TypeError('openPanelMemberThread: version must be a non-empty string');
  }
  if (typeof replay !== 'string' || replay.length === 0 || replay.length > 12_000) {
    throw new TypeError('openPanelMemberThread: replay must contain 1 to 12000 characters');
  }
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new TypeError('openPanelMemberThread: specPath must be a non-empty string');
  }
  const effectiveRoot = repoRoot || process.cwd();
  const overlays = resolveOverlays(effectiveRoot, specPath, planPath, overlayPaths);
  const reviewCheckout = deps.withReviewCheckout ?? withReviewCheckout;
  const prompt = [
    `Artifact version: ${version.trim()}`,
    `Return that exact value in the verdict version field.`,
    '',
    replay,
  ].join('\n');

  const raw = await reviewCheckout(
    effectiveRoot,
    { sha, overlayPaths: overlays },
    async (checkoutPath) => invokeDispatch(deps, prompt, {
      cwd: checkoutPath,
      model,
      execMode: 'reviewer',
      timeout_ms,
      ...(command ? { command } : {}),
      ...(env ? { env } : {}),
    }),
  );
  return {
    threadId: raw.sessionId ?? raw.adapterMeta?.conversation_id ?? raw.threadId,
    content: raw.responseText ?? raw.content ?? '',
    usage: raw.adapterMeta?.usage ?? raw.usage ?? null,
    ...outcomeFields(raw),
  };
}

/**
 * Continue an existing reviewer thread on agy in a throwaway detached checkout.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
 *
 * @param {ReviewerOptions} options
 * @param {ReviewerDeps} [deps] Injectable dependencies for unit tests
 * @returns {Promise<ReviewerTurnResult>}
 */
export async function continueReviewerThread(options, deps = {}) {
  const {
    role,
    specPath,
    repoRoot,
    prompt,
    planPath,
    sha = 'HEAD',
    overlayPaths = [],
    conversationId: explicitConvId,
    timeout_ms = 15 * 60 * 1000,
    command,
    env,
  } = options || {};

  const { modelRole, sidecarKey } = normalizeRole(role);
  const effectiveRoot = repoRoot || process.cwd();
  const resolved = resolveModelRoles({ repoRoot: effectiveRoot, env });
  const roleConfig = resolved.roles[modelRole];

  if (roleConfig.cli === 'codex') {
    /** @type {Error & {code?: string}} */
    const err = new Error(
      `role ${modelRole} uses codex; the Codex MCP tool cannot open an agy thread — use reviewer-thread-reply`,
    );
    err.code = 'reviewer-thread-codex-uses-mcp';
    throw err;
  }

  const fullSpec = isAbsolute(specPath) ? specPath : join(effectiveRoot, specPath);
  const sc = loadSidecar(fullSpec);
  const conversationId = explicitConvId ?? getCodexThreadId(sc, sidecarKey);

  const overlays = resolveOverlays(effectiveRoot, specPath, planPath, overlayPaths);
  const reviewCheckout = deps.withReviewCheckout ?? withReviewCheckout;

  const raw = await reviewCheckout(
    effectiveRoot,
    { sha, overlayPaths: overlays },
    async (checkoutPath) => {
      const dispatchOptions = {
        cwd: checkoutPath,
        model: roleConfig.model,
        execMode: 'reviewer',
        timeout_ms,
        ...(conversationId ? { conversationId } : {}),
        ...(command ? { command } : {}),
        ...(env ? { env } : {}),
      };
      return invokeDispatch(deps, prompt, dispatchOptions);
    },
  );

  const threadId =
    raw.sessionId ?? raw.adapterMeta?.conversation_id ?? conversationId;
  const content = raw.responseText ?? raw.content ?? '';
  const usage = raw.adapterMeta?.usage ?? raw.usage ?? null;

  return {
    threadId,
    content,
    usage,
    ...outcomeFields(raw),
  };
}

/**
 * Failure visibility (Claude C0 review of slice 4): a non-SUCCESS agy status, a stale
 * conversation, a timeout or an abort must not masquerade as an empty reply. Every result
 * carries `ok`, `exit`, `status`, `warnings` and `adapterMeta` so callers (and
 * `isStaleAgyResponse`) can classify it; the CLI verbs exit non-zero when `ok` is false.
 */
/** @param {RawReviewerResult} raw @returns {Pick<ReviewerTurnResult, 'ok' | 'exit' | 'status' | 'warnings' | 'adapterMeta'>} */
function outcomeFields(raw) {
  const exit = Number.isFinite(raw?.exit) ? raw.exit : (raw?.threadId || raw?.sessionId ? 0 : 1);
  const status = raw?.adapterMeta?.status ?? raw?.status ?? (exit === 0 ? 'SUCCESS' : 'ERROR');
  const warnings = Array.isArray(raw?.warnings) ? raw.warnings : [];
  return {
    ok: exit === 0 && status === 'SUCCESS',
    exit,
    status,
    warnings,
    adapterMeta: raw?.adapterMeta ?? null,
  };
}
