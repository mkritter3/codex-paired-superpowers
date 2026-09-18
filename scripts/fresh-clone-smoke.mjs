#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRootOverride = process.env.CPS_FRESH_CLONE_TMP_ROOT;
const tempRoot = tempRootOverride
  ? resolve(tempRootOverride)
  : mkdtempSync(join(tmpdir(), 'cps-fresh-clone-'));
mkdirSync(tempRoot, { recursive: true });
const tempRootReal = realpathSync(tempRoot);
const runId = basename(tempRootReal);
const shell = process.env.CPS_SHELL || 'bash';
const scriptOverride = process.env.CPS_FRESH_CLONE_SCRIPT;
const script = scriptOverride
  ? (isAbsolute(scriptOverride) ? scriptOverride : resolve(repoRoot, scriptOverride))
  : join(repoRoot, 'scripts', 'fresh-clone-smoke.sh');

function durationFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (process.env.CPS_FRESH_CLONE_SKIP_CLEANUP !== '1') {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.env.CPS_FRESH_CLONE_TRACE_TMP === '1') {
  process.stdout.write(`fresh-clone temp: ${tempRoot}\n`);
}

let child;
let childExited;
let timeoutHandle;
let signalHandling = false;
let terminationPromise;
let directChildExited = false;

function sendSignal(id, signal) {
  if (process.env.CPS_FRESH_CLONE_KILL_DISABLED === '1') return;
  try {
    process.kill(id, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function processTable() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 250,
  });
  if (result.error?.code === 'EPERM') return [];
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().split('\n').flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)
      ? [{ pid, ppid, pgid }]
      : [];
  });
}

function isUnderRunRoot(path, runRootReal) {
  return path === runRootReal || path.startsWith(`${runRootReal}/`);
}

function findTreeProcesses() {
  if (!child?.pid) return [];
  const trackedPids = new Set([child.pid]);
  const trackedPgids = new Set([child.pid]);
  const rows = processTable();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!trackedPids.has(row.ppid) && !trackedPgids.has(row.pgid)) continue;
      if (!trackedPids.has(row.pid)) {
        trackedPids.add(row.pid);
        changed = true;
      }
      if (!trackedPgids.has(row.pgid)) {
        trackedPgids.add(row.pgid);
        changed = true;
      }
    }
  }
  return [...trackedPids].filter((pid) => pid !== child.pid || !directChildExited);
}

function findLinuxRunProcesses(marker) {
  const pids = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const environment = readFileSync(`/proc/${entry.name}/environ`, 'utf8').split('\0');
      if (environment.includes(marker)) pids.push(Number(entry.name));
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'ENOENT') throw error;
    }
  }
  return pids;
}

function findLinuxCwdProcesses(runRootReal) {
  const pids = [];
  for (const entry of readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      if (isUnderRunRoot(readlinkSync(`/proc/${entry.name}/cwd`), runRootReal)) {
        pids.push(Number(entry.name));
      }
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'ENOENT') throw error;
    }
  }
  return pids;
}

function findDarwinCwdProcesses(runRootReal) {
  const result = spawnSync(
    'lsof',
    ['-a', '-d', 'cwd', '-u', String(process.getuid()), '-F', 'pn'],
    {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 2_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`lsof failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  const pids = [];
  let pid;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && isUnderRunRoot(line.slice(1), runRootReal)) {
      pids.push(pid);
    }
  }
  return pids;
}

function findDarwinRunProcesses(marker) {
  const result = spawnSync('ps', ['-axE', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 1_000,
  });
  if (result.error?.code === 'EPERM') return [];
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ps failed with exit ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !match[2].split(/\s+/).includes(marker)) return [];
    return [Number(match[1])];
  });
}

function findRunProcesses(runRootReal, marker) {
  const pids = new Set(findTreeProcesses());
  if (process.platform === 'linux') {
    for (const pid of findLinuxCwdProcesses(runRootReal)) pids.add(pid);
    for (const pid of findLinuxRunProcesses(marker)) pids.add(pid);
  } else if (process.platform === 'darwin') {
    for (const pid of findDarwinCwdProcesses(runRootReal)) pids.add(pid);
    for (const pid of findDarwinRunProcesses(marker)) pids.add(pid);
  }
  return [...pids]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
    .sort((left, right) => left - right);
}

function signalRunProcesses(pids, signal) {
  const pidSet = new Set(pids);
  const pgids = new Set(
    processTable()
      .filter((row) => pidSet.has(row.pid) && row.pgid > 1)
      .map((row) => row.pgid),
  );
  for (const pgid of pgids) {
    sendSignal(-pgid, signal);
  }
  for (const pid of pids) {
    sendSignal(pid, signal);
  }
}

function wait(delayMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

/**
 * Reap every run-owned process, converging rather than snapshotting.
 *
 * The previous version waited for a KNOWN pid list to disappear and then ran discovery exactly
 * once, so two things were reported as survivors without ever being signalled: a process the smoke
 * script spawned DURING cancellation (it is still running while we tear down), and a killed process
 * still visible to discovery in the instant after SIGKILL. CI caught it on macOS/Node 26 — the
 * SIGTERM cancellation exited 1 with `incomplete cleanup: 23213,23246` instead of 143.
 *
 * Each pass signals pids it has not signalled yet (SIGTERM), escalates the ones it already has
 * (SIGKILL), then re-discovers. It returns [] as soon as a discovery comes back empty, and only
 * reports survivors once the bound expires.
 */
async function reapRunProcesses(limitMs) {
  const marker = `CPS_FRESH_CLONE_RUN_ID=${runId}`;
  const deadline = Date.now() + limitMs;
  const termed = new Set();
  for (;;) {
    const current = findRunProcesses(tempRootReal, marker);
    if (current.length === 0) return [];
    const fresh = current.filter((pid) => !termed.has(pid));
    if (fresh.length > 0) {
      signalRunProcesses(fresh, 'SIGTERM');
      for (const pid of fresh) termed.add(pid);
    } else {
      signalRunProcesses(current, 'SIGKILL');
    }
    if (Date.now() >= deadline) return findRunProcesses(tempRootReal, marker);
    await wait(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

function destroyChildPipes() {
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  child?.stdin?.destroy();
  child?.unref();
}

async function stopDirectChild(killGraceMs) {
  if (!child?.pid || directChildExited) return;
  sendSignal(-child.pid, 'SIGTERM');
  sendSignal(child.pid, 'SIGTERM');
  destroyChildPipes();
  await Promise.race([childExited, wait(killGraceMs)]);
  if (!directChildExited) {
    sendSignal(-child.pid, 'SIGKILL');
    sendSignal(child.pid, 'SIGKILL');
    await Promise.race([childExited, wait(killGraceMs)]);
  }
}

async function cleanupRunProcesses(killGraceMs, stopChild) {
  if (terminationPromise) return terminationPromise;
  terminationPromise = (async () => {
    const errors = [];
    let survivors = [];
    let stoppingChild;
    if (stopChild) stoppingChild = stopDirectChild(killGraceMs);
    destroyChildPipes();

    try {
      if (stoppingChild) await stoppingChild;
    } catch (error) {
      errors.push(error);
    }
    // One converging reap, bounded by the same total budget the old TERM-wait + KILL-wait pair used.
    try {
      survivors = await reapRunProcesses(killGraceMs * 2);
    } catch (error) {
      errors.push(error);
    }
    return { survivors, errors };
  })();
  return terminationPromise;
}

function reportCleanupFailure(termination) {
  if (termination.survivors.length > 0) {
    process.stderr.write(
      `FAIL fresh-clone smoke: incomplete cleanup: ${termination.survivors.join(',')}\n`,
    );
    return true;
  }
  if (termination.errors.length > 0) {
    process.stderr.write(
      `FAIL fresh-clone smoke: cleanup failed: ${termination.errors.map((error) => error.message).join('; ')}\n`,
    );
    return true;
  }
  return false;
}

const signalExitCodes = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

async function handleSignal(signal) {
  if (signalHandling) return;
  signalHandling = true;
  if (timeoutHandle) clearTimeout(timeoutHandle);

  try {
    const killGraceMs = durationFromEnv('CPS_FRESH_CLONE_KILL_GRACE_MS', 2_000);
    const termination = await cleanupRunProcesses(killGraceMs, true);
    const cleanupFailed = reportCleanupFailure(termination);
    process.exitCode = cleanupFailed ? 1 : signalExitCodes[signal];
  } catch (error) {
    process.stderr.write(`FAIL fresh-clone smoke: cancellation cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    try {
      cleanup();
    } finally {
      process.exit(process.exitCode);
    }
  }
}

for (const signal of Object.keys(signalExitCodes)) {
  process.once(signal, () => { void handleSignal(signal); });
}

try {
  const timeoutMs = durationFromEnv('CPS_FRESH_CLONE_TIMEOUT_MS', 5 * 60 * 1000);
  const killGraceMs = durationFromEnv('CPS_FRESH_CLONE_KILL_GRACE_MS', 2_000);

  child = spawn(
    shell,
    [script, '--tmp-root', tempRoot, '--repo-root', repoRoot, ...process.argv.slice(2)],
    {
      cwd: tempRootReal,
      detached: true,
      env: {
        ...process.env,
        CPS_FRESH_CLONE_RUN_ID: runId,
      },
      // stdin must never be inherited: the fake CLIs drain stdin, so a caller whose stdin is a
      // never-closing pipe (CI runners, background tasks) would hang the doctor step until the
      // deadline. Nothing in the smoke reads stdin.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  childExited = new Promise((resolveExited) => {
    child.once('exit', (code, signal) => {
      directChildExited = true;
      resolveExited({ code, signal });
    });
    child.once('error', (error) => {
      directChildExited = true;
      resolveExited({ code: null, signal: null, error });
    });
  });

  const timeout = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      resolveTimeout({ timedOut: true });
    }, timeoutMs);
  });
  const outcome = await Promise.race([
    childExited.then((result) => ({ timedOut: false, result })),
    timeout,
  ]);
  if (outcome.timedOut) {
    const termination = await cleanupRunProcesses(killGraceMs, true);
    process.stderr.write(`FAIL fresh-clone smoke: exceeded ${timeoutMs} ms timeout\n`);
    reportCleanupFailure(termination);
    process.exitCode = 1;
  } else {
    clearTimeout(timeoutHandle);
    const error = outcome.result.error || spawnError;
    if (error) {
      process.stderr.write(`FAIL fresh-clone smoke: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = outcome.result.code ?? 1;
    }
    const termination = await cleanupRunProcesses(killGraceMs, false);
    if (reportCleanupFailure(termination)) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`FAIL fresh-clone smoke: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  cleanup();
  for (const signal of Object.keys(signalExitCodes)) {
    process.removeAllListeners(signal);
  }
}
