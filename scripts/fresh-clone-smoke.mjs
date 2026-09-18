#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'cps-fresh-clone-'));
const shell = process.env.CPS_SHELL || 'bash';
const script = join(repoRoot, 'scripts', 'fresh-clone-smoke.sh');

if (process.env.CPS_FRESH_CLONE_TRACE_TMP === '1') {
  process.stdout.write(`fresh-clone temp: ${tempRoot}\n`);
}

let result;
try {
  result = spawnSync(shell, [script, '--tmp-root', tempRoot, '--repo-root', repoRoot, ...process.argv.slice(2)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: 5 * 60 * 1000,
    killSignal: 'SIGTERM',
    maxBuffer: 4 * 1024 * 1024,
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  const timedOut = result.error.code === 'ETIMEDOUT';
  process.stderr.write(timedOut
    ? 'FAIL fresh-clone smoke: exceeded 5-minute timeout\n'
    : `FAIL fresh-clone smoke: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
