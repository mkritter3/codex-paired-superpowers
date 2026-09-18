import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(ROOT, 'scripts', 'fresh-clone-smoke.mjs');
const TERM_RESISTANT = join(ROOT, 'tests', 'scripts', 'fixtures', 'fresh-clone', 'term-resistant.sh');
const SELF_TEST = join(ROOT, 'tests', 'scripts', 'fresh-clone-smoke.test.sh');
const TEST_STARTED_AT = Date.now();

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessesGone(pids, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.deepEqual(pids.filter(processExists), [], 'detached descendants survived');
}

async function waitForProcessGroupGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.equal(processGroupExists(pid), false, `process group ${pid} survived`);
}

async function waitForPidFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for nested PID file ${path}`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createOrphanFixture(ownerRoot, { exitCode = null } = {}) {
  const fixture = join(ownerRoot, 'orphan-fixture.sh');
  const pidFile = join(ownerRoot, 'orphan-pid.json');
  const spawnSource = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });',
    'writeFileSync(process.argv[1], `${JSON.stringify([child.pid])}\\n`);',
    'child.unref();',
  ].join(' ');
  const finish = exitCode === null ? 'while :; do sleep 60; done' : `exit ${exitCode}`;
  writeFileSync(fixture, [
    '#!/usr/bin/env bash',
    'set -u',
    `bash -c 'node -e "$1" "$2"' _ ${shellQuote(spawnSource)} ${shellQuote(pidFile)}`,
    finish,
    '',
  ].join('\n'));
  return { fixture, pidFile };
}

function runIdFromOutput(run) {
  const match = run.output().stdout.match(/fresh-clone temp: (.+)/);
  assert.ok(match, `missing fresh-clone temp diagnostic: ${JSON.stringify(run.output())}`);
  return basename(match[1].trim());
}

function assertDarwinPsFinds(pid, runId) {
  if (process.platform !== 'darwin') return;
  const result = spawnSync('ps', ['-axE', '-o', 'pid=,command='], { encoding: 'utf8' });
  const marker = `CPS_FRESH_CLONE_RUN_ID=${runId}`;
  const line = (result.stdout ?? '').split('\n').find((candidate) => (
    Number(candidate.trim().split(/\s+/, 1)[0]) === pid
  ));
  if (result.status !== 0 || !line || !line.split(/\s+/).includes(marker)) {
    process.stderr.write(
      `ps -axE did not expose run marker ${marker} for orphan ${pid}: ${JSON.stringify({
        status: result.status,
        error: result.error?.message,
        line,
        stderr: result.stderr,
      })}\n`,
    );
    assert.fail(`ps -axE discovery did not find orphan ${pid}`);
  }
}

async function waitForClose(run, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      run.closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `wrapper did not exit within ${timeoutMs} ms: ${JSON.stringify(run.output())}`,
        )), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startWrapper(env = {}) {
  const child = spawn(process.execPath, [WRAPPER], {
    cwd: ROOT,
    env: {
      ...process.env,
      CPS_FRESH_CLONE_SCRIPT: TERM_RESISTANT,
      CPS_FRESH_CLONE_TRACE_TMP: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolveClosed, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveClosed({ code, signal }));
  });
  return {
    child,
    closed,
    output: () => ({ stdout, stderr }),
  };
}

async function waitForOutput(run, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = `${run.output().stdout}\n${run.output().stderr}`;
    const match = output.match(pattern);
    if (match) return match;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for ${pattern}: ${JSON.stringify(run.output())}`);
}

test('timeout kills detached descendants without waiting for inherited pipes', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const pidFile = join(ownerRoot, 'nested-pids.json');
  const startedAt = Date.now();
  const run = startWrapper({
    CPS_FRESH_CLONE_TIMEOUT_MS: '200',
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
    CPS_TEST_PID_FILE: pidFile,
  });
  let fixturePid;
  let nestedPids = [];
  t.after(() => {
    if (fixturePid && processGroupExists(fixturePid)) process.kill(-fixturePid, 'SIGKILL');
    for (const pid of nestedPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  fixturePid = Number((await waitForOutput(run, /term-resistant pid: (\d+)/))[1]);
  nestedPids = await waitForPidFile(pidFile);
  const result = await waitForClose(run);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 1, JSON.stringify(run.output()));
  assert.equal(result.signal, null);
  assert.match(run.output().stderr, /exceeded/i);
  assert.ok(elapsedMs < 1_000, `wrapper took ${elapsedMs} ms`);
  await waitForProcessGroupGone(fixturePid);
  await waitForProcessesGone(nestedPids);
});

test('SIGTERM exits 143, kills detached descendants, and removes the temp root', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const pidFile = join(ownerRoot, 'nested-pids.json');
  const run = startWrapper({
    CPS_FRESH_CLONE_TIMEOUT_MS: '10000',
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
    CPS_TEST_PID_FILE: pidFile,
  });
  let fixturePid;
  let nestedPids = [];
  let tempRoot;
  t.after(() => {
    if (fixturePid && processGroupExists(fixturePid)) process.kill(-fixturePid, 'SIGKILL');
    for (const pid of nestedPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  tempRoot = (await waitForOutput(run, /fresh-clone temp: (.+)/))[1].trim();
  fixturePid = Number((await waitForOutput(run, /term-resistant pid: (\d+)/))[1]);
  nestedPids = await waitForPidFile(pidFile);
  const startedAt = Date.now();
  run.child.kill('SIGTERM');
  const result = await waitForClose(run);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 143, JSON.stringify(run.output()));
  assert.equal(result.signal, null);
  assert.ok(elapsedMs < 1_000, `wrapper took ${elapsedMs} ms`);
  assert.equal(existsSync(tempRoot), false, `temp root remains at ${tempRoot}`);
  await waitForProcessGroupGone(fixturePid);
  await waitForProcessesGone(nestedPids);
});

test('ordinary failure cleans up a reparented run-owned orphan without PID hints', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const { fixture, pidFile } = createOrphanFixture(ownerRoot, { exitCode: 1 });
  const run = startWrapper({
    CPS_FRESH_CLONE_SCRIPT: fixture,
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
  });
  let orphanPids = [];
  t.after(() => {
    for (const pid of orphanPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  const result = await waitForClose(run, 3_000);
  orphanPids = await waitForPidFile(pidFile);

  assert.equal(result.code, 1, JSON.stringify(run.output()));
  await waitForProcessesGone(orphanPids, 3_000);
});

test('timeout cleans up a reparented run-owned orphan without PID hints', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const { fixture, pidFile } = createOrphanFixture(ownerRoot);
  const run = startWrapper({
    CPS_FRESH_CLONE_SCRIPT: fixture,
    CPS_FRESH_CLONE_TIMEOUT_MS: '250',
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
  });
  let orphanPids = [];
  t.after(() => {
    for (const pid of orphanPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  orphanPids = await waitForPidFile(pidFile);
  try {
    assertDarwinPsFinds(orphanPids[0], runIdFromOutput(run));
  } catch (error) {
    run.child.kill('SIGTERM');
    await waitForClose(run, 3_000);
    throw error;
  }
  const result = await waitForClose(run, 3_000);

  assert.equal(result.code, 1, JSON.stringify(run.output()));
  assert.match(run.output().stderr, /exceeded/i);
  await waitForProcessesGone(orphanPids, 3_000);
});

test('ordinary success cleans up a reparented run-owned orphan', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const { fixture, pidFile } = createOrphanFixture(ownerRoot, { exitCode: 0 });
  const run = startWrapper({
    CPS_FRESH_CLONE_SCRIPT: fixture,
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
  });
  let orphanPids = [];
  t.after(() => {
    for (const pid of orphanPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  const result = await waitForClose(run, 3_000);
  orphanPids = await waitForPidFile(pidFile);

  assert.equal(result.code, 0, JSON.stringify(run.output()));
  await waitForProcessesGone(orphanPids, 3_000);
});

test('reports incomplete cleanup with surviving run-owned PID', { timeout: 5_000 }, async (t) => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const { fixture, pidFile } = createOrphanFixture(ownerRoot, { exitCode: 0 });
  const run = startWrapper({
    CPS_FRESH_CLONE_SCRIPT: fixture,
    CPS_FRESH_CLONE_KILL_GRACE_MS: '100',
    CPS_FRESH_CLONE_KILL_DISABLED: '1',
  });
  let orphanPids = [];
  t.after(() => {
    for (const pid of orphanPids) {
      if (processExists(pid)) process.kill(pid, 'SIGKILL');
    }
    if (processExists(run.child.pid)) run.child.kill('SIGKILL');
    rmSync(ownerRoot, { recursive: true, force: true });
  });

  const result = await waitForClose(run, 3_000);
  orphanPids = await waitForPidFile(pidFile);

  assert.equal(result.code, 1, JSON.stringify(run.output()));
  assert.match(run.output().stderr, /FAIL fresh-clone smoke: incomplete cleanup:/);
  assert.match(run.output().stderr, new RegExp(`\\b${orphanPids[0]}\\b`));
  assert.equal(processExists(orphanPids[0]), true, 'kill-disabled hook unexpectedly killed orphan');
});

test('fresh-clone shell self-test fails when wrapper cleanup is disabled', { timeout: 30_000 }, () => {
  const ownerRoot = mkdtempSync(join(tmpdir(), 'cps-smoke-wrapper-test-'));
  const smokeRoot = join(ownerRoot, 'owned-smoke-root');
  try {
    const result = spawnSync('bash', [SELF_TEST], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CPS_FRESH_CLONE_SKIP_CLEANUP: '1',
        CPS_FRESH_CLONE_TMP_ROOT: smokeRoot,
      },
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /left temp directory/);
    assert.equal(existsSync(smokeRoot), true, 'cleanup-disabled smoke root was unexpectedly removed');
  } finally {
    rmSync(ownerRoot, { recursive: true, force: true });
  }
});

after(() => {
  const leaks = readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('cps-fresh-clone-'))
    .map((entry) => join(tmpdir(), entry.name))
    .filter((path) => statSync(path).mtimeMs >= TEST_STARTED_AT)
    .map((path) => basename(path));
  assert.deepEqual(leaks, [], `fresh-clone temp roots leaked: ${leaks.join(', ')}`);
});
