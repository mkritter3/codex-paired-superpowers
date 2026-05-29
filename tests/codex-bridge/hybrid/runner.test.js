// Slice 6 — hybrid runner (interactive + autopilot).
//
// Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §6 (preflight),
// §7 (contract handoff), §8 (interactive run), §9 (autopilot run), §10 (background
// classification + halts), §11 (runtime kinds / injectable deps).
//
// The runner composes existing primitives (ownership, contracts, worktree, integrate,
// sidecar, halt-envelope) under FULL dependency injection — these unit tests never shell
// out, never touch a real worktree, and never dispatch a real subagent or Codex process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveUiRuntimeKind,
  classifyBackgroundStatus,
  verifyOwnerClaimedFiles,
  selectHybridReadyBatch,
  hybridPreflight,
  awaitContract,
  runHybridSlice,
} from '../../../lib/codex-bridge/hybrid/runner.js';

import { HYBRID_RUNTIME_KINDS, __hybridShapesForTests } from '../../../lib/codex-bridge/hybrid/types.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const UI_MEMBER = 'hybrid-ui@claude:sonnet#0';
const BACKEND_MEMBER = 'hybrid-backend@codex:gpt-5.5#0';
const UI_FILE = 'app/settings/SettingsScreen.tsx';
const UI_SHIM = 'app/settings/__hybrid_contracts__/account-preferences.ts';
const BACKEND_FILE = 'lib/server/contracts/account-preferences.ts';
const SLICE_FILES = [UI_FILE, UI_SHIM, BACKEND_FILE];

function ownerEntries() {
  return [
    { member_id: UI_MEMBER, owner: 'claude-ui', adapter: 'claude-ui', model: 'sonnet', required: true, files: [UI_FILE, UI_SHIM] },
    { member_id: BACKEND_MEMBER, owner: 'codex-backend', adapter: 'codex-background-bash', model: 'gpt-5.5', required: true, files: [BACKEND_FILE] },
  ];
}

// A deps factory with sensible passing defaults; tests override individual fns.
function makeDeps(over = {}) {
  const calls = { worktreeCreate: [], startImplementerRun: [], integrate: [], dispatch: [], events: [] };
  const deps = {
    parseHybridOwners: () => ownerEntries(),
    validateHybridOwnership: ({ implementers }) => implementers,
    verifyTransport: (transport) => ({ transport }),
    contractDocExists: () => true,
    isCleanCheckout: () => true,
    worktreeCreate: (repoRoot, wtSliceId, sha) => {
      calls.worktreeCreate.push({ wtSliceId, sha });
      return { ok: true, worktreePath: `.git-worktrees/${wtSliceId}`, branchName: `${wtSliceId}-impl` };
    },
    startImplementerRun: (specPath, sliceId, run) => {
      calls.startImplementerRun.push({ sliceId, run });
      return { implementer_run_id: 'run-1' };
    },
    setHybridStatus: () => {},
    appendImplementerEventLocked: (specPath, event) => {
      calls.events.push(event);
      return { event_seq: calls.events.length };
    },
    completeImplementerRun: () => {},
    ...over,
  };
  deps._calls = calls;
  return deps;
}

// ── case 0: types witness (spec §11) ─────────────────────────────────────────

test('hybrid runtime witness pins the three actual runtime kinds', () => {
  assert.deepEqual([...HYBRID_RUNTIME_KINDS].sort(), ['claude-inline', 'claude-subagent', 'codex-background-bash']);
  assert.deepEqual(__hybridShapesForTests.runtimeKindMembers, ['claude-inline', 'claude-subagent', 'codex-background-bash']);
});

test('resolveUiRuntimeKind maps mode to the actual UI runtime kind', () => {
  assert.equal(resolveUiRuntimeKind('interactive'), 'claude-inline');
  assert.equal(resolveUiRuntimeKind('autopilot'), 'claude-subagent');
  assert.throws(() => resolveUiRuntimeKind('nope'), /mode/);
});

// ── case 1: preflight + worktree topology by mode (spec §6 / §8 / §9) ────────

test('autopilot preflight creates BOTH worktrees from the slice-start SHA and starts a two-member run', async () => {
  const deps = makeDeps();
  const r = await hybridPreflight({
    mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, true);
  assert.equal(r.implementerRunId, 'run-1');
  // Both owners isolated in worktrees from the SAME slice-start SHA.
  assert.equal(deps._calls.worktreeCreate.length, 2);
  assert.deepEqual(deps._calls.worktreeCreate.map((c) => c.wtSliceId).sort(), ['slice-4-claude-ui', 'slice-4-codex-backend']);
  assert.ok(deps._calls.worktreeCreate.every((c) => c.sha === 'base123'));
  // Two-member run with owner + actual runtime kind.
  const { run } = deps._calls.startImplementerRun[0];
  assert.equal(run.members[UI_MEMBER].owner, 'claude-ui');
  assert.equal(run.members[UI_MEMBER].runtime_kind, 'claude-subagent');
  assert.equal(run.members[BACKEND_MEMBER].owner, 'codex-backend');
  assert.equal(run.members[BACKEND_MEMBER].runtime_kind, 'codex-background-bash');
});

test('interactive preflight creates ONLY the backend worktree (UI is foreground) and uses claude-inline', async () => {
  const deps = makeDeps();
  const r = await hybridPreflight({
    mode: 'interactive', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, true);
  assert.equal(deps._calls.worktreeCreate.length, 1);
  assert.equal(deps._calls.worktreeCreate[0].wtSliceId, 'slice-4-codex-backend');
  const { run } = deps._calls.startImplementerRun[0];
  assert.equal(run.members[UI_MEMBER].runtime_kind, 'claude-inline');
});

test('interactive preflight halts on a dirty checkout before any dispatch (hybrid-preflight-dirty)', async () => {
  const deps = makeDeps({ isCleanCheckout: () => false });
  const r = await hybridPreflight({
    mode: 'interactive', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-preflight-dirty');
  assert.equal(deps._calls.worktreeCreate.length, 0);
  assert.equal(deps._calls.startImplementerRun.length, 0);
});

test('preflight halts on malformed ownership and never creates worktrees or starts a run', async () => {
  const deps = makeDeps({
    validateHybridOwnership: () => { throw Object.assign(new Error('bad'), { code: 'hybrid-ownership-malformed' }); },
  });
  const r = await hybridPreflight({
    mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-ownership-malformed');
  assert.equal(deps._calls.worktreeCreate.length, 0);
  assert.equal(deps._calls.startImplementerRun.length, 0);
});

test('preflight halts when the dispatcher registry or contract doc is missing (hybrid-dispatcher-invalid)', async () => {
  const deps = makeDeps({ contractDocExists: () => false });
  const r = await hybridPreflight({
    mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-dispatcher-invalid');
  assert.equal(deps._calls.worktreeCreate.length, 0);
});

test('preflight verifies ACTUAL transports (codex-background-bash + claude-subagent), never the logical claude-ui adapter', async () => {
  const seen = [];
  const deps = makeDeps({ verifyTransport: (t) => { seen.push(t); return { transport: t }; } });
  const r = await hybridPreflight({
    mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, true);
  // Backend + autopilot UI transports are checked; the logical 'claude-ui' adapter is NOT.
  assert.ok(seen.includes('codex-background-bash'), 'backend transport verified');
  assert.ok(seen.includes('claude-subagent'), 'autopilot UI transport verified');
  assert.ok(!seen.includes('claude-ui'), 'logical claude-ui adapter must never be resolved against the registry');
});

test('interactive preflight does NOT verify a UI subagent transport (UI is foreground inline)', async () => {
  const seen = [];
  const deps = makeDeps({ verifyTransport: (t) => { seen.push(t); return { transport: t }; } });
  const r = await hybridPreflight({
    mode: 'interactive', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['codex-background-bash']);
});

test('preflight halts hybrid-dispatcher-invalid when a required transport is absent from the registry', async () => {
  const deps = makeDeps({ verifyTransport: () => { throw new Error('no dispatcher offers transport'); } });
  const r = await hybridPreflight({
    mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
    planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123', deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-dispatcher-invalid');
  assert.equal(deps._calls.worktreeCreate.length, 0);
});

// ── case 4: claimed-file verification, both owners (spec §8.7/§8.8) ──────────

test('verifyOwnerClaimedFiles passes when changed files are within the claim (incl. rationalized overlap)', () => {
  assert.deepEqual(verifyOwnerClaimedFiles({ changedFiles: [UI_FILE, UI_SHIM], claimedFiles: [UI_FILE, UI_SHIM] }), { ok: true });
  // A rationalized overlap file is part of the claim on either side → allowed.
  const shared = 'app/settings/shared-config.ts';
  assert.deepEqual(verifyOwnerClaimedFiles({ changedFiles: [shared], claimedFiles: [BACKEND_FILE, shared] }), { ok: true });
});

test('verifyOwnerClaimedFiles halts on a change outside the claim (either owner)', () => {
  const ui = verifyOwnerClaimedFiles({ changedFiles: [UI_FILE, BACKEND_FILE], claimedFiles: [UI_FILE, UI_SHIM] });
  assert.equal(ui.ok, false);
  assert.equal(ui.haltReason, 'implementer-claimed-file-violation');
  assert.deepEqual(ui.detail.unclaimed, [BACKEND_FILE]);

  const backend = verifyOwnerClaimedFiles({ changedFiles: [BACKEND_FILE, UI_FILE], claimedFiles: [BACKEND_FILE] });
  assert.equal(backend.ok, false);
  assert.deepEqual(backend.detail.unclaimed, [UI_FILE]);
});

// ── case 5: background classification (spec §10), table-driven ───────────────

test('classifyBackgroundStatus maps status-file states to the spec §10 outcomes', () => {
  const table = [
    { name: 'completed exit 0', in: { statusFile: { status: 'completed', exit_code: 0 }, taskAlive: true, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'completed', terminal: false, haltReason: null } },
    { name: 'nonzero exit', in: { statusFile: { status: 'completed', exit_code: 1 }, taskAlive: true, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'failed', terminal: true, haltReason: 'hybrid-codex-backend-failed' } },
    { name: 'blocked sentinel', in: { statusFile: { status: 'blocked', exit_code: null }, taskAlive: true, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'failed', terminal: true, haltReason: 'hybrid-codex-backend-failed' } },
    { name: 'transient marker', in: { statusFile: { status: 'running', transient: true }, taskAlive: true, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'transient', terminal: false, haltReason: null } },
    { name: 'missing but task alive', in: { statusFile: null, taskAlive: true, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'transient', terminal: false, haltReason: null } },
    { name: 'missing and task dead', in: { statusFile: null, taskAlive: false, runtimeMs: 10, maxRuntimeMs: 1000 }, want: { state: 'lost', terminal: true, haltReason: 'hybrid-codex-background-lost' } },
    { name: 'runtime exceeded', in: { statusFile: null, taskAlive: true, runtimeMs: 2000, maxRuntimeMs: 1000 }, want: { state: 'timeout', terminal: true, haltReason: 'hybrid-codex-background-timeout' } },
  ];
  for (const row of table) {
    assert.deepEqual(classifyBackgroundStatus(row.in), row.want, row.name);
  }
});

// ── case 3: contract handoff (spec §7) ───────────────────────────────────────

test('awaitContract returns published once a contract appears', async () => {
  let polls = 0;
  const deps = {
    readContractState: () => (++polls >= 2 ? { syncState: 'published', latestPublishedHash: 'sha256:' + 'a'.repeat(64) } : { syncState: 'none', latestPublishedHash: null }),
    now: () => polls * 10,
    sleep: async () => {},
  };
  const r = await awaitContract({ specPath: '/s', sliceId: 'slice-4', backendTerminal: () => false, contractWaitMs: 1000, deps });
  assert.equal(r.state, 'published');
  assert.equal(r.latestPublishedHash, 'sha256:' + 'a'.repeat(64));
});

test('awaitContract returns a non-terminal blocked status when the timer expires while the backend is still live', async () => {
  let t = 0;
  const deps = { readContractState: () => ({ syncState: 'none', latestPublishedHash: null }), now: () => (t += 500), sleep: async () => {} };
  const r = await awaitContract({ specPath: '/s', sliceId: 'slice-4', backendTerminal: () => false, contractWaitMs: 1000, deps });
  assert.equal(r.state, 'blocked');
  assert.equal(r.terminal, false);
});

test('awaitContract halts hybrid-contract-not-published when the backend is terminal with no contract', async () => {
  const deps = { readContractState: () => ({ syncState: 'none', latestPublishedHash: null }), now: () => 0, sleep: async () => {} };
  const r = await awaitContract({ specPath: '/s', sliceId: 'slice-4', backendTerminal: () => true, contractWaitMs: 0, deps });
  assert.equal(r.state, 'halt');
  assert.equal(r.haltReason, 'hybrid-contract-not-published');
});

// ── case 9: autopilot batch selection reuses DAG non-overlap (AC-G4) ─────────

test('selectHybridReadyBatch excludes hybrid slices whose slice-level files overlap', () => {
  // Two ready slices sharing a file must not co-run; disjoint ones may.
  const dag = { nodes: { 'slice-a': { dependsOn: [] }, 'slice-b': { dependsOn: [] }, 'slice-c': { dependsOn: [] } } };
  const filesIndex = {
    'slice-a': new Set(['x.ts']),
    'slice-b': new Set(['x.ts']), // overlaps slice-a
    'slice-c': new Set(['y.ts']), // disjoint
  };
  const sliceStates = { 'slice-a': 'pending', 'slice-b': 'pending', 'slice-c': 'pending' };
  const batch = selectHybridReadyBatch({ dag, sliceStates, filesIndex });
  assert.ok(batch.includes('slice-a'));
  assert.ok(batch.includes('slice-c'));
  assert.ok(!batch.includes('slice-b'), 'overlapping slice must be excluded from the same batch');
});

// ── case 2 + 6 + 7: full autopilot orchestration ────────────────────────────

function completedResult(memberId, changedFiles) {
  return { memberId, outcome: 'completed', exitCode: 0, headSha: 'h', diffHash: null, changedFiles, haltEnvelope: null };
}

function orchestratorDeps(over = {}) {
  const base = makeDeps();
  const calls = base._calls;
  const consumedHash = 'sha256:' + 'c'.repeat(64);
  const deps = {
    ...base,
    dispatch: {
      ui: async (input) => { calls.dispatch.push({ owner: 'claude-ui', input }); return completedResult(UI_MEMBER, [UI_FILE, UI_SHIM]); },
      backend: async (input) => { calls.dispatch.push({ owner: 'codex-backend', input }); return completedResult(BACKEND_MEMBER, [BACKEND_FILE]); },
    },
    readContractState: () => ({ syncState: 'consumed', latestPublishedHash: consumedHash, consumedHash, consumedVersion: 1 }),
    awaitContract: async () => ({ state: 'published', latestPublishedHash: consumedHash }),
    integrate: ({ slices }) => { calls.integrate.push(slices); return { ok: true, head_sha: 'merged', commit_count: 2 }; },
    verifyShimRealization: () => ({ ok: true }),
    typecheck: () => ({ ok: true }),
    isTerminalHalt: () => { calls.isTerminalHalt = (calls.isTerminalHalt || 0) + 1; return true; },
    writeToMailbox: (repoRoot, recipient, message) => { (calls.mailbox = calls.mailbox || []).push({ recipient, message }); return { id: 'm1' }; },
    ...over,
  };
  deps._calls = calls;
  deps._consumedHash = consumedHash;
  return deps;
}

const runArgs = (deps, over = {}) => ({
  mode: 'autopilot', repoRoot: '/repo', specPath: '/repo/spec.md', sliceId: 'slice-4',
  planMarkdown: '#', sliceSection: '#', sliceFiles: SLICE_FILES, sliceStartSha: 'base123',
  integrationBranch: 'autopilot/integration', contractWaitMs: 1000, maxRuntimeMs: 600000, deps, ...over,
});

test('autopilot run dispatches both owners and integrates BOTH owner branches in deterministic order', async () => {
  const deps = orchestratorDeps();
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, true);
  // Both owners dispatched concurrently under one run.
  assert.deepEqual(deps._calls.dispatch.map((d) => d.owner).sort(), ['claude-ui', 'codex-backend']);
  // Integration includes both owner branches, backend before UI (contract source first).
  assert.equal(deps._calls.integrate.length, 1);
  const integrated = deps._calls.integrate[0].map((s) => s.branchName);
  assert.equal(integrated.length, 2);
  assert.ok(integrated[0].includes('codex-backend'), 'backend branch integrated first');
  assert.ok(integrated[1].includes('claude-ui'), 'UI branch integrated second');
});

test('autopilot run swaps the shim and runs final typecheck against the real backend contract (success path)', async () => {
  let shimChecked = false, typed = false;
  const deps = orchestratorDeps({
    verifyShimRealization: () => { shimChecked = true; return { ok: true }; },
    typecheck: () => { typed = true; return { ok: true }; },
  });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, true);
  assert.ok(shimChecked && typed);
  assert.equal(r.shimSwapped, true);
});

test('autopilot run halts hybrid-contract-realization-mismatch when the real backend export mismatches the consumed shim', async () => {
  const deps = orchestratorDeps({ verifyShimRealization: () => ({ ok: false }) });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-contract-realization-mismatch');
});

test('runner consults isTerminalHalt before any retry and treats unknown hybrid halts as terminal', async () => {
  const deps = orchestratorDeps({ integrate: () => ({ ok: false, halt: { reason: 'worktree-merge-conflict', detail: {} } }) });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  assert.ok((deps._calls.isTerminalHalt || 0) >= 1, 'isTerminalHalt must be consulted on a halt');
  assert.equal(r.retried, false);
});

// ── case 8: required-owner failure aborts the live sibling (spec §9.9) ───────

test('a required backend failure aborts the live UI sibling and surfaces the halt', async () => {
  let uiAborted = false;
  const deps = orchestratorDeps({
    dispatch: {
      ui: async (input) => {
        // UI observes the shared abort signal raised by the backend failure.
        await new Promise((res) => setTimeout(res, 5));
        if (input.abortSignal?.aborted) { uiAborted = true; return { memberId: UI_MEMBER, outcome: 'cancelled', exitCode: null, headSha: null, diffHash: null, changedFiles: [], haltEnvelope: null }; }
        return completedResult(UI_MEMBER, [UI_FILE, UI_SHIM]);
      },
      backend: async () => ({ memberId: BACKEND_MEMBER, outcome: 'failed', exitCode: 1, headSha: null, diffHash: null, changedFiles: [], haltEnvelope: null }),
    },
  });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  assert.ok(uiAborted, 'UI sibling must observe the abort signal');
  assert.equal(deps._calls.integrate.length, 0, 'no integration after a required-owner failure');
});

test('autopilot run records started + completed events for both owners and emits the UI→orchestrator contract ack', async () => {
  const deps = orchestratorDeps();
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, true);
  // started + completed for each owner = 4 events.
  const byType = deps._calls.events.reduce((acc, e) => { acc[e.event_type] = (acc[e.event_type] || 0) + 1; return acc; }, {});
  assert.equal(byType.started, 2);
  assert.equal(byType.completed, 2);
  // Events carry the ACTUAL runtime kind (claude-subagent for UI, not the logical adapter).
  const uiStarted = deps._calls.events.find((e) => e.member_id === UI_MEMBER && e.event_type === 'started');
  assert.equal(uiStarted.runtime_kind, 'claude-subagent');
  // Visible orchestrator ack (spec §7) carrying the consumed hash.
  const ack = (deps._calls.mailbox || []).find((m) => m.recipient === 'orchestrator');
  assert.ok(ack, 'a contract ack to orchestrator must be emitted');
  assert.equal(ack.message.body_hash, deps._consumedHash);
  // `from` must be a VALID mailbox recipient slug, not the raw member id (the real
  // writeToMailbox rejects `hybrid-ui@claude:sonnet#0`). recipientForMember → `impl-…`.
  assert.match(ack.message.from, /^(orchestrator|slice-\d+|expert-[a-z][a-z0-9-]{0,47}|impl-[a-z0-9][a-z0-9-]{0,60})$/);
});

test('UI completing without consuming the latest contract halts hybrid-contract-not-consumed', async () => {
  const published = 'sha256:' + 'd'.repeat(64);
  const deps = orchestratorDeps({
    readContractState: () => ({ syncState: 'published', latestPublishedHash: published, consumedHash: null, consumedVersion: 0 }),
    awaitContract: async () => ({ state: 'published', latestPublishedHash: published }),
  });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-contract-not-consumed');
});

test('a backend dispatch failure surfaces its OWN halt envelope (preserves §10 lost/timeout reasons)', async () => {
  const lost = { halt: 'hybrid-codex-background-lost', terminal: true };
  const deps = orchestratorDeps({
    dispatch: {
      ui: async () => completedResult(UI_MEMBER, [UI_FILE, UI_SHIM]),
      backend: async () => ({ memberId: BACKEND_MEMBER, outcome: 'failed', exitCode: null, headSha: null, diffHash: null, changedFiles: [], haltEnvelope: lost }),
    },
  });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  // The precise background-classification reason is preserved, not collapsed to -backend-failed.
  assert.equal(r.halt.halt, 'hybrid-codex-background-lost');
  assert.equal(deps._calls.integrate.length, 0);
});

test('awaitContract returning a non-terminal blocked state halts not-published instead of proceeding with a null bodyHash', async () => {
  let shimCalled = false;
  const deps = orchestratorDeps({
    awaitContract: async () => ({ state: 'blocked', terminal: false }),
    verifyShimRealization: () => { shimCalled = true; return { ok: true }; },
  });
  const r = await runHybridSlice(runArgs(deps));
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-contract-not-published');
  assert.equal(shimCalled, false, 'must not reach shim realization with no published contract');
  assert.equal(deps._calls.integrate.length, 0);
});

// ── spec §8.10: no cherry-pick onto a dirty foreground checkout ──────────────

test('interactive run integrates ONLY the backend branch onto the clean foreground checkout (UI is the foreground tree)', async () => {
  const deps = orchestratorDeps(); // isCleanCheckout defaults to () => true
  const r = await runHybridSlice(runArgs(deps, { mode: 'interactive' }));
  assert.equal(r.ok, true);
  assert.equal(deps._calls.integrate.length, 1);
  const branches = deps._calls.integrate[0].map((s) => s.branchName);
  assert.equal(branches.length, 1);
  assert.ok(branches[0].includes('codex-backend'), 'only the backend branch is cherry-picked; UI work already lives in the foreground tree');
});

test('interactive run halts hybrid-preflight-dirty when the foreground checkout is dirty at integration time (no cherry-pick onto a dirty tree)', async () => {
  let cleanCalls = 0;
  const deps = orchestratorDeps({
    // Clean at preflight (call 1, UI edits not yet made); dirty at the §8.10 guard (call 2).
    isCleanCheckout: () => { cleanCalls += 1; return cleanCalls < 2; },
  });
  const r = await runHybridSlice(runArgs(deps, { mode: 'interactive' }));
  assert.equal(r.ok, false);
  assert.equal(r.halt.halt, 'hybrid-preflight-dirty');
  assert.equal(deps._calls.integrate.length, 0, 'no cherry-pick onto a dirty foreground checkout');
});
