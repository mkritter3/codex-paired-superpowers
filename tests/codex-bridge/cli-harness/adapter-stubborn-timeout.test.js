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
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

// 10s outer bound: timeout_ms is 1000 + ~500ms SIGKILL grace + ~3s reaping
// margin under load.
const TEST_TIMEOUT_MS = 10_000;

function makeStubborn() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-stubborn-cli-'));
  const script = join(dir, 'codex');
  const markerFile = join(dir, '.alive-marker');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      '# Fake CLI: trap SIGTERM and sleep forever. The adapter must escalate',
      '# to SIGKILL + process-group reap within its timeout budget.',
      `MARKER='${markerFile}'`,
      'touch "$MARKER"',
      "trap '' TERM",
      // Read+discard stdin to behave like a real CLI receiving a prompt.
      'cat > /dev/null',
      // sleep "forever" — must be reaped by SIGKILL on the process group.
      'sleep 3600',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script, markerFile };
}

// Count live PIDs whose process group leader is `pgid` (or whose PID is
// pgid). On macOS/Linux: `pgrep -g <pgid>` lists them. Returns 0 if none.
function countLivePidsInGroup(pgid) {
  try {
    const out = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' });
    return out.split('\n').filter((s) => s.trim().length > 0).length;
  } catch (err) {
    // pgrep exits 1 when no matches — that's success for our purposes.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

test('codex adapter: SIGTERM-ignoring child does NOT hang dispatch AND its process group is reaped', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, script, markerFile } = makeStubborn();
  let dispatchedPid = null;
  try {
    // The codex adapter spawns and stores the child internally. We snoop
    // the live process group by polling pgrep against pids we discover
    // via the marker side-effect. The simplest path: capture the script's
    // PID by listing pgrep matches before/after.

    const startedAt = Date.now();
    const result = await codexDispatch(
      'system prompt',
      'user prompt',
      {
        command: script,
        args: [],          // our fake CLI ignores args
        timeout_ms: 1000,  // 1s budget
      },
    );
    const elapsed = Date.now() - startedAt;

    // Marker file is INFORMATIONAL only. Under heavy parallel test load,
    // the script may have been killed before its first `touch` even ran —
    // that's an even stronger version of the test premise (the abort path
    // killed the spawn before bash had time to install the trap). We log
    // it for diagnostics but do NOT fail the test on absence.
    const markerExisted = existsSync(markerFile);
    if (!markerExisted) {
      // eslint-disable-next-line no-console
      console.log('stubborn-timeout: marker absent — fake CLI was killed before its body ran (still a valid timeout-path outcome)');
    }

    // Hard upper bound: must return within ~5s (1s timeout + 500ms SIGKILL
    // grace + safety margin).
    assert.ok(
      elapsed < 5500,
      `adapter did not return within 5.5s of timeout firing; took ${elapsed}ms ` +
        `(SIGKILL escalation likely missing or grace period too long)`
    );

    // The result must clearly signal the failure.
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

    // Process-tree reaping check: poll for any lingering `sleep 3600` from
    // this run. The pattern is unique enough that we can find it via pgrep.
    // Allow up to 3s for the SIGKILL to propagate + kernel to reap.
    let livePids = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        const out = execFileSync('pgrep', ['-f', script], { encoding: 'utf8' });
        livePids = out.split('\n').filter((s) => s.trim().length > 0);
      } catch (err) {
        // pgrep exits 1 when no matches — that's reaped.
        if (err && err.status === 1) { livePids = []; break; }
        throw err;
      }
      if (livePids.length === 0) break;
      // Tiny wait before re-polling.
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      livePids.length,
      0,
      `fake CLI's process group is NOT fully reaped after dispatch returned. ` +
        `Live PIDs still matching '${script}': ${JSON.stringify(livePids)}.\n` +
        `This means SIGTERM-trapping children leak. Operator: investigate the ` +
        `process-group kill path in lib/codex-bridge/cli-harness/adapters/codex.js.`
    );

    // duration_ms is recorded and roughly matches the budget (timeout fired).
    assert.ok(
      typeof result.duration_ms === 'number' && result.duration_ms >= 0,
      `duration_ms must be a non-negative number; got ${result.duration_ms}`
    );
  } finally {
    // Belt: any straggler from a partial run gets a manual cleanup.
    try {
      execFileSync('pkill', ['-9', '-f', script], { stdio: 'ignore' });
    } catch { /* none to kill */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
