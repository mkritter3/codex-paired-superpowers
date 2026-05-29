// Slice 3 — hybrid contract publication/consumption + UI shim protocol.
// Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  initSidecar,
  startImplementerRun,
  readImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';
import { readMailbox } from '../../../lib/codex-bridge/mailbox.js';
import {
  publishContract,
  readLatestContract,
  recordContractConsumed,
  renderContractShim,
  validateShimClaim,
  readContractState,
  parseContractText,
  computeBodyHash,
  HybridContractError,
} from '../../../lib/codex-bridge/hybrid/contracts.js';

const BACKEND_MEMBER = 'hybrid-backend@codex:gpt-5.5#0';
const UI_MEMBER = 'hybrid-ui@claude:sonnet#0';
const UI_SHIM = 'app/settings/__hybrid_contracts__/account-preferences.ts';
const SLICE = 'slice-4';

function sha256Hex(s) {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-contracts-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'hybrid', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec, repoRoot: dir };
}

async function startRun(spec) {
  const { implementer_run_id } = await startImplementerRun(spec, SLICE, {
    base_sha: 'base123',
    members: {
      [BACKEND_MEMBER]: {
        adapter: 'codex-background-bash',
        model: 'gpt-5.5',
        required: true,
        worktree_id: 'wt-slice-4-backend',
        branch: 'hybrid/slice-4/backend',
        claimed_files: ['lib/server/contracts/account-preferences.ts'],
      },
      [UI_MEMBER]: {
        adapter: 'claude-subagent',
        model: 'sonnet',
        required: true,
        worktree_id: 'wt-slice-4-ui',
        branch: 'hybrid/slice-4/ui',
        claimed_files: ['app/settings/SettingsScreen.tsx', UI_SHIM],
      },
    },
  });
  return implementer_run_id;
}

function contractText({ version = 1, previousBodyHash = null } = {}) {
  const body = {
    schema: 'hybrid-contract/v1',
    slice_id: SLICE,
    contract_version: version,
    routes: [
      { method: 'GET', path: '/api/account/preferences', response_type: 'AccountPreferencesResponse' },
    ],
    types: [
      { name: 'AccountPreferencesResponse', fields: { timezone: 'string', emailDigest: 'boolean' } },
    ],
    source_files: ['lib/server/contracts/account-preferences.ts'],
    ui_shim_file: UI_SHIM,
    notes: 'server defaults for missing fields',
  };
  if (previousBodyHash) body.previous_body_hash = previousBodyHash;
  return 'Contract published:\n\n```json\n' + JSON.stringify(body, null, 2) + '\n```\n';
}

// ── case 1: publishContract → mailbox message + sidecar checkpoint ──────────

test('publishContract writes kind:contract mailbox message + contract_published checkpoint with matching body_hash', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const text = contractText({ version: 1 });
  const expectedHash = sha256Hex(text);

  const res = await publishContract({
    repoRoot, specPath: spec, sliceId: SLICE,
    implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text,
  });
  assert.equal(res.bodyHash, expectedHash);
  assert.equal(res.contractVersion, 1);

  // Mailbox: written to the slice mailbox, kind contract, hash + metadata persisted.
  const inbox = await readMailbox(repoRoot, SLICE);
  assert.equal(inbox.length, 1);
  const m = inbox[0];
  assert.equal(m.kind, 'contract');
  assert.equal(m.body_hash, expectedHash);
  assert.equal(m.slice_id, SLICE);
  assert.equal(m.implementer_run_id, runId);

  // Sidecar checkpoint event.
  const run = readImplementerRun(spec, SLICE);
  const published = run.events.filter(e => e.event_type === 'checkpoint' && e.payload.kind === 'contract_published');
  assert.equal(published.length, 1);
  assert.equal(published[0].payload.body_hash, expectedHash);
  assert.equal(published[0].payload.contract_version, 1);
  assert.equal(published[0].member_id, BACKEND_MEMBER);
  rmSync(dir, { recursive: true, force: true });
});

// ── case 2: readLatestContract returns the highest version ──────────────────

test('readLatestContract returns the highest contract_version message + hash', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const t1 = contractText({ version: 1 });
  const r1 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: t1 });
  const t2 = contractText({ version: 2, previousBodyHash: r1.bodyHash });
  const r2 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: t2 });

  const latest = await readLatestContract({ repoRoot, sliceId: SLICE });
  assert.equal(latest.contractVersion, 2);
  assert.equal(latest.bodyHash, r2.bodyHash);
  assert.equal(latest.contract.contract_version, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('readLatestContract returns null when no contract published', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  await startRun(spec);
  const latest = await readLatestContract({ repoRoot, sliceId: SLICE });
  assert.equal(latest, null);
  rmSync(dir, { recursive: true, force: true });
});

// ── case 3: recordContractConsumed appends checkpoint + updates state ───────

test('recordContractConsumed appends contract_consumed checkpoint and updates derived state', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const text = contractText({ version: 1 });
  const { bodyHash } = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text });

  await recordContractConsumed({ specPath: spec, sliceId: SLICE, memberId: UI_MEMBER, bodyHash, shimPath: UI_SHIM });

  const run = readImplementerRun(spec, SLICE);
  const consumed = run.events.filter(e => e.event_type === 'checkpoint' && e.payload.kind === 'contract_consumed');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].payload.body_hash, bodyHash);
  assert.equal(consumed[0].member_id, UI_MEMBER);

  const state = readContractState({ specPath: spec, sliceId: SLICE });
  assert.equal(state.latestPublishedHash, bodyHash);
  assert.equal(state.consumedHash, bodyHash);
  assert.equal(state.syncState, 'consumed');
  rmSync(dir, { recursive: true, force: true });
});

// ── case 4: contract-change detection (resync, NOT terminal) ────────────────

test('publishing v2 after consuming v1 surfaces hybrid-contract-changed resync state (not terminal)', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const t1 = contractText({ version: 1 });
  const r1 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: t1 });
  await recordContractConsumed({ specPath: spec, sliceId: SLICE, memberId: UI_MEMBER, bodyHash: r1.bodyHash, shimPath: UI_SHIM });

  const t2 = contractText({ version: 2, previousBodyHash: r1.bodyHash });
  const r2 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: t2 });

  const changed = readContractState({ specPath: spec, sliceId: SLICE });
  assert.equal(changed.syncState, 'hybrid-contract-changed');
  assert.equal(changed.latestPublishedHash, r2.bodyHash);
  assert.equal(changed.consumedHash, r1.bodyHash);

  // Consuming v2 clears the resync state.
  await recordContractConsumed({ specPath: spec, sliceId: SLICE, memberId: UI_MEMBER, bodyHash: r2.bodyHash, shimPath: UI_SHIM });
  const resolved = readContractState({ specPath: spec, sliceId: SLICE });
  assert.equal(resolved.syncState, 'consumed');
  assert.equal(resolved.consumedHash, r2.bodyHash);
  rmSync(dir, { recursive: true, force: true });
});

// ── case 5: shim claim invariants ───────────────────────────────────────────

test('validateShimClaim rejects a ui_shim_file outside claude-ui.files with hybrid-owner-files-unclaimed', () => {
  assert.throws(
    () => validateShimClaim({ uiShimFile: 'app/elsewhere/shim.ts', claudeUiFiles: ['app/settings/SettingsScreen.tsx', UI_SHIM] }),
    err => err instanceof HybridContractError && err.code === 'hybrid-owner-files-unclaimed'
  );
  // In-claim shim passes.
  assert.doesNotThrow(() => validateShimClaim({ uiShimFile: UI_SHIM, claudeUiFiles: [UI_SHIM] }));
});

test('renderContractShim header records the consumed body_hash', () => {
  const text = contractText({ version: 1 });
  const bodyHash = computeBodyHash(text);
  const contract = parseContractText(text);
  const shim = renderContractShim({ contract, bodyHash });
  assert.match(shim, new RegExp(bodyHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ── case 6: shim render happy path + round-trip ─────────────────────────────

test('renderContractShim produces TS structural types + route constants from the contract', () => {
  const text = contractText({ version: 1 });
  const bodyHash = computeBodyHash(text);
  const contract = parseContractText(text);
  const shim = renderContractShim({ contract, bodyHash });
  // Structural type export from types[].
  assert.match(shim, /export type AccountPreferencesResponse = \{/);
  assert.match(shim, /timezone: string/);
  assert.match(shim, /emailDigest: boolean/);
  // Route constant/helper from routes[].
  assert.match(shim, /\/api\/account\/preferences/);
  // Round-trip: the hash recorded in the shim header equals the contract's body_hash.
  const recorded = shim.match(/sha256:[0-9a-f]{64}/);
  assert.ok(recorded, 'shim header records a sha256 hash');
  assert.equal(recorded[0], bodyHash);
});

// ── case 7: integrity (TDD-panel addition) ──────────────────────────────────

test('recordContractConsumed rejects an unknown body_hash', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const text = contractText({ version: 1 });
  await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text });
  await assert.rejects(
    () => recordContractConsumed({ specPath: spec, sliceId: SLICE, memberId: UI_MEMBER, bodyHash: sha256Hex('never-published'), shimPath: UI_SHIM }),
    err => err instanceof HybridContractError
  );
  rmSync(dir, { recursive: true, force: true });
});

test('recordContractConsumed rejects a non-latest body_hash (must consume the latest)', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const r1 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 1 }) });
  await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 2, previousBodyHash: r1.bodyHash }) });
  // Consuming the old v1 hash is rejected — UI must consume the latest (v2).
  await assert.rejects(
    () => recordContractConsumed({ specPath: spec, sliceId: SLICE, memberId: UI_MEMBER, bodyHash: r1.bodyHash, shimPath: UI_SHIM }),
    err => err instanceof HybridContractError
  );
  rmSync(dir, { recursive: true, force: true });
});

test('publishContract rejects a non-monotonic contract_version and writes nothing', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  const r1 = await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 1 }) });
  // Re-publishing version 1 (non-monotonic) must be rejected.
  await assert.rejects(
    () => publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 1 }) }),
    err => err instanceof HybridContractError
  );
  // State unchanged: still v1, one mailbox message, one published checkpoint.
  const state = readContractState({ specPath: spec, sliceId: SLICE });
  assert.equal(state.latestPublishedVersion, 1);
  assert.equal(state.latestPublishedHash, r1.bodyHash);
  const inbox = await readMailbox(repoRoot, SLICE);
  assert.equal(inbox.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('publishContract rejects version 2 with a wrong previous_body_hash and writes nothing', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  await publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 1 }) });
  await assert.rejects(
    () => publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 2, previousBodyHash: sha256Hex('wrong-prev') }) }),
    err => err instanceof HybridContractError
  );
  const state = readContractState({ specPath: spec, sliceId: SLICE });
  assert.equal(state.latestPublishedVersion, 1);
  const inbox = await readMailbox(repoRoot, SLICE);
  assert.equal(inbox.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('first contract must be version 1', async () => {
  const { dir, spec, repoRoot } = makeFixture();
  const runId = await startRun(spec);
  await assert.rejects(
    () => publishContract({ repoRoot, specPath: spec, sliceId: SLICE, implementerRunId: runId, fromMemberId: BACKEND_MEMBER, text: contractText({ version: 2 }) }),
    err => err instanceof HybridContractError
  );
  rmSync(dir, { recursive: true, force: true });
});
