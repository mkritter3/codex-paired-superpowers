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
import { initSidecar, loadSidecar } from '../../lib/codex-bridge/sidecar.js';

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

function validMachineResult(expertId = 'expert-ui', phase = 'spec-review', status = 'SHIP') {
  return `## Findings\nLooks fine.\n\n## Machine Result\n\`\`\`json\n${JSON.stringify({
    expert_id: expertId,
    phase,
    status,
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_sent: [],
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
  };
  const deps = {
    readUnreadMessages: async () => {
      calls.readUnread++;
      return [];
    },
    markManyAsRead: async (root, id, ids) => {
      calls.markRead.push({ root, id, ids });
      return { marked: ids, skipped: [] };
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
