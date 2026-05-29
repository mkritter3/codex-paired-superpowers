// v0.8.0 slice 4 — tests for lib/codex-bridge/expert-turn.js.
//
// Uses the DI-seam pattern: `runTurnWithDeps(request, deps)` where deps default
// to real implementations. Tests stub mailbox/parser/agentDispatch/sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assembleSpawnPrompt, runTurnWithDeps } from '../../lib/codex-bridge/expert-turn.js';
import {
  assembleSpawnPrompt as reviewerAssembleSpawnPrompt,
  runTurnWithDeps as reviewerRunTurnWithDeps,
} from '../../lib/codex-bridge/reviewer-turn.js';
import { initSidecar, loadSidecar } from '../../lib/codex-bridge/sidecar.js';

// Plan 3 one-window contract: the expert-* shim re-exports the identical
// reviewer-* references.
test('expert-turn shim === reviewer-turn canonical', () => {
  assert.equal(runTurnWithDeps, reviewerRunTurnWithDeps);
  assert.equal(assembleSpawnPrompt, reviewerAssembleSpawnPrompt);
});

function makeTmp(prefix = 'cps-expert-turn-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSpec() {
  const dir = makeTmp();
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

function makeIdentity(dir, body = '<the expert prompt body>') {
  const promptPath = join(dir, 'test-expert-ui.md');
  writeFileSync(promptPath, body);
  return { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
}

function validMachineResult(expertId = 'expert-ui', phase = 'spec-review', status = 'SHIP', peerMessagesRequested = []) {
  return `## Findings\nLooks fine.\n\n## Machine Result\n\`\`\`json\n${JSON.stringify({
    expert_id: expertId,
    phase,
    status,
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: peerMessagesRequested,
    questions_for_orchestrator: [],
  })}\n\`\`\`\n`;
}

// ── assembleSpawnPrompt contract ───────────────────────────────────────────

test('assembleSpawnPrompt includes ALL spec-mandated inputs', () => {
  const dir = makeTmp();
  const identity = makeIdentity(dir);
  const sidecarParticipantStateSnippet = "PRIOR_SUMMARY: expert-ui SHIP'd round 1 with 2 nonblocking findings";
  const unreadMessages = [
    { id: 'msg-1', from: 'expert-ux', text: 'check the panel state boundary', timestamp: '2026-05-11T00:00:00.000Z' },
    { id: 'msg-2', from: 'orchestrator', text: 'review the new component', timestamp: '2026-05-11T00:00:01.000Z' },
  ];

  const prompt = assembleSpawnPrompt({
    identity,
    specPath: '/tmp/test-spec.md',
    specSnippet: 'TEST_SPEC_SNIPPET',
    phase: 'spec-review',
    sidecarParticipantState: sidecarParticipantStateSnippet,
    unreadMessages,
    task: 'Review the spec draft.',
  });

  // L11 rules
  assert.match(prompt, /L11/i, 'should include L11 rules');
  // Expert prompt contents (read from promptPath and embedded)
  assert.ok(prompt.includes('<the expert prompt body>'), 'should include expert prompt contents');
  // Spec path + snippet
  assert.ok(prompt.includes('/tmp/test-spec.md'), 'should include spec path');
  assert.ok(prompt.includes('TEST_SPEC_SNIPPET'), 'should include spec snippet');
  // Sidecar participant state (THE round-2 critique requirement)
  assert.ok(prompt.includes(sidecarParticipantStateSnippet), 'should include sidecar participant state for rehydration');
  // Every unread message body verbatim
  for (const m of unreadMessages) {
    assert.ok(prompt.includes(m.text), `should include message text: ${m.text}`);
  }
  // Phase string
  assert.ok(prompt.includes('spec-review'), 'should include phase');
  // Task text
  assert.ok(prompt.includes('Review the spec draft.'), 'should include task');
  // Output contract / Machine Result schema reference
  assert.ok(prompt.includes('Machine Result'), 'should include output contract reference');
  // Expert identity for outbound DMs
  assert.ok(prompt.includes('expert-ui'), 'should include mailbox identity');
  rmSync(dir, { recursive: true, force: true });
});

test('assembleSpawnPrompt handles empty unread message list gracefully', () => {
  const dir = makeTmp();
  const identity = makeIdentity(dir);
  const prompt = assembleSpawnPrompt({
    identity,
    specPath: '/tmp/s.md',
    specSnippet: 'snip',
    phase: 'spec-review',
    sidecarParticipantState: '',
    unreadMessages: [],
    task: 'do the thing',
  });
  assert.ok(prompt.length > 0);
  assert.ok(prompt.includes('expert-ui'));
  rmSync(dir, { recursive: true, force: true });
});

test('assembleSpawnPrompt embeds the real system-rubric.md content (not a hardcoded placeholder)', () => {
  // Codex round-1 caught: a substring assertion on "L11" would pass even
  // if assembleSpawnPrompt omitted the actual rubric. This test pins the
  // contract by checking signature strings that only appear in
  // lib/codex-bridge/prompts/system-rubric.md, so the test fails if the
  // rubric content is dropped or replaced with a stub.
  const dir = makeTmp();
  const identity = makeIdentity(dir);
  const prompt = assembleSpawnPrompt({
    identity,
    specPath: '/tmp/s.md',
    specSnippet: 'snip',
    phase: 'spec-review',
    sidecarParticipantState: '',
    unreadMessages: [],
    task: 'do the thing',
  });
  // These phrases come straight from prompts/system-rubric.md.
  assert.ok(
    prompt.includes('L11 Engineering Partner'),
    'should embed the "L11 Engineering Partner" heading from system-rubric.md',
  );
  assert.ok(
    prompt.includes('Never rubber-stamp'),
    'should embed the "Never rubber-stamp" behavioral rule from system-rubric.md',
  );
  assert.ok(
    prompt.includes('Pre-SHIP checklist'),
    'should embed the "Pre-SHIP checklist" section from system-rubric.md',
  );
  rmSync(dir, { recursive: true, force: true });
});

// ── runTurnWithDeps contract ───────────────────────────────────────────────

function makeDepStubs(overrides = {}) {
  const calls = {
    readUnread: 0,
    markRead: [],
    parse: 0,
    dispatch: [],
    appendTurn: [],
    breadcrumbs: [],
    writeToMailbox: [],
  };
  let mailboxSeq = 0;
  const deps = {
    readUnreadMessages: async () => {
      calls.readUnread++;
      return [];
    },
    markManyAsRead: async (root, id, ids) => {
      calls.markRead.push({ root, id, ids });
      return { marked: ids, skipped: [] };
    },
    writeToMailbox: async (root, recipient, message) => {
      calls.writeToMailbox.push({ root, recipient, message });
      mailboxSeq++;
      return { id: `msg-stub-${mailboxSeq}` };
    },
    parseExpertOutput: (raw, opts) => {
      calls.parse++;
      // default OK
      return { ok: true, result: JSON.parse(raw.match(/```json\n([\s\S]+?)\n```/)?.[1] || '{}') };
    },
    buildRepairPrompt: (args) => `REPAIR:${args.reason}`,
    agentDispatch: async (prompt) => {
      calls.dispatch.push(prompt);
      return validMachineResult();
    },
    appendExpertTurn: async (specPath, turn) => {
      calls.appendTurn.push(turn);
    },
    writeBreadcrumb: (root, id, msg) => {
      calls.breadcrumbs.push({ root, id, msg });
    },
    ...overrides,
  };
  return { deps, calls };
}

function baseRequest(dir, identity, spec) {
  return {
    identity,
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'snip',
    phase: 'spec-review',
    sliceId: null,
    sidecarParticipantState: 'no prior',
    task: 'do the review',
  };
}

test('runTurnWithDeps happy path: dispatch returns valid Machine Result; messages marked read; turn appended', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const msg = { id: 'msg-a', from: 'orchestrator', text: 'hello', timestamp: '2026-05-11T00:00:00.000Z' };
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [msg],
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.ok(result.result);
  assert.equal(result.result.status, 'SHIP');
  assert.equal(calls.dispatch.length, 1);
  assert.equal(calls.markRead.length, 1);
  assert.deepEqual(calls.markRead[0].ids, ['msg-a']);
  assert.equal(calls.appendTurn.length, 1);
  assert.deepEqual(calls.appendTurn[0].mailbox_message_ids_injected, ['msg-a']);
  assert.equal(calls.appendTurn[0].verdict, 'SHIP');
  assert.equal(calls.appendTurn[0].failure_reason, null);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps parse fail + repair succeeds: messages marked read only after repaired parse', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const msg = { id: 'msg-x', from: 'orchestrator', text: 'fix it', timestamp: '2026-05-11T00:00:00.000Z' };
  let dispatchCallCount = 0;
  let parseCallCount = 0;
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [msg],
    agentDispatch: async () => {
      dispatchCallCount++;
      if (dispatchCallCount === 1) return 'broken garbage no machine block';
      return validMachineResult();
    },
    parseExpertOutput: (raw) => {
      parseCallCount++;
      if (parseCallCount === 1) return { ok: false, reason: 'missing-machine-block' };
      return {
        ok: true,
        result: {
          expert_id: 'expert-ui',
          phase: 'spec-review',
          status: 'SHIP',
          scope: 'ui',
          blocking_findings: [],
          nonblocking_findings: [],
          peer_messages_sent: [],
          questions_for_orchestrator: [],
        },
      };
    },
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(dispatchCallCount, 2, 'agentDispatch should have been called twice (initial + repair)');
  assert.equal(calls.markRead.length, 1, 'markRead called once after repair succeeded');
  assert.deepEqual(calls.markRead[0].ids, ['msg-x']);
  assert.equal(calls.appendTurn[0].failure_reason, null);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps parse fail + repair fails: messages NOT marked read BUT mailbox_message_ids_injected preserves audit trail', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const msg = { id: 'msg-y', from: 'orchestrator', text: 't', timestamp: '2026-05-11T00:00:00.000Z' };
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [msg],
    agentDispatch: async () => 'still broken',
    parseExpertOutput: () => ({ ok: false, reason: 'missing-machine-block' }),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unparseable-output');
  assert.equal(calls.markRead.length, 0, 'messages must NOT be marked read on parse fail');
  assert.equal(calls.appendTurn.length, 1);
  assert.equal(calls.appendTurn[0].failure_reason, 'unparseable-output');
  assert.equal(calls.appendTurn[0].verdict, 'REVISE');
  // Audit trail: messages were INJECTED into the prompt (the expert saw them),
  // even though parse failed. mark-read remains separate (not called above).
  // Per spec §Rehydration State the injected ids must be preserved on failure
  // for restart/audit context. (Codex round-1 critique.)
  assert.deepEqual(calls.appendTurn[0].mailbox_message_ids_injected, ['msg-y']);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps agent dispatch throws: messages NOT marked read BUT mailbox_message_ids_injected preserves audit trail', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const msg = { id: 'msg-z', from: 'orchestrator', text: 't', timestamp: '2026-05-11T00:00:00.000Z' };
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [msg],
    agentDispatch: async () => { throw new Error('agent boom'); },
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dispatch-error');
  assert.equal(calls.markRead.length, 0);
  assert.equal(calls.appendTurn.length, 1);
  assert.equal(calls.appendTurn[0].failure_reason, 'dispatch-error');
  // Same audit-trail contract on the dispatch-error path.
  assert.deepEqual(calls.appendTurn[0].mailbox_message_ids_injected, ['msg-z']);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps empty unread: mailbox_message_ids_injected: []; turn still recorded', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [],
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(calls.appendTurn.length, 1);
  assert.deepEqual(calls.appendTurn[0].mailbox_message_ids_injected, []);
  // markManyAsRead may or may not be called when ids are empty; ensure no crash either way.
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps sidecar append throws: breadcrumb written; result still returned', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const { deps, calls } = makeDepStubs({
    appendExpertTurn: async () => { throw new Error('sidecar boom'); },
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.ok(calls.breadcrumbs.length >= 1);
  assert.match(calls.breadcrumbs[0].msg, /sidecar/i);
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.8.1 peer-DM enqueue ────────────────────────────────────────────────
//
// runTurnWithDeps must consume parsed.peer_messages_requested on parse
// success, classify each item, and call writeToMailbox for valid ones.
// Per-item failures DO NOT fail the turn — they are recorded under
// peer_messages_failed for audit; the scheduler halts on summary.failed > 0.

import { MailboxError } from '../../lib/codex-bridge/mailbox.js';

test('v0.8.1 peer-DM: two valid requests both enqueued; summary records counts; sidecar carries audit', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [
    { to: 'expert-ux', body: 'check panel state', summary: 'panel state q' },
    { to: 'expert-architecture', body: 'review boundary', summary: 'boundary review' },
  ];
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.peer_dm_summary, { enqueued: 2, failed: 0 });
  assert.equal(calls.writeToMailbox.length, 2);
  assert.equal(calls.writeToMailbox[0].recipient, 'expert-ux');
  assert.equal(calls.writeToMailbox[0].message.from, 'expert-ui');
  assert.equal(calls.writeToMailbox[0].message.text, 'check panel state');
  assert.equal(calls.writeToMailbox[0].message.summary, 'panel state q');
  // Sidecar turn record carries the audit.
  const turn = calls.appendTurn[0];
  assert.equal(turn.peer_messages_enqueued.length, 2);
  assert.equal(turn.peer_messages_enqueued[0].to, 'expert-ux');
  assert.ok(turn.peer_messages_enqueued[0].message_id.startsWith('msg-'));
  assert.deepEqual(turn.peer_messages_failed, []);
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: legacy peer_messages_sent (v0.8.0 alias) still enqueues', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  // Simulate parser normalization: parser sees legacy `peer_messages_sent`
  // and writes it onto `peer_messages_requested`. We model the parser's
  // post-normalization output here.
  const legacyMessage = { to: 'expert-ux', summary: 'old shape — only summary' };
  const { deps, calls } = makeDepStubs({
    parseExpertOutput: () => ({
      ok: true,
      result: {
        expert_id: 'expert-ui',
        phase: 'spec-review',
        status: 'SHIP',
        scope: 'ui',
        blocking_findings: [],
        nonblocking_findings: [],
        peer_messages_requested: [legacyMessage], // post-normalization
        questions_for_orchestrator: [],
      },
      warnings: ['legacy-peer_messages_sent-normalized'],
    }),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(result.peer_dm_summary.enqueued, 1);
  // body fell back to summary
  assert.equal(calls.writeToMailbox[0].message.text, 'old shape — only summary');
  assert.equal(calls.writeToMailbox[0].message.summary, 'old shape — only summary');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: invalid recipient → recorded in failed; turn still ok', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [{ to: 'expert-FOO!!', body: 'x' }];
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(result.peer_dm_summary.enqueued, 0);
  assert.equal(result.peer_dm_summary.failed, 1);
  assert.equal(calls.writeToMailbox.length, 0, 'should not attempt write for invalid recipient');
  const failed = calls.appendTurn[0].peer_messages_failed;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].to, 'expert-FOO!!');
  assert.equal(failed[0].reason, 'invalid-recipient');
  assert.equal(failed[0].code, 'mailbox-recipient-malformed');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: self-DM → recorded in failed with reason self-dm', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [{ to: 'expert-ui', body: 'myself' }]; // identity is expert-ui
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(result.peer_dm_summary.failed, 1);
  assert.equal(calls.writeToMailbox.length, 0);
  assert.equal(calls.appendTurn[0].peer_messages_failed[0].reason, 'self-dm');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: empty body (no body, no summary) → recorded in failed', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [{ to: 'expert-ux' }]; // no body, no summary
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.peer_dm_summary.failed, 1);
  assert.equal(calls.writeToMailbox.length, 0);
  assert.equal(calls.appendTurn[0].peer_messages_failed[0].reason, 'empty-body');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: malformed item (not an object) → recorded in failed', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = ['not an object', { to: 'expert-ux', body: 'ok' }];
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.peer_dm_summary.enqueued, 1);
  assert.equal(result.peer_dm_summary.failed, 1);
  const failed = calls.appendTurn[0].peer_messages_failed;
  assert.equal(failed[0].reason, 'malformed-item');
  assert.equal(failed[0].to, null);
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: body preferred when both body and summary present', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [{ to: 'expert-ux', body: 'FULL BODY', summary: 'short' }];
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.peer_dm_summary.enqueued, 1);
  assert.equal(calls.writeToMailbox[0].message.text, 'FULL BODY');
  assert.equal(calls.writeToMailbox[0].message.summary, 'short');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: writeToMailbox throws MailboxError → recorded in failed with code; turn still ok', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [{ to: 'expert-ux', body: 'x' }];
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
    writeToMailbox: async () => {
      throw new MailboxError('mailbox-lock-timeout', 'lock contention');
    },
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true, 'turn succeeds even when peer-DM write fails');
  assert.equal(result.peer_dm_summary.failed, 1);
  const failed = calls.appendTurn[0].peer_messages_failed;
  assert.equal(failed[0].code, 'mailbox-lock-timeout');
  assert.match(failed[0].reason, /lock contention/);
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: parse-fail path does NOT enqueue peer messages', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => 'unparseable',
    parseExpertOutput: () => ({ ok: false, reason: 'missing-machine-block' }),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, false);
  assert.equal(calls.writeToMailbox.length, 0, 'no peer enqueue on parse-fail');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1 peer-DM: no peer_messages_requested field → empty summary, no failures', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const { deps } = makeDepStubs({
    // The validMachineResult helper now defaults to peer_messages_requested: []
    // so the absent-array case is the default. Test asserts no false failures.
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.deepEqual(result.peer_dm_summary, { enqueued: 0, failed: 0 });
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.8.1.1 peer-DM count cap (edge-case #3) ────────────────────────────
//
// A runaway/malicious subagent could request 10K peer DMs; each
// writeToMailbox locks a file. Without a cap, the turn hangs and the
// drain-loop budget burns. Cap applies BEFORE per-item normalization;
// overflow is recorded as ONE bounded audit entry (not per-item) to
// prevent DoS-shift from mailbox locks into sidecar/memory growth.

test('v0.8.1.1 peer-DM cap: 100 items with deps.maxPeerMessagesPerTurn=3 → 3 enqueued + 1 bounded overflow record', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [];
  for (let i = 0; i < 100; i++) {
    requests.push({ to: `expert-ux`, body: `req ${i}` });
  }
  // After de-dup-of-classification: each request is independently valid (same recipient is allowed),
  // so all 3 capped items will enqueue successfully.
  const { deps, calls } = makeDepStubs({
    maxPeerMessagesPerTurn: 3, // cap injection seam
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  assert.equal(result.peer_dm_summary.enqueued, 3, 'exactly 3 enqueued (cap applied)');
  assert.equal(result.peer_dm_summary.failed, 1, 'one overflow record');
  assert.equal(calls.writeToMailbox.length, 3, 'no extra writeToMailbox calls past the cap');
  const turn = calls.appendTurn[0];
  const overflow = turn.peer_messages_failed[0];
  assert.equal(overflow.reason, 'count-cap-exceeded');
  assert.equal(overflow.code, 'count-cap-exceeded');
  assert.equal(overflow.overflow_count, 97);
  assert.equal(overflow.max_allowed, 3);
  assert.ok(Array.isArray(overflow.sample_to));
  assert.ok(overflow.sample_to.length <= 5, 'sample bounded at 5');
  assert.ok(overflow.sample_to.every((t) => typeof t === 'string' && t.length > 0));
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1.1 peer-DM cap: exact cap (no overflow) → no audit record', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [
    { to: 'expert-ux', body: 'a' },
    { to: 'expert-architecture', body: 'b' },
    { to: 'expert-backend', body: 'c' },
  ];
  const { deps } = makeDepStubs({
    maxPeerMessagesPerTurn: 3,
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.peer_dm_summary.enqueued, 3);
  assert.equal(result.peer_dm_summary.failed, 0, 'no overflow record when within cap');
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1.1 peer-DM cap: cap=0 → all overflow, enqueued=0', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [
    { to: 'expert-ux', body: 'a' },
    { to: 'expert-architecture', body: 'b' },
  ];
  const { deps, calls } = makeDepStubs({
    maxPeerMessagesPerTurn: 0,
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.peer_dm_summary.enqueued, 0);
  assert.equal(result.peer_dm_summary.failed, 1);
  assert.equal(calls.writeToMailbox.length, 0, 'no writes attempted when cap=0');
  const overflow = calls.appendTurn[0].peer_messages_failed[0];
  assert.equal(overflow.overflow_count, 2);
  assert.equal(overflow.max_allowed, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('v0.8.1.1 peer-DM cap: sample_to is bounded at 5 even with massive input', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [];
  for (let i = 0; i < 1000; i++) {
    requests.push({ to: `expert-ux`, body: `req ${i}` });
  }
  const { deps, calls } = makeDepStubs({
    maxPeerMessagesPerTurn: 2,
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  const overflow = calls.appendTurn[0].peer_messages_failed[0];
  assert.equal(overflow.overflow_count, 998);
  assert.equal(overflow.sample_to.length, 5, 'sample capped at OVERFLOW_SAMPLE_SIZE');
});

test('v0.8.1.1 peer-DM cap: sample_to truncates pathologically long `to` strings', async () => {
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const longTo = 'expert-' + 'x'.repeat(500); // 507 chars
  // Build a request array that exceeds the cap, with overflow items having
  // pathological `to` strings. Sample entries should be truncated to <=80 chars.
  const requests = [
    { to: 'expert-ux', body: 'cap-fill-1' },
    { to: 'expert-ux', body: 'cap-fill-2' },
    { to: longTo, body: 'overflow-1' }, // overflow with pathological recipient
    { to: longTo, body: 'overflow-2' },
  ];
  const { deps, calls } = makeDepStubs({
    maxPeerMessagesPerTurn: 2,
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  const overflow = calls.appendTurn[0].peer_messages_failed[0];
  for (const sampleEntry of overflow.sample_to) {
    assert.ok(sampleEntry.length <= 80, `sample entry must be <=80 chars; got length ${sampleEntry.length}`);
  }
});

test('v0.8.1.1 peer-DM cap: scheduler halt still triggered (peer_dm_summary.failed > 0)', async () => {
  // Defense-in-depth check: when the cap triggers, the resulting failed
  // count is reflected in peer_dm_summary, so the scheduler will halt
  // with expert-peer-dm-enqueue-failed (existing behavior).
  const { dir, spec } = makeSpec();
  const identity = makeIdentity(dir);
  const requests = [
    { to: 'expert-ux', body: 'a' },
    { to: 'expert-architecture', body: 'b' },
    { to: 'expert-backend', body: 'overflow' }, // 1 over cap
  ];
  const { deps } = makeDepStubs({
    maxPeerMessagesPerTurn: 2,
    agentDispatch: async () => validMachineResult('expert-ui', 'spec-review', 'SHIP', requests),
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.ok(result.peer_dm_summary.failed > 0, 'scheduler halt signal is set');
});

// ── v0.9.0 slice 5b round-1 fix: production write path supplies replay fields ─
//
// `runTurnWithDeps` on its success path must compute the replay/response
// audit fields and pass them to appendExpertTurn so they are persisted into
// the sidecar. Before the fix, helpers like storeResponse/computeInputsHash
// existed but the runtime never invoked them.

import { createHash } from 'node:crypto';
import { writeFileSync as fsWriteFileSync, readFileSync as fsReadFileSync, mkdirSync as fsMkdirSync, existsSync as fsExistsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { storeResponse, readResponse, computeInputsHash } from '../../lib/codex-bridge/sidecar.js';

function sha256HexUtf8(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeRolePromptFile(dir, roleId, version, body) {
  const promptPath = pathJoin(dir, `${roleId}.md`);
  const file = `---\nversion: ${version}\nrole_id: ${roleId}\n---\n${body}`;
  fsWriteFileSync(promptPath, file);
  return { promptPath, file, fileHashHex: sha256HexUtf8(file) };
}

test('runTurnWithDeps success path: persisted turn carries all replay/response audit fields', async () => {
  const { dir, spec } = makeSpec();
  const { promptPath, fileHashHex } = makeRolePromptFile(
    dir,
    'expert-ui',
    'v0.9.0-r1',
    '<the expert prompt body>',
  );
  const identity = { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
  const responseText = 'OK SHIP from agent';
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => responseText + '\n' + validMachineResult(),
  });
  const request = {
    ...baseRequest(dir, identity, spec),
    specSnippet: 'a small snippet',
    task: 'do the review',
  };
  const result = await runTurnWithDeps(request, deps);
  assert.equal(result.ok, true);

  const turn = calls.appendTurn[0];
  // Response fields.
  assert.ok(turn.response_hash, 'response_hash should be populated');
  assert.match(turn.response_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(
    typeof turn.response_text_inline === 'string' || typeof turn.response_ref === 'string',
    'response must be stored either inline or via ref',
  );
  // Replay fields.
  assert.equal(turn.role_prompt_hash, `sha256:${fileHashHex}`);
  assert.equal(turn.role_prompt_version, 'v0.9.0-r1');
  assert.equal(turn.spec_path, spec);
  assert.equal(turn.spec_snippet_hash, `sha256:${sha256HexUtf8('a small snippet')}`);
  assert.match(turn.inputs_hash, /^sha256:[a-f0-9]{64}$/);
  // Adapter defaults to "claude-task" when not provided.
  assert.equal(turn.adapter, 'claude-task');
  assert.equal(turn.requested_role, 'expert-ui');
  assert.equal(turn.task, 'do the review');
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps success path: inputs_hash matches computeInputsHash over the same inputs', async () => {
  const { dir, spec } = makeSpec();
  const { promptPath, fileHashHex } = makeRolePromptFile(
    dir,
    'expert-ui',
    'v0.9.0-r1',
    'body content',
  );
  const identity = { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
  const specSnippet = 'snip-xyz';
  const phase = 'spec-review';
  const task = 'review';
  const msg = { id: 'mb-1', from: 'orchestrator', text: 'hello', timestamp: '2026-05-11T00:00:00.000Z' };
  const { deps, calls } = makeDepStubs({
    readUnreadMessages: async () => [msg],
  });
  await runTurnWithDeps(
    { ...baseRequest(dir, identity, spec), specSnippet, phase, task },
    deps,
  );
  const turn = calls.appendTurn[0];
  const expected = computeInputsHash({
    rolePromptHash: fileHashHex,
    specSnippetHash: sha256HexUtf8(specSnippet),
    mailboxMessageIds: ['mb-1'],
    phase,
    task,
    roleId: 'expert-ui',
  });
  assert.equal(turn.inputs_hash, expected);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps success path: 100KB response → persisted turn uses response_ref + readResponse retrieves original text', async () => {
  const { dir, spec } = makeSpec();
  const { promptPath } = makeRolePromptFile(dir, 'expert-ui', 'v0.9.0-r1', 'body');
  const identity = { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
  const big = 'B'.repeat(100 * 1024); // 100KB > 50KB cap
  const machineResult = validMachineResult();
  // Append big payload BEFORE machine result so raw response > 50KB.
  const rawResponse = big + '\n' + machineResult;
  const { deps, calls } = makeDepStubs({
    agentDispatch: async () => rawResponse,
  });
  const result = await runTurnWithDeps(baseRequest(dir, identity, spec), deps);
  assert.equal(result.ok, true);
  const turn = calls.appendTurn[0];
  assert.ok(turn.response_ref, 'large response should use response_ref');
  assert.equal(turn.response_text_inline, undefined);
  assert.match(turn.response_ref, /^responses\/sha256-[a-f0-9]{64}\.txt$/);
  // readResponse against the tmp repo dir reproduces the original text + verifies hash.
  const retrieved = readResponse(dir, turn);
  assert.equal(retrieved, rawResponse);
  rmSync(dir, { recursive: true, force: true });
});

test('runTurnWithDeps success path: request.adapter overrides default "claude-task"', async () => {
  const { dir, spec } = makeSpec();
  const { promptPath } = makeRolePromptFile(dir, 'expert-ui', 'v0.9.0-r1', 'body');
  const identity = { id: 'expert-ui', role: 'ui', promptPath, source: 'builtin' };
  const { deps, calls } = makeDepStubs();
  await runTurnWithDeps(
    { ...baseRequest(dir, identity, spec), adapter: 'codex' },
    deps,
  );
  const turn = calls.appendTurn[0];
  assert.equal(turn.adapter, 'codex');
  rmSync(dir, { recursive: true, force: true });
});
