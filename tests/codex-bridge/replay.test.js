// v0.9.0 slice 5b — tests for lib/codex-bridge/replay.js.
//
// `replayTurn(turn, deps)` reconstructs the assembled prompt from recorded
// sidecar inputs and verifies that recorded hashes match recomputed values.
// Audit-only — does NOT re-dispatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { replayTurn } from '../../lib/codex-bridge/replay.js';
import { storeResponse, computeInputsHash } from '../../lib/codex-bridge/sidecar.js';

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function makeTmp(prefix = 'cps-replay-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeRecordedTurn({ rolePromptHash, rolePromptVersion, specSnippet, mailboxIds, phase, task, roleId, responseText, repoRoot, useOverflow = false }) {
  const turn = {
    requested_role: roleId,
    role_prompt_version: rolePromptVersion,
    role_prompt_hash: `sha256:${rolePromptHash}`,
    spec_path: '/abs/spec.md',
    spec_snippet_hash: `sha256:${sha256Hex(specSnippet)}`,
    mailbox_message_ids: mailboxIds,
    phase,
    task,
    adapter: 'codex',
  };
  turn.inputs_hash = computeInputsHash({
    rolePromptHash,
    specSnippetHash: sha256Hex(specSnippet),
    mailboxMessageIds: mailboxIds,
    phase,
    task,
    roleId,
  });
  // Storage path
  const stored = storeResponse(repoRoot, responseText, useOverflow ? { maxInlineBytes: 1 } : {});
  Object.assign(turn, stored);
  return turn;
}

// ── replayTurn reconstructs assembled prompt + asserts inputs_hash match ─────

test('replayTurn: reconstructs assembled prompt + inputs_hash matches recomputed value', () => {
  const repoRoot = makeTmp();
  const specSnippet = 'A very small spec snippet for replay test.';
  const rolePromptBody = 'You are the expert-architecture reviewer.';
  const rolePromptHash = sha256Hex(`---\nversion: v0.9.0-r1\nrole_id: expert-architecture\n---\n${rolePromptBody}`);
  const mailboxIds = ['msg-1', 'msg-2'];
  const turn = makeRecordedTurn({
    rolePromptHash,
    rolePromptVersion: 'v0.9.0-r1',
    specSnippet,
    mailboxIds,
    phase: 'spec-review',
    task: 'review the architecture',
    roleId: 'expert-architecture',
    responseText: 'OK, SHIP',
    repoRoot,
  });

  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: (_root, ids) => ids.map((id, i) => ({ id, from: 'orchestrator', text: `body-${i}`, timestamp: '2026-05-11T00:00:00.000Z' })),
    readSpecSnippet: () => specSnippet,
    repoRoot,
    adapter: 'codex',
  };

  const result = replayTurn(turn, deps);
  assert.equal(result.inputsHashMatches, true, 'inputs_hash should match');
  assert.equal(result.responseHashMatches, true, 'response_hash should match');
  assert.deepEqual(result.warnings, []);
  // Reconstructed prompt must contain the role-prompt body + spec snippet + mailbox text.
  assert.ok(result.assembledPrompt.includes(rolePromptBody));
  assert.ok(result.assembledPrompt.includes(specSnippet));
  assert.ok(result.assembledPrompt.includes('msg-1'));
  assert.ok(result.assembledPrompt.includes('msg-2'));
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── inputs_hash mismatch detection ────────────────────────────────────────────

test('replayTurn: detects inputs_hash mismatch when DI-supplied loadRolePrompt yields a different prompt hash', () => {
  const repoRoot = makeTmp();
  const specSnippet = 'snip';
  const realRolePromptHash = sha256Hex('real prompt body');
  const turn = makeRecordedTurn({
    rolePromptHash: realRolePromptHash,
    rolePromptVersion: 'v0.9.0-r1',
    specSnippet,
    mailboxIds: [],
    phase: 'spec-review',
    task: 't',
    roleId: 'expert-architecture',
    responseText: 'r',
    repoRoot,
  });
  // Deliberately return a DIFFERENT role-prompt content + hash than was recorded.
  const wrongHash = sha256Hex('TAMPERED content');
  const deps = {
    loadRolePrompt: () => ({ content: 'TAMPERED content', hash: wrongHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot,
  };
  const result = replayTurn(turn, deps);
  assert.equal(result.inputsHashMatches, false, 'inputs_hash MUST NOT match');
  assert.ok(result.warnings.some((w) => w.includes('role_prompt_hash mismatch')), 'expected role_prompt_hash mismatch warning');
  assert.ok(result.warnings.some((w) => w.includes('inputs_hash mismatch')), 'expected inputs_hash mismatch warning');
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── overflow response path ────────────────────────────────────────────────────

test('replayTurn: handles response_ref (overflow) by reading from disk + verifying response_hash', () => {
  const repoRoot = makeTmp();
  const specSnippet = 'snip';
  const rolePromptBody = 'role body';
  const rolePromptHash = sha256Hex(rolePromptBody);
  // Force overflow by setting maxInlineBytes very low.
  const big = 'X'.repeat(100);
  const turn = makeRecordedTurn({
    rolePromptHash,
    rolePromptVersion: 'v0.9.0-r1',
    specSnippet,
    mailboxIds: [],
    phase: 'spec-review',
    task: 't',
    roleId: 'expert-architecture',
    responseText: big,
    repoRoot,
    useOverflow: true,
  });
  assert.ok(turn.response_ref, 'turn must use response_ref (overflow)');
  assert.equal(turn.response_text_inline, undefined);

  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot,
  };
  const result = replayTurn(turn, deps);
  assert.equal(result.responseHashMatches, true, 'overflow response hash should match');
  assert.equal(result.warnings.length, 0);
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── adapter mismatch warning ──────────────────────────────────────────────────

test('replayTurn: adapter mismatch surfaces as a warning (cross-CLI replay)', () => {
  const repoRoot = makeTmp();
  const specSnippet = 'snip';
  const rolePromptBody = 'rb';
  const rolePromptHash = sha256Hex(rolePromptBody);
  const turn = makeRecordedTurn({
    rolePromptHash,
    rolePromptVersion: 'v0.9.0-r1',
    specSnippet,
    mailboxIds: [],
    phase: 'spec-review',
    task: 't',
    roleId: 'expert-architecture',
    responseText: 'r',
    repoRoot,
  });
  // turn.adapter is 'codex' (set by makeRecordedTurn). Supply 'claude-task'.
  const deps = {
    loadRolePrompt: () => ({ content: rolePromptBody, hash: rolePromptHash, version: 'v0.9.0-r1' }),
    readMailboxMessages: () => [],
    readSpecSnippet: () => specSnippet,
    repoRoot,
    adapter: 'claude-task',
  };
  const result = replayTurn(turn, deps);
  assert.equal(result.inputsHashMatches, true, 'inputs still match (adapter is not in the inputs_hash domain)');
  assert.ok(result.warnings.some((w) => w.includes('adapter mismatch')), 'adapter mismatch warning expected');
  rmSync(repoRoot, { recursive: true, force: true });
});
