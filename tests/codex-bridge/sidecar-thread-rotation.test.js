// v0.13.0 Slice 3 — Codex thread-loss detection and recovery (Goal 3).
//
// MCP threads are process-local; on server restart `codex-reply` returns
// "Session not found for thread_id". These tests cover the sidecar rotation
// primitives, the stale-thread classifier, the replay-context builder (with
// goals fallback), and the deps-injected recovery orchestrator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSidecar,
  loadSidecar,
  setGoals,
  getCodexThreadId,
  setCodexThreadId,
  getThreadConfig,
  isStaleThreadResponse,
  buildReplayContext,
  extractGoalsBlockFromSpec,
  appendRound,
} from '../../lib/codex-bridge/sidecar.js';
import {
  recoverStaleThread,
  composeRecoveryPrompt,
  composeSeedPrompt,
  isStaleAgyResponse,
} from '../../lib/codex-bridge/thread-recovery.js';

function makeSpec(specBody = '# spec') {
  const dir = mkdtempSync(join(tmpdir(), 'cps-rotate-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, specBody);
  initSidecar(spec, { feature: 'rotate-demo', codexSession: 'old-tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const GOALS_BLOCK = '<<<GOALS>>>\n- Goal 1: do X.\n<<<END_GOALS>>>';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'codex-bridge', 'cli.js');

test('initSidecar records the planning thread model snapshot', () => {
  const { dir, spec } = makeSpec();
  const config = loadSidecar(spec).thread_config['paired-reviewer'];
  assert.deepEqual(
    { role: config.role, cli: config.cli, model: config.model, effort: config.effort },
    { role: 'planning', cli: 'codex', model: 'gpt-5.5', effort: 'high' },
  );
  assert.match(config.opened_at, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(dir, { recursive: true, force: true });
});

test('execution thread rotation atomically records its config without changing codex_session', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, {
    role: 'execution-reviewer', newThreadId: 'e1', reason: 'execution-thread',
    threadConfig: { role: 'review', model: 'gpt-6-astra', effort: 'high' },
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.codex_session, 'old-tid');
  assert.equal(sc.role_sessions['execution-reviewer'], 'e1');
  assert.deepEqual(
    { ...sc.thread_config['execution-reviewer'], opened_at: '<time>' },
    { role: 'review', model: 'gpt-6-astra', effort: 'high', opened_at: '<time>' },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('CLI rotate --threadConfig persists the execution snapshot', () => {
  const { dir, spec } = makeSpec();
  const threadConfig = JSON.stringify({ role: 'review', model: 'gpt-6-astra', effort: 'high' });
  execFileSync('node', [CLI, 'sidecar-rotate-thread-id', '--specPath', spec,
    '--role', 'execution-reviewer', '--newThreadId', 'e-cli', '--reason', 'execution-thread',
    '--threadConfig', threadConfig]);
  const sc = loadSidecar(spec);
  assert.equal(sc.role_sessions['execution-reviewer'], 'e-cli');
  assert.equal(sc.thread_config['execution-reviewer'].model, 'gpt-6-astra');
  rmSync(dir, { recursive: true, force: true });
});

test('getThreadConfig returns recorded entries and a role-aware legacy fallback with cli: "codex"', () => {
  const recorded = { role: 'review', cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high', opened_at: 'now' };
  assert.deepEqual(getThreadConfig({ thread_config: { 'execution-reviewer': recorded } }, 'execution-reviewer'), recorded);
  // Entry without cli returns cli: 'codex'
  const withoutCli = { role: 'review', model: 'gpt-6-astra', effort: 'high', opened_at: 'now' };
  assert.deepEqual(getThreadConfig({ thread_config: { 'execution-reviewer': withoutCli } }, 'execution-reviewer'), {
    ...withoutCli, cli: 'codex',
  });
  // Legacy sidecar without thread_config returns cli: 'codex'
  assert.deepEqual(getThreadConfig({}, 'execution-reviewer'), {
    role: 'review', cli: 'codex', model: null, effort: null, legacy: true,
  });
});

test('setCodexThreadId rejects unsafe or unknown thread configuration', async () => {
  const { dir, spec } = makeSpec();
  await assert.rejects(
    setCodexThreadId(spec, { newThreadId: 'e1', threadConfig: { role: 'nope', model: 'm', effort: 'high' } }),
    /threadConfig\.role/,
  );
  await assert.rejects(
    setCodexThreadId(spec, { newThreadId: 'e1', threadConfig: { role: 'review', model: 'bad model', effort: 'high' } }),
    /threadConfig\.model/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('setCodexThreadId with threadConfig.cli: "agy" persists it and rejects cli: "gemini"', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, {
    role: 'execution-reviewer',
    newThreadId: 'agy-tid',
    reason: 'session-not-found',
    threadConfig: { role: 'review', cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.thread_config['execution-reviewer'].cli, 'agy');

  await assert.rejects(
    setCodexThreadId(spec, {
      newThreadId: 'bad-cli-tid',
      threadConfig: { role: 'review', cli: 'gemini', model: 'gemini-3.8-flash-high', effort: 'high' },
    }),
    /threadConfig\.cli/,
  );
  rmSync(dir, { recursive: true, force: true });
});

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

test('composeSeedPrompt explains execution transition and requires reading spec and plan first', () => {
  const replay = { feature: 'f', artifact: '/a.md', goals: GOALS_BLOCK, rounds: [], open_contentions: [], thread_rotations: [] };
  const prompt = composeSeedPrompt(replay, {
    reason: 'execution-thread', specPath: '/repo/spec.md', planPath: '/repo/plan.md', pendingPrompt: 'review now',
  });
  assert.match(prompt, /moving from planning to execution/i);
  assert.match(prompt, /\/repo\/spec\.md/);
  assert.match(prompt, /\/repo\/plan\.md/);
  assert.match(prompt, /read[\s\S]*before answering/i);
});

test('composeSeedPrompt retains lost-thread recovery wording', () => {
  const prompt = composeSeedPrompt({ feature: 'f', rounds: [] }, { reason: 'session-not-found' });
  assert.match(prompt, /thread was lost/i);
});

test('composeRecoveryPrompt is the session-not-found seed alias', () => {
  const replay = { feature: 'f', rounds: [] };
  const opts = { pendingPrompt: 'p', phase: 'plan', round: 2, specPath: '/s', planPath: '/p' };
  assert.equal(composeRecoveryPrompt(replay, opts), composeSeedPrompt(replay, { reason: 'session-not-found', ...opts }));
});

test('recoverStaleThread uses and preserves execution thread config across repeated losses', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, {
    role: 'execution-reviewer', newThreadId: 'e1', reason: 'execution-thread',
    threadConfig: { role: 'review', model: 'gpt-6-astra', effort: 'high' },
  });
  const calls = [];
  const deps = { codexFn: async (args) => { calls.push(args); return { threadId: `e${calls.length + 1}`, content: 'ok' }; } };
  const staleResponse = { isError: true, content: 'Session not found for thread_id: e1' };
  const ctx = {
    staleResponse, role: 'execution-reviewer', pendingPrompt: 'p', phase: 'review-slice:slice-3',
    specPath: '/repo/spec.md', planPath: '/repo/plan.md', repoRoot: dir,
  };
  await recoverStaleThread(spec, ctx, deps);
  await recoverStaleThread(spec, ctx, deps);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.model, 'gpt-6-astra');
    assert.deepEqual(call.config, { model_reasoning_effort: 'high' });
    assert.match(call.prompt, /\/repo\/spec\.md/);
  }
  assert.deepEqual(
    { ...loadSidecar(spec).thread_config['execution-reviewer'], opened_at: '<time>' },
    { role: 'review', model: 'gpt-6-astra', effort: 'high', opened_at: '<time>' },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('recoverStaleThread resolves legacy thread config from environment and records it', async () => {
  const { dir, spec } = makeSpec();
  const legacy = loadSidecar(spec);
  delete legacy.thread_config;
  writeFileSync(`${spec}.codex.json`, JSON.stringify(legacy));
  const old = process.env.CODEX_PAIRED_MODEL_REVIEW;
  process.env.CODEX_PAIRED_MODEL_REVIEW = 'gpt-5.6-terra';
  let call;
  try {
    await recoverStaleThread(spec, {
      staleResponse: { isError: true, content: 'Session not found for thread_id: old-tid' },
      role: 'execution-reviewer', pendingPrompt: 'p', repoRoot: dir,
    }, { codexFn: async (args) => { call = args; return { threadId: 'e1', content: 'ok' }; } });
  } finally {
    if (old === undefined) delete process.env.CODEX_PAIRED_MODEL_REVIEW;
    else process.env.CODEX_PAIRED_MODEL_REVIEW = old;
  }
  assert.equal(call.model, 'gpt-5.6-terra');
  assert.deepEqual(call.config, { model_reasoning_effort: 'high' });
  assert.equal(loadSidecar(spec).thread_config['execution-reviewer'].model, 'gpt-5.6-terra');
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.17.0 agy recovery ──

test('isStaleAgyResponse: detects missing conversation errors in agy response', () => {
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'ERROR', stderr: 'Conversation 123 not found' },
    }),
    true,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'FAILED' },
      stderr: 'conversation does not exist',
    }),
    true,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'UNKNOWN' },
      warnings: ['stderr:unknown conversation conv-xyz'],
    }),
    true,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'ERROR', error: 'conversation id unknown' },
    }),
    true,
  );
  assert.equal(
    isStaleAgyResponse({
      status: 'FAILED',
      stderr: 'conversation not found',
    }),
    true,
  );
});

test('isStaleAgyResponse: returns false for SUCCESS, non-conversation errors, or non-objects', () => {
  assert.equal(isStaleAgyResponse(null), false);
  assert.equal(isStaleAgyResponse(undefined), false);
  assert.equal(isStaleAgyResponse({}), false);
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'SUCCESS', stderr: 'conversation not found' },
    }),
    false,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'ERROR', stderr: 'rate limit exceeded' },
    }),
    false,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'ERROR', stderr: 'file not found' },
    }),
    false,
  );
  assert.equal(
    isStaleAgyResponse({
      adapterMeta: { status: 'ERROR', stderr: 'conversation is currently active' },
    }),
    false,
  );
});

test('recoverStaleThread with agy thread calls openFn once with recorded model and rotates carrying cli: "agy"', async () => {
  const { dir, spec } = makeSpec(`# spec\n${GOALS_BLOCK}`);
  await setCodexThreadId(spec, {
    role: 'execution-reviewer',
    newThreadId: 'agy-old-id',
    reason: 'execution-thread',
    threadConfig: {
      role: 'review',
      cli: 'agy',
      model: 'gemini-3.8-flash-high',
      effort: 'high',
    },
  });

  let openFnCalls = 0;
  let capturedArgs = null;
  const deps = {
    openFn: async (args) => {
      openFnCalls++;
      capturedArgs = args;
      return {
        threadId: 'fresh-agy-tid',
        content: '...recovered agy review...',
      };
    },
  };

  const staleResponse = {
    adapterMeta: {
      status: 'ERROR',
      stderr: 'Conversation agy-old-id not found',
    },
  };

  const result = await recoverStaleThread(
    spec,
    {
      staleResponse,
      role: 'execution-reviewer',
      pendingPrompt: 'Pending agy review prompt',
      phase: 'review-slice:slice-4',
      round: 1,
      repoRoot: dir,
    },
    deps,
  );

  assert.equal(openFnCalls, 1);
  assert.equal(capturedArgs.model, 'gemini-3.8-flash-high');
  assert.match(capturedArgs.prompt, /<<<GOALS>>>/);
  assert.match(capturedArgs.prompt, /Pending agy review prompt/);
  assert.equal(result.recovered, true);
  assert.equal(result.newThreadId, 'fresh-agy-tid');
  assert.equal(result.content, '...recovered agy review...');

  const sc = loadSidecar(spec);
  assert.equal(sc.role_sessions['execution-reviewer'], 'fresh-agy-tid');
  assert.equal(sc.thread_config['execution-reviewer'].cli, 'agy');
  assert.equal(sc.thread_config['execution-reviewer'].model, 'gemini-3.8-flash-high');
  assert.equal(sc.thread_config['execution-reviewer'].effort, 'high');
  const lastRot = sc.thread_rotations[sc.thread_rotations.length - 1];
  assert.equal(lastRot.reason, 'session-not-found');
  assert.equal(lastRot.new_thread_id, 'fresh-agy-tid');
  assert.equal(lastRot.old_thread_id, 'agy-old-id');

  rmSync(dir, { recursive: true, force: true });
});

test('recoverStaleThread: sidecar without cli still uses codexFn', async () => {
  const { dir, spec } = makeSpec();
  const legacy = loadSidecar(spec);
  delete legacy.thread_config;
  writeFileSync(`${spec}.codex.json`, JSON.stringify(legacy));

  let codexCalls = 0;
  let callArgs = null;
  const deps = {
    codexFn: async (args) => {
      codexCalls++;
      callArgs = args;
      return { threadId: 'fresh-codex-id', content: 'codex recovered' };
    },
  };

  const stale = { isError: true, content: 'Session not found for thread_id: old-tid' };
  const result = await recoverStaleThread(
    spec,
    { staleResponse: stale, pendingPrompt: 'hello', repoRoot: dir },
    deps,
  );

  assert.equal(codexCalls, 1);
  assert.equal(result.recovered, true);
  assert.equal(result.newThreadId, 'fresh-codex-id');
  const sc = loadSidecar(spec);
  assert.equal(sc.thread_config['paired-reviewer'].cli, 'codex');

  rmSync(dir, { recursive: true, force: true });
});
