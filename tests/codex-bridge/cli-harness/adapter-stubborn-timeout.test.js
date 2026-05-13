// v0.9.1 hardening — CLI adapter timeout against a SIGTERM-ignoring child.
//
// A real CLI binary occasionally traps signals. The adapter MUST eventually
// escalate to SIGKILL AND reap the process group, or a single stubborn CLI
// can hang the dispatcher AND leave orphan grandchildren consuming resources.
//
// Round-1 critique: the prior test only verified "returned within budget"
// but did not assert the fake CLI was actually reaped. SIGTERM-trapping
// bash + `sleep 3600` could remain alive on disk after the test exited.
// This version writes a marker file as a sentinel: if the script is reaped,
// the marker is created exactly once (it's deleted before each run). After
// the dispatcher returns, we poll for the script's process group being
// fully reaped (no live PIDs in the group).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

// 10s outer bound: timeout_ms is 1000 + ~500ms SIGKILL grace + ~3s reaping
// margin under load.
const TEST_TIMEOUT_MS = 10_000;

function makeStubborn() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-stubborn-cli-'));
  const script = join(dir, 'codex');
  const markerFile = join(dir, '.alive-marker');
  const pidsFile = join(dir, '.pids');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      '# Fake CLI: trap SIGTERM, fork a sleep grandchild, record both PIDs',
      '# to a file, then wait. The adapter must escalate to SIGKILL on the',
      '# process group so BOTH bash AND sleep are reaped.',
      //
      // Round-2 critique: the prior test used `pgrep -f <script>` which only
      // matches processes whose command line contains the script path. The
      // grandchild `sleep 3600` does NOT — so a leaked grandchild would
      // pass undetected. This version writes the bash PID AND the sleep
      // PID to a file; the test reads them and probes both with kill -0.
      //
      `MARKER='${markerFile}'`,
      `PIDS='${pidsFile}'`,
      'touch "$MARKER"',
      "trap '' TERM",
      'cat > /dev/null',
      // Start `sleep 3600` in the background and capture its PID.
      'sleep 3600 &',
      'SLEEP_PID=$!',
      // Write bash PID + sleep PID to the pidfile so the test can probe.
      'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
      // Wait on the sleep so bash stays alive (otherwise bash exits when
      // backgrounding completes and SIGKILL never has anything to escalate).
      'wait "$SLEEP_PID"',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script, markerFile, pidsFile };
}

// Probe whether a PID is still alive via `kill -0` (no-signal). Returns
// true if the process exists, false if it's gone (ESRCH), throws on
// unexpected error.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true; // process exists but we lack permission
    throw err;
  }
}


test('codex adapter: SIGTERM-ignoring child does NOT hang AND its process group (incl. grandchild) is reaped', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, script, markerFile, pidsFile } = makeStubborn();
  let pidsToCheck = [];
  try {
    const startedAt = Date.now();
    const result = await codexDispatch(
      'system prompt',
      'user prompt',
      {
        command: script,
        args: [],
        timeout_ms: 1000,
      },
    );
    const elapsed = Date.now() - startedAt;

    // Marker file is INFORMATIONAL only (see makeStubborn doc).
    const markerExisted = existsSync(markerFile);
    if (!markerExisted) {
      // eslint-disable-next-line no-console
      console.log('stubborn-timeout: marker absent — fake CLI killed before body ran');
    }

    assert.ok(
      elapsed < 5500,
      `adapter did not return within 5.5s of timeout firing; took ${elapsed}ms`
    );

    const warnings = Array.isArray(result.warnings) ? result.warnings.join(' ') : '';
    const meta = result.adapterMeta ? JSON.stringify(result.adapterMeta) : '';
    const failureSignaled =
      (typeof result.exit === 'number' && result.exit !== 0) ||
      /timeout|timed.?out|aborted|kill/i.test(warnings) ||
      /timeout|timed.?out|aborted|kill|abort/i.test(meta);
    assert.ok(
      failureSignaled,
      `adapter must surface a timeout/abort signal. result was: ${JSON.stringify(result, null, 2)}`
    );

    // ── Grandchild reap check (Codex round-2 finding):
    // The fake CLI wrote BOTH its own PID and `sleep 3600`'s PID to a
    // pidfile. Probe each via `kill -0`. The grandchild (`sleep 3600`)
    // has command line `sleep 3600` and does NOT contain the script
    // path — so `pgrep -f <script>` would have missed it. PID-probing
    // proves explicitly that the SIGKILL on the process group reaped
    // BOTH ranks, not just bash.
    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
      assert.equal(pidsToCheck.length, 2,
        `pidfile should record exactly 2 PIDs (bash + sleep); got: ${JSON.stringify(pidLines)}`);
    }

    // Poll up to 3s for SIGKILL propagation. After that, ALL recorded PIDs
    // (bash AND its grandchild sleep) MUST be gone.
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
      `process group NOT fully reaped: live PIDs from pidfile still exist: ${JSON.stringify(livePids)}.\n` +
        `(bash + grandchild sleep PIDs both required to be dead.)\n` +
        `Investigate the SIGKILL-on-process-group path in ` +
        `lib/codex-bridge/cli-harness/adapters/codex.js.`
    );

    assert.ok(
      typeof result.duration_ms === 'number' && result.duration_ms >= 0,
      `duration_ms must be a non-negative number; got ${result.duration_ms}`
    );
  } finally {
    // Belt: SIGKILL any straggler PIDs the test recorded but couldn't reap
    // (defensive — if the assertion above fired, we still don't want to
    // leave processes alive for the next CI run).
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
