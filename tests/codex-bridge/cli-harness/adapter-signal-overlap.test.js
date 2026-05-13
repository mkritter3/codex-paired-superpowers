import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

const TEST_TIMEOUT_MS = 10_000;

function makeSigtermStubborn() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-signal-overlap-'));
  const script = join(dir, 'codex');
  const pidsFile = join(dir, '.pids');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `PIDS='${pidsFile}'`,
      "trap '' TERM",
      'bash -c "trap \'\' TERM; while true; do sleep 1; done" &',
      'CHILD_PID=$!',
      'printf "%s\\n%s\\n" "$$" "$CHILD_PID" > "$PIDS"',
      'cat > /dev/null',
      'wait "$CHILD_PID"',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script, pidsFile };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    throw err;
  }
}

async function waitForFile(path, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return existsSync(path);
}

test('codex adapter: parent SIGTERM overlapping timeout cleans up signal listeners and reaps group', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, script, pidsFile } = makeSigtermStubborn();
  const listenersBefore = process.listenerCount('SIGTERM');
  let pidsToCheck = [];
  try {
    const startedAt = Date.now();
    const dispatchPromise = codexDispatch('system', 'user', {
      command: script,
      args: [],
      timeout_ms: 3000,
    });

    assert.ok(await waitForFile(pidsFile, 2000), 'fake CLI should record PIDs before signal injection');
    const remainingUntilInjection = 300 - (Date.now() - startedAt);
    if (remainingUntilInjection > 0) {
      await new Promise((r) => setTimeout(r, remainingUntilInjection));
    }
    assert.ok(
      process.listenerCount('SIGTERM') > listenersBefore,
      'dispatch should install a SIGTERM forwarder while child is active',
    );

    const swallow = () => {};
    process.on('SIGTERM', swallow);
    try {
      process.kill(process.pid, 'SIGTERM');
    } finally {
      process.removeListener('SIGTERM', swallow);
    }

    const result = await dispatchPromise;
    assert.ok(result && typeof result.exit === 'number', 'dispatch should return a result');
    assert.equal(
      process.listenerCount('SIGTERM'),
      listenersBefore,
      'SIGTERM listener count must return to baseline after overlap cleanup',
    );

    if (existsSync(pidsFile)) {
      pidsToCheck = readFileSync(pidsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      assert.equal(pidsToCheck.length, 2, 'pidfile should record parent bash + stubborn child PIDs');
    }

    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      livePids.length,
      0,
      `process group NOT fully reaped after SIGTERM/timeout overlap: ${JSON.stringify(livePids)}`,
    );
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
