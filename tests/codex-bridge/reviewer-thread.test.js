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
