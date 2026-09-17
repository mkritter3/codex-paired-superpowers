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

function normalizeRole(role) {
  if (role === 'planning' || role === 'paired-reviewer') {
    return { modelRole: 'planning', sidecarKey: 'paired-reviewer' };
  }
  if (role === 'review' || role === 'execution-reviewer') {
    return { modelRole: 'review', sidecarKey: 'execution-reviewer' };
  }
  throw new Error(`invalid reviewer role: ${JSON.stringify(role)}`);
}

function resolveOverlays(effectiveRoot, specPath, planPath, extraOverlays) {
  const fullSpec = isAbsolute(specPath) ? specPath : join(effectiveRoot, specPath);
  if (!existsSync(fullSpec)) {
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
 * @param {object} options
 * @param {string} options.role 'planning' | 'review' | 'paired-reviewer' | 'execution-reviewer'
 * @param {string} options.specPath Path to spec (required)
 * @param {string} [options.repoRoot] Working tree root
 * @param {string} options.prompt Prompt to send
 * @param {string} [options.planPath] Path to plan (optional; silently skipped if absent)
 * @param {string} [options.sha='HEAD'] Git SHA to checkout
 * @param {string[]} [options.overlayPaths] Extra paths to overlay if present
 * @param {number} [options.timeout_ms=900000] Timeout in milliseconds
 * @param {string} [options.command] CLI command override
 * @param {object} [options.env] Extra environment variables
 * @param {object} [deps] Injectable dependencies for unit tests
 * @returns {Promise<{ threadId: string, content: string, usage: object|null }>}
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
 * Continue an existing reviewer thread on agy in a throwaway detached checkout.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
 *
 * @param {object} options
 * @param {string} options.role 'planning' | 'review' | 'paired-reviewer' | 'execution-reviewer'
 * @param {string} options.specPath Path to spec (required)
 * @param {string} [options.repoRoot] Working tree root
 * @param {string} options.prompt Prompt to send
 * @param {string} [options.planPath] Path to plan (optional; silently skipped if absent)
 * @param {string} [options.sha='HEAD'] Git SHA to checkout
 * @param {string[]} [options.overlayPaths] Extra paths to overlay if present
 * @param {string} [options.conversationId] Explicit conversation ID override
 * @param {number} [options.timeout_ms=900000] Timeout in milliseconds
 * @param {string} [options.command] CLI command override
 * @param {object} [options.env] Extra environment variables
 * @param {object} [deps] Injectable dependencies for unit tests
 * @returns {Promise<{ threadId: string, content: string, usage: object|null }>}
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
