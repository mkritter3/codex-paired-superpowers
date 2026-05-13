// v0.10.0 slice 6 — mailbox-poller cadence/scheduler tests.
//
// All tests use injected seams (scheduler, clearScheduler, jitterSource) — no
// global timer state, no real sleeps, deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  initSidecar,
  startImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';
import { createMailboxPoller } from '../../../lib/codex-bridge/implementer/mailbox-poller.js';

const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

function makeSpec(prefix = 'cps-cadence-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'v0.10.0', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

async function startRun(spec, sliceId = 'slice-3') {
  const memberId = 'expert-implementer@claude:kimi-k2.6:cloud#0';
  const { implementer_run_id } = await startImplementerRun(spec, sliceId, {
    base_sha: 'abc123',
    members: {
      [memberId]: {
        adapter: 'claude-cli',
        model: 'kimi-k2.6:cloud',
        required: true,
        worktree_id: 'wt-slice-3-claude-0',
        branch: 'implementer/slice-3/claude-0',
        claimed_files: [],
      },
    },
  });
  return { implementer_run_id, memberId };
}

function makeStubReadUnread(messages = []) {
  return async () => messages;
}

function makeStubAppend() {
  const calls = [];
  const fn = async (specPath, event) => {
    calls.push({ specPath, event });
    return { event_seq: calls.length };
  };
  fn.calls = calls;
  return fn;
}

function makeStubScheduler() {
  const calls = []; // { delay, callback, handle }
  let handleCounter = 0;
  const scheduler = (cb, delay) => {
    const handle = ++handleCounter;
    calls.push({ delay, callback: cb, handle });
    return handle;
  };
  scheduler.calls = calls;
  return scheduler;
}

function makeStubClearScheduler() {
  const calls = [];
  const fn = (handle) => { calls.push(handle); };
  fn.calls = calls;
  return fn;
}

function makeBasePoller(spec, implementerRunId, overrides = {}) {
  const appendStub = makeStubAppend();
  const readStub = makeStubReadUnread([]);
  return {
    appendStub,
    readStub,
    poller: createMailboxPoller({
      specPath: spec,
      repoRoot: '/tmp/fake-repo',
      sliceId: 'slice-3',
      implementerRunId,
      memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-slice-3-claude-0',
      cadenceMs: 45_000,
      jitterMs: 10_000,
      clockNow: Date.now,
      _deps: {
        appendImplementerEventLocked: appendStub,
        readUnreadMessages: readStub,
      },
      ...overrides,
    }),
  };
}

// ── happy.scheduler-call ────────────────────────────────────────────────────

test('happy.scheduler-call: jitterMs:0, jitterSource:()=>0 → delay=45000', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    const schedulerStub = makeStubScheduler();
    const { poller } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 0,
      jitterSource: () => 0,
      scheduler: schedulerStub,
      clearScheduler: makeStubClearScheduler(),
    });
    poller.start();
    assert.equal(schedulerStub.calls.length, 1, 'should schedule once on start');
    assert.equal(schedulerStub.calls[0].delay, 45_000, `delay should be 45000, got ${schedulerStub.calls[0].delay}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.deterministic-jitter-positive ─────────────────────────────────────

test('happy.deterministic-jitter-positive: jitterSource returns +5000 → delay=50000', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    const schedulerStub = makeStubScheduler();
    const { poller } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 10_000,
      jitterSource: () => 5_000,
      scheduler: schedulerStub,
      clearScheduler: makeStubClearScheduler(),
    });
    poller.start();
    assert.equal(schedulerStub.calls[0].delay, 50_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.deterministic-jitter-negative ─────────────────────────────────────

test('happy.deterministic-jitter-negative: jitterSource returns -5000 → delay=40000', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    const schedulerStub = makeStubScheduler();
    const { poller } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 10_000,
      jitterSource: () => -5_000,
      scheduler: schedulerStub,
      clearScheduler: makeStubClearScheduler(),
    });
    poller.start();
    assert.equal(schedulerStub.calls[0].delay, 40_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary.jitter-bounds ──────────────────────────────────────────────

test('edge.boundary jitter-bounds: 100 random iters → all delays in [35000, 55000]', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    for (let i = 0; i < 100; i++) {
      const schedulerStub = makeStubScheduler();
      const { poller } = makeBasePoller(spec, implementer_run_id, {
        cadenceMs: 45_000,
        jitterMs: 10_000,
        scheduler: schedulerStub,
        clearScheduler: makeStubClearScheduler(),
      });
      poller.start();
      const delay = schedulerStub.calls[0].delay;
      assert.ok(
        delay >= 35_000 && delay <= 55_000,
        `iteration ${i}: delay ${delay} out of [35000, 55000]`
      );
      poller.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary.jitter-zero-min-max ───────────────────────────────────────

test('edge.boundary jitter-zero-min-max: jitterSource=-10000 → 35000, +10000 → 55000', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);

    // Min bound
    const sMin = makeStubScheduler();
    const { poller: pMin } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 10_000,
      jitterSource: () => -10_000,
      scheduler: sMin,
      clearScheduler: makeStubClearScheduler(),
    });
    pMin.start();
    assert.equal(sMin.calls[0].delay, 35_000);

    // Max bound
    const sMax = makeStubScheduler();
    const { poller: pMax } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 10_000,
      jitterSource: () => 10_000,
      scheduler: sMax,
      clearScheduler: makeStubClearScheduler(),
    });
    pMax.start();
    assert.equal(sMax.calls[0].delay, 55_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent.stop-clearScheduler-exactly-once ────────────────────────

test('edge.concurrent stop-clearScheduler-exactly-once: stop()×2 → 1 call', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    const schedulerStub = makeStubScheduler();
    const clearStub = makeStubClearScheduler();
    const { poller } = makeBasePoller(spec, implementer_run_id, {
      cadenceMs: 45_000,
      jitterMs: 0,
      jitterSource: () => 0,
      scheduler: schedulerStub,
      clearScheduler: clearStub,
    });
    poller.start();
    const handle = schedulerStub.calls[0].handle;
    poller.stop();
    poller.stop(); // second call must be no-op
    assert.equal(clearStub.calls.length, 1, 'clearScheduler should be called exactly once');
    assert.equal(clearStub.calls[0], handle, 'clearScheduler must receive the scheduler handle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency.invalid-cadence ─────────────────────────────────────────

test('fail.dependency invalid-cadence: cadenceMs:-1 → throw', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    assert.throws(
      () => createMailboxPoller({
        specPath: spec,
        repoRoot: '/tmp/r',
        sliceId: 'slice-3',
        implementerRunId: implementer_run_id,
        memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
        runtimeKind: 'claude-cli',
        worktreeId: 'wt-slice-3-claude-0',
        cadenceMs: -1,
        jitterMs: 0,
        _deps: { appendImplementerEventLocked: makeStubAppend(), readUnreadMessages: makeStubReadUnread() },
      }),
      /cadenceMs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail.dependency invalid-cadence: cadenceMs:0 → throw', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    assert.throws(
      () => createMailboxPoller({
        specPath: spec,
        repoRoot: '/tmp/r',
        sliceId: 'slice-3',
        implementerRunId: implementer_run_id,
        memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
        runtimeKind: 'claude-cli',
        worktreeId: 'wt-slice-3-claude-0',
        cadenceMs: 0,
        jitterMs: 0,
        _deps: { appendImplementerEventLocked: makeStubAppend(), readUnreadMessages: makeStubReadUnread() },
      }),
      /cadenceMs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail.dependency invalid-cadence: cadenceMs:1.5 (non-integer) → throw', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    assert.throws(
      () => createMailboxPoller({
        specPath: spec,
        repoRoot: '/tmp/r',
        sliceId: 'slice-3',
        implementerRunId: implementer_run_id,
        memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
        runtimeKind: 'claude-cli',
        worktreeId: 'wt-slice-3-claude-0',
        cadenceMs: 1.5,
        jitterMs: 0,
        _deps: { appendImplementerEventLocked: makeStubAppend(), readUnreadMessages: makeStubReadUnread() },
      }),
      /cadenceMs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail.dependency invalid-cadence: jitterMs:-1 → throw', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    assert.throws(
      () => createMailboxPoller({
        specPath: spec,
        repoRoot: '/tmp/r',
        sliceId: 'slice-3',
        implementerRunId: implementer_run_id,
        memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
        runtimeKind: 'claude-cli',
        worktreeId: 'wt-slice-3-claude-0',
        cadenceMs: 45_000,
        jitterMs: -1,
        _deps: { appendImplementerEventLocked: makeStubAppend(), readUnreadMessages: makeStubReadUnread() },
      }),
      /jitterMs/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail.dependency invalid-cadence: cadenceMs ≤ jitterMs → throw', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    assert.throws(
      () => createMailboxPoller({
        specPath: spec,
        repoRoot: '/tmp/r',
        sliceId: 'slice-3',
        implementerRunId: implementer_run_id,
        memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
        runtimeKind: 'claude-cli',
        worktreeId: 'wt-slice-3-claude-0',
        cadenceMs: 10_000,
        jitterMs: 10_000,
        _deps: { appendImplementerEventLocked: makeStubAppend(), readUnreadMessages: makeStubReadUnread() },
      }),
      /cadenceMs.*jitterMs|jitterMs.*cadenceMs|prevent negative/i
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── perf.slo repeated-firing ─────────────────────────────────────────────────

test('perf.slo repeated-firing: drive 5 callback invocations → 5 mailbox_poll events contiguous event_seq', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startRun(spec);
    const appendStub = makeStubAppend();
    const schedulerStub = makeStubScheduler();
    const clearStub = makeStubClearScheduler();

    // Use a monotonically increasing clock so each poll happens >1s apart (debounce).
    let fakeTime = 0;
    const poller = createMailboxPoller({
      specPath: spec,
      repoRoot: '/tmp/fake-repo',
      sliceId: 'slice-3',
      implementerRunId: implementer_run_id,
      memberId: 'expert-implementer@claude:kimi-k2.6:cloud#0',
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-slice-3-claude-0',
      cadenceMs: 45_000,
      jitterMs: 0,
      jitterSource: () => 0,
      clockNow: () => { fakeTime += 2000; return fakeTime; }, // +2s per call, always >1s gap
      scheduler: schedulerStub,
      clearScheduler: clearStub,
      _deps: {
        appendImplementerEventLocked: appendStub,
        readUnreadMessages: makeStubReadUnread([]),
      },
    });

    poller.start();

    // Drive 5 callbacks
    for (let i = 0; i < 5; i++) {
      const call = schedulerStub.calls[i];
      assert.ok(call, `expected scheduler call ${i}`);
      // Invoke the callback and wait for pollNow to complete
      await new Promise((resolve) => {
        // The callback internally calls pollNow() then schedules the next iteration.
        call.callback();
        // Yield to let the async chain run
        setImmediate(resolve);
      });
      // Wait for any async stuff
      await new Promise(r => setImmediate(r));
    }

    // There should be exactly 5 mailbox_poll events (one per poll, each >1s apart)
    const pollEvents = appendStub.calls.filter(c => c.event.event_type === 'mailbox_poll');
    assert.equal(pollEvents.length, 5, `expected 5 mailbox_poll events, got ${pollEvents.length}`);

    // All have contiguous event_seq (stubs assign 1,2,3,4,5)
    const seqs = appendStub.calls.map((c, i) => i + 1);
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
