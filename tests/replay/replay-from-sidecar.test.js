// v0.9.0 slice 8 — replay-from-sidecar integration test.
//
// TIER 5 — replay tests. Run by `npm run test:replay`.
// NOT included in the default `npm test` run (uses skip-pattern).
//
// What this tests:
//   1. Record a turn via fake agentDispatch + runTurnWithDeps
//   2. Read the written sidecar entry
//   3. Call replayTurn → assert inputs_hash matches and assembled prompt
//      is byte-identical to what the dispatcher assembled (via a shared
//      helper that can reconstruct the canonical inputs)
//   4. Cross-CLI replay: turn recorded under 'codex' adapter; replay with
//      deps.adapter = 'claude-task' → adapter mismatch warning appears,
//      but inputs_hash still matches (adapter is NOT in the hash domain)
//
// Uses the DI-seam pattern (runTurnWithDeps + injected agentDispatch)
// so no real CLI is required. Same fixture pattern as tests/codex-bridge/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { runTurnWithDeps } from '../../lib/codex-bridge/expert-turn.js';
import { initSidecar, loadSidecar, appendExpertTurn, storeResponse, computeInputsHash, getTeammatesBlock, sidecarPathFor } from '../../lib/codex-bridge/sidecar.js';
import { replayTurn } from '../../lib/codex-bridge/replay.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeTmp(prefix = 'cps-replay-sidecar-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSpec(dir) {
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# Test Spec\n\nA simple spec for replay tests.');
  initSidecar(spec, { feature: 'replay-test', codexSession: 'sess-replay', model: 'gpt-5.5', reasoningEffort: 'high' });
  return spec;
}

function makeIdentityFile(dir, body = 'You are the expert-architecture reviewer.') {
  const promptPath = join(dir, 'expert-architecture.md');
  writeFileSync(promptPath, `---\nversion: v0.9.0-r1\nrole_id: expert-architecture\n---\n${body}`);
  return { path: promptPath, body };
}

// Build a minimal valid Machine Result string so the parser accepts the response.
function validMachineResult(expertId = 'expert-architecture', phase = 'spec-review') {
  return [
    '## Findings',
    'Architecture looks clean.',
    '',
    '## Machine Result',
    '```json',
    JSON.stringify({
      expert_id: expertId,
      phase,
      status: 'SHIP',
      scope: 'architecture',
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    }),
    '```',
  ].join('\n');
}

// ── Test 1: record via runTurnWithDeps + replay → inputs_hash matches ─────────

test('replay-from-sidecar: inputs_hash matches after real runTurnWithDeps dispatch', async () => {
  const dir = makeTmp();
  const specPath = makeSpec(dir);
  const { path: promptPath, body: rolePromptBody } = makeIdentityFile(dir);

  const identity = {
    id: 'expert-architecture',
    role: 'architecture',
    promptPath,
    source: 'builtin',
  };

  const specSnippet = '# Test Spec\n\nA simple spec for replay tests.';
  const responseText = validMachineResult('expert-architecture', 'spec-review');

  // Fake agentDispatch returns a deterministic response.
  let capturedPrompt = null;
  const fakeDispatch = async (prompt) => {
    capturedPrompt = prompt;
    return responseText;
  };

  const result = await runTurnWithDeps(
    {
      identity,
      repoRoot: dir,
      specPath,
      specSnippet,
      phase: 'spec-review',
      sliceId: null,
      adapter: 'cli-harness:codex',     // Explicit adapter audit field so the
                                         // recorded turn carries it and replay
                                         // can verify the round-trip cleanly.
      sidecarParticipantState: '',
      task: 'Review the architecture section.',
      suppressPeerMessages: false,
    },
    {
      agentDispatch: fakeDispatch,
      readUnreadMessages: async () => [],
      markMessagesRead: async () => {},
      // Use a no-op writeBreadcrumb so we don't need a full sidecar bootstrap.
      writeBreadcrumb: async () => {},
    },
  );

  assert.ok(result.ok, `runTurnWithDeps must succeed; got: ${JSON.stringify(result)}`);
  assert.ok(capturedPrompt !== null, 'agentDispatch must have been called');

  // Load the sidecar to find the recorded turn.
  const sidecar = loadSidecar(specPath);
  // Find the expert turn we just recorded. It's in expert_teammates turns or role_sessions.
  // In v0.9.0, expert turns land in role_sessions keyed by role_id.
  let recordedTurn = null;

  // Try role_sessions first (v0.9.0 schema).
  if (sidecar.role_sessions) {
    for (const [, session] of Object.entries(sidecar.role_sessions)) {
      if (Array.isArray(session.turns)) {
        for (const t of session.turns) {
          if ((t.requested_role || t.role_id || t.expert_id) === 'expert-architecture') {
            recordedTurn = t;
            break;
          }
        }
      }
      if (recordedTurn) break;
    }
  }

  // Fall back to the teammates block (canonical write path per sidecar.js
  // `appendReviewerTurn`; it's a flat array, not a per-role object). Dual-read
  // via getTeammatesBlock so both reviewer_teammates (new) and legacy
  // expert_teammates sidecars resolve.
  const teammates = getTeammatesBlock(sidecar);
  if (!recordedTurn && teammates && Array.isArray(teammates.turns)) {
    for (const t of teammates.turns) {
      if ((t.requested_role || t.role_id || t.expert_id) === 'expert-architecture') {
        recordedTurn = t;
        break;
      }
    }
  }

  // If no structured turn was found, try any turn-like entry in the rounds.
  if (!recordedTurn && Array.isArray(sidecar.rounds)) {
    for (const round of sidecar.rounds) {
      if (Array.isArray(round.expert_turns)) {
        for (const t of round.expert_turns) {
          if ((t.requested_role || t.role_id || t.expert_id) === 'expert-architecture') {
            recordedTurn = t;
            break;
          }
        }
      }
      if (recordedTurn) break;
    }
  }

  // Per Codex round-1 slice-8 finding #3: the test MUST fail loudly when
  // runTurnWithDeps did not persist the turn we just dispatched. A synthetic
  // fallback would mask a real sidecar persistence regression — the whole
  // point of this test is to verify the record-→-reload-→-replay path.
  assert.ok(
    recordedTurn,
    'Expected runTurnWithDeps to persist an expert-architecture turn to ' +
      'the sidecar (rounds[].expert_turns[] or role_sessions[role].turns[]). ' +
      'No matching turn found — sidecar persistence is broken or the schema ' +
      'changed. Inspect sidecar at ' + join(dir, '.superpowers-codex-paired') +
      ' to debug.',
  );

  // --- Replay ---
  const rolePromptHash = sha256Hex(`---\nversion: v0.9.0-r1\nrole_id: expert-architecture\n---\n${rolePromptBody}`);

  const replayDeps = {
    loadRolePrompt: () => ({
      content: rolePromptBody,
      hash: rolePromptHash,
      version: 'v0.9.0-r1',
    }),
    readMailboxMessages: (_root, ids) =>
      ids.map((id, i) => ({
        id,
        from: 'orchestrator',
        text: `body-${i}`,
        timestamp: '2026-05-11T00:00:00.000Z',
      })),
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'cli-harness:codex',     // Matches the adapter the turn was recorded under.
  };

  const replayResult = replayTurn(recordedTurn, replayDeps);

  assert.equal(
    replayResult.inputsHashMatches,
    true,
    `inputs_hash must match; warnings: ${JSON.stringify(replayResult.warnings)}`,
  );
  assert.deepEqual(
    replayResult.warnings.filter((w) => !/role_prompt_hash/.test(w) && !/spec_snippet_hash/.test(w)),
    [],
    `No unexpected warnings (hash warnings may appear if sidecar schema differs): ${JSON.stringify(replayResult.warnings)}`,
  );

  // Assembled prompt is non-empty and contains key reconstructed fields.
  assert.ok(
    replayResult.assembledPrompt.includes('expert-architecture'),
    'Assembled prompt must include the role ID',
  );
  assert.ok(
    replayResult.assembledPrompt.includes(specSnippet) ||
      replayResult.assembledPrompt.includes('Test Spec'),
    'Assembled prompt must reference the spec snippet',
  );
  assert.ok(
    replayResult.assembledPrompt.includes(rolePromptBody),
    'Assembled prompt must include the role-prompt body',
  );

  rmSync(dir, { recursive: true, force: true });
});

// ── Test 2: byte-identical assembled prompt ───────────────────────────────────

test('replay-from-sidecar: assembled prompt is byte-identical across two replay calls with same inputs', () => {
  const dir = makeTmp();
  const { body: rolePromptBody } = makeIdentityFile(dir);
  const specSnippet = 'Byte-identical spec snippet.';
  const rolePromptHash = sha256Hex(rolePromptBody);

  const stored = storeResponse(dir, 'resp', {});
  const turn = {
    requested_role: 'expert-architecture',
    role_prompt_version: 'v0.9.0-r1',
    role_prompt_hash: `sha256:${rolePromptHash}`,
    spec_path: '/fake/spec.md',
    spec_snippet_hash: `sha256:${sha256Hex(specSnippet)}`,
    mailbox_message_ids: ['msg-a', 'msg-b'],
    phase: 'spec-review',
    task: 'Check the architecture.',
    adapter: 'codex',
    inputs_hash: computeInputsHash({
      rolePromptHash,
      specSnippetHash: sha256Hex(specSnippet),
      mailboxMessageIds: ['msg-a', 'msg-b'],
      phase: 'spec-review',
      task: 'Check the architecture.',
      roleId: 'expert-architecture',
    }),
    ...stored,
  };

  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: (_root, ids) =>
      ids.map((id, i) => ({
        id,
        from: 'orchestrator',
        text: `body-${i}`,
        timestamp: '2026-05-11T00:00:00.000Z',
      })),
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'codex',
  };

  const r1 = replayTurn(turn, deps);
  const r2 = replayTurn(turn, deps);

  // Byte-identical: exact string equality, not just hash equality.
  assert.strictEqual(
    r1.assembledPrompt,
    r2.assembledPrompt,
    'Two replay calls with identical inputs must produce byte-identical assembled prompts',
  );
  assert.equal(r1.inputsHashMatches, true);
  assert.equal(r2.inputsHashMatches, true);

  rmSync(dir, { recursive: true, force: true });
});

// ── Test 3: cross-CLI replay — adapter mismatch flags warning (not fail) ──────

test('replay-from-sidecar: cross-CLI replay flags adapter mismatch as warning, inputs_hash still matches', () => {
  const dir = makeTmp();
  const { body: rolePromptBody } = makeIdentityFile(dir);
  const specSnippet = 'Cross-CLI spec snippet.';
  const rolePromptHash = sha256Hex(rolePromptBody);

  const stored = storeResponse(dir, 'cross-cli-response', {});
  const turn = {
    requested_role: 'expert-architecture',
    role_prompt_version: 'v0.9.0-r1',
    role_prompt_hash: `sha256:${rolePromptHash}`,
    spec_path: '/fake/spec.md',
    spec_snippet_hash: `sha256:${sha256Hex(specSnippet)}`,
    mailbox_message_ids: [],
    phase: 'spec-review',
    task: 'Cross-CLI replay test.',
    adapter: 'codex', // <── Recorded under codex
    inputs_hash: computeInputsHash({
      rolePromptHash,
      specSnippetHash: sha256Hex(specSnippet),
      mailboxMessageIds: [],
      phase: 'spec-review',
      task: 'Cross-CLI replay test.',
      roleId: 'expert-architecture',
    }),
    ...stored,
  };

  // Replay under 'claude-task' — adapter mismatch.
  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'claude-task', // <── Different adapter
  };

  const result = replayTurn(turn, deps);

  // inputs_hash must STILL match — adapter is not in the hash domain.
  assert.equal(
    result.inputsHashMatches,
    true,
    'inputs_hash must match even when adapter differs (adapter not in hash domain)',
  );

  // Adapter mismatch must appear as a warning (not a failure).
  assert.ok(
    result.warnings.some((w) => w.includes('adapter mismatch')),
    `Expected 'adapter mismatch' warning; got: ${JSON.stringify(result.warnings)}`,
  );

  // Only one mismatch warning (not duplicated).
  const mismatchWarnings = result.warnings.filter((w) => w.includes('adapter mismatch'));
  assert.equal(mismatchWarnings.length, 1, 'adapter mismatch warning must appear exactly once');

  // The warning must name both adapters for debuggability.
  assert.ok(
    mismatchWarnings[0].includes('codex'),
    `Warning must name recorded adapter 'codex'; got: ${mismatchWarnings[0]}`,
  );
  assert.ok(
    mismatchWarnings[0].includes('claude-task'),
    `Warning must name supplied adapter 'claude-task'; got: ${mismatchWarnings[0]}`,
  );

  rmSync(dir, { recursive: true, force: true });
});

// ── Test 4: inputs_hash mismatch detection (tampered turn) ────────────────────

test('replay-from-sidecar: inputs_hash mismatch detected when role prompt is tampered', () => {
  const dir = makeTmp();
  const { body: rolePromptBody } = makeIdentityFile(dir);
  const specSnippet = 'Tamper detection spec snippet.';
  const realHash = sha256Hex(rolePromptBody);

  const stored = storeResponse(dir, 'some-response', {});
  const turn = {
    requested_role: 'expert-architecture',
    role_prompt_version: 'v0.9.0-r1',
    role_prompt_hash: `sha256:${realHash}`,
    spec_path: '/fake/spec.md',
    spec_snippet_hash: `sha256:${sha256Hex(specSnippet)}`,
    mailbox_message_ids: [],
    phase: 'spec-review',
    task: 't',
    adapter: 'codex',
    inputs_hash: computeInputsHash({
      rolePromptHash: realHash,
      specSnippetHash: sha256Hex(specSnippet),
      mailboxMessageIds: [],
      phase: 'spec-review',
      task: 't',
      roleId: 'expert-architecture',
    }),
    ...stored,
  };

  const tamperedHash = sha256Hex('TAMPERED CONTENT');
  const deps = {
    loadRolePrompt: () => ({ content: 'TAMPERED CONTENT', hash: tamperedHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'codex',
  };

  const result = replayTurn(turn, deps);

  assert.equal(result.inputsHashMatches, false, 'inputs_hash must NOT match on tampered content');
  assert.ok(
    result.warnings.some((w) => w.includes('inputs_hash mismatch')),
    `Expected 'inputs_hash mismatch' warning; got: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    result.warnings.some((w) => w.includes('role_prompt_hash mismatch')),
    `Expected 'role_prompt_hash mismatch' warning; got: ${JSON.stringify(result.warnings)}`,
  );

  rmSync(dir, { recursive: true, force: true });
});

// ── Test 5: legacy sidecar (only expert_teammates) → migrate-on-load + replay ─

test('replay-from-sidecar: old expert_teammates-only sidecar reconstructs reviewer turns and emits one migration record', () => {
  const dir = makeTmp();
  const { body: rolePromptBody } = makeIdentityFile(dir);
  const specSnippet = 'Legacy migration spec snippet.';
  const rolePromptHash = sha256Hex(rolePromptBody);

  // Bootstrap a normal sidecar, then rewrite it to the LEGACY shape: a turn
  // stored under expert_teammates with NO reviewer_teammates block. This is
  // exactly what a pre-migration sidecar on disk looks like.
  const specPath = makeSpec(dir);
  const stored = storeResponse(dir, 'legacy-response', {});
  const legacyTurn = {
    requested_role: 'expert-architecture',
    role_prompt_version: 'v0.9.0-r1',
    role_prompt_hash: `sha256:${rolePromptHash}`,
    spec_path: specPath,
    spec_snippet_hash: `sha256:${sha256Hex(specSnippet)}`,
    mailbox_message_ids: [],
    phase: 'spec-review',
    task: 'Legacy replay test.',
    adapter: 'codex',
    inputs_hash: computeInputsHash({
      rolePromptHash,
      specSnippetHash: sha256Hex(specSnippet),
      mailboxMessageIds: [],
      phase: 'spec-review',
      task: 'Legacy replay test.',
      roleId: 'expert-architecture',
    }),
    ...stored,
  };

  const sidecarPath = sidecarPathFor(specPath);
  const raw = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  delete raw.reviewer_teammates;
  raw.expert_teammates = { selected: [], turns: [legacyTurn], fan_out_rationales: [] };
  writeFileSync(sidecarPath, JSON.stringify(raw, null, 2));

  // loadSidecar runs migrateIfNeeded → should populate reviewer_teammates and
  // append exactly one migration record.
  const migrated = loadSidecar(specPath);

  assert.ok(migrated.reviewer_teammates, 'reviewer_teammates must be populated on load');
  assert.deepEqual(
    migrated.reviewer_teammates.turns,
    [legacyTurn],
    'reviewer_teammates.turns must be a deep copy of the legacy expert_teammates.turns',
  );

  const teammateMigrations = (migrated.migrations || []).filter(
    (m) => m.from_schema === 'expert_teammates' && m.to_schema === 'reviewer_teammates',
  );
  assert.equal(
    teammateMigrations.length,
    1,
    `Expected exactly one expert_teammates→reviewer_teammates migration record; got: ${JSON.stringify(migrated.migrations)}`,
  );

  // getTeammatesBlock resolves the migrated block; replay reconstructs the turn.
  const teammates = getTeammatesBlock(migrated);
  const recordedTurn = teammates.turns.find(
    (t) => (t.requested_role || t.role_id || t.expert_id) === 'expert-architecture',
  );
  assert.ok(recordedTurn, 'Reviewer turn must be reachable via getTeammatesBlock after migration');

  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot: dir,
    adapter: 'codex',
  };
  const replayResult = replayTurn(recordedTurn, deps);
  assert.equal(
    replayResult.inputsHashMatches,
    true,
    `Replay of migrated reviewer turn must match inputs_hash; warnings: ${JSON.stringify(replayResult.warnings)}`,
  );

  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// replayImplementerEvents tests (v0.10.0 slice 10)
// ────────────────────────────────────────────────────────────────────────────

import { replayImplementerEvents } from '../../lib/codex-bridge/replay.js';

// ── Sidecar builder helpers ──────────────────────────────────────────────────

function buildMinimalSidecar() {
  return {
    version: 1,
    slice_reviews: {},
  };
}

function addImplementerBlock(sidecar, sliceId, events = []) {
  if (!sidecar.slice_reviews[sliceId]) {
    sidecar.slice_reviews[sliceId] = { phases: {} };
  }
  sidecar.slice_reviews[sliceId].phases.implementer_experts = {
    implementer_run_id: 'run-1',
    base_sha: 'abc123',
    status: 'running',
    members: {},
    events,
  };
  return sidecar;
}

function makeEvent(overrides = {}) {
  return {
    event_seq: 1,
    event_type: 'started',
    implementer_run_id: 'run-1',
    slice_id: 'slice-3',
    member_id: 'member-a',
    runtime_kind: 'claude-cli',
    worktree_id: 'wt-1',
    payload_hash: 'sha256:' + sha256Hex('{}'),
    payload: {},
    ...overrides,
  };
}

// ── happy: 3-implementer slice interleaved → global sort by event_seq ────────

test('replayImplementerEvents: 3-member interleaved events → sorted by event_seq', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 3, member_id: 'member-c' }),
    makeEvent({ event_seq: 1, member_id: 'member-a' }),
    makeEvent({ event_seq: 5, member_id: 'member-b' }),
    makeEvent({ event_seq: 2, member_id: 'member-b', event_type: 'checkpoint' }),
    makeEvent({ event_seq: 4, member_id: 'member-a', event_type: 'completed' }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });

  assert.deepEqual(
    result.events.map(e => e.event_seq),
    [1, 2, 3, 4, 5],
    'Events must be sorted ascending by event_seq'
  );
  assert.deepEqual(result.warnings, []);
});

// ── happy: memberId filter, still sorted globally ───────────────────────────

test('replayImplementerEvents: memberId filter → only that member, still sorted', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a' }),
    makeEvent({ event_seq: 2, member_id: 'member-b' }),
    makeEvent({ event_seq: 3, member_id: 'member-a', event_type: 'completed' }),
    makeEvent({ event_seq: 4, member_id: 'member-b', event_type: 'completed' }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3', memberId: 'member-a' });

  assert.deepEqual(
    result.events.map(e => e.event_seq),
    [1, 3],
    'Only member-a events, sorted'
  );
  assert.deepEqual(
    result.events.map(e => e.member_id),
    ['member-a', 'member-a']
  );
  assert.deepEqual(result.warnings, []);
});

// ── happy: mailbox causal — walks parent + child references ─────────────────

test('replayImplementerEvents: mailboxCausal walks parent and child references', () => {
  const sidecar = buildMinimalSidecar();
  // Event 1: sent message, event 3 is reply (parent_event_seq=1)
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a', mailbox_message_id: 'msg-1' }),
    makeEvent({ event_seq: 2, member_id: 'member-b', event_type: 'checkpoint' }),
    makeEvent({ event_seq: 3, member_id: 'member-b', mailbox_message_id: 'msg-2', parent_event_seq: 1 }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3', mailboxCausal: true });

  assert.ok(Array.isArray(result.causalChains), 'causalChains must be an array');
  // Chain should include events 1 and 3 (connected via parent_event_seq)
  const hasChainWith1and3 = result.causalChains.some(c =>
    c.chain.includes(1) && c.chain.includes(3)
  );
  assert.ok(hasChainWith1and3, 'Causal chain must connect event_seq 1 and 3');
});

// ── mailbox causal cross-member: memberId filter doesn't restrict causal traversal ──

test('replayImplementerEvents: mailboxCausal cross-member traversal ignores memberId', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a', mailbox_message_id: 'msg-x' }),
    makeEvent({ event_seq: 2, member_id: 'member-b', parent_event_seq: 1, mailbox_message_id: 'msg-y' }),
    makeEvent({ event_seq: 3, member_id: 'member-a', event_type: 'completed' }),
  ]);

  // Filter to member-a only, but causal should still pull in member-b's event
  const result = replayImplementerEvents(sidecar, {
    sliceId: 'slice-3',
    memberId: 'member-a',
    mailboxCausal: true,
  });

  assert.ok(Array.isArray(result.causalChains), 'causalChains must be present');
  // Chain root includes events from both members
  const chain = result.causalChains.find(c => c.chain.includes(1));
  assert.ok(chain, 'Chain starting at event 1 must exist');
  assert.ok(
    chain.chain.includes(2),
    'Cross-member causal traversal must include member-b event_seq=2'
  );
});

// ── edge.zero-null-empty: missing/non-object sidecar → throw ─────────────────

for (const [label, value] of [
  ['null', null],
  ['undefined', undefined],
  ['string', 'not-an-object'],
  ['array', []],
  ['number', 42],
]) {
  test(`replayImplementerEvents: sidecar=${label} → throws`, () => {
    assert.throws(
      () => replayImplementerEvents(value, { sliceId: 'slice-3' }),
      /sidecar must be a non-null object/,
      `Should throw for sidecar=${label}`
    );
  });
}

// ── edge.zero-null-empty: missing/empty sliceId → throw ─────────────────────

for (const [label, value] of [
  ['missing', {}],
  ['null', { sliceId: null }],
  ['empty-string', { sliceId: '' }],
  ['number', { sliceId: 42 }],
]) {
  test(`replayImplementerEvents: sliceId=${label} → throws`, () => {
    const sidecar = buildMinimalSidecar();
    assert.throws(
      () => replayImplementerEvents(sidecar, value),
      /sliceId must be a non-empty string/,
      `Should throw for sliceId=${label}`
    );
  });
}

// ── edge.zero-null-empty: missing phases.implementer_experts → empty + warning ──

test('replayImplementerEvents: missing implementer_experts block → empty result with warning', () => {
  const sidecar = buildMinimalSidecar();
  sidecar.slice_reviews['slice-3'] = { phases: {} }; // no implementer_experts

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });

  assert.deepEqual(result.events, []);
  assert.ok(
    result.warnings.some(w => w.includes('no implementer_experts block')),
    `Expected warning about missing block; got: ${JSON.stringify(result.warnings)}`
  );
});

// ── edge.boundary: parent_event_seq pointing outside slice → chain stops ──────

test('replayImplementerEvents: parent_event_seq pointing outside slice → chain stops at missing seq', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a', mailbox_message_id: 'msg-1', parent_event_seq: 999 }),
  ]);

  // Should not throw; chain should just stop at event_seq=999 (missing from seqMap)
  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3', mailboxCausal: true });

  assert.ok(Array.isArray(result.events), 'events must be an array');
  assert.equal(result.events.length, 1);
  assert.ok(Array.isArray(result.causalChains), 'causalChains must be present');
  // Chain should include event_seq=1 (parent 999 doesn't exist, traversal stops)
  const chain = result.causalChains.find(c => c.chain.includes(1));
  assert.ok(chain, 'Chain containing event 1 must exist');
  assert.ok(!chain.chain.includes(999), 'Chain must not include missing event 999');
});

// ── edge.boundary: duplicate mailbox_message_id → warning + dedupe ───────────

test('replayImplementerEvents: duplicate mailbox_message_id → warning + dedupe', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a', mailbox_message_id: 'msg-dup' }),
    makeEvent({ event_seq: 2, member_id: 'member-b', mailbox_message_id: 'msg-dup' }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3', mailboxCausal: true });

  assert.ok(
    result.warnings.some(w => w.includes('duplicate mailbox_message_id')),
    `Expected duplicate warning; got: ${JSON.stringify(result.warnings)}`
  );
});

// ── edge.boundary: cycle in parent_event_seq → visited-set prevents loop ─────

test('replayImplementerEvents: cycle in parent_event_seq → cycle warning + no infinite loop', () => {
  const sidecar = buildMinimalSidecar();
  // Create a cycle: event 1 → parent 2, event 2 → parent 1
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1, member_id: 'member-a', mailbox_message_id: 'msg-1', parent_event_seq: 2 }),
    makeEvent({ event_seq: 2, member_id: 'member-b', mailbox_message_id: 'msg-2', parent_event_seq: 1 }),
  ]);

  // Must complete without hanging
  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3', mailboxCausal: true });

  // Should have a cycle warning
  assert.ok(
    result.warnings.some(w => w.includes('cycle detected')),
    `Expected cycle warning; got: ${JSON.stringify(result.warnings)}`
  );
  assert.ok(Array.isArray(result.events), 'events must be an array');
});

// ── fail.malformed-input: non-numeric event_seq → skip with location warning ──

test('replayImplementerEvents: non-numeric event_seq → skipped with warning', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 'not-a-number', event_type: 'started' }),
    makeEvent({ event_seq: 1, event_type: 'completed' }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });

  assert.equal(result.events.length, 1, 'Only the valid event should be returned');
  assert.equal(result.events[0].event_seq, 1);
  assert.ok(
    result.warnings.some(w => w.includes('invalid event_seq')),
    `Expected event_seq warning; got: ${JSON.stringify(result.warnings)}`
  );
});

// ── fail.malformed-input: missing event_type → skip with warning ──────────────

test('replayImplementerEvents: missing event_type → skipped with warning', () => {
  const sidecar = buildMinimalSidecar();
  const rawEvents = [
    makeEvent({ event_seq: 1 }),
    makeEvent({ event_seq: 3, event_type: 'completed' }),
  ];
  // Add event 2 without event_type
  const ev2 = { event_seq: 2, implementer_run_id: 'run-1', slice_id: 'slice-3', member_id: 'm', runtime_kind: 'claude-cli', worktree_id: 'wt', payload_hash: 'sha256:' + sha256Hex('{}'), payload: {} };
  addImplementerBlock(sidecar, 'slice-3', [rawEvents[0], ev2, rawEvents[1]]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });

  assert.equal(result.events.length, 2, 'Events 1 and 3 should be returned (2 skipped)');
  assert.ok(
    result.warnings.some(w => w.includes('event_type')),
    `Expected event_type warning; got: ${JSON.stringify(result.warnings)}`
  );
});

// ── fail.malformed-input: non-integer parent_event_seq → skip with warning ───

test('replayImplementerEvents: non-integer parent_event_seq → skipped with warning', () => {
  const sidecar = buildMinimalSidecar();
  addImplementerBlock(sidecar, 'slice-3', [
    makeEvent({ event_seq: 1 }),
    makeEvent({ event_seq: 2, parent_event_seq: 'not-an-int' }),
    makeEvent({ event_seq: 3, event_type: 'completed' }),
  ]);

  const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });

  assert.equal(result.events.length, 2, 'Event with invalid parent_event_seq should be skipped');
  assert.ok(
    result.warnings.some(w => w.includes('invalid parent_event_seq')),
    `Expected parent_event_seq warning; got: ${JSON.stringify(result.warnings)}`
  );
});

// ── stress.scale: 1000 events → deterministic order + <500ms ─────────────────

test('replayImplementerEvents: 1000 events → deterministic order in <500ms', () => {
  const sidecar = buildMinimalSidecar();

  // Build 1000 events with shuffled event_seqs
  const events = [];
  for (let i = 1; i <= 1000; i++) {
    events.push(makeEvent({
      event_seq: i,
      member_id: `member-${(i % 3) + 1}`,
      event_type: i % 10 === 0 ? 'checkpoint' : 'started',
    }));
  }
  // Shuffle
  for (let i = events.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [events[i], events[j]] = [events[j], events[i]];
  }

  addImplementerBlock(sidecar, 'slice-3', events);

  const runs = [];
  for (let run = 0; run < 3; run++) {
    const start = Date.now();
    const result = replayImplementerEvents(sidecar, { sliceId: 'slice-3' });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `Run ${run} took ${elapsed}ms, must be <500ms`);
    runs.push(result.events.map(e => e.event_seq));
  }

  // Deterministic: all 3 runs produce identical order
  assert.deepEqual(runs[0], runs[1], '3 runs must produce identical order (run 0 vs 1)');
  assert.deepEqual(runs[1], runs[2], '3 runs must produce identical order (run 1 vs 2)');

  // Verify sorted ascending
  const sorted = [...runs[0]].sort((a, b) => a - b);
  assert.deepEqual(runs[0], sorted, 'Events must be sorted ascending by event_seq');
  assert.equal(runs[0].length, 1000);
});
