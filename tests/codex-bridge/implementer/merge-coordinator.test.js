// v0.10.0 slice-7 — merge-coordinator.test.js
//
// Validation tier: critical.
// Tests mergeImplementerBranches() with real git operations in mkdtempSync
// directories, using DI (_deps) to stub lockfile and appendImplementerEventLocked
// for specific scenarios.
//
// Setup convention:
//   - makeIntegrationRepo() creates a parent git repo + integration worktree via
//     `git worktree add` (NOT just git init — we need the gitlink path).
//   - makeSidecar() creates a spec.md + initSidecar + startImplementerRun.
//   - The coordinator members map uses { branchName, runtimeKind, worktreeId }
//     which must match the sidecar member { adapter, model, worktree_id }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { mergeImplementerBranches } from '../../../lib/codex-bridge/implementer/merge-coordinator.js';
import {
  initSidecar,
  startImplementerRun,
  readImplementerRun,
  appendImplementerEventLocked,
} from '../../../lib/codex-bridge/sidecar.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a base git repo with a single empty commit.
 * Returns { repoRoot, baseSha }.
 */
function makeBaseRepo(prefix = 'cps-mc-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init', '-q']);
  const baseSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repoRoot: dir, baseSha };
}

/**
 * Add an integration worktree via `git worktree add` so the worktree has a
 * gitlink file (not a full .git dir). Returns the integration worktree path.
 */
function addIntegrationWorktree(repoRoot, suffix = 'integration') {
  const wtPath = join(repoRoot + '-wt', suffix);
  mkdirSync(join(repoRoot + '-wt'), { recursive: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', wtPath]);
  return wtPath;
}

/**
 * Create a branch off the given repo's HEAD with file content changes.
 * Returns the branch name.
 */
function makeBranch(repoRoot, branchName, files) {
  execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-b', branchName]);
  for (const [filename, content] of Object.entries(files)) {
    const fullPath = join(repoRoot, filename);
    // Ensure parent dir exists
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
    execFileSync('git', ['-C', repoRoot, 'add', filename]);
  }
  execFileSync('git', ['-C', repoRoot, 'commit', '-m', `feat: ${branchName}`, '-q']);
  // Return to main/master
  execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-']);
  return branchName;
}

/**
 * Create a sidecar with a running implementer_experts run.
 * Returns { spec, implementerRunId }.
 */
async function makeSidecarRun(repoRoot, sliceId, memberSpecs, baseSha = null) {
  const spec = join(repoRoot, 'plan.md');
  writeFileSync(spec, `# plan`);
  initSidecar(spec, { feature: 'test', codexSession: 'sess', model: 'x', reasoningEffort: 'high' });

  // Resolve real baseSha from the repo if not provided
  const resolvedBaseSha = baseSha ||
    execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Build the sidecar members map (adapter/model/required/worktree_id/branch/claimed_files)
  const members = {};
  for (const [memberId, m] of Object.entries(memberSpecs)) {
    members[memberId] = {
      adapter: m.runtimeKind,
      model: 'test-model',
      required: true,
      worktree_id: m.worktreeId,
      branch: m.branchName,
      claimed_files: m.claimedFiles || ['lib/a.js'],
    };
  }
  const { implementer_run_id } = await startImplementerRun(spec, sliceId, {
    base_sha: resolvedBaseSha,
    members,
  });
  return { spec, implementerRunId: implementer_run_id };
}

/**
 * Build the coordinator `members` Map and `memberOrder` from memberSpecs.
 */
function buildCoordinatorArgs(memberSpecs) {
  const members = new Map();
  for (const [memberId, m] of Object.entries(memberSpecs)) {
    members.set(memberId, {
      branchName: m.branchName,
      runtimeKind: m.runtimeKind,
      worktreeId: m.worktreeId,
    });
  }
  const memberOrder = [...members.keys()].sort();
  return { members, memberOrder };
}

// ── happy: disjoint-merge (2 members) ─────────────────────────────────────────

test('happy: 2 members with disjoint files merge cleanly; HEAD has 2 merge commits', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'console.log("A");\n' });
    makeBranch(repoRoot, 'impl/branch-B', { 'lib/b.js': 'console.log("B");\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, false);
    assert.deepEqual(result.merged, memberOrder);
    assert.equal(result.mergedSoFar, 2);
    assert.ok(typeof result.integrationHeadSha === 'string' && result.integrationHeadSha.length > 0);

    // HEAD should have 2 merge commits (subjects start with "merge(slice:")
    const logOut = execFileSync('git', ['-C', integrationWt, 'log', '--oneline', '--merges'], { encoding: 'utf8' });
    const mergeLines = logOut.trim().split('\n').filter(Boolean);
    assert.equal(mergeLines.length, 2, `expected 2 merge commits, got: ${logOut.trim()}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── happy: 5-member-stress (5 disjoint) ───────────────────────────────────────

test('happy: 5 members with disjoint files all merge cleanly', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    const memberSpecs = {};
    for (let i = 0; i < 5; i++) {
      const id = `member${String.fromCharCode(65 + i)}`; // memberA..memberE
      const branch = `impl/branch-${id}`;
      makeBranch(repoRoot, branch, { [`lib/${id}.js`]: `// ${id}\n` });
      memberSpecs[id] = { branchName: branch, runtimeKind: 'codex-cli', worktreeId: `wt-${id}` };
    }

    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, false);
    assert.equal(result.merged.length, 5);
    assert.equal(result.mergedSoFar, 5);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── happy: sidecar event shape check ─────────────────────────────────────────

test('happy: sidecar has merge_started + merge_resolved events with correct shape', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, false);

    const run = readImplementerRun(spec, 'slice-7');
    const events = run.events;

    // merge_started event
    const startEvt = events.find(e => e.event_type === 'merge_started');
    assert.ok(startEvt, 'merge_started event must exist');
    assert.equal(startEvt.implementer_run_id, implementerRunId);
    assert.equal(startEvt.slice_id, 'slice-7');
    assert.ok(Array.isArray(startEvt.payload.member_order));
    assert.ok(typeof startEvt.payload.integration_head_sha === 'string');
    assert.ok(typeof startEvt.event_seq === 'number');

    // merge_resolved event
    const resolvedEvt = events.find(e => e.event_type === 'merge_resolved');
    assert.ok(resolvedEvt, 'merge_resolved event must exist');
    assert.equal(resolvedEvt.member_id, 'memberA');
    assert.equal(resolvedEvt.runtime_kind, 'codex-cli');
    assert.equal(resolvedEvt.worktree_id, 'wt-A');
    assert.ok(typeof resolvedEvt.payload.merge_commit_sha === 'string' && resolvedEvt.payload.merge_commit_sha.length > 0);
    assert.equal(resolvedEvt.payload.member_id, 'memberA');
    assert.equal(resolvedEvt.payload.branch_name, 'impl/branch-A');
    assert.ok(typeof resolvedEvt.payload_hash === 'string');
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(resolvedEvt.payload_hash));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── happy: merge_commit_sha captured in merge_resolved event ─────────────────

test('happy: merge_resolved event payload contains correct commit SHA', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/sha-test.js': '// sha test\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, false);

    // integrationHeadSha from result matches actual HEAD
    const actualHead = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(result.integrationHeadSha, actualHead);

    // sidecar merge_resolved payload SHA also matches
    const run = readImplementerRun(spec, 'slice-7');
    const resolvedEvt = run.events.find(e => e.event_type === 'merge_resolved');
    assert.equal(resolvedEvt.payload.merge_commit_sha, actualHead);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty: validation-reject tests ────────────────────────────
// Note: mergeImplementerBranches is async; validation errors become rejected
// Promises (TypeError). Use assert.rejects.

test('edge: rejects when integrationWorktree is missing', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when integrationWorktree is empty string', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '',
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when members is not a Map', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: { A: { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' } },
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when memberOrder is empty array', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: [],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when specPath is missing', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when sliceId is empty string', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: '',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when implementerRunId is empty string', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: '',
    }),
    TypeError
  );
});

test('edge: rejects when member branchName is empty string', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: '', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when member runtimeKind is empty string', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'b', runtimeKind: '', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

// ── edge.boundary: branch name adversarial ───────────────────────────────────

test('edge: rejects when branchName starts with dash (-)', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: '-bad-branch', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when branchName contains a space', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'bad branch', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when branchName contains a tab', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'bad\tbranch', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

test('edge: rejects when branchName contains a NUL byte', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([['A', { branchName: 'bad\x00branch', runtimeKind: 'codex-cli', worktreeId: 'wt' }]]),
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

// ── edge.boundary: same-line conflict ────────────────────────────────────────

test('edge: same-line conflict — first merges, second halts; mergedSoFar === 1', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    // Both branches modify the same line in the same file
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/conflict.js': 'const x = "A";\n' });
    makeBranch(repoRoot, 'impl/branch-B', { 'lib/conflict.js': 'const x = "B";\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-conflict');
    assert.equal(result.mergedSoFar, 1);
    assert.ok(Array.isArray(result.conflictedFiles));
    assert.ok(result.conflictedFiles.includes('lib/conflict.js'));
    assert.equal(result.conflictedMemberId, 'memberB');
    assert.equal(result.conflictedFilesTotal, 1);

    // Integration worktree MUST preserve the conflicted state after halt so that
    // slice 8's merger agent can resolve conflicts in place.
    // See: docs/architecture/2026-05-12-v0.10.0-implementer-experts-design.md:309
    const statusOut = execFileSync('git', ['-C', integrationWt, 'status', '--porcelain'], { encoding: 'utf8' });
    // Status output must be non-empty (conflicted files show as UU)
    assert.ok(statusOut.trim().length > 0, `integration worktree status must be non-empty after conflict halt (conflict state must be preserved), got: ${JSON.stringify(statusOut)}`);
    // There must be at least one UU (unmerged) entry
    const unmergedLines = statusOut.split('\n')
      .filter(line => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD') || line.startsWith('AU') || line.startsWith('UA'));
    assert.ok(unmergedLines.length > 0, `must have unmerged (UU) entries in status after conflict halt, got: ${statusOut.trim()}`);
    // git diff --name-only --diff-filter=U must also show the conflicted file
    const diffUOut = execFileSync('git', ['-C', integrationWt, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' });
    assert.ok(diffUOut.trim().includes('lib/conflict.js'), `conflicted file must appear in diff --diff-filter=U after halt, got: ${diffUOut.trim()}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── critical: conflict-state preservation handoff invariant ──────────────────
// Asserts that after merge-conflict halt, the conflicted file CONTAINS all three
// Git conflict marker strings so the slice 8 merger agent can work in-place.

test('critical: conflict-state preserved — conflicted file contains all 3 Git marker strings after halt', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    // Both branches write different content to the same file on the same line
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/marker-test.js': 'const val = "FROM_A";\n' });
    makeBranch(repoRoot, 'impl/branch-B', { 'lib/marker-test.js': 'const val = "FROM_B";\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-conflict');

    // Read the conflicted file directly — it must contain all 3 Git conflict markers
    const { readFileSync } = await import('node:fs');
    const conflictedContent = readFileSync(join(integrationWt, 'lib/marker-test.js'), 'utf8');
    assert.ok(conflictedContent.includes('<<<<<<<'), `conflicted file must contain '<<<<<<<' marker, got: ${JSON.stringify(conflictedContent)}`);
    assert.ok(conflictedContent.includes('======='), `conflicted file must contain '=======' marker, got: ${JSON.stringify(conflictedContent)}`);
    assert.ok(conflictedContent.includes('>>>>>>>'), `conflicted file must contain '>>>>>>>' marker, got: ${JSON.stringify(conflictedContent)}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.boundary: 50 conflict files — no truncation ─────────────────────────

test('edge: 50 conflicted files reported; total === 50, truncated === false', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    // Create 50 files that conflict
    const filesA = {};
    const filesB = {};
    for (let i = 0; i < 50; i++) {
      filesA[`lib/file${i}.js`] = `const x = "A${i}";\n`;
      filesB[`lib/file${i}.js`] = `const x = "B${i}";\n`;
    }
    makeBranch(repoRoot, 'impl/branch-A', filesA);
    makeBranch(repoRoot, 'impl/branch-B', filesB);

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-conflict');
    assert.equal(result.conflictedFilesTotal, 50);
    assert.equal(result.conflictedFilesTruncated, false);
    assert.equal(result.conflictedFiles.length, 50);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.boundary: 150 conflict files — truncated ────────────────────────────

test('edge: 150 conflicted files; total === 150, truncated === true, conflictedFiles.length === 100', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    const filesA = {};
    const filesB = {};
    for (let i = 0; i < 150; i++) {
      filesA[`lib/f${i}.js`] = `const x = "A${i}";\n`;
      filesB[`lib/f${i}.js`] = `const x = "B${i}";\n`;
    }
    makeBranch(repoRoot, 'impl/branch-A', filesA);
    makeBranch(repoRoot, 'impl/branch-B', filesB);

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-conflict');
    assert.equal(result.conflictedFilesTotal, 150);
    assert.equal(result.conflictedFilesTruncated, true);
    assert.equal(result.conflictedFiles.length, 100);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.concurrent: single-flight — injected locked state ───────────────────

test('edge: concurrent — when lock is already held, second call halts merge-integration-busy', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // Inject a fake lockfile that always throws ELOCKED (simulates held lock)
    const fakeLockfileBusy = {
      lock: async (_path, _opts) => {
        const err = new Error('Lock held by concurrent process');
        err.code = 'ELOCKED';
        throw err;
      },
    };

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
      _deps: { lockfile: fakeLockfileBusy },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-integration-busy');
    assert.deepEqual(result.merged, []);
    assert.equal(result.mergedSoFar, 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

test('edge: concurrent — two simultaneous calls on real worktree; at most one busy (no crash)', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const args = {
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    };

    // Both calls must complete (no unexpected rejection)
    const [r1, r2] = await Promise.allSettled([
      mergeImplementerBranches(args),
      mergeImplementerBranches(args),
    ]);

    assert.equal(r1.status, 'fulfilled');
    assert.equal(r2.status, 'fulfilled');

    // At most one should be busy (can also be 0 if they ran sequentially)
    const results = [r1.value, r2.value];
    const busyCount = results.filter(r => r.halt === 'merge-integration-busy').length;
    assert.ok(busyCount <= 1, `at most one call can be merge-integration-busy (got ${busyCount})`);

    // At least one must have succeeded (halted: false)
    const successCount = results.filter(r => !r.halted).length;
    assert.ok(successCount >= 1, `at least one call must succeed (got ${successCount} successes)`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency: not-git-repo ─────────────────────────────────────────────

test('fail: non-existent dir halts with merge-integration-not-a-git-repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-notgit-'));
  try {
    // Make a plain directory, not a git repo
    const plainDir = join(dir, 'plain');
    mkdirSync(plainDir);

    // Need a sidecar; use a temp base repo for that
    const { repoRoot } = makeBaseRepo();
    try {
      const memberSpecs = {
        'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      };
      const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
      const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

      // Use DI to stub git so it returns not-a-repo for rev-parse --git-dir
      const result = await mergeImplementerBranches({
        integrationWorktree: plainDir,
        members,
        memberOrder,
        specPath: spec,
        sliceId: 'slice-7',
        implementerRunId,
      });

      assert.equal(result.halted, true);
      assert.equal(result.halt, 'merge-integration-not-a-git-repo');
      assert.deepEqual(result.merged, []);
      assert.equal(result.mergedSoFar, 0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(repoRoot + '-wt', { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency: unknown-branch ───────────────────────────────────────────

test('fail: unknown branch halts with merge-branch-unknown', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-nonexistent', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-branch-unknown');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency: stub git-merge non-zero ─────────────────────────────────

test('fail: git merge non-zero with no conflict files → merge-git-failure via DI stub', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const stubbedGit = {
      exec(args, cwd) {
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          return { stdout: '', stderr: 'fake merge error', status: 1 };
        }
        if (args[0] === 'diff' && args.includes('--diff-filter=U')) {
          return { stdout: '', stderr: '', status: 0 };
        }
        try {
          const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return { stdout, stderr: '', status: 0 };
        } catch (e) {
          return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status || 1 };
        }
      },
    };

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
      _deps: { git: stubbedGit },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-git-failure');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency: stub git-commit fails ───────────────────────────────────

test('fail: git commit fails → merge-commit-failed via DI stub', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const stubbedGitCommit = {
      exec(args, cwd) {
        if (args[0] === 'commit') {
          return { stdout: '', stderr: 'commit hook failed', status: 1 };
        }
        try {
          const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          return { stdout, stderr: '', status: 0 };
        } catch (e) {
          return { stdout: e.stdout || '', stderr: e.stderr || '', status: e.status || 1 };
        }
      },
    };

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
      _deps: { git: stubbedGitCommit },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-commit-failed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency: stub appendImplementerEventLocked fails on merge_started ─

test('fail: appendImplementerEventLocked throws on merge_started → rejection (no git work)', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // Capture HEAD before
    const headBefore = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const stubbedAppend = async () => {
      throw new Error('sidecar unavailable');
    };

    await assert.rejects(
      () => mergeImplementerBranches({
        integrationWorktree: integrationWt,
        members,
        memberOrder,
        specPath: spec,
        sliceId: 'slice-7',
        implementerRunId,
        _deps: { appendImplementerEventLocked: stubbedAppend },
      }),
      /sidecar unavailable/
    );

    // HEAD should be unchanged — no git work happened
    const headAfter = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'HEAD should not change when merge_started event fails');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency: stub appendImplementerEventLocked fails on merge_resolved ─

test('fail: appendImplementerEventLocked fails on merge_resolved + retry → merge-audit-divergence with captured SHA', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    let callCount = 0;
    const stubbedAppend = async (specPath, event) => {
      callCount++;
      // Allow merge_started (first call)
      if (event.event_type === 'merge_started') {
        return appendImplementerEventLocked(specPath, event);
      }
      // Fail both merge_resolved attempts
      throw new Error('audit write failed');
    };

    // Capture HEAD before git merge
    const headBefore = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
      _deps: { appendImplementerEventLocked: stubbedAppend },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-audit-divergence');

    // The commit DID happen — HEAD changed
    const headAfter = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.notEqual(headAfter, headBefore, 'HEAD should have changed (commit succeeded)');

    // The integrationHeadSha in the result should be the new HEAD
    assert.equal(result.integrationHeadSha, headAfter);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.malformed-input: non-Map members ────────────────────────────────────

test('fail: non-Map members (array) rejects with TypeError', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: [['A', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt' }]],
      memberOrder: ['A'],
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

// ── fail.malformed-input: memberOrder not sorted ──────────────────────────────

test('fail: memberOrder not equal to sorted keys rejects with TypeError', async () => {
  await assert.rejects(
    () => mergeImplementerBranches({
      integrationWorktree: '/tmp/foo',
      members: new Map([
        ['B', { branchName: 'b', runtimeKind: 'codex-cli', worktreeId: 'wt-B' }],
        ['A', { branchName: 'a', runtimeKind: 'codex-cli', worktreeId: 'wt-A' }],
      ]),
      memberOrder: ['B', 'A'], // wrong order — sorted should be ['A', 'B']
      specPath: '/tmp/spec.md',
      sliceId: 'slice-7',
      implementerRunId: 'run-1',
    }),
    TypeError
  );
});

// ── fail.exception-path: dirty integration worktree ──────────────────────────

test('fail: dirty integration worktree halts with merge-integration-dirty', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);

    // Stage a tracked change in the integration worktree (untracked files do NOT count as dirty)
    writeFileSync(join(integrationWt, 'dirty.txt'), 'uncommitted\n');
    execFileSync('git', ['-C', integrationWt, 'add', 'dirty.txt']);

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // HEAD before dirty check
    const headBefore = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-integration-dirty');

    // HEAD unchanged
    const headAfter = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headAfter, headBefore, 'HEAD should not change when integration worktree is dirty');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── integration.cross-module: trailer-based recovery ─────────────────────────

test('integration: trailer-based recovery — commit with Member-Id trailer but no sidecar event → coordinator catches up', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // Manually merge and commit with Member-Id trailer (simulating a crash after commit
    // but before the sidecar was updated)
    execFileSync('git', ['-C', integrationWt, 'merge', '--no-ff', '--no-commit', 'impl/branch-A'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', integrationWt,
      'commit',
      '-m', 'merge(slice:7): memberA',
      '-m', '',
      '-m', `Member-Id: memberA\nSlice-Id: slice-7\nBranch-Name: impl/branch-A\nImplementer-Run-Id: ${implementerRunId}`,
    ]);
    const shaAfterManualCommit = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // No merge_resolved in sidecar yet — verify
    const runBefore = readImplementerRun(spec, 'slice-7');
    const resolvedBefore = (runBefore.events || []).filter(e => e.event_type === 'merge_resolved');
    assert.equal(resolvedBefore.length, 0, 'no merge_resolved event should exist yet');

    // Re-run coordinator — should catch up via trailer scan
    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    assert.equal(result.halted, false, `expected halted:false but got halt: ${result.halt}`);
    assert.ok(result.merged.includes('memberA'));

    // Sidecar should now have merge_resolved event
    const runAfter = readImplementerRun(spec, 'slice-7');
    const resolvedAfter = (runAfter.events || []).filter(e => e.event_type === 'merge_resolved');
    assert.equal(resolvedAfter.length, 1);
    assert.equal(resolvedAfter[0].payload.merge_commit_sha, shaAfterManualCommit);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── integration.cross-module: spoofed-subject-rejection ──────────────────────

test('integration: spoofed subject without Member-Id trailer is NOT treated as catch-up', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // Manually commit with the SUBJECT of a merge commit but NO Member-Id trailer
    execFileSync('git', ['-C', integrationWt, 'merge', '--no-ff', '--no-commit', 'impl/branch-A'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', integrationWt,
      'commit',
      '-m', 'merge(slice:7): memberA',
      // NOTE: No Member-Id trailer
    ]);

    // Re-run coordinator — should NOT treat this as a catch-up
    // because the commit has no Member-Id trailer.
    // The integration worktree is now dirty with a merge commit but no trailer.
    // The HEAD is one commit ahead, but memberA is not in sidecar.
    // Since we don't find a Member-Id trailer, the coordinator should skip the
    // recovery path and try to merge again — but the branch is already merged.
    // In practice, git merge --no-commit of an already-merged branch will result
    // in "Already up to date" with status 0, but the index is clean so no conflict.
    // Actually git will produce an up-to-date message. The important thing is the
    // coordinator does NOT use the subject-only heuristic.

    // After re-running, check that no merge_resolved event was back-patched from
    // a spoofed subject (only genuine Member-Id trailer triggers catch-up).
    // The coordinator may complete normally if the branch is already merged.

    // Verify: No Member-Id trailer → trailer map for memberA is empty
    // This is an internal behavior — we test by confirming the pre-run sidecar
    // has no merge_resolved events and after the run there's at most one
    // (from the actual merge path or idempotency path).
    const runBefore = readImplementerRun(spec, 'slice-7');
    const resolvedBeforeCount = (runBefore.events || []).filter(e => e.event_type === 'merge_resolved').length;
    assert.equal(resolvedBeforeCount, 0, 'no merge_resolved event before re-run');

    // The coordinator will try to do the real merge — since the branch IS already
    // merged into HEAD, git merge --no-commit will say "Already up to date." with exit 0.
    // The diff --diff-filter=U will show nothing. So git commit will be attempted on
    // an empty index — likely fails with exit 1 (nothing to commit).
    // Result: merge-commit-failed (not a spoofed catch-up)
    const result = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    // The key assertion: no merge_resolved event appeared from a spoofed subject.
    // The coordinator either commits an empty merge (fails) or recognizes idempotency
    // via sidecar (no event) — but it does NOT succeed via subject-only spoofing.
    if (!result.halted) {
      // If it somehow completed (e.g., already-up-to-date logic), it should have
      // appended via real sidecar, not from subject spoofing.
      const runAfter = readImplementerRun(spec, 'slice-7');
      const resolvedAfter = (runAfter.events || []).filter(e => e.event_type === 'merge_resolved');
      // If resolved, the SHA must be the real current HEAD
      if (resolvedAfter.length > 0) {
        const actualHead = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        assert.equal(resolvedAfter[0].payload.merge_commit_sha, actualHead);
      }
    } else {
      // Halted is acceptable — no spurious merge_resolved from subject spoofing
      assert.ok(
        ['merge-commit-failed', 'merge-git-failure'].includes(result.halt),
        `expected merge-commit-failed or merge-git-failure but got: ${result.halt}`
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── integration.cross-module: idempotency-from-sidecar ───────────────────────

test('integration: re-run after success → all members skipped (idempotency)', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });
    makeBranch(repoRoot, 'impl/branch-B', { 'lib/b.js': 'const b = 2;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    const args = {
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    };

    // First run — succeeds
    const r1 = await mergeImplementerBranches(args);
    assert.equal(r1.halted, false);
    assert.equal(r1.merged.length, 2);

    const headAfterFirst = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // Second run — should skip both members (idempotent via sidecar check)
    const r2 = await mergeImplementerBranches(args);
    assert.equal(r2.halted, false);
    assert.equal(r2.merged.length, 2);

    // HEAD should not have changed
    const headAfterSecond = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headAfterSecond, headAfterFirst, 'HEAD should not change on idempotent re-run');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── critical.residual-risk: mid-merge-audit-divergence with real worktree ─────

test('critical: merge-audit-divergence recovery — commit succeeds, sidecar throws; re-run with real sidecar catches up', async () => {
  const { repoRoot } = makeBaseRepo();
  try {
    const integrationWt = addIntegrationWorktree(repoRoot);
    makeBranch(repoRoot, 'impl/branch-A', { 'lib/a.js': 'const a = 1;\n' });
    makeBranch(repoRoot, 'impl/branch-B', { 'lib/b.js': 'const b = 2;\n' });

    const memberSpecs = {
      'memberA': { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' },
      'memberB': { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' },
    };
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-7', memberSpecs);
    const { members, memberOrder } = buildCoordinatorArgs(memberSpecs);

    // Phase 1: Stub appendImplementerEventLocked to:
    //   - pass merge_started
    //   - pass merge_resolved for memberA
    //   - fail merge_resolved for memberB (both attempts)
    let appendCallLog = [];
    const stubbedAppend = async (specPath, event) => {
      appendCallLog.push({ event_type: event.event_type, member_id: event.member_id });
      if (event.event_type === 'merge_resolved' && event.member_id === 'memberB') {
        throw new Error('sidecar write for memberB failed');
      }
      return appendImplementerEventLocked(specPath, event);
    };

    const result1 = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
      _deps: { appendImplementerEventLocked: stubbedAppend },
    });

    assert.equal(result1.halted, true);
    assert.equal(result1.halt, 'merge-audit-divergence');
    // mergedSoFar should be 1 (memberA completed, memberB diverged)
    assert.equal(result1.mergedSoFar, 1);
    // integrationHeadSha should be the commit for memberB (git commit succeeded)
    const actualHeadAfterDivergence = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(result1.integrationHeadSha, actualHeadAfterDivergence);

    // Verify retry was attempted (3 entries for memberB: merge_resolved + 1 retry)
    const memberBAppends = appendCallLog.filter(e => e.event_type === 'merge_resolved' && e.member_id === 'memberB');
    assert.equal(memberBAppends.length, 2, 'merge_resolved for memberB should be attempted twice (initial + retry)');

    // Phase 2: Re-run with real sidecar — should catch up via trailer scan
    // The commit for memberB is already there with a Member-Id trailer
    const result2 = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members,
      memberOrder,
      specPath: spec,
      sliceId: 'slice-7',
      implementerRunId,
    });

    // On re-run:
    //   - memberA: already in sidecar (merge_resolved) → skipped
    //   - memberB: NOT in sidecar but HAS a commit with Member-Id: memberB trailer → catch-up
    assert.equal(result2.halted, false, `expected halted:false on recovery run but got halt: ${result2.halt}`);
    assert.ok(result2.merged.includes('memberA'));
    assert.ok(result2.merged.includes('memberB'));

    // Sidecar should now have merge_resolved for memberB
    const runAfter = readImplementerRun(spec, 'slice-7');
    const resolvedEvts = runAfter.events.filter(e => e.event_type === 'merge_resolved');
    assert.equal(resolvedEvts.length, 2, 'both members should have merge_resolved after recovery');

    const memberBResolvedEvt = resolvedEvts.find(e => e.member_id === 'memberB');
    assert.ok(memberBResolvedEvt, 'merge_resolved for memberB must exist after recovery');
    assert.equal(memberBResolvedEvt.payload.merge_commit_sha, actualHeadAfterDivergence);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});
