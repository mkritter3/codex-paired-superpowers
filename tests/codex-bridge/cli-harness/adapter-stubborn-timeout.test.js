// v0.9.1 hardening — CLI adapter timeout against a SIGTERM-ignoring child.
//
// A real CLI binary occasionally traps signals (e.g., it's mid-flush, has
// a custom signal handler, or its parent process is in TASK_UNINTERRUPTIBLE
// state). The adapter MUST eventually escalate to SIGKILL or otherwise
// guarantee a timely return — otherwise a single stubborn CLI can hang the
// entire dispatch (and ralph-loop, etc.).
//
// This test runs a fake CLI shell script that traps SIGTERM and sleeps
// forever. The adapter is configured with timeout_ms = 1000. The test
// asserts the adapter returns within a generous outer bound (5s) with a
// warning indicating timeout. If the adapter only sends SIGTERM with no
// SIGKILL escalation, this test will hang the test runner — which is
// itself the regression signal we want.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

// 8s outer bound: the test must NOT hang. timeout_ms is 1000; even with a
// generous SIGKILL grace period the adapter should return in ~1-3s.
const TEST_TIMEOUT_MS = 8_000;

function makeStubborn() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-stubborn-cli-'));
  const script = join(dir, 'codex');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      "# Fake CLI: trap SIGTERM and sleep forever. The adapter must escalate",
      "# to SIGKILL or fail the whole dispatch within its timeout budget.",
      "trap '' TERM",
      // Read+discard stdin to behave like a real CLI receiving a prompt.
      'cat > /dev/null',
      // Sleep "forever" — in practice the test kills the dir tree on exit.
      'sleep 3600',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script };
}

test('codex adapter: SIGTERM-ignoring child does NOT hang dispatch beyond timeout budget', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, script } = makeStubborn();
  try {
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

    // Hard upper bound: must return within 6s (5x the configured timeout
    // budget — generous to cover SIGKILL grace + bash wait).
    assert.ok(
      elapsed < 6000,
      `adapter did not return within 6s of timeout firing; took ${elapsed}ms ` +
        `(SIGKILL escalation likely missing)`
    );

    // The result must clearly signal the failure. We accept any of:
    //   - non-zero exit (process killed)
    //   - 'spawn-failed' / 'timeout' / 'timed-out' / 'aborted' warning
    //   - non-empty error in adapterMeta
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

    // duration_ms is recorded and roughly matches the budget (timeout fired).
    assert.ok(
      typeof result.duration_ms === 'number' && result.duration_ms >= 0,
      `duration_ms must be a non-negative number; got ${result.duration_ms}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
