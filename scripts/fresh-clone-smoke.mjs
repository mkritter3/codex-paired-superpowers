#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRootOverride = process.env.CPS_FRESH_CLONE_TMP_ROOT;
const tempRoot = tempRootOverride
  ? resolve(tempRootOverride)
  : mkdtempSync(join(tmpdir(), 'cps-fresh-clone-'));
mkdirSync(tempRoot, { recursive: true });
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
const trackedPids = new Set();
const trackedPgids = new Set();
let directChildExited = false;

function sendSignal(id, signal) {
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

function addFixturePids() {
  const pidFile = process.env.CPS_FRESH_CLONE_PID_FILE;
  if (!pidFile || !existsSync(pidFile)) return false;
  const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    trackedPids.add(pid);
    trackedPgids.add(pid);
  }
  return true;
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

function refreshTrackedProcesses() {
  if (!child?.pid) return [];
  trackedPids.add(child.pid);
  trackedPgids.add(child.pid);
  const hasFixturePids = addFixturePids();
  let rows;
  try {
    rows = processTable();
  } catch (error) {
    // Sandboxed test runners can forbid process-table inspection. The fixture
    // PID file gives those tests an explicit, equally bounded fallback while
    // production runs continue to discover the real descendant tree via ps.
    if (!hasFixturePids || error.code !== 'EPERM') throw error;
    return [...trackedPids]
      .filter((pid) => pid !== child.pid ? processExists(pid) : !directChildExited)
      .map((pid) => ({ pid, ppid: 0, pgid: pid }));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!trackedPids.has(row.pid)
          && !trackedPids.has(row.ppid)
          && !trackedPgids.has(row.pgid)) continue;
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
  return rows.filter((row) => trackedPids.has(row.pid) || trackedPgids.has(row.pgid));
}

function signalKnownProcesses(signal) {
  for (const pgid of trackedPgids) {
    if (pgid > 1) sendSignal(-pgid, signal);
  }
  for (const pid of trackedPids) {
    if (pid > 1 && pid !== process.pid) sendSignal(pid, signal);
  }
}

function signalTrackedProcesses(signal) {
  refreshTrackedProcesses();
  signalKnownProcesses(signal);
}

function knownProcessesRemain() {
  if (child?.pid && !directChildExited) return true;
  return [...trackedPids].some((pid) => pid !== child?.pid && processExists(pid));
}

function wait(delayMs) {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

async function waitForKnownProcessesExit(limitMs) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (!knownProcessesRemain()) return true;
    await wait(Math.min(10, Math.max(1, deadline - Date.now())));
  }
  return !knownProcessesRemain();
}

function destroyChildPipes() {
  child?.stdout?.destroy();
  child?.stderr?.destroy();
  child?.stdin?.destroy();
  child?.unref();
}

async function terminateChildTree(killGraceMs) {
  if (terminationPromise) return terminationPromise;
  terminationPromise = (async () => {
    const errors = [];
    try {
      signalTrackedProcesses('SIGTERM');
    } catch (error) {
      errors.push(error);
    }
    destroyChildPipes();

    let gone = false;
    try {
      gone = await waitForKnownProcessesExit(killGraceMs);
    } catch (error) {
      errors.push(error);
    }
    if (!gone) {
      try {
        // Escalate known groups at the grace boundary, then repeat the tree
        // walk to catch reparented descendants still in those groups.
        signalKnownProcesses('SIGKILL');
        signalTrackedProcesses('SIGKILL');
      } catch (error) {
        errors.push(error);
      }
      try {
        gone = await waitForKnownProcessesExit(killGraceMs);
      } catch (error) {
        errors.push(error);
      }
    }

    return { gone, errors };
  })();
  return terminationPromise;
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
    const termination = await terminateChildTree(killGraceMs);
    if (!termination.gone || termination.errors.length > 0) {
      const detail = termination.errors.map((error) => error.message).join('; ');
      process.stderr.write(
        `FAIL fresh-clone smoke: cancellation cleanup incomplete${detail ? `: ${detail}` : ''}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`FAIL fresh-clone smoke: cancellation cleanup failed: ${error.message}\n`);
  } finally {
    try {
      cleanup();
    } finally {
      process.exit(signalExitCodes[signal]);
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
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        CPS_FRESH_CLONE_RUN_ID: basename(tempRoot),
      },
      stdio: ['inherit', 'pipe', 'pipe'],
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
    child.once('error', (error) => resolveExited({ code: null, signal: null, error }));
  });

  const timeout = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      resolveTimeout({ timedOut: true, termination: terminateChildTree(killGraceMs) });
    }, timeoutMs);
  });
  const outcome = await Promise.race([
    childExited.then((result) => ({ timedOut: false, result })),
    timeout,
  ]);
  if (outcome.timedOut) {
    const termination = await outcome.termination;
    process.stderr.write(`FAIL fresh-clone smoke: exceeded ${timeoutMs} ms timeout\n`);
    if (!termination.gone || termination.errors.length > 0) {
      const detail = termination.errors.map((error) => error.message).join('; ');
      process.stderr.write(
        `FAIL fresh-clone smoke: process cleanup incomplete${detail ? `: ${detail}` : ''}\n`,
      );
    }
    process.exitCode = 1;
  } else {
    clearTimeout(timeoutHandle);
    destroyChildPipes();
    const error = outcome.result.error || spawnError;
    if (error) {
      process.stderr.write(`FAIL fresh-clone smoke: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = outcome.result.code ?? 1;
    }
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
