// Slice 5 — sidecar hybrid owner state.
// Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §6 (members carry
// `owner`) + §9 (the `hybrid` status block under the slice phase).
//
// The implementer_experts event stream stays the audit trail; the hybrid status
// block is an additive convenience mirror under phases.hybrid. Owner/runtime_kind/
// overlap_rationale are optional, additive member fields — legacy members without
// them remain valid and byte-identical (unknown fields ignored by legacy readers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  initSidecar,
  loadSidecar,
  startImplementerRun,
  appendImplementerEventLocked,
  readImplementerRun,
  setHybridStatus,
  getHybridStatus,
} from '../../lib/codex-bridge/sidecar.js';

function payloadHash(payload) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-sidecar-hybrid-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'hybrid', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const UI_MEMBER = 'hybrid-ui@claude:sonnet#0';
const BACKEND_MEMBER = 'hybrid-backend@codex:gpt-5.5#0';
const UI_SHIM = 'app/settings/__hybrid_contracts__/account-preferences.ts';

function hybridMembers() {
  return {
    [UI_MEMBER]: {
      adapter: 'claude-ui',
      model: 'sonnet',
      required: true,
      worktree_id: 'wt-slice-4-ui',
      branch: 'hybrid/slice-4/ui',
      claimed_files: ['app/settings/SettingsScreen.tsx', UI_SHIM],
      owner: 'claude-ui',
      runtime_kind: 'claude-subagent',
    },
    [BACKEND_MEMBER]: {
      adapter: 'codex-background-bash',
      model: 'gpt-5.5',
      required: true,
      worktree_id: 'wt-slice-4-backend',
      branch: 'hybrid/slice-4/backend',
      claimed_files: ['lib/server/contracts/account-preferences.ts'],
      owner: 'codex-backend',
      runtime_kind: 'codex-background-bash',
    },
  };
}

// ── case 1: members carry owner + runtime_kind, persisted + round-tripped ────

test('startImplementerRun persists owner + runtime_kind on members and round-trips', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members: hybridMembers() });
    const run = readImplementerRun(spec, 'slice-4');
    assert.equal(run.members[UI_MEMBER].owner, 'claude-ui');
    assert.equal(run.members[UI_MEMBER].runtime_kind, 'claude-subagent');
    assert.equal(run.members[BACKEND_MEMBER].owner, 'codex-backend');
    assert.equal(run.members[BACKEND_MEMBER].runtime_kind, 'codex-background-bash');
    // Existing fields untouched.
    assert.equal(run.members[UI_MEMBER].adapter, 'claude-ui');
    assert.deepEqual(run.members[BACKEND_MEMBER].claimed_files, ['lib/server/contracts/account-preferences.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1b: legacy members without owner stay valid + omit the keys ─────────

test('legacy members without owner/runtime_kind are valid and omit the optional keys', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startImplementerRun(spec, 'slice-3', {
      base_sha: 'base123',
      members: {
        'expert-implementer@claude:sonnet#0': {
          adapter: 'claude-cli',
          model: 'sonnet',
          required: true,
          worktree_id: 'wt-slice-3-claude-0',
          branch: 'implementer/slice-3/claude-0',
          claimed_files: ['lib/a.js'],
        },
      },
    });
    const member = readImplementerRun(spec, 'slice-3').members['expert-implementer@claude:sonnet#0'];
    assert.equal('owner' in member, false, 'legacy member must not carry an owner key');
    assert.equal('runtime_kind' in member, false, 'legacy member must not carry a runtime_kind key');
    assert.equal('overlap_rationale' in member, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 1c: events validate against runtime_kind, not the logical adapter ───
//
// Codex slice-5 review finding: appendImplementerEventLocked must accept the
// member's ACTUAL runtime kind. A hybrid UI member has adapter "claude-ui"
// (logical) but runtime_kind "claude-subagent" (actual); events carry the
// actual kind, so validating against adapter would reject the whole audit trail.

test('appendImplementerEventLocked accepts a hybrid member event using runtime_kind (not adapter)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-4', {
      base_sha: 'base123',
      members: hybridMembers(),
    });
    const payload = { kind: 'started' };
    // The event uses the ACTUAL runtime kind, which differs from the logical adapter.
    const r = await appendImplementerEventLocked(spec, {
      event_type: 'started',
      implementer_run_id,
      slice_id: 'slice-4',
      member_id: UI_MEMBER,
      runtime_kind: 'claude-subagent', // matches members[UI].runtime_kind, NOT adapter "claude-ui"
      worktree_id: 'wt-slice-4-ui',
      payload_hash: payloadHash(payload),
      payload,
    });
    assert.equal(r.event_seq, 1);
    const run = readImplementerRun(spec, 'slice-4');
    assert.equal(run.events[0].runtime_kind, 'claude-subagent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked rejects a hybrid member event using the logical adapter', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-4', {
      base_sha: 'base123',
      members: hybridMembers(),
    });
    const payload = { kind: 'started' };
    await assert.rejects(
      () =>
        appendImplementerEventLocked(spec, {
          event_type: 'started',
          implementer_run_id,
          slice_id: 'slice-4',
          member_id: UI_MEMBER,
          runtime_kind: 'claude-ui', // logical adapter — must be rejected
          worktree_id: 'wt-slice-4-ui',
          payload_hash: payloadHash(payload),
          payload,
        }),
      /runtime_kind/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendImplementerEventLocked still validates against adapter for legacy members without runtime_kind', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-3', {
      base_sha: 'base123',
      members: {
        'expert-implementer@claude:sonnet#0': {
          adapter: 'claude-cli',
          model: 'sonnet',
          required: true,
          worktree_id: 'wt-slice-3-claude-0',
          branch: 'implementer/slice-3/claude-0',
          claimed_files: ['lib/a.js'],
        },
      },
    });
    const payload = { kind: 'started' };
    // Legacy member: no runtime_kind, so adapter "claude-cli" is the expected kind.
    const r = await appendImplementerEventLocked(spec, {
      event_type: 'started',
      implementer_run_id,
      slice_id: 'slice-3',
      member_id: 'expert-implementer@claude:sonnet#0',
      runtime_kind: 'claude-cli',
      worktree_id: 'wt-slice-3-claude-0',
      payload_hash: payloadHash(payload),
      payload,
    });
    assert.equal(r.event_seq, 1);
    // A non-matching kind is still rejected.
    await assert.rejects(
      () =>
        appendImplementerEventLocked(spec, {
          event_type: 'checkpoint',
          implementer_run_id,
          slice_id: 'slice-3',
          member_id: 'expert-implementer@claude:sonnet#0',
          runtime_kind: 'codex',
          worktree_id: 'wt-slice-3-claude-0',
          payload_hash: payloadHash(payload),
          payload,
        }),
      /runtime_kind/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 2: hybrid status block written + read back, NOT replacing the run ───

test('setHybridStatus writes the §9 block under phases.hybrid without replacing implementer_experts', async () => {
  const { dir, spec } = makeSpec();
  try {
    const { implementer_run_id } = await startImplementerRun(spec, 'slice-4', {
      base_sha: 'base123',
      members: hybridMembers(),
    });

    const block = {
      owners: {
        'claude-ui': {
          member_id: UI_MEMBER,
          status: 'in-progress',
          worktree: '.git-worktrees/slice-4-claude-ui',
          claimed_files: ['app/settings/SettingsScreen.tsx', UI_SHIM],
          contract_consumed_hash: null,
          contract_shim_file: UI_SHIM,
          shim_swapped_to_real_contract: false,
        },
        'codex-backend': {
          member_id: BACKEND_MEMBER,
          status: 'in-progress',
          worktree: '.git-worktrees/slice-4-codex-backend',
          claimed_files: ['lib/server/contracts/account-preferences.ts'],
          contract_published_hash: null,
          task_id: 'task-abc',
          status_file: '/abs/.codex-paired/codex/slice-4.status.json',
        },
      },
      latest_contract_hash: null,
      contract_version: 0,
      contract_sync_state: 'none',
    };
    setHybridStatus(spec, 'slice-4', block);

    const readBack = getHybridStatus(spec, 'slice-4');
    assert.deepEqual(readBack, block);

    // The implementer_experts event-stream block is untouched (still the audit trail).
    const run = readImplementerRun(spec, 'slice-4');
    assert.equal(run.implementer_run_id, implementer_run_id);
    assert.equal(run.status, 'running');
    assert.deepEqual(run.events, []);

    // Both coexist under the slice's phases container.
    const sc = loadSidecar(spec);
    assert.ok(sc.slice_reviews['slice-4'].phases.implementer_experts);
    assert.ok(sc.slice_reviews['slice-4'].phases.hybrid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 2b: getHybridStatus returns null when never set ─────────────────────

test('getHybridStatus returns null when no hybrid block was written', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members: hybridMembers() });
    assert.equal(getHybridStatus(spec, 'slice-4'), null);
    assert.equal(getHybridStatus(spec, 'slice-nonexistent'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 2c: a second setHybridStatus does not disturb the event stream ──────

test('updating the hybrid block preserves implementer_experts events', async () => {
  const { dir, spec } = makeSpec();
  try {
    await startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members: hybridMembers() });
    setHybridStatus(spec, 'slice-4', { latest_contract_hash: null, contract_version: 0, contract_sync_state: 'none', owners: {} });
    setHybridStatus(spec, 'slice-4', { latest_contract_hash: 'sha256:' + 'a'.repeat(64), contract_version: 1, contract_sync_state: 'published', owners: {} });
    const block = getHybridStatus(spec, 'slice-4');
    assert.equal(block.contract_version, 1);
    assert.equal(block.contract_sync_state, 'published');
    const run = readImplementerRun(spec, 'slice-4');
    assert.equal(run.status, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 3 (TDD-panel): overlap_rationale round-trips through sidecar member ─

test('overlap_rationale on a member round-trips through the sidecar (AC-G1)', async () => {
  const { dir, spec } = makeSpec();
  try {
    const members = hybridMembers();
    // Both owners touch a shared config file with an explicit rationale.
    members[UI_MEMBER].claimed_files.push('app/settings/shared-config.ts');
    members[BACKEND_MEMBER].claimed_files.push('app/settings/shared-config.ts');
    members[UI_MEMBER].overlap_rationale = 'both owners append to the same settings registry by design';
    members[BACKEND_MEMBER].overlap_rationale = 'both owners append to the same settings registry by design';

    await startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members });
    const run = readImplementerRun(spec, 'slice-4');
    assert.equal(
      run.members[UI_MEMBER].overlap_rationale,
      'both owners append to the same settings registry by design'
    );
    assert.equal(
      run.members[BACKEND_MEMBER].overlap_rationale,
      'both owners append to the same settings registry by design'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── case 4: validation of the optional owner field ──────────────────────────

test('startImplementerRun rejects an owner outside claude-ui|codex-backend', async () => {
  const { dir, spec } = makeSpec();
  try {
    const members = hybridMembers();
    members[UI_MEMBER].owner = 'frontend';
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members }),
      /owner/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startImplementerRun rejects empty-string runtime_kind / overlap_rationale when present', async () => {
  const { dir, spec } = makeSpec();
  try {
    const m1 = hybridMembers();
    m1[UI_MEMBER].runtime_kind = '';
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-4', { base_sha: 'base123', members: m1 }),
      /runtime_kind/
    );
    const m2 = hybridMembers();
    m2[UI_MEMBER].overlap_rationale = '';
    await assert.rejects(
      () => startImplementerRun(spec, 'slice-5', { base_sha: 'base123', members: m2 }),
      /overlap_rationale/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
