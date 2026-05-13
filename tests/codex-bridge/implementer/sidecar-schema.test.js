// v0.10.0 slice 2 — implementer_experts schema + locked event append.
//
// Covers the 4 new sidecar.js exports (startImplementerRun,
// appendImplementerEventLocked, completeImplementerRun, readImplementerRun)
// per spec § L405-423 (block shape), § L431-449 (event shape), § L470 (global
// monotonic event_seq), and § L474-488 (event_type enum).
//
// Validation tier: critical. Mock-vs-integration: real sidecar file in
// `mkdtempSync` tmpdir; real proper-lockfile. Cross-process tests spawn 4
// async child node processes that synchronize on a barrier so they race
// the sidecar lock simultaneously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as lockfile from 'proper-lockfile';
import {
  initSidecar,
  loadSidecar,
  startImplementerRun,
  appendImplementerEventLocked,
  completeImplementerRun,
  readImplementerRun,
  SidecarLockError,
} from '../../../lib/codex-bridge/sidecar.js';
import { writeToMailbox } from '../../../lib/codex-bridge/mailbox.js';

const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const ONE_HASH = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';

const SIDECAR_PATH = resolve('lib/codex-bridge/sidecar.js');

function makeSpec(prefix = 'cps-impl-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'v0.10.0', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

function defaultMember() {
  return {
    'expert-implementer@claude:kimi-k2.6:cloud#0': {
      adapter: 'claude-cli',
      model: 'kimi-k2.6:cloud',
      required: true,
      worktree_id: 'wt-slice-3-claude-0',
      branch: 'implementer/slice-3/claude-0',
      claimed_files: ['lib/a.js'],
    },
  };
}

function baseEvent(overrides = {}) {
  return {
    event_type: 'started',
    implementer_run_id: overrides.implementer_run_id ?? 'placeholder',
    slice_id: 'slice-3',
    member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0',
    runtime_kind: 'claude-cli',
    worktree_id: 'wt-slice-3-claude-0',
    payload_hash: ZERO_HASH,
    payload: { hello: 'world' },
    ...overrides,
  };
}

async function startBasicRun(spec) {
  const { implementer_run_id } = await startImplementerRun(spec, 'slice-3', {
    base_sha: 'abc123',
    members: defaultMember(),
  });
  return implementer_run_id;
}

// ── happy.exact-schema ───────────────────────────────────────────────────────

test('startImplementerRun: creates phases.implementer_experts with spec-exact keys', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'abc123',
      members: defaultMember(),
    });
    const sc = loadSidecar(spec);
    const block = sc.slice_reviews['slice-3'].phases.implementer_experts;
    // Exact key set per spec § L405-423.
    assert.deepEqual(
      Object.keys(block).sort(),
      [
        'base_sha',
        'completed_at',
        'events',
        'implementer_run_id',
        'members',
        'merge',
        'post_merge_review',
        'started_at',
        'status',
      ].sort()
    );
    assert.equal(block.implementer_run_id, implementer_run_id);
    assert.equal(block.base_sha, 'abc123');
    assert.equal(block.completed_at, null);
    assert.equal(block.status, 'running');
    assert.equal(block.merge, null);
    assert.equal(block.post_merge_review, null);
    assert.deepEqual(block.events, []);
    assert.equal(typeof block.started_at, 'string');
    assert.ok(block.started_at.length > 0);
    assert.deepEqual(Object.keys(block.members), ['expert-implementer@claude:kimi-k2.6:cloud#0']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: assigns event_seq=1,2,3 in order in single run', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const r1 = await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId }));
    const r2 = await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'checkpoint' }));
    const r3 = await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'completed' }));
    assert.equal(r1.event_seq, 1);
    assert.equal(r2.event_seq, 2);
    assert.equal(r3.event_seq, 3);
    const block = readImplementerRun(spec, 'slice-3');
    assert.deepEqual(block.events.map((e) => e.event_seq), [1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty: every required field ──────────────────────────────

const REQUIRED_STRING_FIELDS = [
  'event_type',
  'implementer_run_id',
  'slice_id',
  'member_id',
  'runtime_kind',
  'worktree_id',
  'payload_hash',
];

for (const field of REQUIRED_STRING_FIELDS) {
  test(`appendImplementerEventLocked: rejects missing ${field}`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startBasicRun(spec);
      const ev = baseEvent({ implementer_run_id: runId });
      delete ev[field];
      await assert.rejects(() => appendImplementerEventLocked(spec, ev), new RegExp(field));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`appendImplementerEventLocked: rejects empty-string ${field}`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startBasicRun(spec);
      const ev = baseEvent({ implementer_run_id: runId });
      ev[field] = '';
      await assert.rejects(() => appendImplementerEventLocked(spec, ev), new RegExp(field));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`appendImplementerEventLocked: rejects null ${field}`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startBasicRun(spec);
      const ev = baseEvent({ implementer_run_id: runId });
      ev[field] = null;
      await assert.rejects(() => appendImplementerEventLocked(spec, ev), new RegExp(field));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const bad of [null, [], 'string', 42, true]) {
  test(`appendImplementerEventLocked: rejects payload=${JSON.stringify(bad)} (not plain object)`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startBasicRun(spec);
      const ev = baseEvent({ implementer_run_id: runId, payload: bad });
      await assert.rejects(() => appendImplementerEventLocked(spec, ev), /payload/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── enum + hash + optional-field validation ─────────────────────────────────

test('appendImplementerEventLocked: rejects non-enum event_type', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'bogus' })),
      /event_type/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects malformed payload_hash (not sha256:hex64)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, payload_hash: 'sha256:short' })),
      /payload_hash/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects malformed inputs_hash when present', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, inputs_hash: 'not-a-hash' })),
      /inputs_hash/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: accepts valid inputs_hash', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const r = await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, inputs_hash: ONE_HASH }));
    assert.equal(r.event_seq, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects empty turn_id when present', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, turn_id: '' })),
      /turn_id/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: accepts non-empty turn_id', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const r = await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, turn_id: 'turn-abc' }));
    assert.equal(r.event_seq, 1);
    assert.equal(readImplementerRun(spec, 'slice-3').events[0].turn_id, 'turn-abc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects bad parent_event_seq (zero / negative / non-int / over max)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    // First append seeds events[].
    await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId }));
    for (const bad of [0, -1, 1.5, '1']) {
      await assert.rejects(
        () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, parent_event_seq: bad })),
        /parent_event_seq/
      );
    }
    // Over-max: only 1 event exists, so parent_event_seq=2 must reject.
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, parent_event_seq: 2 })),
      /parent_event_seq/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: accepts valid parent_event_seq', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId }));
    const r = await appendImplementerEventLocked(
      spec,
      baseEvent({ implementer_run_id: runId, parent_event_seq: 1 })
    );
    assert.equal(r.event_seq, 2);
    assert.equal(readImplementerRun(spec, 'slice-3').events[1].parent_event_seq, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: accepts mailbox_message_id = msg-* (real mailbox shape, NOT sha256)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const id = 'msg-2026-05-12T14:00:00.000Z-0001';
    const r = await appendImplementerEventLocked(
      spec,
      baseEvent({ implementer_run_id: runId, event_type: 'mailbox_delivered', mailbox_message_id: id })
    );
    assert.equal(r.event_seq, 1);
    assert.equal(readImplementerRun(spec, 'slice-3').events[0].mailbox_message_id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects empty mailbox_message_id when present', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () =>
        appendImplementerEventLocked(
          spec,
          baseEvent({ implementer_run_id: runId, event_type: 'mailbox_delivered', mailbox_message_id: '' })
        ),
      /mailbox_message_id/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects caller-set event_seq', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const ev = baseEvent({ implementer_run_id: runId });
    ev.event_seq = 99;
    await assert.rejects(() => appendImplementerEventLocked(spec, ev), /event_seq/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial cross-field ────────────────────────────────────────────

test('appendImplementerEventLocked: rejects implementer_run_id mismatch', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: 'not-the-run-id' })),
      /implementer_run_id/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects unknown member_id', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () =>
        appendImplementerEventLocked(
          spec,
          baseEvent({ implementer_run_id: runId, member_id: 'expert-implementer@codex:gpt-5.5#0' })
        ),
      /member/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects runtime_kind ≠ member.adapter', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () =>
        appendImplementerEventLocked(
          spec,
          baseEvent({ implementer_run_id: runId, runtime_kind: 'codex' })
        ),
      /runtime_kind/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects worktree_id ≠ member.worktree_id', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () =>
        appendImplementerEventLocked(
          spec,
          baseEvent({ implementer_run_id: runId, worktree_id: 'wt-other' })
        ),
      /worktree_id/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked: rejects event for slice with no implementer_experts run', async () => {
  const { dir, spec } = makeSpec();
  try {
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: 'anything' })),
      /implementer_experts run/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary global event_seq across slices ─────────────────────────────

test('appendImplementerEventLocked: event_seq is contiguous globally across two slices', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runA = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'a',
      members: defaultMember(),
    });
    const runB = await startImplementerRun(spec, 'slice-4', {
      base_sha: 'b',
      members: {
        'expert-implementer@codex:gpt-5.5#0': {
          adapter: 'codex',
          model: 'gpt-5.5',
          required: true,
          worktree_id: 'wt-slice-4-codex-0',
          branch: 'implementer/slice-4/codex-0',
          claimed_files: ['lib/b.js'],
        },
      },
    });
    // Interleave 3 appends to slice-3 then 3 to slice-4.
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      const r = await appendImplementerEventLocked(
        spec,
        baseEvent({ implementer_run_id: runA.implementer_run_id, event_type: 'checkpoint' })
      );
      seqs.push(r.event_seq);
    }
    for (let i = 0; i < 3; i++) {
      const r = await appendImplementerEventLocked(spec, {
        event_type: 'checkpoint',
        implementer_run_id: runB.implementer_run_id,
        slice_id: 'slice-4',
        member_id: 'expert-implementer@codex:gpt-5.5#0',
        runtime_kind: 'codex',
        worktree_id: 'wt-slice-4-codex-0',
        payload_hash: ZERO_HASH,
        payload: { i },
      });
      seqs.push(r.event_seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    // Globally re-collect and assert no duplicates.
    const sc = loadSidecar(spec);
    const all = [];
    for (const s of Object.keys(sc.slice_reviews)) {
      const evs = sc.slice_reviews[s]?.phases?.implementer_experts?.events;
      if (Array.isArray(evs)) all.push(...evs.map((e) => e.event_seq));
    }
    all.sort((a, b) => a - b);
    assert.deepEqual(all, [1, 2, 3, 4, 5, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent: 4 parallel cross-process appends ───────────────────────

test('appendImplementerEventLocked: 4 parallel cross-process appends yield contiguous 1..4', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'abc',
      members: defaultMember(),
    });
    // A start-barrier file: each worker writes its PID to <BARRIER>.<i>.ready
    // and then busy-waits until <BARRIER>.go exists. This forces all 4 children
    // to be alive and ready before any of them tries to acquire the sidecar
    // lock, producing real cross-process contention.
    const barrier = join(dir, 'barrier');
    const workerScript = `
      import('${SIDECAR_PATH}').then(async ({ appendImplementerEventLocked }) => {
        const fs = await import('node:fs');
        // With node -e SCRIPT -- a b: process.argv === [node, 'a', 'b']
        const idx = process.argv[1];
        const barrier = process.argv[2];
        fs.writeFileSync(barrier + '.' + idx + '.ready', String(process.pid));
        // Busy-wait until barrier.go exists (cheap, brief; max ~5s).
        const start = Date.now();
        while (!fs.existsSync(barrier + '.go')) {
          if (Date.now() - start > 10_000) throw new Error('barrier timeout');
          await new Promise((r) => setTimeout(r, 20));
        }
        const ev = {
          event_type: 'checkpoint',
          implementer_run_id: '${implementer_run_id}',
          slice_id: 'slice-3',
          member_id: 'expert-implementer@claude:kimi-k2.6:cloud#0',
          runtime_kind: 'claude-cli',
          worktree_id: 'wt-slice-3-claude-0',
          payload_hash: '${ZERO_HASH}',
          payload: { pid: process.pid, idx: parseInt(idx, 10) },
        };
        const r = await appendImplementerEventLocked(${JSON.stringify(spec)}, ev);
        process.stdout.write(JSON.stringify(r));
      }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
    `;
    // Spawn all 4 children (non-blocking) BEFORE awaiting any of them.
    const children = [];
    const results = [];
    for (let i = 0; i < 4; i++) {
      const child = spawn('node', ['--input-type=module', '-e', workerScript, '--', String(i), barrier], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
      child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
      const exited = new Promise((resolveP) => {
        child.on('close', (code) => resolveP({ code, stdout, stderr }));
      });
      children.push({ child, exited });
    }
    // Wait until all 4 children have reported ready, then release the barrier.
    {
      const start = Date.now();
      while (true) {
        const ready = [0, 1, 2, 3].every((i) => {
          try {
            return readFileSync(`${barrier}.${i}.ready`).length > 0;
          } catch {
            return false;
          }
        });
        if (ready) break;
        if (Date.now() - start > 15_000) throw new Error('children failed to reach ready');
        await new Promise((r) => setTimeout(r, 25));
      }
      writeFileSync(`${barrier}.go`, '1');
    }
    for (const c of children) {
      const r = await c.exited;
      results.push(r);
    }
    for (const r of results) {
      assert.equal(r.code, 0, `worker exit ${r.code} stderr=${r.stderr}`);
    }
    const seqs = results.map((r) => JSON.parse(r.stdout).event_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3, 4]);
    // Independent re-read confirms 4 events landed with contiguous event_seq.
    const block = readImplementerRun(spec, 'slice-3');
    assert.equal(block.events.length, 4);
    const seqsRead = block.events.map((e) => e.event_seq).sort((a, b) => a - b);
    assert.deepEqual(seqsRead, [1, 2, 3, 4]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startImplementerRun + appendImplementerEventLocked: in-flight race resolves consistently', async () => {
  // Real race between a start and an append for the SAME slice that does not
  // yet have a run. withSidecarLock serializes them; the outcome depends on
  // which acquires the lock first. Either ordering must leave a consistent state.
  const { dir, spec } = makeSpec();
  try {
    const member = defaultMember();
    const memberId = 'expert-implementer@claude:kimi-k2.6:cloud#0';
    // Fire both at once; do NOT await either before the other starts.
    const startPromise = startImplementerRun(spec, 'slice-3', { base_sha: 'abc', members: member });
    const appendPromise = startPromise
      .catch(() => null) // any start outcome — we want the run_id if it succeeds
      .then(async (r) => {
        const runId = r ? r.implementer_run_id : 'unknown';
        return appendImplementerEventLocked(spec, {
          event_type: 'started',
          implementer_run_id: runId,
          slice_id: 'slice-3',
          member_id: memberId,
          runtime_kind: 'claude-cli',
          worktree_id: 'wt-slice-3-claude-0',
          payload_hash: ZERO_HASH,
          payload: { phase: 'init' },
        });
      });
    // Also fire a separate append that races without knowing the run_id.
    const eagerAppend = appendImplementerEventLocked(spec, {
      event_type: 'started',
      implementer_run_id: 'unknown-runid',
      slice_id: 'slice-3',
      member_id: memberId,
      runtime_kind: 'claude-cli',
      worktree_id: 'wt-slice-3-claude-0',
      payload_hash: ZERO_HASH,
      payload: { phase: 'eager' },
    }).then(
      (ok) => ({ ok: true, val: ok }),
      (err) => ({ ok: false, err: err.message })
    );
    const [, ordered, eager] = await Promise.all([startPromise, appendPromise, eagerAppend]);
    // The ordered append (after start) must succeed with event_seq=1.
    assert.equal(ordered.event_seq, 1);
    // The eager append must EITHER succeed with seq=2 (if it ran after start)
    // OR fail cleanly because the run didn't exist or run_id mismatched.
    if (eager.ok) {
      assert.equal(eager.val.event_seq, 2);
    } else {
      assert.match(eager.err, /(implementer_experts run|implementer_run_id)/);
    }
    const block = readImplementerRun(spec, 'slice-3');
    assert.equal(block.status, 'running');
    assert.ok(block.events.length >= 1);
    // All persisted events have contiguous event_seq starting at 1.
    const persisted = block.events.map((e) => e.event_seq).sort((a, b) => a - b);
    for (let i = 0; i < persisted.length; i++) {
      assert.equal(persisted[i], i + 1, `event_seq[${i}] expected ${i + 1}, got ${persisted[i]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent: start↔append (in-process serialized via withSidecarLock) ─

test('startImplementerRun rejects second running run on same slice (atomic under lock)', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startBasicRun(spec);
    await assert.rejects(
      () =>
        startImplementerRun(spec, 'slice-3', {
          base_sha: 'def',
          members: defaultMember(),
        }),
      /already has a running/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent: complete ↔ append ──────────────────────────────────────

test('completeImplementerRun + appendImplementerEventLocked: both succeed, no events lost', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    // Start them in parallel — withSidecarLock will serialize internally.
    const completed = completeImplementerRun(spec, 'slice-3', runId, {
      status: 'completed',
      merge: { sha: 'merge-sha' },
      post_merge_review: null,
    });
    const appended = appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'checkpoint' }));
    await Promise.all([completed, appended]);
    const block = readImplementerRun(spec, 'slice-3');
    assert.equal(block.status, 'completed');
    assert.equal(typeof block.completed_at, 'string');
    assert.equal(block.events.length, 1);
    assert.equal(block.events[0].event_type, 'checkpoint');
    assert.deepEqual(block.merge, { sha: 'merge-sha' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency: ELOCKED via injected lockfile dep ──────────────────────

test('appendImplementerEventLocked: throws SidecarLockError on ELOCKED (held by another lock)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    // Acquire the sidecar's underlying lock with the same proper-lockfile
    // module so the in-process append attempt sees ELOCKED. We pass
    // lockOptions.retries: 0 so it fails fast (no waiting for our release).
    const sidecarFile = __sidecarFilePath(spec);
    const release = await lockfile.lock(sidecarFile, { stale: 30_000, retries: 0 });
    try {
      await assert.rejects(
        () =>
          appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId }), {
            lockOptions: { stale: 30_000, retries: 0 },
          }),
        (err) => err instanceof SidecarLockError && err.code === 'sidecar-lock-failed'
      );
      // events[] is unchanged because the lock never opened.
      const block = readImplementerRun(spec, 'slice-3');
      assert.deepEqual(block.events, []);
    } finally {
      await release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path: validation-before-write ────────────────────────────

test('appendImplementerEventLocked: rejected call leaves events[] byte-equivalent', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    // Seed one valid event.
    await appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId }));
    const sidecarBytesBefore = readFileSync(__sidecarFilePath(spec));
    // Attempt a malformed append (bad event_type).
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'bogus' }))
    );
    const sidecarBytesAfter = readFileSync(__sidecarFilePath(spec));
    assert.deepEqual(sidecarBytesBefore, sidecarBytesAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startImplementerRun: rejected call leaves slice phases unchanged', async () => {
  const { dir, spec } = makeSpec();
  try {
    // Pre-populate slice-3 with phases.implement to ensure it's preserved.
    const sc = loadSidecar(spec);
    sc.slice_reviews['slice-3'] = { phases: { implement: { dispatches: [] } } };
    writeFileSync(__sidecarFilePath(spec), JSON.stringify(sc));
    const beforeBytes = readFileSync(__sidecarFilePath(spec));
    // Attempt to start with bad members (empty members object).
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-3', { base_sha: 'abc', members: {} }),
      /members/
    );
    const afterBytes = readFileSync(__sidecarFilePath(spec));
    assert.deepEqual(beforeBytes, afterBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completeImplementerRun: rejected call (bad status) leaves run unchanged', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    const beforeBytes = readFileSync(__sidecarFilePath(spec));
    await assert.rejects(
      () => completeImplementerRun(spec, 'slice-3', runId, { status: 'bogus' }),
      /status/
    );
    const afterBytes = readFileSync(__sidecarFilePath(spec));
    assert.deepEqual(beforeBytes, afterBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completeImplementerRun: rejects mismatched implementer_run_id', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startBasicRun(spec);
    await assert.rejects(
      () =>
        completeImplementerRun(spec, 'slice-3', 'not-the-run-id', {
          status: 'completed',
        }),
      /does not match/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── completeImplementerRun happy path ───────────────────────────────────────

test('completeImplementerRun: sets status + completed_at + merge + post_merge_review', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await completeImplementerRun(spec, 'slice-3', runId, {
      status: 'completed',
      merge: { sha: 'm1' },
      post_merge_review: { verdict: 'SHIP' },
    });
    const block = readImplementerRun(spec, 'slice-3');
    assert.equal(block.status, 'completed');
    assert.equal(typeof block.completed_at, 'string');
    assert.deepEqual(block.merge, { sha: 'm1' });
    assert.deepEqual(block.post_merge_review, { verdict: 'SHIP' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readImplementerRun ──────────────────────────────────────────────────────

test('readImplementerRun: returns null for missing slice', () => {
  const { dir, spec } = makeSpec();
  try {
    assert.equal(readImplementerRun(spec, 'slice-99'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readImplementerRun: returns null for slice with only legacy phases.implement', async () => {
  const { dir, spec } = makeSpec();
  try {
    const sc = loadSidecar(spec);
    sc.slice_reviews['slice-7'] = { phases: { implement: { dispatches: [] } } };
    writeFileSync(__sidecarFilePath(spec), JSON.stringify(sc));
    assert.equal(readImplementerRun(spec, 'slice-7'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module: real mailbox shape ────────────────────────────

test('integration: writeToMailbox id round-trips through implementer event', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    // writeToMailbox needs a repo root with a writable .codex-paired dir.
    const { id } = await writeToMailbox(dir, 'slice-3', {
      from: 'orchestrator',
      text: 'progress message',
    });
    assert.ok(id.startsWith('msg-'), `id should start with msg-, got "${id}"`);
    const r = await appendImplementerEventLocked(
      spec,
      baseEvent({
        implementer_run_id: runId,
        event_type: 'mailbox_delivered',
        mailbox_message_id: id,
      })
    );
    assert.equal(r.event_seq, 1);
    const stored = readImplementerRun(spec, 'slice-3').events[0];
    assert.equal(stored.mailbox_message_id, id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── compat.breaking: legacy phases.implement preserved ──────────────────────

test('startImplementerRun: preserves sibling phases.implement on same slice', async () => {
  const { dir, spec } = makeSpec();
  try {
    const sc = loadSidecar(spec);
    sc.slice_reviews['slice-3'] = {
      phases: {
        implement: {
          dispatches: [{ slice_id: 'slice-3', agent: 'codex', dispatched_at: 't', worktree: 'w', outcome: 'shipped' }],
          bootstrap: { symlinks: [], completed_at: 'x' },
        },
      },
    };
    writeFileSync(__sidecarFilePath(spec), JSON.stringify(sc));
    const beforeImpl = JSON.stringify(sc.slice_reviews['slice-3'].phases.implement);
    await startImplementerRun(spec, 'slice-3', { base_sha: 'abc', members: defaultMember() });
    const after = loadSidecar(spec);
    const afterImpl = JSON.stringify(after.slice_reviews['slice-3'].phases.implement);
    assert.equal(afterImpl, beforeImpl);
    assert.ok(after.slice_reviews['slice-3'].phases.implementer_experts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── startImplementerRun: input validation ───────────────────────────────────

test('startImplementerRun: rejects empty members', async () => {
  const { dir, spec } = makeSpec();
  try {
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-3', { base_sha: 'abc', members: {} }),
      /members/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startImplementerRun: rejects missing base_sha', async () => {
  const { dir, spec } = makeSpec();
  try {
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-3', { members: defaultMember() }),
      /base_sha/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startImplementerRun: rejects member with missing adapter', async () => {
  const { dir, spec } = makeSpec();
  try {
    const bad = {
      'expert-implementer@claude:kimi-k2.6:cloud#0': {
        adapter: '',
        model: 'm',
        required: true,
        worktree_id: 'w',
        branch: 'b',
        claimed_files: [],
      },
    };
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-3', { base_sha: 'abc', members: bad }),
      /adapter/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── compat.breaking slice-8: 4 new event types accepted ─────────────────────

const SLICE8_NEW_EVENT_TYPES = [
  'merger_started',
  'merger_completed',
  'merge_review_claude',
  'merge_review_codex',
];

for (const eventType of SLICE8_NEW_EVENT_TYPES) {
  test(`appendImplementerEventLocked: accepts new slice-8 event_type "${eventType}"`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startBasicRun(spec);
      const r = await appendImplementerEventLocked(
        spec,
        baseEvent({ implementer_run_id: runId, event_type: eventType })
      );
      assert.equal(r.event_seq, 1, `event_seq should be 1 for event_type "${eventType}"`);
      const stored = readImplementerRun(spec, 'slice-3').events[0];
      assert.equal(stored.event_type, eventType, `stored event_type should be "${eventType}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('appendImplementerEventLocked: still rejects unknown event_type after slice-8 additions', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startBasicRun(spec);
    await assert.rejects(
      () => appendImplementerEventLocked(spec, baseEvent({ implementer_run_id: runId, event_type: 'unknown_merger_event' })),
      /event_type/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── helper: locate the sidecar file path (mirrors sidecar.js logic) ─────────

function __sidecarFilePath(specPath) {
  // For tests the spec lives in tmpdir (outside a repo), so the sidecar is
  // always at the legacy path: <spec>.codex.json.
  return `${specPath}.codex.json`;
}
