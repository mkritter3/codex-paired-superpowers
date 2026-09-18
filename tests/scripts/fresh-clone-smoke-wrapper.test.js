import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(ROOT, 'scripts', 'fresh-clone-smoke.mjs');
const TERM_RESISTANT = join(ROOT, 'tests', 'scripts', 'fixtures', 'fresh-clone', 'term-resistant.sh');
const SELF_TEST = join(ROOT, 'tests', 'scripts', 'fresh-clone-smoke.test.sh');

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
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

test('timeout kills a TERM-resistant process group within the deadline grace', { timeout: 5_000 }, async (t) => {
  const startedAt = Date.now();
  const run = startWrapper({
    CPS_FRESH_CLONE_TIMEOUT_MS: '200',
    CPS_FRESH_CLONE_KILL_GRACE_MS: '2000',
  });
  let fixturePid;
  t.after(() => {
    if (fixturePid && processGroupExists(fixturePid)) process.kill(-fixturePid, 'SIGKILL');
  });

  fixturePid = Number((await waitForOutput(run, /term-resistant pid: (\d+)/))[1]);
  const result = await run.closed;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 1, JSON.stringify(run.output()));
  assert.equal(result.signal, null);
  assert.match(run.output().stderr, /exceeded/i);
  assert.ok(elapsedMs < 3_500, `wrapper took ${elapsedMs} ms`);
  assert.equal(processGroupExists(fixturePid), false, `process group ${fixturePid} survived`);
});

test('SIGTERM exits 143, kills the child group, and removes the temp root', { timeout: 5_000 }, async (t) => {
  const run = startWrapper({ CPS_FRESH_CLONE_TIMEOUT_MS: '10000' });
  let fixturePid;
  let tempRoot;
  t.after(() => {
    if (fixturePid && processGroupExists(fixturePid)) process.kill(-fixturePid, 'SIGKILL');
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  tempRoot = (await waitForOutput(run, /fresh-clone temp: (.+)/))[1].trim();
  fixturePid = Number((await waitForOutput(run, /term-resistant pid: (\d+)/))[1]);
  run.child.kill('SIGTERM');
  const result = await run.closed;

  assert.equal(result.code, 143, JSON.stringify(run.output()));
  assert.equal(result.signal, null);
  assert.equal(existsSync(tempRoot), false, `temp root remains at ${tempRoot}`);
  assert.equal(processGroupExists(fixturePid), false, `process group ${fixturePid} survived`);
});

test('fresh-clone shell self-test fails when wrapper cleanup is disabled', { timeout: 30_000 }, () => {
  const result = spawnSync('bash', [SELF_TEST], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CPS_FRESH_CLONE_SKIP_CLEANUP: '1' },
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const leakedRoots = [...output.matchAll(/^fresh-clone temp: (.+)$/gm)].map((match) => match[1]);
  for (const leakedRoot of leakedRoots) {
    rmSync(leakedRoot, { recursive: true, force: true });
  }

  assert.equal(result.status, 1, output);
  assert.match(output, /left temp directory/);
});
