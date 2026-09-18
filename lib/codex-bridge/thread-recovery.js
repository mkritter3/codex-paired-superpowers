// @ts-check

// v0.13.0 Slice 3 — Codex thread-loss recovery orchestrator (Goal 3).
// v0.17.0 Slice 4 — Antigravity (agy) thread-loss recovery (Goal 2).
//
// MCP threads are process-local; a `codex-reply` against a thread from a restarted server
// returns "Session not found for thread_id". Similarly, an agy conversation may become stale
// or not found on the backend. This module turns that into a graceful recovery:
// re-seed a fresh thread with the goals block + a compact replay of prior sidecar rounds, then
// rotate the persisted thread id. All MCP/CLI I/O is injected so the flow is unit-testable.

import { existsSync } from 'node:fs';
import { isAbsolute, relative, join } from 'node:path';
import {
  isStaleThreadResponse,
  buildReplayContext,
  getCodexThreadId,
  setCodexThreadId,
  loadSidecar,
  getThreadConfig,
} from './sidecar.js';
import { resolveModelRoles } from './models.js';
import { withReviewCheckout } from './worktree.js';
import { dispatch as harnessDispatch } from './cli-harness/harness.js';

/** @typedef {Record<string, any>} RecoveryResponse */
/**
 * @typedef {object} RecoveryReplay
 * @property {string} [feature]
 * @property {string} [artifact]
 * @property {string} [goals]
 * @property {Array<{phase: string, round: number, claude?: string, codex?: string}>} [rounds]
 * @property {unknown[]} [open_contentions]
 * @property {unknown[]} [thread_rotations]
 */
/**
 * @typedef {object} RecoveryPromptOptions
 * @property {string} [reason]
 * @property {string} [pendingPrompt]
 * @property {string} [phase]
 * @property {number} [round]
 * @property {string} [specPath]
 * @property {string} [planPath]
 */
/**
 * @typedef {object} RecoveryDeps
 * @property {(args: {prompt: string, model?: string | null, config?: object}) => Promise<{threadId: string, content: any}>} [codexFn]
 * @property {(args: {prompt: string, model?: string | null, cwd?: string}) => Promise<{threadId: string, content: any}>} [openFn]
 * @property {typeof withReviewCheckout} [withReviewCheckout]
 */

/**
 * Classify an agy CLI response as a stale-thread failure (conversation lost / not found).
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
 *
 * @param {RecoveryResponse} result
 * @returns {boolean}
 */
export function isStaleAgyResponse(result) {
  if (!result || typeof result !== 'object') return false;
  const adapterMeta = result.adapterMeta ?? result.rawResult?.adapterMeta;
  const status = adapterMeta?.status ?? result.status;
  if (!status || status === 'SUCCESS') return false;

  const parts = [];
  if (typeof result.stderr === 'string') parts.push(result.stderr);
  if (typeof adapterMeta?.stderr === 'string') parts.push(adapterMeta.stderr);
  if (typeof adapterMeta?.error === 'string') parts.push(adapterMeta.error);
  if (Array.isArray(result.warnings)) parts.push(...result.warnings);
  if (typeof result.warnings === 'string') parts.push(result.warnings);
  if (Array.isArray(adapterMeta?.warnings)) parts.push(...adapterMeta.warnings);
  if (typeof result.content === 'string') parts.push(result.content);
  if (typeof result.responseText === 'string') parts.push(result.responseText);

  const text = parts.join(' ');
  return /conversation/i.test(text) && /(?:not found|does not exist|unknown)/i.test(text);
}

/** @param {string} role @param {Record<string, unknown>} resolvedRole */
function legacyAgyThreadConfig(role, resolvedRole) {
  return { role, cli: 'agy', ...resolvedRole };
}

/**
 * Build an execution-thread or recovery seed that reloads authoritative
 * artifacts before review (v0.16.0 spec §5).
 */
/**
 * @param {RecoveryReplay} replay
 * @param {RecoveryPromptOptions} [options]
 * @returns {string}
 */
export function composeSeedPrompt(replay, {
  reason, pendingPrompt, phase, round, specPath, planPath,
} = {}) {
  const execution = reason === 'execution-thread';
  const lines = [
    execution
      ? 'You are the execution reviewer, moving from planning to execution in a fresh thread.'
      : 'You are the paired reviewer. The previous Codex thread was lost ("Session not found for thread_id") — this is a recovery re-seed. Continue as the same reviewer.',
    '',
    `Feature: ${replay.feature ?? '(unknown)'}`,
    `Artifact: ${replay.artifact ?? '(unknown)'}  Phase: ${phase ?? '(unknown)'}  Round: ${round ?? '(unknown)'}`,
    '',
    'Read the authoritative spec and plan from disk before answering:',
    `- Spec: ${specPath ?? replay.artifact ?? '(unknown)'}`,
    `- Plan: ${planPath ?? '(unknown)'}`,
    '',
    replay.goals || '<<<GOALS>>>\n(goals unavailable)\n<<<END_GOALS>>>',
    '',
    '## Prior rounds (replayed from sidecar)',
    ...(replay.rounds && replay.rounds.length
      ? replay.rounds.map((r) => `- ${r.phase} round ${r.round}: claude=${r.claude} / codex=${r.codex}`)
      : ['- (none)']),
  ];
  if (replay.open_contentions && replay.open_contentions.length) {
    lines.push('', '## Open contentions', ...replay.open_contentions.map((c) => `- ${JSON.stringify(c)}`));
  }
  if (replay.thread_rotations && replay.thread_rotations.length) {
    lines.push('', `(prior thread rotations: ${replay.thread_rotations.length})`);
  }
  lines.push('', '## Pending prompt (failed against the lost thread — answer this now)', pendingPrompt ?? '');
  return lines.join('\n');
}

/**
 * Preserve the legacy recovery-prompt API through the shared seed composer
 * (v0.16.0 spec §5).
 */
/** @param {RecoveryReplay} replay @param {RecoveryPromptOptions} [opts] @returns {string} */
export function composeRecoveryPrompt(replay, opts = {}) {
  return composeSeedPrompt(replay, { reason: 'session-not-found', ...opts });
}

/**
 * Detect a stale-thread response and recover. On recovery, makes exactly one initial
 * call (deps.codexFn for codex roles; deps.openFn for agy roles) and exactly one
 * sidecar thread rotation.
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
 *
 * @param {string} specPath
 * @param {{staleResponse: RecoveryResponse, pendingPrompt: string, phase?: string, round?: number, role?: string, specPath?: string, planPath?: string, repoRoot?: string}} ctx
 * @param {RecoveryDeps} [deps]
 * @returns {Promise<{recovered: boolean, newThreadId?: string, content?: any, response?: object}>}
 */
export async function recoverStaleThread(specPath, ctx, deps = {}) {
  const {
    staleResponse, pendingPrompt, phase, round, role = 'paired-reviewer',
    specPath: promptSpecPath, planPath, repoRoot = process.cwd(),
  } = ctx || {};

  const sc = loadSidecar(specPath);
  const recorded = getThreadConfig(sc, role);
  const isAgy = recorded.cli === 'agy';

  const isStale = isAgy ? isStaleAgyResponse(staleResponse) : isStaleThreadResponse(staleResponse);
  if (!isStale) {
    return { recovered: false, response: staleResponse };
  }

  const replay = buildReplayContext(specPath);
  const oldThreadId = getCodexThreadId(sc, role);
  const seed = composeRecoveryPrompt(replay, {
    pendingPrompt, phase, round, specPath: promptSpecPath ?? specPath, planPath,
  });

  if (isAgy) {
    /** @type {Record<string, any>} */
    let threadConfig;
    if (recorded.legacy) {
      /** @type {Record<string, unknown>} */
      const resolvedRole = resolveModelRoles({ repoRoot }).roles[recorded.role];
      threadConfig = legacyAgyThreadConfig(recorded.role, resolvedRole);
    } else {
      threadConfig = { role: recorded.role, cli: 'agy', model: recorded.model, effort: recorded.effort };
    }

    let openFn = deps?.openFn;
    if (!openFn) {
      openFn = async ({ prompt, model, cwd }) => {
        const effectiveSpec = promptSpecPath ?? specPath;
        const overlayPaths = [];
        const fullSpec = isAbsolute(effectiveSpec) ? effectiveSpec : join(repoRoot, effectiveSpec);
        if (existsSync(fullSpec)) {
          overlayPaths.push(isAbsolute(effectiveSpec) ? relative(repoRoot, effectiveSpec) : effectiveSpec);
        }
        if (planPath) {
          const fullPlan = isAbsolute(planPath) ? planPath : join(repoRoot, planPath);
          if (existsSync(fullPlan)) {
            overlayPaths.push(isAbsolute(planPath) ? relative(repoRoot, planPath) : planPath);
          }
        }
        const reviewCheckout = deps?.withReviewCheckout ?? withReviewCheckout;
        return reviewCheckout(repoRoot, { sha: 'HEAD', overlayPaths }, async (checkoutDir) => {
          const res = await harnessDispatch(
            { cli: 'agy' },
            '',
            prompt,
            {
              cwd: cwd ?? checkoutDir,
              model,
              execMode: 'reviewer',
              timeout_ms: 15 * 60 * 1000,
            },
          );
          return {
            threadId: res.sessionId ?? res.adapterMeta?.conversation_id,
            content: res.responseText,
          };
        });
      };
    }

    const fresh = await openFn({
      prompt: seed,
      model: threadConfig.model,
    });

    if (!fresh || typeof fresh.threadId !== 'string' || fresh.threadId.length === 0) {
      throw new Error('recoverStaleThread: openFn must return a non-empty threadId');
    }

    await setCodexThreadId(specPath, {
      role,
      oldThreadId,
      newThreadId: fresh.threadId,
      reason: 'session-not-found',
      phase,
      round,
      threadConfig,
    });
    return { recovered: true, newThreadId: fresh.threadId, content: fresh.content };
  }

  // Codex path
  if (!deps || typeof deps.codexFn !== 'function') {
    throw new Error('recoverStaleThread: deps.codexFn is required');
  }
  const threadConfig = recorded.legacy
    ? { role: recorded.role, ...resolveModelRoles({ repoRoot }).roles[recorded.role] }
    : { role: recorded.role, model: recorded.model, effort: recorded.effort };

  const fresh = await deps.codexFn({
    prompt: seed,
    model: threadConfig.model,
    config: { model_reasoning_effort: threadConfig.effort },
  });
  if (!fresh || typeof fresh.threadId !== 'string' || fresh.threadId.length === 0) {
    throw new Error('recoverStaleThread: codexFn must return a non-empty threadId');
  }
  await setCodexThreadId(specPath, {
    role, oldThreadId, newThreadId: fresh.threadId, reason: 'session-not-found', phase, round, threadConfig,
  });
  return { recovered: true, newThreadId: fresh.threadId, content: fresh.content };
}
