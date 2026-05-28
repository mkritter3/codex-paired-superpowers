// v0.13.0 Slice 3 — Codex thread-loss detection and recovery (Goal 3).
//
// MCP threads are process-local; on server restart `codex-reply` returns
// "Session not found for thread_id". These tests cover the sidecar rotation
// primitives, the stale-thread classifier, the replay-context builder (with
// goals fallback), and the deps-injected recovery orchestrator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  setGoals,
  getCodexThreadId,
  setCodexThreadId,
  isStaleThreadResponse,
  buildReplayContext,
  extractGoalsBlockFromSpec,
  appendRound,
} from '../../lib/codex-bridge/sidecar.js';
import { recoverStaleThread, composeRecoveryPrompt } from '../../lib/codex-bridge/thread-recovery.js';

function makeSpec(specBody = '# spec') {
  const dir = mkdtempSync(join(tmpdir(), 'cps-rotate-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, specBody);
  initSidecar(spec, { feature: 'rotate-demo', codexSession: 'old-tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const GOALS_BLOCK = '<<<GOALS>>>\n- Goal 1: do X.\n<<<END_GOALS>>>';

// ── setCodexThreadId / thread_rotations ────────────────────────────────────

test('setCodexThreadId updates codex_session, role_sessions, and thread_rotations atomically', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, {
    role: 'paired-reviewer', oldThreadId: 'old-tid', newThreadId: 'new-tid',
    reason: 'session-not-found', phase: 'plan', round: 3,
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.codex_session, 'new-tid');
  assert.equal(sc.role_sessions['paired-reviewer'], 'new-tid');
  assert.equal(sc.thread_rotations.length, 1);
  const rot = sc.thread_rotations[0];
  assert.equal(rot.old_thread_id, 'old-tid');
  assert.equal(rot.new_thread_id, 'new-tid');
  assert.equal(rot.reason, 'session-not-found');
  assert.equal(rot.phase, 'plan');
  assert.equal(rot.round, 3);
  assert.match(rot.rotated_at, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(dir, { recursive: true, force: true });
});

test('getCodexThreadId returns role_sessions.paired-reviewer after rotation', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, { newThreadId: 'rotated-tid', oldThreadId: 'old-tid', reason: 'x' });
  assert.equal(getCodexThreadId(loadSidecar(spec)), 'rotated-tid');
  rmSync(dir, { recursive: true, force: true });
});

// ── stale-thread classifier ────────────────────────────────────────────────

test('isStaleThreadResponse: matches Session not found, not other errors', () => {
  assert.equal(isStaleThreadResponse({ isError: true, content: 'Session not found for thread_id: abc' }), true);
  assert.equal(isStaleThreadResponse({ isError: true, content: 'some other error' }), false);
  assert.equal(isStaleThreadResponse({ isError: false, content: 'Session not found for thread_id: abc' }), false);
  assert.equal(isStaleThreadResponse(null), false);
  assert.equal(isStaleThreadResponse({ isError: true, content: [{ text: 'Session not found for thread_id: z' }] }), true);
});

// ── replay context (+ goals fallback) ──────────────────────────────────────

test('buildReplayContext includes goals, rounds, contentions, rotations', async () => {
  const { dir, spec } = makeSpec();
  setGoals(spec, { block: GOALS_BLOCK });
  appendRound(spec, { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' });
  await setCodexThreadId(spec, { newThreadId: 'n', oldThreadId: 'old-tid', reason: 'x' });
  const rc = buildReplayContext(spec);
  assert.equal(rc.feature, 'rotate-demo');
  assert.equal(rc.goals, GOALS_BLOCK);
  assert.equal(rc.rounds.length, 1);
  assert.equal(rc.rounds[0].codex, 'SHIP');
  assert.equal(rc.thread_rotations.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('buildReplayContext falls back to spec-file goals when none persisted (spec §5.3 step 1)', () => {
  const { dir, spec } = makeSpec(`# spec\n\n${GOALS_BLOCK}\n\nmore text`);
  // no setGoals → persisted goals absent
  const rc = buildReplayContext(spec);
  assert.equal(rc.goals, GOALS_BLOCK);
  rmSync(dir, { recursive: true, force: true });
});

test('buildReplayContext goals is null when neither persisted nor in spec', () => {
  const { dir, spec } = makeSpec('# spec with no goals block');
  assert.equal(buildReplayContext(spec).goals, null);
  rmSync(dir, { recursive: true, force: true });
});

test('extractGoalsBlockFromSpec returns block or null', () => {
  const { dir, spec } = makeSpec(`prefix\n${GOALS_BLOCK}\nsuffix`);
  assert.equal(extractGoalsBlockFromSpec(spec), GOALS_BLOCK);
  assert.equal(extractGoalsBlockFromSpec('/no/such/file.md'), null);
  rmSync(dir, { recursive: true, force: true });
});

// ── recovery orchestrator (deps-injected fake MCP) ─────────────────────────

test('recoverStaleThread: stale reply → exactly one codex call + one rotation + recovery content', async () => {
  const { dir, spec } = makeSpec(`# spec\n${GOALS_BLOCK}`);
  let codexCalls = 0;
  const deps = {
    codexFn: async ({ prompt }) => {
      codexCalls += 1;
      assert.match(prompt, /<<<GOALS>>>/); // re-seeded with goals
      return { threadId: 'fresh-tid', content: '...resumed review...' };
    },
  };
  const stale = { isError: true, content: 'Session not found for thread_id: old-tid' };
  const result = await recoverStaleThread(
    spec,
    { staleResponse: stale, pendingPrompt: 'Round 2 prompt', phase: 'plan', round: 2 },
    deps,
  );
  assert.equal(codexCalls, 1);
  assert.equal(result.recovered, true);
  assert.equal(result.newThreadId, 'fresh-tid');
  assert.equal(result.content, '...resumed review...');
  const sc = loadSidecar(spec);
  assert.equal(sc.thread_rotations.length, 1);
  assert.equal(getCodexThreadId(sc), 'fresh-tid');
  rmSync(dir, { recursive: true, force: true });
});

test('recoverStaleThread: non-stale response → no recovery, zero codex calls, zero rotations', async () => {
  const { dir, spec } = makeSpec();
  let codexCalls = 0;
  const deps = { codexFn: async () => { codexCalls += 1; return { threadId: 'x', content: 'y' }; } };
  const normal = { isError: true, content: 'rate limited' };
  const result = await recoverStaleThread(spec, { staleResponse: normal, pendingPrompt: 'p', phase: 'plan', round: 1 }, deps);
  assert.equal(result.recovered, false);
  assert.equal(codexCalls, 0);
  assert.equal((loadSidecar(spec).thread_rotations || []).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('composeRecoveryPrompt embeds goals, replay, pending prompt, phase/round', () => {
  const replay = { feature: 'f', artifact: '/a.md', goals: GOALS_BLOCK, rounds: [{ phase: 'plan', round: 1, claude: 'SHIP', codex: 'REVISE' }], open_contentions: [], thread_rotations: [] };
  const p = composeRecoveryPrompt(replay, { pendingPrompt: 'PENDING-XYZ', phase: 'plan', round: 2 });
  assert.match(p, /<<<GOALS>>>/);
  assert.match(p, /PENDING-XYZ/);
  assert.match(p, /plan/);
  assert.match(p, /Session was lost|thread was lost|recovery/i);
});
