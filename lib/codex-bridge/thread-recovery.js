// v0.13.0 Slice 3 — Codex thread-loss recovery orchestrator (Goal 3).
//
// MCP threads are process-local; a `codex-reply` against a thread from a restarted server
// returns "Session not found for thread_id". This module turns that into a graceful recovery:
// re-seed a fresh thread with the goals block + a compact replay of prior sidecar rounds, then
// rotate the persisted thread id. All MCP I/O is injected so the flow is unit-testable.

import {
  isStaleThreadResponse,
  buildReplayContext,
  getCodexThreadId,
  setCodexThreadId,
  loadSidecar,
  getThreadConfig,
} from './sidecar.js';
import { resolveModelRoles } from './models.js';

/**
 * Build an execution-thread or recovery seed that reloads authoritative
 * artifacts before review (v0.16.0 spec §5).
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
export function composeRecoveryPrompt(replay, opts = {}) {
  return composeSeedPrompt(replay, { reason: 'session-not-found', ...opts });
}

/**
 * Detect a stale-thread response and recover. On recovery, makes exactly one initial `codex`
 * call (deps.codexFn) and exactly one sidecar thread rotation.
 *
 * @param {string} specPath
 * @param {{staleResponse: object, pendingPrompt: string, phase?: string, round?: number, role?: string}} ctx
 * @param {{codexFn: (args: {prompt: string}) => Promise<{threadId: string, content: any}>}} deps
 * @returns {Promise<{recovered: boolean, newThreadId?: string, content?: any, response?: object}>}
 */
export async function recoverStaleThread(specPath, ctx, deps) {
  const {
    staleResponse, pendingPrompt, phase, round, role = 'paired-reviewer',
    specPath: promptSpecPath, planPath, repoRoot = process.cwd(),
  } = ctx || {};
  if (!isStaleThreadResponse(staleResponse)) {
    return { recovered: false, response: staleResponse };
  }
  if (!deps || typeof deps.codexFn !== 'function') {
    throw new Error('recoverStaleThread: deps.codexFn is required');
  }
  const replay = buildReplayContext(specPath);
  const sc = loadSidecar(specPath);
  const oldThreadId = getCodexThreadId(sc, role);
  const recorded = getThreadConfig(sc, role);
  const threadConfig = recorded.legacy
    ? { role: recorded.role, ...resolveModelRoles({ repoRoot }).roles[recorded.role] }
    : { role: recorded.role, model: recorded.model, effort: recorded.effort };
  const seed = composeRecoveryPrompt(replay, {
    pendingPrompt, phase, round, specPath: promptSpecPath ?? specPath, planPath,
  });
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
