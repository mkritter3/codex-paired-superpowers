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
import { initSidecar, loadSidecar, appendExpertTurn, storeResponse, computeInputsHash } from '../../lib/codex-bridge/sidecar.js';
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

  // Fall back to expert_teammates.turns (canonical write path per sidecar.js
  // `appendExpertTurn`; it's a flat array, not a per-role object).
  if (!recordedTurn && sidecar.expert_teammates && Array.isArray(sidecar.expert_teammates.turns)) {
    for (const t of sidecar.expert_teammates.turns) {
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
