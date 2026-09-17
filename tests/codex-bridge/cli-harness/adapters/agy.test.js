import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatch } from '../../../../lib/codex-bridge/cli-harness/adapters/agy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FAKE_AGY = join(__dirname, '..', '..', '..', 'fixtures', 'fake-cli', 'agy.sh');

test('agy adapter reviewer argv composition', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  const argsFile = join(tmp, 'args.txt');
  const cwdFile = join(tmp, 'cwd.txt');
  try {
    const result = await dispatch('System instructions.', 'User query.', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      timeout_ms: 15 * 60 * 1000,
      env: {
        FAKE_AGY_ARGS_FILE: argsFile,
        FAKE_AGY_CWD_FILE: cwdFile,
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(result.adapterMeta.exec_mode, 'reviewer');
    assert.equal(result.adapterMeta.adapter, 'cli-harness:agy');

    const expectedArgs = [
      '-p',
      'System instructions.\n\nUser query.',
      '--output-format',
      'json',
      '--model',
      'gemini-3.8-flash-high',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--mode',
      'plan',
      '--print-timeout',
      '900s',
    ];
    assert.deepEqual(result.adapterMeta.args, expectedArgs);
    const rawWritten = readFileSync(argsFile, 'utf8');
    assert.ok(rawWritten.includes('gemini-3.8-flash-high'));
    assert.ok(rawWritten.includes('--mode\nplan'));
    assert.equal(
      realpathSync(readFileSync(cwdFile, 'utf8').trim()),
      realpathSync(tmp),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter implementer argv: no --mode plan, repeated --add-dir', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  const argsFile = join(tmp, 'args.txt');
  try {
    const result = await dispatch('System instructions.', 'User query.', {
      command: FAKE_AGY,
      execMode: 'implementer',
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      timeout_ms: 60_000,
      addDirs: ['/repo/.git', '/other/dir'],
      env: { FAKE_AGY_ARGS_FILE: argsFile },
    });

    assert.equal(result.exit, 0);
    assert.equal(result.adapterMeta.exec_mode, 'implementer');

    const expectedArgs = [
      '-p',
      'System instructions.\n\nUser query.',
      '--output-format',
      'json',
      '--model',
      'gemini-3.8-flash-high',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/repo/.git',
      '--add-dir',
      '/other/dir',
      '--print-timeout',
      '60s',
    ];
    assert.deepEqual(result.adapterMeta.args, expectedArgs);
    const rawWritten = readFileSync(argsFile, 'utf8');
    assert.ok(!result.adapterMeta.args.includes('--mode'));
    assert.ok(!rawWritten.split('\n').includes('--mode'));
    assert.ok(rawWritten.includes('--add-dir\n/repo/.git'));
    assert.ok(rawWritten.includes('--add-dir\n/other/dir'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter passes conversationId as --conversation', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  const argsFile = join(tmp, 'args.txt');
  try {
    await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      conversationId: 'thread-conv-456',
      env: { FAKE_AGY_ARGS_FILE: argsFile },
    });

    const writtenArgs = readFileSync(argsFile, 'utf8').trim().split('\n');
    const convIndex = writtenArgs.indexOf('--conversation');
    assert.ok(convIndex >= 0);
    assert.equal(writtenArgs[convIndex + 1], 'thread-conv-456');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter missing cwd throws before spawn', async () => {
  await assert.rejects(
    () => dispatch('sys', 'user', { model: 'gemini-3.8-flash-high' }),
    /cwd/,
  );
  await assert.rejects(
    () => dispatch('sys', 'user', { cwd: '   ', model: 'gemini-3.8-flash-high' }),
    /cwd/,
  );
  await assert.rejects(
    () => dispatch('sys', 'user', { cwd: null, model: 'gemini-3.8-flash-high' }),
    /cwd/,
  );
});

test('agy adapter missing or invalid model throws before spawn', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    await assert.rejects(
      () => dispatch('sys', 'user', { cwd: tmp }),
      /model/,
    );
    await assert.rejects(
      () => dispatch('sys', 'user', { cwd: tmp, model: '' }),
      /model/,
    );
    await assert.rejects(
      () => dispatch('sys', 'user', { cwd: tmp, model: 'invalid model; token' }),
      /model/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter JSON parsed into responseText, sessionId, and adapterMeta', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      env: {
        FAKE_AGY_RESPONSE: 'Detailed reviewer feedback.',
        FAKE_AGY_CONVERSATION: 'conv-session-789',
        FAKE_AGY_STATUS: 'SUCCESS',
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(result.responseText, 'Detailed reviewer feedback.');
    assert.equal(result.sessionId, 'conv-session-789');
    assert.equal(result.adapterMeta.status, 'SUCCESS');
    assert.equal(result.adapterMeta.conversation_id, 'conv-session-789');
    assert.deepEqual(result.adapterMeta.denied_actions, []);
    assert.deepEqual(result.adapterMeta.usage, {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter status ERROR: exit 1 + agy-status:ERROR warning', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      env: {
        FAKE_AGY_STATUS: 'ERROR',
        FAKE_AGY_RESPONSE: 'Failed to process prompt',
      },
    });

    assert.equal(result.exit, 1);
    assert.ok(result.warnings.includes('agy-status:ERROR'));
    assert.equal(result.adapterMeta.status, 'ERROR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter denied actions: agy-denied:ListDir warning', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      env: {
        FAKE_AGY_DENIED: 'ListDir',
      },
    });

    assert.equal(result.exit, 0);
    assert.ok(result.warnings.includes('agy-denied:ListDir'));
    assert.deepEqual(result.adapterMeta.denied_actions, ['ListDir']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter malformed stdout: exit 1 + malformed-output warning', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      env: {
        FAKE_CLI_OUTPUT: 'Not valid JSON at all\nAnother line',
      },
    });

    assert.equal(result.exit, 1);
    assert.equal(result.responseText, '');
    assert.ok(result.warnings.includes('malformed-output'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter abort via signal: aborted warning, exit 130, group reaped', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  const ac = new AbortController();
  try {
    setTimeout(() => ac.abort(), 100);
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      signal: ac.signal,
      env: {
        FAKE_CLI_HANG: '1',
      },
    });

    assert.equal(result.exit, 130);
    assert.ok(result.warnings.includes('aborted'));
    assert.equal(result.responseText, '');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter timeout: timeout warning, exit 137', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  try {
    const t0 = Date.now();
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      timeout_ms: 150,
      env: {
        FAKE_CLI_HANG: '1',
      },
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.exit, 137);
    assert.ok(result.warnings.includes('timeout'));
    assert.equal(result.responseText, '');
    assert.ok(elapsed < 2000, `kill should be prompt; took ${elapsed}ms`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('agy adapter onSpawn receives pid', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cps-agy-test-'));
  let spawnedPid = null;
  try {
    const result = await dispatch('sys', 'user', {
      command: FAKE_AGY,
      cwd: tmp,
      model: 'gemini-3.8-flash-high',
      onSpawn: (pid) => {
        spawnedPid = pid;
      },
    });

    assert.equal(result.exit, 0);
    assert.equal(typeof spawnedPid, 'number');
    assert.ok(spawnedPid > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
