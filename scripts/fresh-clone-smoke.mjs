#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'cps-fresh-clone-'));
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
let childClosed;
let timeoutHandle;
let signalHandling = false;

function killChildGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
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
    killChildGroup('SIGTERM');
    killChildGroup('SIGKILL');
    if (childClosed) await childClosed;
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
      env: process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  childClosed = new Promise((resolveClosed) => {
    child.once('close', (code, signal) => resolveClosed({ code, signal }));
  });

  let timeoutPromise;
  timeoutHandle = setTimeout(() => {
    timeoutPromise = (async () => {
      killChildGroup('SIGTERM');
      await new Promise((resolveWait) => setTimeout(resolveWait, killGraceMs));
      killChildGroup('SIGKILL');
      await childClosed;
    })();
  }, timeoutMs);

  const result = await childClosed;
  if (timeoutPromise) {
    await timeoutPromise;
    process.stderr.write(`FAIL fresh-clone smoke: exceeded ${timeoutMs} ms timeout\n`);
    process.exitCode = 1;
  } else {
    clearTimeout(timeoutHandle);
    if (spawnError) {
      process.stderr.write(`FAIL fresh-clone smoke: ${spawnError.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = result.code ?? 1;
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
