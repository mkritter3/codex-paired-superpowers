// v0.9.1 hardening — replay against a legacy (v0.8.x) sidecar.
//
// A real-world failure: an operator runs `replayTurn` against a sidecar that
// predates v0.9.0's resolution-audit + inputs_hash fields. The replay module
// must:
//   1. Load the sidecar via the migration path (no throws on missing
//      v0.9.0 fields).
//   2. Preserve legacy fields per the three-release back-compat rule.
//   3. Reconstruct what it CAN reconstruct from the remaining fields.
//   4. Emit a CLEAR warning that the turn is "not fully replayable"
//      when audit fields the replay needs are missing — NOT silently
//      return inputsHashMatches=false with no explanation.
//
// Codex reframed this gap (round 1): "Replay should report 'not replayable
// / missing audit fields' clearly. Do not assert full reconstruction."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { replayTurn } from '../../lib/codex-bridge/replay.js';
import { loadSidecar, initSidecar } from '../../lib/codex-bridge/sidecar.js';

function sha256Hex(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-replay-legacy-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# legacy spec\nfor v0.8.x replay back-compat');
  return { dir, spec };
}

// Build a turn record shaped like v0.8.x: no inputs_hash, no response_hash,
// no spec_snippet_hash, no role_prompt_hash, no resolution-audit fields.
// Only the fields v0.8.x actually persisted.
function legacyTurn() {
  return {
    expert_id: 'expert-architecture',
    phase: 'spec-review',
    slice_id: null,
    mailbox_message_ids_injected: [],
    started_at: '2026-04-01T10:00:00.000Z',
    completed_at: '2026-04-01T10:00:30.000Z',
    result_summary: 'SHIP',
    verdict: 'SHIP',
    failure_reason: null,
    // v0.8.x DID record adapter, but as a string (no cli-harness prefix).
    adapter: 'claude-task',
    // v0.8.x recorded expert_id but no requested_role.
  };
}

test('replay: legacy v0.8.x turn missing audit fields does not throw; emits clear warnings', () => {
  const { dir, spec: _spec } = makeSpec();
  try {
    const turn = legacyTurn();
    const replayDeps = {
      loadRolePrompt: () => ({
        content: 'You are expert-architecture.',
        hash: sha256Hex('You are expert-architecture.'),
        version: 'v0.8.x-legacy',
      }),
      readMailboxMessages: () => [],
      readSpecSnippet: () => '# legacy spec\nfor v0.8.x replay back-compat',
      repoRoot: dir,
      adapter: 'claude-task',
    };

    const result = replayTurn(turn, replayDeps);

    // 1. Replay returned a result (did NOT throw on missing audit fields).
    assert.ok(result, 'replayTurn must return a result object on legacy input');
    assert.ok(typeof result.assembledPrompt === 'string' && result.assembledPrompt.length > 0,
      'assembled prompt should still be reconstructable from the role + spec');

    // 2. inputs_hash is recorded as absent → match is false (cannot compare).
    assert.equal(result.inputsHashMatches, false,
      'legacy turn has no inputs_hash; match must be false');

    // 3. response_hash is absent → no responseHashMatches.
    assert.equal(result.responseHashMatches, false,
      'legacy turn has no response_hash; match must be false');

    // 4. Warnings array exists. We assert the replay surface clearly tells
    //    the caller WHY they can't verify the hashes — either via explicit
    //    "missing inputs_hash" / "not replayable" warnings, OR via a
    //    documented null-return that's actionable.
    //
    //    Currently, replay.js only warns on mismatches, not on absent
    //    fields. This test pins the CONTRACT: a legacy turn must produce
    //    explicit "missing audit field" warnings so operators know it's
    //    not a silent verification pass.
    assert.ok(Array.isArray(result.warnings),
      'warnings must always be an array');

    const warningsText = result.warnings.join(' | ');
    const hasClearNotReplayableSignal =
      /missing|not.replayable|legacy|no.inputs.hash|no.response.hash/i.test(warningsText);
    assert.ok(
      hasClearNotReplayableSignal,
      `legacy turn must produce a clear "not fully replayable / missing audit field" warning. ` +
        `Got warnings: ${JSON.stringify(result.warnings)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replay: legacy turn with role prompt drift still surfaces the drift even when inputs_hash absent', () => {
  // If the operator loaded a legacy turn AND the role-prompt content drifted
  // since the original dispatch, the role_prompt_hash warning should still
  // fire (when present on the legacy turn). This tests that absent-fields
  // warnings don't crowd out present-but-mismatched warnings.
  const { dir, spec: _spec } = makeSpec();
  try {
    const turn = {
      ...legacyTurn(),
      // Legacy turn DID have role_prompt_hash from mid-v0.8.x; we test that
      // the drift detection still works for partially-populated legacy turns.
      role_prompt_hash: `sha256:${sha256Hex('OLD-PROMPT-BODY-DIFFERENT')}`,
    };
    const result = replayTurn(turn, {
      loadRolePrompt: () => ({
        content: 'CURRENT-PROMPT-BODY',
        hash: sha256Hex('CURRENT-PROMPT-BODY'),
        version: 'v0.8.x-legacy',
      }),
      readMailboxMessages: () => [],
      readSpecSnippet: () => '# legacy',
      repoRoot: dir,
      adapter: 'claude-task',
    });

    const warningsText = result.warnings.join(' | ');
    assert.match(
      warningsText,
      /role_prompt_hash mismatch/,
      `role-prompt drift warning must fire even when inputs_hash is absent. ` +
        `Got: ${JSON.stringify(result.warnings)}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
