// v0.10.0 slice 10 — canary rejection at sidecar (appendImplementerEventLocked).
//
// Critical contract: REJECT canaries at hashed-surface writers (sidecar/mailbox).
// This preserves the audit-hash invariant: payload_hash === sha256(JSON.stringify(payload)).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  initSidecar,
  loadSidecar,
  startImplementerRun,
  appendImplementerEventLocked,
  readImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';

import { CANARY_TOKENS, ALL_CANARIES } from './fixtures/canary-tokens.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function payloadHash(payload) {
  return 'sha256:' + sha256Hex(JSON.stringify(payload));
}

function makeSpec(prefix = 'cps-canary-sidecar-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'v0.10.0', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const MEMBER_ID = 'expert-implementer@claude:kimi-k2.6:cloud#0';
const MEMBER = {
  [MEMBER_ID]: {
    adapter: 'claude-cli',
    model: 'kimi-k2.6:cloud',
    required: true,
    worktree_id: 'wt-slice-3-claude-0',
    branch: 'implementer/slice-3/claude-0',
    claimed_files: ['lib/a.js'],
  },
};

async function startRun(spec) {
  const { implementer_run_id } = await startImplementerRun(spec, 'slice-3', {
    base_sha: 'abc123',
    members: MEMBER,
  });
  return implementer_run_id;
}

function buildEvent(runId, payload) {
  return {
    event_type: 'started',
    implementer_run_id: runId,
    slice_id: 'slice-3',
    member_id: MEMBER_ID,
    runtime_kind: 'claude-cli',
    worktree_id: 'wt-slice-3-claude-0',
    payload_hash: payloadHash(payload),
    payload,
  };
}

// ── Tests: each of 4 canaries throws synchronously (well, Promise rejection) ─

for (const [tokenName, tokenValue] of Object.entries(CANARY_TOKENS)) {
  test(`appendImplementerEventLocked: rejects canary in payload.text (${tokenName})`, async () => {
    const { dir, spec } = makeSpec();
    try {
      const runId = await startRun(spec);
      const payload = { info: `value with ${tokenValue} embedded` };
      const event = buildEvent(runId, payload);

      await assert.rejects(
        () => appendImplementerEventLocked(spec, event),
        (err) => {
          assert.match(err.message, /redacted-secret pattern/);
          return true;
        },
        `Expected canary rejection for token ${tokenName}`
      );

      // Events array must be unchanged
      const run = readImplementerRun(spec, 'slice-3');
      assert.equal(run.events.length, 0, 'No events should have been appended');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ── Test: canary in nested object ────────────────────────────────────────────

test('appendImplementerEventLocked: rejects canary nested in payload object', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const payload = {
      nested: {
        deeply: {
          value: `token=${CANARY_TOKENS.anthropicApi}`,
        },
      },
    };
    const event = buildEvent(runId, payload);

    await assert.rejects(
      () => appendImplementerEventLocked(spec, event),
      /redacted-secret pattern/,
      'Should reject nested canary'
    );

    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 0, 'No events appended on rejection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: 4 concurrent rejected appends with canaries ───────────────────────

test('appendImplementerEventLocked: 4 concurrent canary appends leave sidecar unchanged', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);

    const results = await Promise.allSettled(
      ALL_CANARIES.map((canary) => {
        const payload = { secret: canary };
        return appendImplementerEventLocked(spec, buildEvent(runId, payload));
      })
    );

    // All should be rejected
    for (const result of results) {
      assert.equal(result.status, 'rejected', 'Each canary append should be rejected');
      assert.match(result.reason.message, /redacted-secret pattern/);
    }

    // Events array must be unchanged
    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 0, 'No events appended after 4 concurrent canary attempts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: safe metadata is ACCEPTED ─────────────────────────────────────────

test('appendImplementerEventLocked: safe metadata payload is accepted', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);
    const payload = {
      secret_presence: 'present',
      base_url_hash: 'sha256:' + sha256Hex('https://api.example.com'),
      provider: 'ollama-cloud',
    };
    const event = buildEvent(runId, payload);

    const result = await appendImplementerEventLocked(spec, event);
    assert.equal(typeof result.event_seq, 'number');
    assert.ok(result.event_seq >= 1, 'event_seq must be positive');

    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 1, 'Event should be appended');
    assert.equal(run.events[0].payload.secret_presence, 'present');
    assert.equal(run.events[0].payload.provider, 'ollama-cloud');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: hash invariant — every persisted event has payload_hash === sha256(payload) ──

test('appendImplementerEventLocked: hash invariant on save+load', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);

    // Append 3 clean events
    const payloads = [
      { event: 'started', info: 'clean-1' },
      { event: 'checkpoint', progress: 50 },
      { event: 'completed', result: 'ok' },
    ];

    const eventTypes = ['started', 'checkpoint', 'completed'];
    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      await appendImplementerEventLocked(spec, {
        event_type: eventTypes[i],
        implementer_run_id: runId,
        slice_id: 'slice-3',
        member_id: MEMBER_ID,
        runtime_kind: 'claude-cli',
        worktree_id: 'wt-slice-3-claude-0',
        payload_hash: payloadHash(payload),
        payload,
      });
    }

    // Re-load and verify hash invariant
    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 3, 'Expected 3 events');

    for (const event of run.events) {
      const expectedHash = 'sha256:' + sha256Hex(JSON.stringify(event.payload));
      assert.equal(
        event.payload_hash,
        expectedHash,
        `Hash invariant violated for event_seq=${event.event_seq}: ` +
        `stored=${event.payload_hash} computed=${expectedHash}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: regression — normal appends still work ────────────────────────────

test('appendImplementerEventLocked: normal appends still work after canary rejection', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);

    // First: reject a canary append
    const badPayload = { secret: CANARY_TOKENS.openai };
    await assert.rejects(
      () => appendImplementerEventLocked(spec, buildEvent(runId, badPayload)),
      /redacted-secret pattern/
    );

    // Then: normal append succeeds
    const goodPayload = { progress: 'normal work', percent: 75 };
    const result = await appendImplementerEventLocked(spec, buildEvent(runId, goodPayload));
    assert.equal(typeof result.event_seq, 'number');
    assert.ok(result.event_seq >= 1);

    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 1, 'Only the good event should be persisted');
    assert.equal(run.events[0].payload.percent, 75);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Test: payload_hash mismatch is rejected (critique 1) ─────────────────────

test('appendImplementerEventLocked rejects payload+payload_hash mismatch', async () => {
  const { dir, spec } = makeSpec();
  try {
    const runId = await startRun(spec);

    // Build a clean payload with a well-formed but wrong hash (the zero-hash)
    const cleanPayload = { ok: true };
    const zeroHash = 'sha256:' + '0'.repeat(64);

    const badEvent = {
      event_type: 'started',
      implementer_run_id: runId,
      slice_id: 'slice-3',
      member_id: MEMBER_ID,
      runtime_kind: 'claude-cli',
      worktree_id: 'wt-slice-3-claude-0',
      payload_hash: zeroHash,
      payload: cleanPayload,
    };

    await assert.rejects(
      () => appendImplementerEventLocked(spec, badEvent),
      (err) => {
        assert.match(err.message, /payload_hash mismatch/);
        return true;
      },
      'Should throw on payload_hash mismatch'
    );

    // Events array must be unchanged after the rejection
    const run = readImplementerRun(spec, 'slice-3');
    assert.equal(run.events.length, 0, 'No events should have been appended after hash mismatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
