import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPanelMembersAvailable,
  composeMemberReplay,
  reducePanelRound,
  runPanelRound,
} from '../../lib/codex-bridge/review-panel-run.js';
import { openPanelMemberThread } from '../../lib/codex-bridge/reviewer-thread.js';

const VERSION = `sha256:${'a'.repeat(64)}`;
const ROSTER = [
  { member_id: 'codex:gpt-a', cli: 'codex', model: 'gpt-a', effort: 'high' },
  { member_id: 'agy:gemini-b-high', cli: 'agy', model: 'gemini-b-high', effort: 'high' },
];

function verdict(status = 'SHIP', overrides = {}) {
  return { status, critique: [], rationale: 'checked', deferred: [], version: VERSION, ...overrides };
}

function members(statuses = ['SHIP', 'SHIP']) {
  return ROSTER.map((member, index) => ({
    member_id: member.member_id,
    verdict: verdict(statuses[index]),
    conversation_id: `session-${index}`,
    usage: null,
  }));
}

test('reducePanelRound: all members SHIP implies SHIP', () => {
  assert.deepEqual(
    reducePanelRound({ roster: ROSTER, version: VERSION, claude: verdict(), members: members() }),
    { status: 'SHIP', blocking: [], deferred: [] },
  );
});

test('reducePanelRound: any member REVISE implies REVISE and labels its findings', () => {
  const inputs = members(['SHIP', 'REVISE']);
  inputs[1].verdict.critique = ['fix the race'];
  const result = reducePanelRound({ roster: ROSTER, version: VERSION, claude: verdict(), members: inputs });
  assert.equal(result.status, 'REVISE');
  assert.deepEqual(result.blocking, [{ member_id: ROSTER[1].member_id, finding: 'fix the race' }]);
});

for (const [name, mutate, memberId] of [
  ['missing member', (value) => value.pop(), ROSTER[1].member_id],
  ['failed member', (value) => { value[0] = { member_id: ROSTER[0].member_id, ok: false, error: 'timeout' }; }, ROSTER[0].member_id],
  ['missing version', (value) => { value[0].verdict.version = null; }, ROSTER[0].member_id],
  ['wrong version', (value) => { value[1].verdict.version = `sha256:${'b'.repeat(64)}`; }, ROSTER[1].member_id],
]) {
  test(`reducePanelRound: ${name} throws panel-member-unavailable naming the member`, () => {
    const value = members();
    mutate(value);
    assert.throws(
      () => reducePanelRound({ roster: ROSTER, version: VERSION, claude: verdict(), members: value }),
      (error) => error.code === 'panel-member-unavailable' && error.message.includes(memberId),
    );
  });
}

test('reducePanelRound: a configured one-member roster behaves as a panel', () => {
  const roster = [ROSTER[0]];
  const result = reducePanelRound({ roster, version: VERSION, claude: verdict(), members: members().slice(0, 1) });
  assert.equal(result.status, 'SHIP');
});

test('reducePanelRound: unknown or malformed verdict fields fail instead of becoming votes', () => {
  const unknown = members();
  unknown[0].verdict.surprise = true;
  assert.throws(
    () => reducePanelRound({ roster: ROSTER, version: VERSION, claude: verdict(), members: unknown }),
    /unknown field/,
  );
  const malformed = members();
  malformed[0].verdict.rationale = 42;
  assert.throws(
    () => reducePanelRound({ roster: ROSTER, version: VERSION, claude: verdict(), members: malformed }),
    (error) => error.code === 'panel-member-unavailable' && error.message.includes(ROSTER[0].member_id),
  );
});

test('runPanelRound dispatches independently so no prompt contains a current-round peer verdict', async () => {
  const prompts = new Map();
  const currentSecrets = new Map([
    [ROSTER[0].member_id, 'CURRENT-A-VERDICT'],
    [ROSTER[1].member_id, 'CURRENT-B-VERDICT'],
  ]);
  const result = await runPanelRound(
    {
      repoRoot: '/repo', roster: ROSTER, version: VERSION, claude: verdict(),
      round: 2, prompt: 'review the artifact',
    },
    {
      dispatchMember: async ({ member, prompt }) => {
        prompts.set(member.member_id, prompt);
        await Promise.resolve();
        return { member_id: member.member_id, verdict: verdict(), conversation_id: member.member_id, usage: null };
      },
    },
  );
  assert.equal(result.status, 'SHIP');
  for (const [memberId, prompt] of prompts) {
    for (const [peerId, secret] of currentSecrets) {
      if (peerId !== memberId) assert.equal(prompt.includes(secret), false);
    }
  }
});

test('mixed roster across three rounds keeps distinct Codex session keys and opens fresh agy conversations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-panel-rounds-'));
  const specPath = join(dir, 'spec.md');
  writeFileSync(specPath, '# spec\n');
  const roster = [
    { member_id: 'codex:gpt-a', cli: 'codex', model: 'gpt-a', effort: 'high' },
    { member_id: 'codex:gpt-b', cli: 'codex', model: 'gpt-b', effort: 'high' },
    { member_id: 'agy:gemini-c-high', cli: 'agy', model: 'gemini-c-high', effort: 'high' },
  ];
  const codexKeys = new Set();
  const agyGivenConversationIds = [];
  const agyOpenedConversationIds = [];
  let agyRound = 0;
  try {
    for (let round = 1; round <= 3; round += 1) {
      const result = await runPanelRound(
        {
          repoRoot: dir, specPath, role: 'review', sidecarKey: 'execution-reviewer',
          roster, version: VERSION, claude: verdict(), round, prompt: `round ${round}`,
        },
        {
          detectAvailableCLIs: async () => new Map([
            ['codex', { status: 'available' }], ['agy', { status: 'available' }],
          ]),
          dispatchMember: async (request) => {
            if (request.member.cli === 'codex') {
              codexKeys.add(request.sessionKey);
              return { member_id: request.member_id, verdict: verdict(), conversation_id: request.sessionKey, usage: null };
            }
            const opened = await openPanelMemberThread(request, {
              withReviewCheckout: async (_root, _opts, fn) => fn(dir),
              dispatch: async (_target, _system, _prompt, options) => {
                agyGivenConversationIds.push(options.conversationId);
                agyRound += 1;
                return {
                  responseText: '', sessionId: `agy-fresh-${agyRound}`,
                  adapterMeta: { status: 'SUCCESS', conversation_id: `agy-fresh-${agyRound}`, usage: null },
                };
              },
            });
            agyOpenedConversationIds.push(opened.threadId);
            return { member_id: request.member_id, verdict: verdict(), conversation_id: opened.threadId, usage: null };
          },
        },
      );
      assert.equal(result.status, 'SHIP');
    }
    assert.deepEqual([...codexKeys].sort(), [
      'execution-reviewer:codex:gpt-a',
      'execution-reviewer:codex:gpt-b',
    ]);
    assert.deepEqual(agyGivenConversationIds, [undefined, undefined, undefined]);
    assert.deepEqual(agyOpenedConversationIds, ['agy-fresh-1', 'agy-fresh-2', 'agy-fresh-3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assertPanelMembersAvailable halts before round 1 when a member is unauthenticated', async () => {
  let dispatches = 0;
  const detectAvailableCLIs = async () => new Map([
    ['codex', { status: 'available' }],
    ['agy', { status: 'unavailable', reason: 'auth probe failed' }],
  ]);
  await assert.rejects(
    () => runPanelRound(
      { repoRoot: '/repo', roster: ROSTER, version: VERSION, claude: verdict(), round: 1, prompt: 'review' },
      {
        detectAvailableCLIs,
        dispatchMember: async () => { dispatches += 1; },
      },
    ),
    (error) => error.code === 'panel-member-unavailable' && error.message.includes(ROSTER[1].member_id),
  );
  assert.equal(dispatches, 0);
});

test('assertPanelMembersAvailable checks every distinct roster CLI', async () => {
  let calls = 0;
  let options;
  await assertPanelMembersAvailable(
    { repoRoot: '/repo', roster: ROSTER },
    { detectAvailableCLIs: async (_root, received) => {
      calls += 1;
      options = received;
      return new Map(ROSTER.map((m) => [m.cli, { status: 'available' }]));
    } },
  );
  assert.equal(calls, 1);
  assert.deepEqual(options, { force: true });
});

test('composeMemberReplay rounds 1-7 stay within 12,000 chars and put unresolved before previous findings', () => {
  for (let round = 1; round <= 7; round += 1) {
    const replay = composeMemberReplay({
      goals: ['preserve behavior', `complete round ${round}`],
      round,
      unresolved: [{ member_id: 'codex:gpt-a', status: 'open', finding: `unresolved-${round}` }],
      previousRound: {
        findings: [{ member_id: 'agy:gemini-b-high', status: 'resolved', finding: `previous-${round}` }],
        resolved_count: round - 1,
      },
    });
    assert.ok(replay.length <= 12_000);
    assert.ok(replay.indexOf(`unresolved-${round}`) < replay.indexOf(`previous-${round}`));
  }
});

test('composeMemberReplay throws panel-replay-overflow instead of truncating', () => {
  assert.throws(
    () => composeMemberReplay({
      goals: 'goal', round: 2,
      unresolved: [{ member_id: 'codex:gpt-a', status: 'open', finding: 'x'.repeat(12_000) }],
      previousRound: { findings: [], resolved_count: 0 },
    }),
    (error) => error.code === 'panel-replay-overflow',
  );
});
