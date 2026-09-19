// v0.17.0 Slice 4 — Reviewer thread on agy + throwaway checkout tests.
// Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §4
// Plan: docs/plans/2026-09-17-v0.17.0-antigravity-transport.md (Slice 4)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  openReviewerThread,
  openPanelMemberThread,
  continueReviewerThread,
} from '../../lib/codex-bridge/reviewer-thread.js';
import {
  initSidecar,
  loadSidecar,
  getCodexThreadId,
} from '../../lib/codex-bridge/sidecar.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'lib', 'codex-bridge', 'cli.js');
const FAKE_AGY_SH = join(REPO_ROOT, 'tests', 'fixtures', 'fake-cli', 'agy.sh');

const MIN_PROJECT_CONFIG = {
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'library' },
};

function setupRepo(projectConfig = null) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-rev-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });

  writeFileSync(
    join(dir, '.gitignore'),
    '.git-worktrees/\n.superpowers-codex-paired/\n',
  );
  execFileSync('git', ['add', '.gitignore'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: dir });

  if (projectConfig) {
    mkdirSync(join(dir, '.codex-paired'), { recursive: true });
    writeFileSync(
      join(dir, '.codex-paired', 'project.json'),
      JSON.stringify(projectConfig),
    );
  }

  return dir;
}

test('openReviewerThread with role:review on agy invokes dispatch and records sidecar rotation', async () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      review: {
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    },
  });

  try {
    const specRel = join('docs', 'spec.md');
    const planRel = join('docs', 'plan.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec Content\n');
    writeFileSync(join(dir, planRel), '# Plan Content\n');

    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-feature',
      codexSession: 'old-session-1',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    const statusBefore = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    });

    let dispatchCalled = 0;
    let capturedOptions = null;
    let capturedPrompt = null;
    let seenCwdFiles = null;
    let seenCwd = null;

    const deps = {
      dispatch: async (target, sys, prompt, opts) => {
        dispatchCalled++;
        capturedPrompt = prompt;
        // Handle options parameter whether called with 3 or 4 arguments
        capturedOptions = opts !== undefined ? opts : prompt;
        seenCwd = capturedOptions.cwd;
        seenCwdFiles = {
          specExists: existsSync(join(seenCwd, specRel)),
          planExists: existsSync(join(seenCwd, planRel)),
          specContent: existsSync(join(seenCwd, specRel))
            ? readFileSync(join(seenCwd, specRel), 'utf8')
            : null,
        };
        return {
          responseText: 'review response text',
          sessionId: 'conv-agy-123',
          adapterMeta: {
            status: 'SUCCESS',
            conversation_id: 'conv-agy-123',
            usage: { prompt_tokens: 150, completion_tokens: 45 },
          },
        };
      },
    };

    const result = await openReviewerThread(
      {
        role: 'review',
        specPath: specRel,
        repoRoot: dir,
        prompt: 'Please review this spec and plan',
        planPath: planRel,
      },
      deps,
    );

    assert.equal(dispatchCalled, 1);
    assert.equal(capturedOptions.execMode, 'reviewer');
    assert.equal(capturedOptions.model, 'gemini-3.8-flash-high');
    assert.equal(capturedOptions.conversationId, undefined);
    assert.ok(seenCwd !== dir, 'must run in throwaway checkout, not repoRoot');
    assert.ok(!existsSync(seenCwd), 'throwaway checkout must be cleaned up');
    assert.equal(seenCwdFiles.specExists, true);
    assert.equal(seenCwdFiles.planExists, true);
    assert.equal(seenCwdFiles.specContent, '# Spec Content\n');

    assert.equal(result.threadId, 'conv-agy-123');
    assert.equal(result.content, 'review response text');
    assert.deepEqual(result.usage, { prompt_tokens: 150, completion_tokens: 45 });
    assert.equal(result.ok, true);
    assert.equal(result.exit, 0);
    assert.equal(result.status, 'SUCCESS');
    assert.deepEqual(result.warnings, []);

    const sc = loadSidecar(specAbs);
    assert.equal(sc.role_sessions['execution-reviewer'], 'conv-agy-123');
    assert.deepEqual(
      {
        role: sc.thread_config['execution-reviewer'].role,
        cli: sc.thread_config['execution-reviewer'].cli,
        model: sc.thread_config['execution-reviewer'].model,
        effort: sc.thread_config['execution-reviewer'].effort,
      },
      {
        role: 'review',
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    );
    assert.match(sc.thread_config['execution-reviewer'].opened_at, /^\d{4}-\d{2}-\d{2}T/);
    const lastRot = sc.thread_rotations[sc.thread_rotations.length - 1];
    assert.equal(lastRot.reason, 'opened');
    assert.equal(lastRot.new_thread_id, 'conv-agy-123');
    assert.equal(lastRot.role, 'execution-reviewer');

    const statusAfter = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(statusAfter, statusBefore, 'repo git status must remain unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openReviewerThread with role:planning updates paired-reviewer sidecar key', async () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      planning: {
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    },
  });

  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec Content\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-plan',
      codexSession: 'old-session-2',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    const deps = {
      dispatch: async () => ({
        responseText: 'planning review ok',
        sessionId: 'conv-agy-planning-456',
        adapterMeta: {
          status: 'SUCCESS',
          conversation_id: 'conv-agy-planning-456',
          usage: null,
        },
      }),
    };

    const result = await openReviewerThread(
      {
        role: 'planning',
        specPath: specAbs,
        repoRoot: dir,
        prompt: 'Planning prompt',
      },
      deps,
    );

    assert.equal(result.threadId, 'conv-agy-planning-456');
    const sc = loadSidecar(specAbs);
    assert.equal(sc.role_sessions['paired-reviewer'], 'conv-agy-planning-456');
    assert.equal(sc.codex_session, 'conv-agy-planning-456');
    assert.equal(sc.thread_config['paired-reviewer'].role, 'planning');
    assert.equal(sc.thread_config['paired-reviewer'].cli, 'agy');
    assert.equal(sc.thread_config['paired-reviewer'].model, 'gemini-3.8-flash-high');
    assert.equal(sc.thread_config['paired-reviewer'].effort, 'high');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PANEL_VERDICT = `<<<VERDICT>>>\nstatus: SHIP\nversion: v1\ncritique: []\ndeferred: []\nrationale: ok\n<<<END>>>`;

function panelSpec(dir, feature) {
  const specRel = join('docs', 'spec.md');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, specRel), '# Spec Content\n');
  const specAbs = join(dir, specRel);
  initSidecar(specAbs, { feature, codexSession: 'legacy', model: 'gpt-6-astra', reasoningEffort: 'high' });
  return { specRel, specAbs };
}

function panelMember(dir, specRel, model, round) {
  return {
    role: 'review', specPath: specRel, repoRoot: dir,
    member_id: `agy:${model}`, model, version: 'v1',
    prompt: 'ROUND PROMPT: review the artifact; verdict format applies', replay: `round ${round}`,
  };
}

// Each Gemini member keeps ONE conversation for the phase, like a Codex member keeps one thread.
// Its id lives in role_sessions under `<sidecarKey>:<member_id>`, owned by this function.
test('openPanelMemberThread continues one agy conversation per member across rounds and stores it', async () => {
  const dir = setupRepo();
  try {
    const { specRel, specAbs } = panelSpec(dir, 'panel-continue');
    const given = [];
    const prompts = [];
    const deps = {
      withReviewCheckout: async (_root, _opts, fn) => fn(dir),
      dispatch: async (_target, _sys, prompt, options) => {
        given.push(options.conversationId);
        prompts.push(prompt);
        return { responseText: PANEL_VERDICT, sessionId: 'conv-1', adapterMeta: { status: 'SUCCESS', conversation_id: 'conv-1', usage: null } };
      },
    };
    const results = [];
    for (let round = 1; round <= 3; round += 1) {
      results.push(await openPanelMemberThread(panelMember(dir, specRel, 'gemini-panel-high', round), deps));
    }
    assert.deepEqual(given, [undefined, 'conv-1', 'conv-1']);
    assert.deepEqual(results.map((r) => [r.threadId, r.resumed, r.recovered]), [
      ['conv-1', false, false], ['conv-1', true, false], ['conv-1', true, false],
    ]);
    prompts.forEach((prompt, index) => {
      assert.match(prompt, /^Artifact version: v1/);
      assert.match(prompt, /ROUND PROMPT: review the artifact/);
      assert.match(prompt, /current working directory is a fresh checkout of this version/);
      assert.match(prompt, new RegExp(`round ${index + 1}$`));
    });
    const sc = loadSidecar(specAbs);
    assert.equal(sc.role_sessions['execution-reviewer:agy:gemini-panel-high'], 'conv-1');
    assert.equal(sc.role_sessions['execution-reviewer'], undefined);
    assert.equal(sc.codex_session, 'legacy');
    const rotations = sc.thread_rotations.filter((r) => r.role === 'execution-reviewer:agy:gemini-panel-high');
    assert.deepEqual(rotations.map((r) => r.reason), ['panel-member-open'], 'stored once, not on every round');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openPanelMemberThread keeps separate conversations for two Gemini members and per phase', async () => {
  const dir = setupRepo();
  try {
    const { specRel, specAbs } = panelSpec(dir, 'panel-two');
    let next = 0;
    const deps = {
      withReviewCheckout: async (_root, _opts, fn) => fn(dir),
      dispatch: async (_target, _sys, _prompt, options) => {
        const id = options.conversationId ?? `conv-${(next += 1)}`;
        return { responseText: PANEL_VERDICT, sessionId: id, adapterMeta: { status: 'SUCCESS', conversation_id: id, usage: null } };
      },
    };
    await openPanelMemberThread(panelMember(dir, specRel, 'gemini-a-high', 1), deps);
    await openPanelMemberThread(panelMember(dir, specRel, 'gemini-b-high', 1), deps);
    await openPanelMemberThread({ ...panelMember(dir, specRel, 'gemini-a-high', 1), role: 'planning' }, deps);
    const sessions = loadSidecar(specAbs).role_sessions;
    assert.equal(sessions['execution-reviewer:agy:gemini-a-high'], 'conv-1');
    assert.equal(sessions['execution-reviewer:agy:gemini-b-high'], 'conv-2');
    assert.equal(sessions['paired-reviewer:agy:gemini-a-high'], 'conv-3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openPanelMemberThread recovers a lost conversation once by opening a new one with the replay', async () => {
  const dir = setupRepo();
  try {
    const { specRel, specAbs } = panelSpec(dir, 'panel-recover');
    const deps1 = {
      withReviewCheckout: async (_root, _opts, fn) => fn(dir),
      dispatch: async () => ({ responseText: PANEL_VERDICT, sessionId: 'conv-old', adapterMeta: { status: 'SUCCESS', conversation_id: 'conv-old' } }),
    };
    await openPanelMemberThread(panelMember(dir, specRel, 'gemini-panel-high', 1), deps1);
    const given = [];
    const prompts = [];
    const deps2 = {
      withReviewCheckout: async (_root, _opts, fn) => fn(dir),
      dispatch: async (_target, _sys, prompt, options) => {
        given.push(options.conversationId);
        prompts.push(prompt);
        if (options.conversationId === 'conv-old') {
          return { responseText: '', exit: 1, sessionId: null, adapterMeta: { status: 'ERROR', stderr: 'conversation conv-old not found' } };
        }
        return { responseText: PANEL_VERDICT, sessionId: 'conv-new', adapterMeta: { status: 'SUCCESS', conversation_id: 'conv-new' } };
      },
    };
    const result = await openPanelMemberThread(panelMember(dir, specRel, 'gemini-panel-high', 2), deps2);
    assert.deepEqual(given, ['conv-old', undefined]);
    assert.equal(prompts[0], prompts[1], 'the new conversation gets the same prompt, including the replay');
    assert.equal(result.ok, true);
    assert.equal(result.threadId, 'conv-new');
    assert.equal(result.recovered, true);
    const sc = loadSidecar(specAbs);
    assert.equal(sc.role_sessions['execution-reviewer:agy:gemini-panel-high'], 'conv-new');
    const last = sc.thread_rotations.at(-1);
    assert.deepEqual([last.old_thread_id, last.new_thread_id, last.reason], ['conv-old', 'conv-new', 'panel-member-recovered']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openPanelMemberThread never stores a conversation from a failed turn and does not retry a non-stale failure', async () => {
  const dir = setupRepo();
  try {
    const { specRel, specAbs } = panelSpec(dir, 'panel-fail');
    let calls = 0;
    const result = await openPanelMemberThread(panelMember(dir, specRel, 'gemini-panel-high', 1), {
      withReviewCheckout: async (_root, _opts, fn) => fn(dir),
      dispatch: async () => {
        calls += 1;
        return { responseText: '', exit: 1, sessionId: 'conv-x', adapterMeta: { status: 'ERROR', conversation_id: 'conv-x', stderr: 'quota exceeded' } };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(loadSidecar(specAbs).role_sessions?.['execution-reviewer:agy:gemini-panel-high'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('continueReviewerThread passes stored conversationId and does not rotate', async () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      review: {
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    },
  });

  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec Content\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-continue',
      codexSession: 'old-session-3',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    let openCaptured = null;
    let replyCaptured = null;

    const openDeps = {
      dispatch: async (target, sys, prompt, opts) => {
        openCaptured = opts !== undefined ? opts : prompt;
        return {
          responseText: 'initial review',
          sessionId: 'conv-agy-orig',
          adapterMeta: {
            status: 'SUCCESS',
            conversation_id: 'conv-agy-orig',
            usage: { prompt_tokens: 100 },
          },
        };
      },
    };

    await openReviewerThread(
      {
        role: 'review',
        specPath: specAbs,
        repoRoot: dir,
        prompt: 'initial prompt',
      },
      openDeps,
    );

    const scAfterOpen = loadSidecar(specAbs);
    const rotationCountBefore = (scAfterOpen.thread_rotations || []).length;

    const replyDeps = {
      dispatch: async (target, sys, prompt, opts) => {
        replyCaptured = opts !== undefined ? opts : prompt;
        return {
          responseText: 'reply review',
          sessionId: 'conv-agy-orig',
          adapterMeta: {
            status: 'SUCCESS',
            conversation_id: 'conv-agy-orig',
            usage: { prompt_tokens: 120 },
          },
        };
      },
    };

    const replyResult = await continueReviewerThread(
      {
        role: 'review',
        specPath: specAbs,
        repoRoot: dir,
        prompt: 'reply prompt',
      },
      replyDeps,
    );

    assert.equal(replyCaptured.conversationId, 'conv-agy-orig');
    assert.equal(replyResult.threadId, 'conv-agy-orig');
    assert.equal(replyResult.content, 'reply review');

    const scAfterReply = loadSidecar(specAbs);
    assert.equal((scAfterReply.thread_rotations || []).length, rotationCountBefore);
    assert.equal(scAfterReply.role_sessions['execution-reviewer'], 'conv-agy-orig');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex role throws reviewer-thread-codex-uses-mcp', async () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      review: {
        cli: 'codex',
        model: 'gpt-6-astra',
        effort: 'high',
      },
    },
  });

  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec Content\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-codex-guard',
      codexSession: 'session-c',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    await assert.rejects(
      openReviewerThread({
        role: 'review',
        specPath: specAbs,
        repoRoot: dir,
        prompt: 'Prompt',
      }),
      (err) => err.code === 'reviewer-thread-codex-uses-mcp',
    );

    await assert.rejects(
      continueReviewerThread({
        role: 'review',
        specPath: specAbs,
        repoRoot: dir,
        prompt: 'Prompt',
      }),
      (err) => err.code === 'reviewer-thread-codex-uses-mcp',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay filtering: missing planPath is silently skipped, missing specPath throws review-overlay-invalid', async () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      review: {
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    },
  });

  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec Content\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-overlay',
      codexSession: 'sess-1',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    let seenCwd = null;
    const deps = {
      dispatch: async (target, sys, prompt, opts) => {
        const options = opts !== undefined ? opts : prompt;
        seenCwd = options.cwd;
        return {
          responseText: 'ok',
          sessionId: 'conv-1',
          adapterMeta: { status: 'SUCCESS', conversation_id: 'conv-1' },
        };
      },
    };

    // Missing planPath silently skipped:
    const result = await openReviewerThread(
      {
        role: 'review',
        specPath: specRel,
        repoRoot: dir,
        prompt: 'prompt',
        planPath: 'docs/nonexistent-plan.md',
        overlayPaths: ['docs/also-nonexistent.md'],
      },
      deps,
    );
    assert.equal(result.threadId, 'conv-1');

    // Missing specPath throws review-overlay-invalid:
    await assert.rejects(
      openReviewerThread(
        {
          role: 'review',
          specPath: 'docs/missing-spec.md',
          repoRoot: dir,
          prompt: 'prompt',
        },
        deps,
      ),
      (err) => err.code === 'review-overlay-invalid',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI verbs: reviewer-thread-open and reviewer-thread-reply with fake agy CLI', () => {
  const dir = setupRepo({
    ...MIN_PROJECT_CONFIG,
    models: {
      review: {
        cli: 'agy',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
      },
    },
  });

  const binDir = mkdtempSync(join(tmpdir(), 'cps-bin-'));
  const agyBin = join(binDir, 'agy');
  copyFileSync(FAKE_AGY_SH, agyBin);
  chmodSync(agyBin, 0o755);

  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# Spec for CLI Test\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, {
      feature: 'test-cli',
      codexSession: 'old-sess',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
    });

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_AGY_CONVERSATION: 'cli-conv-777',
      FAKE_AGY_RESPONSE: 'cli response text',
      FAKE_AGY_STATUS: 'SUCCESS',
    };

    // 1. Test reviewer-thread-open
    const openOutput = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        'reviewer-thread-open',
        '--role',
        'review',
        '--specPath',
        specAbs,
        '--repoRoot',
        dir,
        '--prompt-stdin',
      ],
      {
        input: 'Please review from CLI',
        env,
        encoding: 'utf8',
      },
    );

    const openParsed = JSON.parse(openOutput);
    assert.equal(openParsed.threadId, 'cli-conv-777');
    assert.equal(openParsed.content, 'cli response text');
    assert.ok(openParsed.usage !== undefined);

    const sc = loadSidecar(specAbs);
    assert.equal(sc.role_sessions['execution-reviewer'], 'cli-conv-777');

    // 2. Test reviewer-thread-reply
    const replyEnv = {
      ...env,
      FAKE_AGY_RESPONSE: 'cli reply response text',
    };
    const replyOutput = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        'reviewer-thread-reply',
        '--role',
        'review',
        '--specPath',
        specAbs,
        '--repoRoot',
        dir,
        '--prompt-stdin',
      ],
      {
        input: 'Continue discussion from CLI',
        env: replyEnv,
        encoding: 'utf8',
      },
    );

    const replyParsed = JSON.parse(replyOutput);
    assert.equal(replyParsed.threadId, 'cli-conv-777');
    assert.equal(replyParsed.content, 'cli reply response text');

    // 3. Test missing args exit 2
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [CLI_PATH, 'reviewer-thread-open', '--specPath', specAbs],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    }, (err) => err.status === 2);

    // 4. Test codex role exits 2 with message
    assert.throws(() => {
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          'reviewer-thread-open',
          '--role',
          'planning', // default planning role uses codex
          '--specPath',
          specAbs,
          '--repoRoot',
          dir,
          '--prompt-stdin',
        ],
        {
          input: 'Prompt for codex',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }, (err) => err.status === 2);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── Claude C0 review of slice 4: adapter failures must be visible, not empty replies ──

test('continueReviewerThread surfaces a non-SUCCESS agy status as ok:false with exit/status/warnings', async () => {
  const dir = setupRepo({ ...MIN_PROJECT_CONFIG, models: { review: { cli: 'agy', model: 'gemini-3.8-flash-high' } } });
  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# spec\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, { feature: 'f', codexSession: 'conv-1', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const result = await continueReviewerThread(
      { role: 'review', specPath: specAbs, repoRoot: dir, prompt: 'p', conversationId: 'conv-1' },
      { dispatch: async (_sys, _prompt, _opts) => ({
          responseText: '', exit: 1, warnings: ['agy-status:ERROR', 'stderr:conversation conv-1 not found'],
          sessionId: null, adapterMeta: { adapter: 'cli-harness:agy', status: 'ERROR', stderr: 'conversation conv-1 not found' }, duration_ms: 1,
        }) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.exit, 1);
    assert.equal(result.status, 'ERROR');
    assert.ok(result.warnings.includes('agy-status:ERROR'));
    assert.equal(result.content, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('openReviewerThread does not record a thread when the open turn failed', async () => {
  const dir = setupRepo({ ...MIN_PROJECT_CONFIG, models: { review: { cli: 'agy', model: 'gemini-3.8-flash-high' } } });
  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# spec\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, { feature: 'f', codexSession: 'old', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const result = await openReviewerThread(
      { role: 'review', specPath: specAbs, repoRoot: dir, prompt: 'p' },
      { dispatch: async () => ({ responseText: '', exit: 1, warnings: ['timeout'], sessionId: 'half-open', adapterMeta: { adapter: 'cli-harness:agy' }, duration_ms: 1 }) },
    );
    assert.equal(result.ok, false);
    assert.equal(getCodexThreadId(loadSidecar(specAbs), 'execution-reviewer'), undefined, 'a failed open must not persist a thread id');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI verbs exit 1 and print status when the fake agy reports ERROR', () => {
  const dir = setupRepo({ ...MIN_PROJECT_CONFIG, models: { review: { cli: 'agy', model: 'gemini-3.8-flash-high' } } });
  const binDir = mkdtempSync(join(tmpdir(), 'cps-bin-'));
  copyFileSync(FAKE_AGY_SH, join(binDir, 'agy'));
  chmodSync(join(binDir, 'agy'), 0o755);
  try {
    const specRel = join('docs', 'spec.md');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, specRel), '# spec\n');
    const specAbs = join(dir, specRel);
    initSidecar(specAbs, { feature: 'f', codexSession: 'old', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_AGY_CONVERSATION: 'c9', FAKE_AGY_RESPONSE: '', FAKE_AGY_STATUS: 'ERROR' };
    let status = 0; let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [CLI_PATH, 'reviewer-thread-open', '--role', 'review', '--specPath', specAbs, '--repoRoot', dir, '--prompt-stdin'], { input: 'p', env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { status = e.status; stdout = e.stdout; }
    assert.equal(status, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 'ERROR');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('openPanelMemberThread rejects a missing round prompt and an over-budget replay', async () => {
  const base = {
    role: 'review', specPath: 'docs/spec.md', repoRoot: process.cwd(),
    member_id: 'agy:gemini-panel-high', model: 'gemini-panel-high', version: 'v1',
  };
  const deps = { dispatch: async () => { throw new Error('must not dispatch'); } };
  await assert.rejects(() => openPanelMemberThread({ ...base, replay: 'r' }, deps), /prompt/);
  await assert.rejects(() => openPanelMemberThread({ ...base, prompt: '   ', replay: 'r' }, deps), /prompt/);
  // The 12,000-character budget applies to the replay only, never to the round prompt.
  await assert.rejects(() => openPanelMemberThread({ ...base, prompt: 'p', replay: 'x'.repeat(12_001) }, deps), /replay/);
});
