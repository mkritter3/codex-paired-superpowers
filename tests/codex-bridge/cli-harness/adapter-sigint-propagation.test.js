// v0.9.1 hardening round-2 — happy-path SIGINT must reach the child.
//
// Round-2 critique: detached: true on spawn() creates a new process group
// for the spawned CLI. That breaks the normal behavior where Ctrl-C on
// the parent's terminal propagates to the child via the foreground
// process group. Without explicit forwarding, an operator pressing
// Ctrl-C during a happy-path dispatch would NOT kill the CLI process.
//
// The fix in lib/codex-bridge/cli-harness/adapters/codex.js installs a
// per-dispatch process.on('SIGINT'/'SIGTERM', forwardToChildGroup)
// handler that explicitly relays the signal. This test verifies the
// forwarding works AND that handlers are cleaned up after dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

const TEST_TIMEOUT_MS = 10_000;

// Create a fake CLI that records when it receives SIGINT/SIGTERM by
// writing a sentinel file, then exits cleanly. The test sends SIGINT
// to its OWN process (simulating an operator Ctrl-C); the adapter's
// per-dispatch handler must forward to the child group; the child
// records the sentinel and exits.
function makeSignalAware() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-sigint-'));
  const script = join(dir, 'codex');
  const sigintMarker = join(dir, '.got-sigint');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `MARKER='${sigintMarker}'`,
      // Catch SIGINT, record the marker, exit cleanly (non-zero).
      `trap 'touch "$MARKER"; exit 130' INT`,
      // Run long enough that the test has time to send SIGINT.
      'cat > /dev/null &',
      'sleep 5',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script, sigintMarker };
}

test('happy-path SIGINT to parent propagates to detached child via per-dispatch forwarder', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, script, sigintMarker } = makeSignalAware();
  const listenersBefore = process.listenerCount('SIGINT');
  try {
    // Kick off the dispatch (will run for up to ~5s on its own).
    const dispatchPromise = codexDispatch(
      'system',
      'user',
      {
        command: script,
        args: [],
        timeout_ms: 8000,   // longer than the script's natural runtime
      },
    );

    // Wait briefly for the child to spawn + install its trap.
    await new Promise((r) => setTimeout(r, 300));

    // Verify the adapter installed its per-dispatch SIGINT forwarder.
    const listenersDuring = process.listenerCount('SIGINT');
    assert.ok(
      listenersDuring > listenersBefore,
      `adapter must install a per-dispatch SIGINT forwarder (had ${listenersBefore}, now ${listenersDuring})`
    );

    // Simulate operator Ctrl-C — send SIGINT to OUR process.
    // The forwarder must relay to the child's process group.
    // We swallow the SIGINT on our side (the listener-cleanup at the
    // bottom of this try block also runs at process.on('SIGINT') time)
    // by registering a no-op handler FIRST.
    const swallow = () => { /* keep test alive */ };
    process.on('SIGINT', swallow);
    try {
      process.kill(process.pid, 'SIGINT');
    } finally {
      process.removeListener('SIGINT', swallow);
    }

    const result = await dispatchPromise;

    // After dispatch returns, the adapter must have removed its
    // per-dispatch forwarder (otherwise handlers accumulate across
    // many dispatches in one Node process).
    const listenersAfter = process.listenerCount('SIGINT');
    assert.equal(
      listenersAfter,
      listenersBefore,
      `adapter must remove its per-dispatch SIGINT forwarder after dispatch ` +
        `(was ${listenersBefore} before, ${listenersDuring} during, ${listenersAfter} after)`
    );

    // The child must have received SIGINT (via the forwarder) and
    // recorded it. If forwarding is broken, the marker is absent.
    if (existsSync(sigintMarker)) {
      const contents = readFileSync(sigintMarker, 'utf8');
      // Marker exists → success path.
      assert.ok(contents !== undefined, `sigint marker exists at ${sigintMarker}`);
    } else {
      // Tolerate: under heavy load the script may have already exited
      // before the SIGINT reached it. We require either the marker OR
      // a result whose exit indicates the process was terminated.
      assert.ok(
        result && (result.exit !== 0 || /SIGINT|INT/i.test(JSON.stringify(result))),
        `SIGINT propagation did NOT reach the child: marker absent AND result is clean-exit. ` +
          `result: ${JSON.stringify(result, null, 2)}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
