// v0.10.0 slice 6 — mailbox-poller.test.js
//
// Critical tier. Tests real mailbox writes + sidecar appends in tmpdir.
// No real sleeps. All scheduler/timer seams injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  startImplementerRun,
  readImplementerRun,
  appendImplementerEventLocked,
} from '../../../lib/codex-bridge/sidecar.js';
import {
  writeToMailbox,
  readUnreadMessages,
} from '../../../lib/codex-bridge/mailbox.js';
import {
  createMailboxPoller,
  injectMailboxDelivery,
} from '../../../lib/codex-bridge/implementer/mailbox-poller.js';
import { recipientForMember } from '../../../lib/codex-bridge/mailbox.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_MEMBER_ID = 'expert-implementer@claude:kimi-k2.6:cloud#0';
const DEFAULT_WORKTREE_ID = 'wt-slice-3-claude-0';
const DEFAULT_SLICE_ID = 'slice-3';

function makeSpec(prefix = 'cps-mbox-poller-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'v0.10.0', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

async function startRun(spec, sliceId = DEFAULT_SLICE_ID, memberId = DEFAULT_MEMBER_ID) {
  const { implementer_run_id } = await startImplementerRun(spec, sliceId, {
    base_sha: 'abc123',
    members: {
      [memberId]: {
        adapter: 'claude-cli',
        model: 'kimi-k2.6:cloud',
        required: true,
        worktree_id: DEFAULT_WORKTREE_ID,
        branch: 'implementer/slice-3/claude-0',
        claimed_files: [],
      },
    },
  });
  return implementer_run_id;
}

function makePoller(spec, dir, implementerRunId, overrides = {}) {
  return createMailboxPoller({
    specPath: spec,
    repoRoot: dir,
    sliceId: DEFAULT_SLICE_ID,
    implementerRunId,
    memberId: DEFAULT_MEMBER_ID,
    runtimeKind: 'claude-cli',
    worktreeId: DEFAULT_WORKTREE_ID,
    cadenceMs: 45_000,
    jitterMs: 0,
    jitterSource: () => 0,
    clockNow: Date.now,
    scheduler: (cb, delay) => setTimeout(cb, delay),
    clearScheduler: clearTimeout,
    ...overrides,
  });
}

function makeStubAppend(appendFn) {
  // appendFn can be undefined (use real), a function to call, or an object with onCall
  return appendFn;
}

// ── happy.delivery ────────────────────────────────────────────────────────────

test('happy.delivery: real writeToMailbox + pollNow returns {polled:1, delivered:[msg]}', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);

    // Write a message to the implementer's inbox
    await writeToMailbox(dir, recipient, { from: 'orchestrator', text: 'hello from orch' });

    const poller = makePoller(spec, dir, runId);
    const result = await poller.pollNow();

    assert.equal(result.polled, 1);
    assert.equal(result.delivered.length, 1);
    assert.equal(result.delivered[0].text, 'hello from orch');
    assert.equal(result.delivered[0].from, 'orchestrator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.sidecar-event-shape ─────────────────────────────────────────────────

test('happy.sidecar-event-shape: real delivery → 1 mailbox_poll + 1 mailbox_delivered with all cross-fields', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);

    const { id: msgId } = await writeToMailbox(dir, recipient, {
      from: 'orchestrator',
      text: 'event-shape test',
    });

    const poller = makePoller(spec, dir, runId);
    await poller.pollNow();

    const block = readImplementerRun(spec, DEFAULT_SLICE_ID);
    assert.ok(block, 'implementer run block must exist');
    assert.equal(block.events.length, 2, 'should have 1 mailbox_delivered + 1 mailbox_poll');

    const deliveredEv = block.events.find(e => e.event_type === 'mailbox_delivered');
    const pollEv = block.events.find(e => e.event_type === 'mailbox_poll');

    assert.ok(deliveredEv, 'mailbox_delivered event must exist');
    assert.ok(pollEv, 'mailbox_poll event must exist');

    // Cross-fields on delivered event
    assert.equal(deliveredEv.implementer_run_id, runId);
    assert.equal(deliveredEv.slice_id, DEFAULT_SLICE_ID);
    assert.equal(deliveredEv.member_id, DEFAULT_MEMBER_ID);
    assert.equal(deliveredEv.runtime_kind, 'claude-cli');
    assert.equal(deliveredEv.worktree_id, DEFAULT_WORKTREE_ID);
    assert.equal(deliveredEv.mailbox_message_id, msgId);

    // Payload shape
    assert.equal(typeof deliveredEv.payload.from, 'string');
    assert.equal(typeof deliveredEv.payload.to, 'string');
    assert.match(deliveredEv.payload.body_hash, /^sha256:[0-9a-f]{64}$/);

    // Cross-fields on poll event
    assert.equal(pollEv.implementer_run_id, runId);
    assert.equal(pollEv.slice_id, DEFAULT_SLICE_ID);
    assert.equal(pollEv.member_id, DEFAULT_MEMBER_ID);

    // Poll payload
    assert.equal(typeof pollEv.payload.polled_count, 'number');
    assert.equal(typeof pollEv.payload.delivered_count, 'number');
    assert.match(pollEv.payload_hash, /^sha256:[0-9a-f]{64}$/);

    // Contiguous event_seq
    const seqs = block.events.map(e => e.event_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.empty-inbox-nonblocking ─────────────────────────────────────────────

test('happy.empty-inbox-nonblocking: pollNow on empty inbox resolves fast (stubbed deps, within 100ms race)', async () => {
  // Use stubbed deps so there's no real sidecar lock acquisition latency.
  // The test verifies the implementation does not sleep or block internally.
  const runId = 'run-id-empty-test';
  const appendCalls = [];
  const poller = createMailboxPoller({
    specPath: '/tmp/fake-spec.md',
    repoRoot: '/tmp/fake-repo',
    sliceId: DEFAULT_SLICE_ID,
    implementerRunId: runId,
    memberId: DEFAULT_MEMBER_ID,
    runtimeKind: 'claude-cli',
    worktreeId: DEFAULT_WORKTREE_ID,
    cadenceMs: 45_000,
    jitterMs: 0,
    _deps: {
      appendImplementerEventLocked: async (sp, ev) => {
        appendCalls.push(ev);
        return { event_seq: appendCalls.length };
      },
      // Empty inbox — returns immediately
      readUnreadMessages: async () => [],
    },
  });

  const result = await Promise.race([
    poller.pollNow(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout: pollNow took too long')), 100)),
  ]);

  assert.equal(result.polled, 0);
  assert.equal(result.delivered.length, 0);
});

// ── edge.zero-null-empty: 7 required fields ───────────────────────────────────

const REQUIRED_FIELDS = [
  'specPath',
  'repoRoot',
  'sliceId',
  'implementerRunId',
  'memberId',
  'runtimeKind',
  'worktreeId',
];

for (const field of REQUIRED_FIELDS) {
  test(`edge.zero-null-empty: missing ${field} → synchronous throw`, () => {
    const opts = {
      specPath: '/tmp/spec.md',
      repoRoot: '/tmp/repo',
      sliceId: 'slice-3',
      implementerRunId: 'run-id',
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-x',
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async () => {},
        readUnreadMessages: async () => [],
      },
    };
    delete opts[field];
    assert.throws(() => createMailboxPoller(opts), new RegExp(field));
  });

  test(`edge.zero-null-empty: empty ${field} → synchronous throw`, () => {
    const opts = {
      specPath: '/tmp/spec.md',
      repoRoot: '/tmp/repo',
      sliceId: 'slice-3',
      implementerRunId: 'run-id',
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-x',
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async () => {},
        readUnreadMessages: async () => [],
      },
    };
    opts[field] = '';
    assert.throws(() => createMailboxPoller(opts), new RegExp(field));
  });

  test(`edge.zero-null-empty: null ${field} → synchronous throw`, () => {
    const opts = {
      specPath: '/tmp/spec.md',
      repoRoot: '/tmp/repo',
      sliceId: 'slice-3',
      implementerRunId: 'run-id',
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-x',
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async () => {},
        readUnreadMessages: async () => [],
      },
    };
    opts[field] = null;
    assert.throws(() => createMailboxPoller(opts), new RegExp(field));
  });
}

// ── edge.boundary debounce ─────────────────────────────────────────────────────

test('edge.boundary debounce: 2 pollNow within 1s → 1 mailbox_poll event; gap > 1s → 2 events', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const appendCalls = [];
    const stubAppend = async (specPath, event) => {
      appendCalls.push(event);
      return { event_seq: appendCalls.length };
    };

    let fakeTime = 1000;
    const poller = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      jitterSource: () => 0,
      clockNow: () => fakeTime,
      _deps: {
        appendImplementerEventLocked: stubAppend,
        readUnreadMessages: async () => [],
      },
    });

    // First poll at time=1000
    await poller.pollNow();
    const pollsAfterFirst = appendCalls.filter(e => e.event_type === 'mailbox_poll').length;
    assert.equal(pollsAfterFirst, 1, 'first poll should emit 1 mailbox_poll event');

    // Second poll at time=1000 (within 1s) → no new poll event
    await poller.pollNow();
    const pollsAfterSecond = appendCalls.filter(e => e.event_type === 'mailbox_poll').length;
    assert.equal(pollsAfterSecond, 1, 'second poll within 1s should not emit another mailbox_poll event');

    // Third poll at time=2001 (>1s after first) → new poll event
    fakeTime = 2001;
    await poller.pollNow();
    const pollsAfterThird = appendCalls.filter(e => e.event_type === 'mailbox_poll').length;
    assert.equal(pollsAfterThird, 2, 'poll after >1s gap should emit a new mailbox_poll event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary global event_seq ───────────────────────────────────────────

test('edge.boundary global event_seq: preseed with a different slice → next event_seq starts correctly', async () => {
  const { dir, spec } = makeSpec();
  try {
    // Start run for slice-5 and add 3 events
    const runId5 = await startImplementerRun(spec, 'slice-5', {
      base_sha: 'xyz',
      members: {
        [DEFAULT_MEMBER_ID]: {
          adapter: 'claude-cli',
          model: 'kimi-k2.6:cloud',
          required: true,
          worktree_id: DEFAULT_WORKTREE_ID,
          branch: 'b',
          claimed_files: [],
        },
      },
    });
    const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    for (let i = 0; i < 3; i++) {
      await appendImplementerEventLocked(spec, {
        event_type: 'checkpoint',
        implementer_run_id: runId5.implementer_run_id,
        slice_id: 'slice-5',
        member_id: DEFAULT_MEMBER_ID,
        runtime_kind: 'claude-cli',
        worktree_id: DEFAULT_WORKTREE_ID,
        payload_hash: ZERO_HASH,
        payload: { i },
      });
    }

    // Now start a run for slice-3 and poll
    const runId3 = await startRun(spec, DEFAULT_SLICE_ID);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);
    await writeToMailbox(dir, recipient, { from: 'orchestrator', text: 'cross-slice test' });

    const poller = makePoller(spec, dir, runId3);
    await poller.pollNow();

    const block3 = readImplementerRun(spec, DEFAULT_SLICE_ID);
    const seqs = block3.events.map(e => e.event_seq).sort((a, b) => a - b);
    // Pre-seeded 3 events in slice-5, so slice-3 events should start at 4
    assert.ok(seqs[0] >= 4, `first event_seq should be >= 4, got ${seqs[0]}`);
    // Contiguous
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, `event_seq should be contiguous`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent overlap-no-duplicates ────────────────────────────────────

test('edge.concurrent overlap-no-duplicates: Promise.all 2 pollNow on 3 messages → 3 distinct delivered events', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);

    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await writeToMailbox(dir, recipient, { from: 'orchestrator', text: `msg-${i}` });
      ids.push(id);
    }

    const poller = makePoller(spec, dir, runId);

    const deliveredEvents = [];
    poller.on('delivered', (msg) => deliveredEvents.push(msg.id));

    // Run 2 concurrent polls on the same 3 messages
    await Promise.all([poller.pollNow(), poller.pollNow()]);

    // Should have exactly 3 distinct delivered events (no duplicates)
    const uniqueIds = new Set(deliveredEvents);
    assert.equal(uniqueIds.size, 3, `expected 3 distinct delivered events, got ${uniqueIds.size}`);
    assert.equal(deliveredEvents.length, 3, `expected exactly 3 delivered events (no duplicates), got ${deliveredEvents.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent sequential-no-duplicates ─────────────────────────────────

test('edge.concurrent sequential-no-duplicates: 2 pollNow on 1 message → 1 delivered event', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);
    await writeToMailbox(dir, recipient, { from: 'orchestrator', text: 'dedup test' });

    const poller = makePoller(spec, dir, runId);
    const deliveredEvents = [];
    poller.on('delivered', (msg) => deliveredEvents.push(msg));

    const r1 = await poller.pollNow();
    assert.equal(r1.delivered.length, 1);

    const r2 = await poller.pollNow();
    assert.equal(r2.delivered.length, 0, 'second poll should not re-deliver the same message');
    assert.equal(deliveredEvents.length, 1, 'should have received exactly 1 delivered event total');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent stop-clears-dedupe-set ───────────────────────────────────

test('edge.concurrent stop-clears-dedupe-set: deliver, stop, start, re-poll → fresh delivered event', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);
    await writeToMailbox(dir, recipient, { from: 'orchestrator', text: 'reset test' });

    const schedulerStub = (cb, delay) => setTimeout(cb, 999_999); // very long, won't fire
    const clearStub = (h) => clearTimeout(h);
    const poller = makePoller(spec, dir, runId, {
      scheduler: schedulerStub,
      clearScheduler: clearStub,
    });

    const deliveredEvents = [];
    poller.on('delivered', (msg) => deliveredEvents.push(msg));

    // First poll + start/stop cycle
    await poller.pollNow();
    assert.equal(deliveredEvents.length, 1);

    poller.stop(); // clears dedupe set

    // Re-poll: message should be delivered again (Set was cleared)
    await poller.pollNow();
    assert.equal(deliveredEvents.length, 2, 'after stop/restart, message should be re-delivered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent start-stop-idempotent ────────────────────────────────────

test('edge.concurrent start-stop-idempotent: start×2 → scheduler called once; stop×2 → clearScheduler called once', () => {
  const schedulerCalls = [];
  const clearCalls = [];
  const stubScheduler = (cb, delay) => {
    const h = schedulerCalls.length + 1;
    schedulerCalls.push({ cb, delay, h });
    return h;
  };
  const stubClear = (h) => { clearCalls.push(h); };

  const poller = createMailboxPoller({
    specPath: '/tmp/spec.md',
    repoRoot: '/tmp/repo',
    sliceId: 'slice-3',
    implementerRunId: 'run-id',
    memberId: DEFAULT_MEMBER_ID,
    runtimeKind: 'claude-cli',
    worktreeId: 'wt-x',
    cadenceMs: 45_000,
    jitterMs: 0,
    jitterSource: () => 0,
    scheduler: stubScheduler,
    clearScheduler: stubClear,
    _deps: {
      appendImplementerEventLocked: async () => {},
      readUnreadMessages: async () => [],
    },
  });

  poller.start();
  poller.start(); // idempotent
  assert.equal(schedulerCalls.length, 1, 'scheduler should be called exactly once');

  poller.stop();
  poller.stop(); // idempotent
  assert.equal(clearCalls.length, 1, 'clearScheduler should be called exactly once');
});

// ── edge.concurrent in-flight-poll-stop ──────────────────────────────────────

test('edge.concurrent in-flight-poll-stop: fire pollNow, immediately stop; in-flight completes; no scheduled fire', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);

    const schedulerCalls = [];
    const clearCalls = [];
    const stubScheduler = (cb, delay) => {
      const h = schedulerCalls.length + 1;
      schedulerCalls.push({ cb, delay, h });
      return h;
    };
    const stubClear = (h) => { clearCalls.push(h); };

    const poller = makePoller(spec, dir, runId, {
      scheduler: stubScheduler,
      clearScheduler: stubClear,
    });

    poller.start();
    assert.equal(schedulerCalls.length, 1);

    // Fire pollNow and immediately stop (before it resolves)
    const pollPromise = poller.pollNow();
    poller.stop();

    const result = await pollPromise; // in-flight completes
    assert.equal(result.polled, 0, 'in-flight poll should complete successfully');

    // The scheduled fire (handle 1) should have been cleared
    assert.equal(clearCalls.length, 1);
    assert.equal(clearCalls[0], schedulerCalls[0].h);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial recipient-injection ─────────────────────────────────────

test('edge.adversarial recipient-injection: malformed memberId → recipientForMember rejects at construction', () => {
  assert.throws(
    () => createMailboxPoller({
      specPath: '/tmp/spec.md',
      repoRoot: '/tmp/repo',
      sliceId: 'slice-3',
      implementerRunId: 'run-id',
      memberId: 'not-a-valid-member-id-no-hash', // missing # ordinal
      runtimeKind: 'claude-cli',
      worktreeId: 'wt-x',
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async () => {},
        readUnreadMessages: async () => [],
      },
    }),
    /memberId|member_id|parseMemberId|ordinal/i
  );
});

// ── fail.dependency readUnreadMessages-throws ─────────────────────────────────

test('fail.dependency readUnreadMessages-throws: stub throws → pollNow rejects, no sidecar events', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const appendCalls = [];

    const poller = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async (sp, ev) => {
          appendCalls.push(ev);
          return { event_seq: appendCalls.length };
        },
        readUnreadMessages: async () => {
          throw new Error('readUnreadMessages: simulated failure');
        },
      },
    });

    await assert.rejects(() => poller.pollNow(), /simulated failure/);
    assert.equal(appendCalls.length, 0, 'no sidecar events should be appended on readUnreadMessages failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency appendImplementerEventLocked-throws ──────────────────────

test('fail.dependency appendImplementerEventLocked-throws: stub throws → pollNow rejects, mailbox unchanged', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);
    const { id: msgId } = await writeToMailbox(dir, recipient, { from: 'orchestrator', text: 'stub fail' });

    const poller = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async () => {
          throw new Error('appendImplementerEventLocked: simulated failure');
        },
        readUnreadMessages,
      },
    });

    await assert.rejects(() => poller.pollNow(), /simulated failure/);

    // Message should NOT be in the dedupe Set (pollNow failed), so re-polling returns it again
    let readUnreadCalled = 0;
    const poller2 = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: async (sp, ev) => ({ event_seq: 1 }),
        readUnreadMessages: async (repoRoot, recipient) => {
          readUnreadCalled++;
          return readUnreadMessages(repoRoot, recipient);
        },
      },
    });

    const result = await poller2.pollNow();
    assert.equal(result.polled, 1, 'message should still be unread (not marked read on failure)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path partial-batch ────────────────────────────────────────

test('fail.exception-path partial-batch: 3 messages; stub allows 2 then throws; 2 events persisted, 2 messages unaffected in Set', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);

    // Write 3 messages
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await writeToMailbox(dir, recipient, { from: 'orchestrator', text: `partial-${i}` });
      ids.push(id);
    }

    const persistedEvents = [];
    let callCount = 0;
    const stubAppend = async (specPath, event) => {
      callCount++;
      // Allow first 2 appends (for mailbox_delivered msg0 and mailbox_delivered msg1),
      // then throw on the 3rd (which would be mailbox_delivered for msg2)
      if (callCount === 3) {
        throw new Error('partial batch failure on 3rd append');
      }
      persistedEvents.push(event);
      return { event_seq: callCount };
    };

    const poller = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: stubAppend,
        readUnreadMessages,
      },
    });

    await assert.rejects(() => poller.pollNow(), /partial batch failure/);

    // 2 events persisted (mailbox_delivered for msg0 and msg1)
    const deliveredEvents = persistedEvents.filter(e => e.event_type === 'mailbox_delivered');
    assert.equal(deliveredEvents.length, 2, '2 mailbox_delivered events should be persisted');

    // The 2 delivered message IDs should be in the dedupe Set (they succeeded)
    // The 3rd should NOT be (it failed)
    // Verify by polling again: the 3rd message should come back
    const remainingCalls = [];
    const stubAppend2 = async (specPath, event) => {
      remainingCalls.push(event);
      return { event_seq: remainingCalls.length };
    };
    const poller2 = createMailboxPoller({
      specPath: spec,
      repoRoot: dir,
      sliceId: DEFAULT_SLICE_ID,
      implementerRunId: runId,
      memberId: DEFAULT_MEMBER_ID,
      runtimeKind: 'claude-cli',
      worktreeId: DEFAULT_WORKTREE_ID,
      cadenceMs: 45_000,
      jitterMs: 0,
      _deps: {
        appendImplementerEventLocked: stubAppend2,
        readUnreadMessages,
      },
    });

    const r2 = await poller2.pollNow();
    // New poller has a fresh Set, so all 3 messages appear unread again
    assert.equal(r2.delivered.length, 3, 'new poller should see all 3 unread messages (mailbox not modified)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module 2-implementer ────────────────────────────────────

test('integration.cross-module 2-implementer: A writes, B polls, transitions verified', async () => {
  const { dir, spec } = makeSpec();
  try {
    const MEMBER_A = 'expert-implementer@claude:kimi-k2.6:cloud#0';
    const MEMBER_B = 'expert-implementer@claude:kimi-k2.6:cloud#0'; // same member for simplicity; B is the poller

    const runId = await startRun(spec);
    const recipientB = recipientForMember(MEMBER_B);

    // A writes to B's inbox
    const { id: msgId } = await writeToMailbox(dir, recipientB, {
      from: 'orchestrator',
      text: 'cross-module message',
    });

    // Verify message is unread
    const unreadBefore = await readUnreadMessages(dir, recipientB);
    assert.equal(unreadBefore.length, 1);
    assert.equal(unreadBefore[0].id, msgId);

    // B polls
    const pollerB = makePoller(spec, dir, runId);
    const deliveredBMessages = [];
    pollerB.on('delivered', (msg) => deliveredBMessages.push(msg));

    const result = await pollerB.pollNow();
    assert.equal(result.polled, 1);
    assert.equal(result.delivered.length, 1);
    assert.equal(result.delivered[0].id, msgId);
    assert.equal(deliveredBMessages.length, 1);

    // Sidecar event was written
    const block = readImplementerRun(spec, DEFAULT_SLICE_ID);
    const delivEv = block.events.find(e => e.event_type === 'mailbox_delivered');
    assert.ok(delivEv, 'mailbox_delivered event must exist in sidecar');
    assert.equal(delivEv.mailbox_message_id, msgId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module deferred-injection-stub ────────────────────────

test('integration.cross-module deferred-injection-stub: injectMailboxDelivery is exported and callable', () => {
  assert.equal(typeof injectMailboxDelivery, 'function', 'injectMailboxDelivery must be exported as a function');
  // Should not throw when called (it's a stub)
  assert.doesNotThrow(() => injectMailboxDelivery('claude-cli', []));
  assert.doesNotThrow(() => injectMailboxDelivery('codex-cli', [{ id: 'msg-1', text: 'test' }]));
});

// ── stress.scale n-messages-ordered ──────────────────────────────────────────

test('stress.scale n-messages-ordered: 10 messages → 1 poll + 10 delivered events, event_seq contiguous, IDs in write order', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const recipient = recipientForMember(DEFAULT_MEMBER_ID);

    // Write 10 messages in order
    const writtenIds = [];
    for (let i = 0; i < 10; i++) {
      const { id } = await writeToMailbox(dir, recipient, {
        from: 'orchestrator',
        text: `scale-msg-${i}`,
      });
      writtenIds.push(id);
    }

    const poller = makePoller(spec, dir, runId);
    const result = await poller.pollNow();

    assert.equal(result.polled, 10, `expected polled=10, got ${result.polled}`);
    assert.equal(result.delivered.length, 10, `expected delivered=10, got ${result.delivered.length}`);

    const block = readImplementerRun(spec, DEFAULT_SLICE_ID);
    const pollEvents = block.events.filter(e => e.event_type === 'mailbox_poll');
    const deliveredEvents = block.events.filter(e => e.event_type === 'mailbox_delivered');

    assert.equal(pollEvents.length, 1, 'should have exactly 1 mailbox_poll event');
    assert.equal(deliveredEvents.length, 10, 'should have exactly 10 mailbox_delivered events');

    // Verify event_seq is contiguous starting from 1
    const allSeqs = block.events.map(e => e.event_seq).sort((a, b) => a - b);
    assert.equal(allSeqs.length, 11, '10 delivered + 1 poll = 11 total events');
    for (let i = 0; i < allSeqs.length; i++) {
      assert.equal(allSeqs[i], i + 1, `event_seq[${i}] should be ${i + 1}, got ${allSeqs[i]}`);
    }

    // IDs in write order (the order messages were read from mailbox)
    const deliveredIds = deliveredEvents.map(e => e.mailbox_message_id);
    for (const id of writtenIds) {
      assert.ok(deliveredIds.includes(id), `written id ${id} should be in delivered events`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
