// Deterministic controls for the fresh-clone smoke's converging reap.
//
// These drive scripts/lib/reap-run-processes.mjs with scripted discovery results and a fake clock,
// because a control built from real processes has to win a race against the cleanup it is testing —
// an earlier attempt at that passed against the broken implementation and proved nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reapRunProcesses } from '../../scripts/lib/reap-run-processes.mjs';

function harness(discoveries, { limitMs = 100, step = 10 } = {}) {
  let clock = 0;
  const sent = [];
  const queue = [...discoveries];
  let last = queue[queue.length - 1] ?? [];
  return {
    sent,
    elapsed: () => clock,
    promise: reapRunProcesses({
      discover: () => (queue.length > 0 ? (last = queue.shift()) : last),
      signal: (pids, signal) => sent.push({ signal, pids: [...pids].sort((a, b) => a - b) }),
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      limitMs,
      step,
    }),
  };
}

test('empty discovery reaps nothing and returns no survivors', async () => {
  const h = harness([[]]);
  assert.deepEqual(await h.promise, []);
  assert.deepEqual(h.sent, []);
});

test('a pid seen once gets SIGTERM, and SIGKILL on the next pass if it is still there', async () => {
  const h = harness([[101], [101], []]);
  assert.deepEqual(await h.promise, []);
  assert.deepEqual(h.sent, [
    { signal: 'SIGTERM', pids: [101] },
    { signal: 'SIGKILL', pids: [101] },
  ]);
});

test('a process discovered only during teardown is signalled, not reported as a survivor', async () => {
  // The CI failure: 101 is known, 202 appears on a later pass. Both must be signalled.
  const h = harness([[101], [101, 202], [202], []]);
  assert.deepEqual(await h.promise, []);
  assert.deepEqual(h.sent, [
    { signal: 'SIGTERM', pids: [101] },
    { signal: 'SIGKILL', pids: [101] },
    { signal: 'SIGTERM', pids: [202] },
    { signal: 'SIGKILL', pids: [202] },
  ]);
});

test('new arrivals never postpone escalation of an already-signalled pid', async () => {
  // Regression for the starvation bug: a producer that ignores SIGTERM keeps spawning children, so
  // every pass has a fresh pid. The producer (101) must still be escalated on each pass rather than
  // waiting for a pass with no new arrivals.
  const h = harness([[101], [101, 202], [101, 303], [101, 404], []], { limitMs: 1000 });
  assert.deepEqual(await h.promise, []);
  const killsOf101 = h.sent.filter((s) => s.signal === 'SIGKILL' && s.pids.includes(101));
  assert.ok(killsOf101.length >= 3, `101 must be escalated on every pass after the first: ${JSON.stringify(h.sent)}`);
  for (const [i, pid] of [[1, 202], [2, 303], [3, 404]]) {
    assert.ok(
      h.sent.some((s) => s.signal === 'SIGTERM' && s.pids.includes(pid)),
      `late arrival ${pid} (pass ${i}) must receive SIGTERM`,
    );
  }
});

test('a pid that lingers after SIGKILL still converges once discovery clears', async () => {
  const h = harness([[101], [101], [101], [101], []]);
  assert.deepEqual(await h.promise, []);
});

test('survivors are reported only once the bound expires', async () => {
  // Discovery never clears: the loop must stop at the deadline and report what is left.
  const h = harness([[101]], { limitMs: 50 });
  assert.deepEqual(await h.promise, [101]);
  assert.ok(h.elapsed() >= 50, `should have used its budget, used ${h.elapsed()}`);
});
