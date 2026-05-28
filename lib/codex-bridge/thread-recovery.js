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
} from './sidecar.js';

/**
 * Build the recovery seed prompt for the fresh thread: goals block, replay summary, artifact
 * path/phase, and the pending prompt that failed against the stale thread.
 */
export function composeRecoveryPrompt(replay, { pendingPrompt, phase, round } = {}) {
  const lines = [
    'You are the paired reviewer. The previous Codex thread was lost ("Session not found for',
    'thread_id") — this is a recovery re-seed. Continue as the same reviewer.',
    '',
    `Feature: ${replay.feature ?? '(unknown)'}`,
    `Artifact: ${replay.artifact ?? '(unknown)'}  Phase: ${phase ?? '(unknown)'}  Round: ${round ?? '(unknown)'}`,
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
 * Detect a stale-thread response and recover. On recovery, makes exactly one initial `codex`
 * call (deps.codexFn) and exactly one sidecar thread rotation.
 *
 * @param {string} specPath
 * @param {{staleResponse: object, pendingPrompt: string, phase?: string, round?: number, role?: string}} ctx
 * @param {{codexFn: (args: {prompt: string}) => Promise<{threadId: string, content: any}>}} deps
 * @returns {Promise<{recovered: boolean, newThreadId?: string, content?: any, response?: object}>}
 */
export async function recoverStaleThread(specPath, ctx, deps) {
  const { staleResponse, pendingPrompt, phase, round, role = 'paired-reviewer' } = ctx || {};
  if (!isStaleThreadResponse(staleResponse)) {
    return { recovered: false, response: staleResponse };
  }
  if (!deps || typeof deps.codexFn !== 'function') {
    throw new Error('recoverStaleThread: deps.codexFn is required');
  }
  const replay = buildReplayContext(specPath);
  const oldThreadId = getCodexThreadId(loadSidecar(specPath), role);
  const seed = composeRecoveryPrompt(replay, { pendingPrompt, phase, round });
  const fresh = await deps.codexFn({ prompt: seed });
  if (!fresh || typeof fresh.threadId !== 'string' || fresh.threadId.length === 0) {
    throw new Error('recoverStaleThread: codexFn must return a non-empty threadId');
  }
  await setCodexThreadId(specPath, {
    role, oldThreadId, newThreadId: fresh.threadId, reason: 'session-not-found', phase, round,
  });
  return { recovered: true, newThreadId: fresh.threadId, content: fresh.content };
}
