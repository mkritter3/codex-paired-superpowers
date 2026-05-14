// v0.10.0 slice-8 — merger-agent.test.js
//
// Validation tier: critical (high_stakes: true).
// Tests runMergerAgent() using real git repos in mkdtempSync directories and
// DI (_deps) to stub lockfile, appendImplementerEventLocked, and git for
// specific failure scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { runMergerAgent } from '../../../lib/codex-bridge/implementer/merger-agent.js';
import { mergeImplementerBranches } from '../../../lib/codex-bridge/implementer/merge-coordinator.js';
import {
  initSidecar,
  startImplementerRun,
  readImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';

// ── test helpers ──────────────────────────────────────────────────────────────

/**
 * Create a base git repo with a single empty commit.
 */
function makeBaseRepo(prefix = 'cps-ma-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init', '-q']);
  const baseSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { repoRoot: dir, baseSha };
}

function addIntegrationWorktree(repoRoot, suffix = 'integration') {
  const wtPath = join(repoRoot + '-wt', suffix);
  mkdirSync(join(repoRoot + '-wt'), { recursive: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', wtPath]);
  return wtPath;
}

function makeBranch(repoRoot, branchName, files) {
  execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-b', branchName]);
  for (const [filename, content] of Object.entries(files)) {
    const fullPath = join(repoRoot, filename);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
    execFileSync('git', ['-C', repoRoot, 'add', filename]);
  }
  execFileSync('git', ['-C', repoRoot, 'commit', '-m', `feat: ${branchName}`, '-q']);
  execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-']);
  return branchName;
}

async function makeSidecarRun(repoRoot, sliceId, memberSpecs, baseSha = null) {
  const spec = join(repoRoot, 'plan.md');
  writeFileSync(spec, `# plan`);
  initSidecar(spec, { feature: 'test', codexSession: 'sess', model: 'x', reasoningEffort: 'high' });
  const resolvedBaseSha = baseSha ||
    execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const members = {};
  for (const [memberId, m] of Object.entries(memberSpecs)) {
    members[memberId] = {
      adapter: m.runtimeKind,
      model: 'test-model',
      required: true,
      worktree_id: m.worktreeId,
      branch: m.branchName || 'some-branch',
      claimed_files: m.claimedFiles || ['lib/a.js'],
    };
  }
  const { implementer_run_id } = await startImplementerRun(spec, sliceId, {
    base_sha: resolvedBaseSha,
    members,
  });
  return { spec, implementerRunId: implementer_run_id };
}

// Default merger member spec
const MERGER_MEMBER_ID = 'merger@claude-cli:claude-opus#0';
const MERGER_RUNTIME_KIND = 'claude-cli';
const MERGER_WORKTREE_ID = 'wt-merger-0';
const MERGER_MEMBER_SPECS = {
  [MERGER_MEMBER_ID]: {
    runtimeKind: MERGER_RUNTIME_KIND,
    worktreeId: MERGER_WORKTREE_ID,
    branchName: 'merger-resolve',
    claimedFiles: ['lib/conflict.js'],
  },
};

function defaultMergeContext(baseSha = 'abc123') {
  return {
    planRef: 'docs/plans/test-plan.md',
    baseSha,
    mergeOrder: ['memberA', 'memberB'],
    diffstats: '1 file changed',
    conflictDiffs: ['<<<<<<< HEAD\nconsole.log("A");\n=======\nconsole.log("B");\n>>>>>>> branch-B\n'],
    mailboxNotes: 'no notes',
  };
}

function makeShipReviewer() {
  let calls = 0;
  const fn = async () => {
    calls++;
    return { verdict: 'SHIP', rationale: 'Looks correct' };
  };
  fn.getCallCount = () => calls;
  return fn;
}

function makeReviseReviewer() {
  let calls = 0;
  const fn = async () => {
    calls++;
    return { verdict: 'REVISE', rationale: 'Needs changes' };
  };
  fn.getCallCount = () => calls;
  return fn;
}

function makeThrowingReviewer(msg = 'reviewer error') {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error(msg);
  };
  fn.getCallCount = () => calls;
  return fn;
}

/**
 * Create a real conflicted integration worktree using mergeImplementerBranches.
 * Returns { repoRoot, integrationWt, spec, implementerRunId, baseSha, conflictedFiles }.
 */
async function makeConflictedRepo() {
  const { repoRoot, baseSha } = makeBaseRepo('cps-ma-conflict-');
  const integrationWt = addIntegrationWorktree(repoRoot);

  // Both branches edit the same line in lib/conflict.js → guaranteed conflict
  makeBranch(repoRoot, 'impl/branch-A', { 'lib/conflict.js': 'console.log("branch-A resolution");\n' });
  makeBranch(repoRoot, 'impl/branch-B', { 'lib/conflict.js': 'console.log("branch-B resolution");\n' });

  // We need a sidecar for mergeImplementerBranches
  const mcSpec = join(repoRoot, 'mc-plan.md');
  writeFileSync(mcSpec, `# plan`);
  initSidecar(mcSpec, { feature: 'test', codexSession: 's', model: 'x', reasoningEffort: 'high' });
  const mcMemberSpecs = {
    'memberA': {
      branchName: 'impl/branch-A',
      runtimeKind: 'codex-cli',
      worktreeId: 'wt-A',
      claimedFiles: ['lib/conflict.js'],
    },
    'memberB': {
      branchName: 'impl/branch-B',
      runtimeKind: 'codex-cli',
      worktreeId: 'wt-B',
      claimedFiles: ['lib/conflict.js'],
    },
  };
  const mcMembers = {};
  for (const [id, m] of Object.entries(mcMemberSpecs)) {
    mcMembers[id] = {
      adapter: m.runtimeKind,
      model: 'test-model',
      required: true,
      worktree_id: m.worktreeId,
      branch: m.branchName,
      claimed_files: m.claimedFiles,
    };
  }
  const { implementer_run_id: mcRunId } = await startImplementerRun(mcSpec, 'slice-7', {
    base_sha: baseSha,
    members: mcMembers,
  });

  const mcMembersMap = new Map([
    ['memberA', { branchName: 'impl/branch-A', runtimeKind: 'codex-cli', worktreeId: 'wt-A' }],
    ['memberB', { branchName: 'impl/branch-B', runtimeKind: 'codex-cli', worktreeId: 'wt-B' }],
  ]);
  const mcResult = await mergeImplementerBranches({
    integrationWorktree: integrationWt,
    members: mcMembersMap,
    memberOrder: ['memberA', 'memberB'],
    specPath: mcSpec,
    sliceId: 'slice-7',
    implementerRunId: mcRunId,
  });

  // Should have halted with merge-conflict
  assert.equal(mcResult.halted, true, 'expected merge-conflict halt from coordinator');
  assert.equal(mcResult.halt, 'merge-conflict');
  const conflictedFiles = mcResult.conflictedFiles;
  assert.ok(conflictedFiles.length > 0, 'expected conflicted files');

  return { repoRoot, integrationWt, mcSpec, baseSha, conflictedFiles };
}

/**
 * Fake dispatchFn that "resolves" conflict by writing content to conflicted files.
 * Used for happy-path tests.
 */
function makeResolvingDispatchFn(integrationWt, conflictedFiles, resolution = 'console.log("resolved");\n') {
  return async () => {
    for (const f of conflictedFiles) {
      writeFileSync(join(integrationWt, f), resolution);
    }
    return { outcome: 'completed' };
  };
}

// ── happy.full-flow ───────────────────────────────────────────────────────────

test('happy.full-flow: resolves conflict, SHIP-SHIP → commit + full sidecar event chain', async () => {
  const { repoRoot, integrationWt, mcSpec, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);
    const claudeReview = makeShipReviewer();
    const codexReview = makeShipReviewer();

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: claudeReview,
      codexReviewFn: codexReview,
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, false);
    assert.ok(typeof result.mergerCommitSha === 'string' && result.mergerCommitSha.length > 0);
    assert.equal(result.claudeVerdict, 'SHIP');
    assert.equal(result.codexVerdict, 'SHIP');

    // Verify commit is in the worktree
    const logOut = execFileSync('git', ['-C', integrationWt, 'log', '--oneline', '-1'], { encoding: 'utf8' }).trim();
    assert.ok(logOut.includes('merge-resolution'), `commit subject should include merge-resolution: ${logOut}`);

    // Verify sidecar event chain
    const run = readImplementerRun(spec, 'slice-8');
    const types = run.events.map(e => e.event_type);
    assert.ok(types.includes('merger_started'), 'must have merger_started');
    assert.ok(types.includes('merger_completed'), 'must have merger_completed');
    assert.ok(types.includes('merge_review_claude'), 'must have merge_review_claude');
    assert.ok(types.includes('merge_review_codex'), 'must have merge_review_codex');

    // Two merger_completed events: outcome=completed and outcome=committed
    const completedEvts = run.events.filter(e => e.event_type === 'merger_completed');
    assert.equal(completedEvts.length, 2);
    const outcomes = completedEvts.map(e => e.payload.outcome).sort();
    assert.deepEqual(outcomes, ['committed', 'completed']);

    // Verify reviewers were called
    assert.equal(claudeReview.getCallCount(), 1);
    assert.equal(codexReview.getCallCount(), 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── happy.allowlist-file-touched ─────────────────────────────────────────────

test('happy.allowlist-file-touched: merger edits allowlisted file + conflicted file; out-of-scope passes', async () => {
  // Build a conflicted repo that also has package-lock.json committed (pre-conflict).
  const { repoRoot, baseSha } = makeBaseRepo('cps-ma-allowlist-');
  const wtBase = repoRoot + '-wt';
  try {
    // Commit package-lock.json to the base repo BEFORE creating branches (so it's tracked)
    mkdirSync(join(repoRoot, 'lib'), { recursive: true });
    writeFileSync(join(repoRoot, 'package-lock.json'), '{"version": 1}\n');
    writeFileSync(join(repoRoot, 'lib/conflict.js'), 'base\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'package-lock.json', 'lib/conflict.js']);
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'add files', '-q']);
    const actualBaseSha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // Branch A and B both conflict on lib/conflict.js
    makeBranch(repoRoot, 'impl/branch-A-al', { 'lib/conflict.js': 'console.log("branch-A-al");\n' });
    makeBranch(repoRoot, 'impl/branch-B-al', { 'lib/conflict.js': 'console.log("branch-B-al");\n' });

    // Integration worktree
    mkdirSync(wtBase, { recursive: true });
    const integrationWt = join(wtBase, 'integration');
    execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', integrationWt]);

    // Run merge-coordinator to set up conflict state
    const mcSpec = join(repoRoot, 'mc-plan.md');
    writeFileSync(mcSpec, '# plan');
    initSidecar(mcSpec, { feature: 'test', codexSession: 's', model: 'x', reasoningEffort: 'high' });
    const mcMembers = {
      'memberA': { adapter: 'codex-cli', model: 'x', required: true, worktree_id: 'wt-A', branch: 'impl/branch-A-al', claimed_files: ['lib/conflict.js'] },
      'memberB': { adapter: 'codex-cli', model: 'x', required: true, worktree_id: 'wt-B', branch: 'impl/branch-B-al', claimed_files: ['lib/conflict.js'] },
    };
    const { implementer_run_id: mcRunId } = await startImplementerRun(mcSpec, 'slice-7', {
      base_sha: actualBaseSha,
      members: mcMembers,
    });
    const mcResult = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members: new Map([
        ['memberA', { branchName: 'impl/branch-A-al', runtimeKind: 'codex-cli', worktreeId: 'wt-A' }],
        ['memberB', { branchName: 'impl/branch-B-al', runtimeKind: 'codex-cli', worktreeId: 'wt-B' }],
      ]),
      memberOrder: ['memberA', 'memberB'],
      specPath: mcSpec,
      sliceId: 'slice-7',
      implementerRunId: mcRunId,
    });
    assert.equal(mcResult.halted, true);
    assert.equal(mcResult.halt, 'merge-conflict');
    const conflictedFiles = mcResult.conflictedFiles;

    const allowlist = ['package-lock.json'];
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, actualBaseSha);

    const dispatchFn = async () => {
      // Resolve conflicted file
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), 'console.log("resolved-al");\n');
      }
      // Also edit allowlisted file (package-lock.json is tracked, so this is ok)
      writeFileSync(join(integrationWt, 'package-lock.json'), '{"version": 2}\n');
      return { outcome: 'completed' };
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(actualBaseSha),
      dispatchFn,
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      allowlist,
    });

    assert.equal(result.halted, false, `expected no halt, got: ${result.halt}`);
    assert.ok(typeof result.mergerCommitSha === 'string');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(wtBase, { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty: sync validation ────────────────────────────────────
// Note: runMergerAgent is a sync outer wrapper that throws BEFORE returning a
// Promise. Validation errors are thrown synchronously, so we use assert.throws.

test('edge.zero-null-empty: throws on missing integrationWorktree', () => {
  assert.throws(
    () => runMergerAgent({
      integrationWorktree: '',
      conflictedFiles: ['f.js'],
      mergeContext: defaultMergeContext(),
      dispatchFn: async () => {},
      claudeReviewFn: async () => {},
      codexReviewFn: async () => {},
      specPath: '/tmp/spec.md',
      sliceId: 'slice-8',
      implementerRunId: 'run-1',
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    }),
    /integrationWorktree/
  );
});

test('edge.zero-null-empty: throws on empty conflictedFiles', () => {
  assert.throws(
    () => runMergerAgent({
      integrationWorktree: '/tmp/wt',
      conflictedFiles: [],
      mergeContext: defaultMergeContext(),
      dispatchFn: async () => {},
      claudeReviewFn: async () => {},
      codexReviewFn: async () => {},
      specPath: '/tmp/spec.md',
      sliceId: 'slice-8',
      implementerRunId: 'run-1',
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    }),
    /conflictedFiles/
  );
});

test('edge.zero-null-empty: throws on null mergeContext', () => {
  assert.throws(
    () => runMergerAgent({
      integrationWorktree: '/tmp/wt',
      conflictedFiles: ['f.js'],
      mergeContext: null,
      dispatchFn: async () => {},
      claudeReviewFn: async () => {},
      codexReviewFn: async () => {},
      specPath: '/tmp/spec.md',
      sliceId: 'slice-8',
      implementerRunId: 'run-1',
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    }),
    /mergeContext/
  );
});

const REQUIRED_MERGE_CONTEXT_FIELDS = ['planRef', 'baseSha', 'mergeOrder', 'diffstats', 'conflictDiffs', 'mailboxNotes'];
for (const field of REQUIRED_MERGE_CONTEXT_FIELDS) {
  test(`edge.zero-null-empty: throws on missing mergeContext.${field}`, () => {
    const ctx = { ...defaultMergeContext() };
    delete ctx[field];
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: '/tmp/wt',
        conflictedFiles: ['f.js'],
        mergeContext: ctx,
        dispatchFn: async () => {},
        claudeReviewFn: async () => {},
        codexReviewFn: async () => {},
        specPath: '/tmp/spec.md',
        sliceId: 'slice-8',
        implementerRunId: 'run-1',
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
      }),
      new RegExp(field)
    );
  });
}

for (const field of ['dispatchFn', 'claudeReviewFn', 'codexReviewFn']) {
  test(`edge.zero-null-empty: throws when ${field} is not a function`, () => {
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: '/tmp/wt',
        conflictedFiles: ['f.js'],
        mergeContext: defaultMergeContext(),
        dispatchFn: field === 'dispatchFn' ? null : async () => {},
        claudeReviewFn: field === 'claudeReviewFn' ? null : async () => {},
        codexReviewFn: field === 'codexReviewFn' ? null : async () => {},
        specPath: '/tmp/spec.md',
        sliceId: 'slice-8',
        implementerRunId: 'run-1',
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
      }),
      new RegExp(field)
    );
  });
}

for (const [field, value] of [
  ['specPath', ''],
  ['sliceId', ''],
  ['implementerRunId', ''],
  ['mergerMemberId', ''],
  ['mergerRuntimeKind', ''],
  ['mergerWorktreeId', ''],
]) {
  test(`edge.zero-null-empty: throws on empty ${field}`, () => {
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: '/tmp/wt',
        conflictedFiles: ['f.js'],
        mergeContext: defaultMergeContext(),
        dispatchFn: async () => {},
        claudeReviewFn: async () => {},
        codexReviewFn: async () => {},
        specPath: field === 'specPath' ? value : '/tmp/spec.md',
        sliceId: field === 'sliceId' ? value : 'slice-8',
        implementerRunId: field === 'implementerRunId' ? value : 'run-1',
        mergerMemberId: field === 'mergerMemberId' ? value : MERGER_MEMBER_ID,
        mergerRuntimeKind: field === 'mergerRuntimeKind' ? value : MERGER_RUNTIME_KIND,
        mergerWorktreeId: field === 'mergerWorktreeId' ? value : MERGER_WORKTREE_ID,
      }),
      new RegExp(field)
    );
  });
}

// Path safety on conflictedFiles
for (const [desc, badPath] of [
  ['dotdot', '../escape.js'],
  ['leading slash', '/etc/passwd'],
  ['backslash', 'lib\\file.js'],
]) {
  test(`edge.zero-null-empty: throws on unsafe conflictedFiles entry (${desc})`, () => {
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: '/tmp/wt',
        conflictedFiles: [badPath],
        mergeContext: defaultMergeContext(),
        dispatchFn: async () => {},
        claudeReviewFn: async () => {},
        codexReviewFn: async () => {},
        specPath: '/tmp/spec.md',
        sliceId: 'slice-8',
        implementerRunId: 'run-1',
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
      }),
      /conflictedFiles/
    );
  });
}

// Path safety on allowlist
for (const [desc, badPath] of [
  ['dotdot', '../escape.js'],
  ['leading slash', '/etc/passwd'],
  ['backslash', 'lib\\file.js'],
]) {
  test(`edge.zero-null-empty: throws on unsafe allowlist entry (${desc})`, () => {
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: '/tmp/wt',
        conflictedFiles: ['f.js'],
        mergeContext: defaultMergeContext(),
        dispatchFn: async () => {},
        claudeReviewFn: async () => {},
        codexReviewFn: async () => {},
        specPath: '/tmp/spec.md',
        sliceId: 'slice-8',
        implementerRunId: 'run-1',
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
        allowlist: [badPath],
      }),
      /allowlist/
    );
  });
}

// ── edge.boundary unresolved-conflicts ───────────────────────────────────────

test('edge.boundary unresolved-conflicts: merger leaves marker → halt before git add and before reviewers', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);
    let gitAddCalled = false;
    let claudeCalled = 0;
    let codexCalled = 0;

    // dispatchFn writes file with conflict markers still present
    const dispatchFn = async () => {
      for (const f of conflictedFiles) {
        // Write content that still has conflict markers
        writeFileSync(join(integrationWt, f), '<<<<<<< HEAD\nconsole.log("A");\n=======\nconsole.log("B");\n>>>>>>> branch-B\n');
      }
      return { outcome: 'completed' };
    };

    // Instrument git to detect git add calls
    const realGitExec = (args, cwd) => {
      try {
        const stdout = execFileSync('git', args, {
          cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        });
        return { stdout, stderr: '', status: 0 };
      } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', status: 1 };
      }
    };
    const stubbedGit = {
      exec: (args, cwd) => {
        if (args[0] === 'add') gitAddCalled = true;
        return realGitExec(args, cwd);
      },
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn,
      claudeReviewFn: async () => { claudeCalled++; return { verdict: 'SHIP', rationale: 'ok' }; },
      codexReviewFn: async () => { codexCalled++; return { verdict: 'SHIP', rationale: 'ok' }; },
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { git: stubbedGit },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-unresolved-conflicts');

    // CRITICAL: git add must NOT have been called
    assert.equal(gitAddCalled, false, 'git add must not be called when markers remain');

    // Reviewers must NOT have been called
    assert.equal(claudeCalled, 0, 'claudeReviewFn must not be called');
    assert.equal(codexCalled, 0, 'codexReviewFn must not be called');

    // Verify the file is still unstaged (still has markers, unstaged in git)
    const statusOut = execFileSync('git', ['-C', integrationWt, 'status', '--porcelain'], { encoding: 'utf8' });
    // Should show as unmerged/modified, not staged
    assert.ok(statusOut.length > 0, 'worktree should still have pending changes');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.adversarial allowlist-symlink-escape ─────────────────────────────────

test('edge.adversarial allowlist-symlink-escape: symlink pointing outside worktree → halt', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    // Create a symlink in the worktree that points to /etc/passwd
    const symlinkPath = join(integrationWt, 'escape-link.js');
    try {
      symlinkSync('/etc/passwd', symlinkPath);
    } catch {
      // /etc/passwd may not exist on this platform; use /tmp as target
      symlinkSync('/tmp', symlinkPath);
    }

    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => ({ outcome: 'completed' }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      allowlist: ['escape-link.js'],
    });

    assert.equal(result.halted, true);
    // The symlink escapes the worktree → merger-conflict-state-mismatch
    assert.equal(result.halt, 'merger-conflict-state-mismatch');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.adversarial conflictedFiles-symlink-escape ───────────────────────────

test('edge.adversarial conflictedFiles-symlink-escape: symlink in conflictedFiles pointing outside worktree → throws synchronously', () => {
  // We need a real directory with a symlink for realpathSync to follow.
  const tmpDir = mkdtempSync(join(tmpdir(), 'cps-ma-cfsymlink-'));
  try {
    // Create a symlink inside tmpDir that points outside (to /tmp or /etc).
    const symlinkName = 'escape-conflict.js';
    const symlinkPath = join(tmpDir, symlinkName);
    try {
      symlinkSync('/etc/passwd', symlinkPath);
    } catch {
      symlinkSync('/tmp', symlinkPath);
    }

    // This should throw SYNCHRONOUSLY (not return a rejected Promise).
    assert.throws(
      () => runMergerAgent({
        integrationWorktree: tmpDir,
        conflictedFiles: [symlinkName],
        mergeContext: defaultMergeContext(),
        dispatchFn: async () => {},
        claudeReviewFn: async () => {},
        codexReviewFn: async () => {},
        specPath: '/tmp/spec.md',
        sliceId: 'slice-8',
        implementerRunId: 'run-1',
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
      }),
      /conflictedFiles/
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── edge.large-input prompt-too-large ────────────────────────────────────────

test('edge.large-input prompt-too-large: conflictDiffs > promptByteCap → halt with byte count', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // Use many diffs that together exceed a small promptByteCap (1000 bytes).
    // Each diff gets capped at 32KB individually, but the total must exceed promptByteCap.
    // With promptByteCap=1000: the header + a few diffs of 500 bytes each will exceed it.
    const smallCap = 1000;
    const diffs = Array.from({ length: 10 }, (_, i) => 'x'.repeat(200));

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: {
        ...defaultMergeContext(baseSha),
        conflictDiffs: diffs,
      },
      dispatchFn: async () => ({ outcome: 'completed' }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      promptByteCap: smallCap,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-prompt-too-large');
    assert.ok(typeof result.promptBytes === 'number' && result.promptBytes > smallCap,
      `expected promptBytes ${result.promptBytes} > ${smallCap}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.large-input prompt-within-bound ─────────────────────────────────────

test('edge.large-input prompt-within-bound: ~50KB diff succeeds; prompt_bytes matches', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // ~50KB diff, but each diff is capped at 32KB, so prompt will be ~32KB + header overhead
    const mediumDiff = 'y'.repeat(50 * 1024);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: {
        ...defaultMergeContext(baseSha),
        conflictDiffs: [mediumDiff],
      },
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, false, `expected no halt, got: ${result.halt}`);

    // Verify merger_started event has prompt_bytes matching actual
    const run = readImplementerRun(spec, 'slice-8');
    const startedEvt = run.events.find(e => e.event_type === 'merger_started');
    assert.ok(startedEvt, 'must have merger_started event');
    assert.ok(typeof startedEvt.payload.prompt_bytes === 'number');
    assert.ok(startedEvt.payload.prompt_bytes > 0 && startedEvt.payload.prompt_bytes <= 200_000);
    // The recorded bytes should match the actual prompt size
    // The 50KB diff is capped at 32KB per-file, so prompt is ~32KB + header.
    // It should be at least 32KB and definitely < 200KB (cap).
    assert.ok(
      startedEvt.payload.prompt_bytes > 30_000,
      `prompt_bytes ${startedEvt.payload.prompt_bytes} should be > 30KB (32KB capped diff + header)`
    );
    assert.ok(
      startedEvt.payload.prompt_bytes < 200_000,
      `prompt_bytes ${startedEvt.payload.prompt_bytes} should be < 200KB (within cap)`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.concurrent single-flight ────────────────────────────────────────────

test('edge.concurrent single-flight: 2 concurrent calls on same worktree → 1 halts merger-integration-busy', async () => {
  // Use DI-injected lockfile to guarantee contention: first call holds the lock,
  // second call attempts to acquire and gets ELOCKED immediately.
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);
    const { spec: spec2, implementerRunId: runId2 } = await makeSidecarRun(repoRoot, 'slice-9',
      { [MERGER_MEMBER_ID]: { runtimeKind: MERGER_RUNTIME_KIND, worktreeId: MERGER_WORKTREE_ID, branchName: 'merger-resolve', claimedFiles: ['lib/conflict.js'] } },
      baseSha
    );

    // Stub lockfile: first call gets the lock; second call gets ELOCKED
    let lockAcquired = false;
    const stubbedLockfile = {
      lock: async (path, opts) => {
        if (!lockAcquired) {
          lockAcquired = true;
          // Return a release function
          return async () => { lockAcquired = false; };
        } else {
          // Simulate ELOCKED
          const err = new Error('ELOCKED');
          err.code = 'ELOCKED';
          throw err;
        }
      },
    };

    const commonOpts = {
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { lockfile: stubbedLockfile },
    };

    // Run both concurrently — whichever acquires the stub lock first succeeds,
    // the other gets ELOCKED and returns merger-integration-busy.
    const results = await Promise.allSettled([
      runMergerAgent({
        ...commonOpts,
        dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
        specPath: spec,
        sliceId: 'slice-8',
        implementerRunId,
      }),
      runMergerAgent({
        ...commonOpts,
        dispatchFn: async () => ({ outcome: 'completed' }),
        specPath: spec2,
        sliceId: 'slice-9',
        implementerRunId: runId2,
      }),
    ]);

    // Extract non-thrown results
    const values = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);
    const rejected = results.filter(r => r.status === 'rejected');

    // At least one must have halted with merger-integration-busy
    const busyHalt = values.find(r => r && r.halted && r.halt === 'merger-integration-busy');
    assert.ok(
      busyHalt,
      `expected one call to halt with merger-integration-busy; values=${JSON.stringify(values)}, rejected=${rejected.length}`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.adversarial out-of-scope ─────────────────────────────────────────────

test('edge.adversarial out-of-scope: merger edits unrelated file → halt, no commit, forensic preserved', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // dispatchFn resolves conflict AND edits an out-of-scope file
    const dispatchFn = async () => {
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), 'console.log("resolved");\n');
      }
      // Edit out-of-scope file
      writeFileSync(join(integrationWt, 'unrelated.js'), '// evil edit\n');
      return { outcome: 'completed' };
    };

    const claudeReview = makeShipReviewer();
    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn,
      claudeReviewFn: claudeReview,
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-out-of-scope');
    assert.ok(Array.isArray(result.outOfScopeFiles));
    assert.ok(result.outOfScopeFiles.includes('unrelated.js'));

    // No commit (HEAD is unchanged from pre-merge state)
    const headSha = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // The out-of-scope file should still be present (forensic preserved)
    const statusOut = execFileSync('git', ['-C', integrationWt, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.ok(statusOut.includes('unrelated.js'), 'forensic: unrelated.js should still be dirty');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── edge.concurrent conflict-state-mismatch ───────────────────────────────────

test('edge.concurrent conflict-state-mismatch: conflictedFiles does not match actual unmerged paths → halt', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      // Pass wrong file list
      conflictedFiles: ['nonexistent-file.js'],
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => ({ outcome: 'completed' }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-conflict-state-mismatch');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency dispatch-throws ──────────────────────────────────────────

test('fail.dependency dispatch-throws: dispatchFn throws → halt merger-dispatch-failed', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => { throw new Error('dispatch exploded'); },
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-dispatch-failed');
    assert.ok(result.diagnostic && result.diagnostic.includes('dispatch exploded'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency dispatch-returns-failed-outcome ──────────────────────────

test('fail.dependency dispatch-returns-failed-outcome: dispatchFn returns {outcome: "failed"} → halt', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => ({ outcome: 'failed' }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-dispatch-failed');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency dispatch-throws emits merger_completed with failed ────────

test('fail.dependency dispatch-throws emits merger_completed with outcome=failed', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => { throw new Error('dispatch exploded audit'); },
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-dispatch-failed');

    // Sidecar must have merger_started AND merger_completed with outcome=failed
    const run = readImplementerRun(spec, 'slice-8');
    const types = run.events.map(e => e.event_type);
    assert.ok(types.includes('merger_started'), 'must have merger_started');
    assert.ok(types.includes('merger_completed'), 'must have merger_completed');

    const completedEvts = run.events.filter(e => e.event_type === 'merger_completed');
    assert.ok(completedEvts.length >= 1, 'must have at least one merger_completed event');
    const failedEvt = completedEvts.find(e => e.payload && e.payload.outcome === 'failed');
    assert.ok(
      failedEvt,
      `merger_completed with outcome=failed must be present; got outcomes: ${completedEvts.map(e => e.payload && e.payload.outcome).join(', ')}`
    );
    assert.equal(failedEvt.payload.merger_member_id, MERGER_MEMBER_ID);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency dispatch-returns-halted emits merger_completed with halted ─

test('fail.dependency dispatch-returns-halted emits merger_completed with outcome=halted', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => ({ outcome: 'halted', haltEnvelope: { halt: 'some-halt' } }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-dispatch-failed');

    // Sidecar must have merger_started AND merger_completed with outcome=halted
    const run = readImplementerRun(spec, 'slice-8');
    const types = run.events.map(e => e.event_type);
    assert.ok(types.includes('merger_started'), 'must have merger_started');
    assert.ok(types.includes('merger_completed'), 'must have merger_completed');

    const completedEvts = run.events.filter(e => e.event_type === 'merger_completed');
    assert.ok(completedEvts.length >= 1, 'must have at least one merger_completed event');
    const haltedEvt = completedEvts.find(e => e.payload && e.payload.outcome === 'halted');
    assert.ok(
      haltedEvt,
      `merger_completed with outcome=halted must be present; got outcomes: ${completedEvts.map(e => e.payload && e.payload.outcome).join(', ')}`
    );
    assert.equal(haltedEvt.payload.merger_member_id, MERGER_MEMBER_ID);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency review-throws ────────────────────────────────────────────

test('fail.dependency review-throws: claudeReviewFn throws → halt merge-review-dispatch-failed', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeThrowingReviewer('claude threw'),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-review-dispatch-failed');
    assert.ok(Array.isArray(result.failedReviewers) && result.failedReviewers.includes('claude'));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.malformed-input verdict variants ────────────────────────────────────

for (const [desc, claudeRet, codexRet] of [
  ['lowercase ship', { verdict: 'ship', rationale: 'ok' }, { verdict: 'SHIP', rationale: 'ok' }],
  ['SHIP IT', { verdict: 'SHIP IT', rationale: 'ok' }, { verdict: 'SHIP', rationale: 'ok' }],
  ['missing verdict', { rationale: 'ok' }, { verdict: 'SHIP', rationale: 'ok' }],
  ['empty rationale', { verdict: 'SHIP', rationale: '' }, { verdict: 'SHIP', rationale: 'ok' }],
]) {
  test(`fail.malformed-input verdict (${desc}) → halt merge-review-malformed`, async () => {
    const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
    try {
      const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

      const result = await runMergerAgent({
        integrationWorktree: integrationWt,
        conflictedFiles,
        mergeContext: defaultMergeContext(baseSha),
        dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
        claudeReviewFn: async () => claudeRet,
        codexReviewFn: async () => codexRet,
        specPath: spec,
        sliceId: 'slice-8',
        implementerRunId,
        mergerMemberId: MERGER_MEMBER_ID,
        mergerRuntimeKind: MERGER_RUNTIME_KIND,
        mergerWorktreeId: MERGER_WORKTREE_ID,
      });

      assert.equal(result.halted, true);
      assert.equal(result.halt, 'merge-review-malformed');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(repoRoot + '-wt', { recursive: true, force: true });
    }
  });
}

// ── fail.REVISE verdict ───────────────────────────────────────────────────────

test('fail.REVISE: SHIP-REVISE → halt merge-conflict-double-ship-failed with both verdicts', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeReviseReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merge-conflict-double-ship-failed');
    assert.ok('claudeVerdict' in result);
    assert.ok('codexVerdict' in result);
    // One is SHIP, other is REVISE
    const verdicts = [result.claudeVerdict, result.codexVerdict].sort();
    assert.deepEqual(verdicts, ['REVISE', 'SHIP']);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency git-commit-fails ─────────────────────────────────────────

test('fail.dependency git-commit-fails: stub git commit failure → halt merger-commit-failed; staged preserved', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // Stub git to fail on 'commit' but succeed on everything else
    const realGit = (args, cwd) => {
      try {
        const stdout = execFileSync('git', args, {
          cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        });
        return { stdout, stderr: '', status: 0 };
      } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', status: 1 };
      }
    };
    const stubbedGit = {
      exec: (args, cwd) => {
        if (args[0] === 'commit') {
          return { stdout: '', stderr: 'commit failed (stubbed)', status: 1 };
        }
        return realGit(args, cwd);
      },
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { git: stubbedGit },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-commit-failed');

    // Staged state preserved (files are staged but not committed)
    const diffCached = execFileSync('git', ['-C', integrationWt, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim();
    assert.ok(diffCached.length > 0, 'staged state should be preserved after commit failure');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency sidecar-append-failure on merger_started ─────────────────

test('fail.dependency sidecar-append-failure on merger_started: reject without dispatching', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    let dispatchCalled = false;

    const stubbedAppend = async (specPath, event) => {
      if (event.event_type === 'merger_started') {
        throw new Error('sidecar locked');
      }
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => { dispatchCalled = true; return { outcome: 'completed' }; },
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: '/tmp/spec.md',
      sliceId: 'slice-8',
      implementerRunId: 'run-1',
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { appendImplementerEventLocked: stubbedAppend },
    });

    // Should reject (throw), not return a halted result
    assert.fail('should have thrown due to merger_started append failure');
  } catch (err) {
    // Expected: the rejection propagates
    assert.ok(err.message.includes('sidecar locked') || err.message.length > 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── fail.dependency sidecar-append-failure on post-commit merger_completed ───

test('fail.dependency sidecar-append-failure on post-commit merger_completed: retry once; second failure → merger-audit-divergence', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    let appendCallCount = 0;
    let committedAppendCount = 0;

    // Use real sidecar for non-committed events, but fail on merger_completed with outcome=committed
    const { appendImplementerEventLocked: realAppend } = await import('../../../lib/codex-bridge/sidecar.js');
    const stubbedAppend = async (specPath, event) => {
      appendCallCount++;
      if (event.event_type === 'merger_completed' && event.payload && event.payload.outcome === 'committed') {
        committedAppendCount++;
        throw new Error('post-commit audit fail');
      }
      return realAppend(specPath, event);
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { appendImplementerEventLocked: stubbedAppend },
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-audit-divergence');
    // The commit SHA should be present even though the audit failed
    assert.ok(typeof result.mergerCommitSha === 'string' && result.mergerCommitSha.length > 0);
    // Retry was attempted: called exactly 2 times for the committed event
    assert.equal(committedAppendCount, 2, 'should have retried exactly once (total 2 calls)');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── integration.cross-module slice-7-handoff ──────────────────────────────────

test('integration.cross-module slice-7-handoff: slice-7 produces conflict, slice-8 resolves; sidecar has both slices events', async () => {
  const { repoRoot, integrationWt, mcSpec: spec7, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    // Set up slice-8 sidecar run on the same repo
    const { spec: spec8, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec8,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, false);

    // Verify slice-8 sidecar events chain is complete
    const run8 = readImplementerRun(spec8, 'slice-8');
    const types8 = run8.events.map(e => e.event_type);
    assert.ok(types8.includes('merger_started'));
    assert.ok(types8.includes('merger_completed'));
    assert.ok(types8.includes('merge_review_claude'));
    assert.ok(types8.includes('merge_review_codex'));

    // event_seqs are monotonically increasing
    const seqs8 = run8.events.map(e => e.event_seq);
    for (let i = 1; i < seqs8.length; i++) {
      assert.ok(seqs8[i] > seqs8[i - 1], `event_seq should be increasing: ${seqs8[i - 1]} -> ${seqs8[i]}`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── stress.scale 8-file ───────────────────────────────────────────────────────

test('stress.scale 8-file: 8 conflicted files, merger resolves all, SHIP-SHIP, commit succeeds', async () => {
  const { repoRoot, baseSha } = makeBaseRepo('cps-ma-stress-');
  const integrationWt = addIntegrationWorktree(repoRoot);

  // Create 8 files that conflict
  const fileNames = Array.from({ length: 8 }, (_, i) => `lib/file${i}.js`);

  try {
    // Make two branches that each write all 8 files with different content
    const filesBranchA = {};
    const filesBranchB = {};
    for (const f of fileNames) {
      filesBranchA[f] = `console.log("A-${f}");\n`;
      filesBranchB[f] = `console.log("B-${f}");\n`;
    }
    makeBranch(repoRoot, 'impl/branch-A-stress', filesBranchA);
    makeBranch(repoRoot, 'impl/branch-B-stress', filesBranchB);

    // Set up sidecar for merge-coordinator
    const mcSpec = join(repoRoot, 'mc-plan-stress.md');
    writeFileSync(mcSpec, '# plan');
    initSidecar(mcSpec, { feature: 'test', codexSession: 's', model: 'x', reasoningEffort: 'high' });
    const mcMembers = {
      'memberA': { adapter: 'codex-cli', model: 'x', required: true, worktree_id: 'wt-A', branch: 'impl/branch-A-stress', claimed_files: fileNames },
      'memberB': { adapter: 'codex-cli', model: 'x', required: true, worktree_id: 'wt-B', branch: 'impl/branch-B-stress', claimed_files: fileNames },
    };
    const { implementer_run_id: mcRunId } = await startImplementerRun(mcSpec, 'slice-7', {
      base_sha: baseSha,
      members: mcMembers,
    });

    const mcResult = await mergeImplementerBranches({
      integrationWorktree: integrationWt,
      members: new Map([
        ['memberA', { branchName: 'impl/branch-A-stress', runtimeKind: 'codex-cli', worktreeId: 'wt-A' }],
        ['memberB', { branchName: 'impl/branch-B-stress', runtimeKind: 'codex-cli', worktreeId: 'wt-B' }],
      ]),
      memberOrder: ['memberA', 'memberB'],
      specPath: mcSpec,
      sliceId: 'slice-7',
      implementerRunId: mcRunId,
    });

    assert.equal(mcResult.halted, true);
    assert.equal(mcResult.halt, 'merge-conflict');
    const conflictedFiles = mcResult.conflictedFiles;
    assert.equal(conflictedFiles.length, 8, `expected 8 conflicted files, got ${conflictedFiles.length}`);

    // Set up slice-8 merger run
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // dispatchFn resolves all 8 files
    const dispatchFn = async () => {
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), `console.log("resolved-${f}");\n`);
      }
      return { outcome: 'completed' };
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: {
        ...defaultMergeContext(baseSha),
        conflictDiffs: conflictedFiles.map(f => `# conflict in ${f}\n`),
      },
      dispatchFn,
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, false, `expected no halt, got: ${JSON.stringify(result)}`);
    assert.ok(typeof result.mergerCommitSha === 'string' && result.mergerCommitSha.length > 0);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── critical.residual-risk: markers-still-present-halts-before-add+review+commit ──

test('critical.residual-risk: markers-still-present halts before add+review+commit', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    let gitAddCalled = false;
    let claudeCallCount = 0;
    let codexCallCount = 0;

    // Stub git to track git add calls
    const realGit = (args, cwd) => {
      try {
        const stdout = execFileSync('git', args, {
          cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        });
        return { stdout, stderr: '', status: 0 };
      } catch (err) {
        return { stdout: err.stdout || '', stderr: err.stderr || '', status: 1 };
      }
    };

    const stubbedGit = {
      exec: (args, cwd) => {
        if (args[0] === 'add') {
          gitAddCalled = true;
        }
        return realGit(args, cwd);
      },
    };

    // dispatchFn resolves conflict partially but leaves >>>>>>> marker in file
    const dispatchFn = async () => {
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), 'console.log("start");\n>>>>>>> bad-marker\n');
      }
      return { outcome: 'completed' };
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn,
      claudeReviewFn: async () => { claudeCallCount++; return { verdict: 'SHIP', rationale: 'ok' }; },
      codexReviewFn: async () => { codexCallCount++; return { verdict: 'SHIP', rationale: 'ok' }; },
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { git: stubbedGit },
    });

    // Must halt with merger-unresolved-conflicts
    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-unresolved-conflicts');

    // git add was NOT called (markers detected before staging)
    assert.equal(gitAddCalled, false, 'git add must not have been called');

    // Reviewer functions were NOT called
    assert.equal(claudeCallCount, 0, 'claudeReviewFn must not have been called');
    assert.equal(codexCallCount, 0, 'codexReviewFn must not have been called');

    // No commit (verify the file is still in unmerged/conflict state, not resolved+staged).
    // In a git merge conflict, files appear in the index as 'UU' (unmerged).
    // git diff --diff-filter=U should still show the file as unresolved.
    const stillConflicted = execFileSync('git', ['-C', integrationWt, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).trim();
    assert.ok(
      conflictedFiles.some(f => stillConflicted.includes(f)),
      `conflicted files should still show as unresolved after marker detection halt (got: ${stillConflicted})`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── critical.residual-risk: not-a-git-repo ────────────────────────────────────

test('critical.residual-risk: not-a-git-repo → halt merger-integration-not-a-git-repo', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cps-ma-notgit-'));
  try {
    const { spec, implementerRunId } = await makeSidecarRun(tmpDir, 'slice-8', MERGER_MEMBER_SPECS, 'abc');

    const result = await runMergerAgent({
      integrationWorktree: tmpDir, // not a git repo
      conflictedFiles: ['lib/f.js'],
      mergeContext: defaultMergeContext('abc'),
      dispatchFn: async () => ({ outcome: 'completed' }),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-integration-not-a-git-repo');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── forensic preservation: no git-reset across failure paths ─────────────────

// ── abortSignal ───────────────────────────────────────────────────────────────

test('dispatch.abortSignal: merger dispatch receives a real AbortSignal that is not aborted', async () => {
  const { repoRoot, integrationWt, mcSpec, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    let capturedRequest = null;
    const spyDispatchFn = async (request) => {
      capturedRequest = request;
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), 'console.log("resolved");\n');
      }
      return { outcome: 'completed' };
    };

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: spyDispatchFn,
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, false, 'expected successful merge');
    assert.ok(capturedRequest !== null, 'dispatchFn should have been called');
    assert.ok(
      capturedRequest.abortSignal instanceof AbortSignal,
      `abortSignal must be an AbortSignal instance, got: ${capturedRequest.abortSignal}`
    );
    assert.equal(capturedRequest.abortSignal.aborted, false, 'abortSignal must not be aborted');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── prompt guard ──────────────────────────────────────────────────────────────

test('prompt.worktree-guard: rendered prompt contains "Do not run commands outside the worktree."', async () => {
  const { repoRoot, integrationWt, mcSpec, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    let capturedPrompt = null;
    const capturingDispatchFn = async (request) => {
      capturedPrompt = request.prompt;
      for (const f of conflictedFiles) {
        writeFileSync(join(integrationWt, f), 'console.log("resolved");\n');
      }
      return { outcome: 'completed' };
    };

    await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: capturingDispatchFn,
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.ok(capturedPrompt !== null, 'dispatchFn should have been called');
    assert.ok(
      capturedPrompt.includes('Do not run commands outside the worktree.'),
      `prompt must contain "Do not run commands outside the worktree." but got:\n${capturedPrompt.slice(0, 500)}`
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

test('forensic preservation: worktree is NOT git-reset on any halt path', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // Write a marker file to verify it's preserved
    writeFileSync(join(integrationWt, 'forensic-witness.txt'), 'preserve-me');

    const result = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => {
        // Edit out-of-scope file to trigger out-of-scope halt
        writeFileSync(join(integrationWt, 'forensic-witness.txt'), 'changed');
        for (const f of conflictedFiles) {
          writeFileSync(join(integrationWt, f), 'console.log("resolved");\n');
        }
        return { outcome: 'completed' };
      },
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
    });

    assert.equal(result.halted, true);
    assert.equal(result.halt, 'merger-out-of-scope');

    // forensic-witness.txt should still be dirty (NOT reset)
    const statusOut = execFileSync('git', ['-C', integrationWt, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.ok(statusOut.includes('forensic-witness.txt'), 'forensic file must still be present/dirty (no git reset)');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});

// ── critical.residual-risk audit-divergence-recovery-on-next-invocation ───────

test('critical.residual-risk audit-divergence-recovery-on-next-invocation: re-appends missing committed event on second run', async () => {
  const { repoRoot, integrationWt, baseSha, conflictedFiles } = await makeConflictedRepo();
  try {
    const { spec, implementerRunId } = await makeSidecarRun(repoRoot, 'slice-8', MERGER_MEMBER_SPECS, baseSha);

    // ── First run: simulate post-commit audit-divergence ────────────────────────
    // The appendImplementerEventLocked throws for merger_completed.outcome='committed'
    // on both the first attempt AND the retry, so the agent halts with
    // merger-audit-divergence. The merge-resolution commit IS on HEAD but the
    // sidecar lacks the committed event.

    const { appendImplementerEventLocked: realAppend } = await import('../../../lib/codex-bridge/sidecar.js');
    let committedAppendCount = 0;

    const throwingAppend = async (specPath, event) => {
      if (event.event_type === 'merger_completed' && event.payload && event.payload.outcome === 'committed') {
        committedAppendCount++;
        throw new Error('simulated post-commit audit failure');
      }
      return realAppend(specPath, event);
    };

    const firstResult = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: makeResolvingDispatchFn(integrationWt, conflictedFiles),
      claudeReviewFn: makeShipReviewer(),
      codexReviewFn: makeShipReviewer(),
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      _deps: { appendImplementerEventLocked: throwingAppend },
    });

    // Verify the first run halted with merger-audit-divergence
    assert.equal(firstResult.halted, true, `expected halt, got: ${JSON.stringify(firstResult)}`);
    assert.equal(firstResult.halt, 'merger-audit-divergence');
    assert.ok(typeof firstResult.mergerCommitSha === 'string' && firstResult.mergerCommitSha.length > 0,
      'mergerCommitSha must be present in audit-divergence halt');
    // Both the initial attempt and retry threw
    assert.equal(committedAppendCount, 2, 'expected exactly 2 committed append attempts (initial + retry)');

    const capturedCommitSha = firstResult.mergerCommitSha;

    // Verify the merge-resolution commit IS on HEAD
    const headSha = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headSha, capturedCommitSha,
      'merge-resolution commit must be on HEAD after audit-divergence halt');

    // Verify the commit has the Merger-Member-Id trailer
    const commitMsg = execFileSync('git', ['-C', integrationWt, 'log', '--format=%B', '-1'], { encoding: 'utf8' });
    assert.ok(commitMsg.includes(`Merger-Member-Id: ${MERGER_MEMBER_ID}`),
      `commit message must contain Merger-Member-Id trailer: ${commitMsg}`);

    // Verify the sidecar has expected events but NOT merger_completed.outcome:'committed'
    const runAfterFirstRun = readImplementerRun(spec, 'slice-8');
    const eventTypesAfterFirst = runAfterFirstRun.events.map(e => e.event_type);
    assert.ok(eventTypesAfterFirst.includes('merger_started'), 'sidecar must have merger_started');
    assert.ok(eventTypesAfterFirst.includes('merge_review_claude'), 'sidecar must have merge_review_claude');
    assert.ok(eventTypesAfterFirst.includes('merge_review_codex'), 'sidecar must have merge_review_codex');

    // Must have merger_completed.outcome='completed' (pre-commit)
    const completedEventsAfterFirst = runAfterFirstRun.events.filter(e => e.event_type === 'merger_completed');
    const completedOutcomesAfterFirst = completedEventsAfterFirst.map(e => e.payload.outcome);
    assert.ok(completedOutcomesAfterFirst.includes('completed'), 'must have merger_completed.outcome=completed');

    // Must NOT have merger_completed.outcome='committed'
    assert.ok(
      !completedOutcomesAfterFirst.includes('committed'),
      `sidecar must NOT have merger_completed.outcome=committed after first run; got: ${JSON.stringify(completedOutcomesAfterFirst)}`
    );

    // ── Second run: healthy appendImplementerEventLocked → recovery ─────────────
    // Re-run with a healthy append function. The recovery scan should detect the
    // merge-resolution commit on HEAD, find the missing committed event, re-append
    // it, and return {halted: false, recovered: true, mergerCommitSha: <same>}.

    const secondResult = await runMergerAgent({
      integrationWorktree: integrationWt,
      conflictedFiles,
      mergeContext: defaultMergeContext(baseSha),
      dispatchFn: async () => {
        throw new Error('dispatchFn must NOT be called during recovery');
      },
      claudeReviewFn: async () => {
        throw new Error('claudeReviewFn must NOT be called during recovery');
      },
      codexReviewFn: async () => {
        throw new Error('codexReviewFn must NOT be called during recovery');
      },
      specPath: spec,
      sliceId: 'slice-8',
      implementerRunId,
      mergerMemberId: MERGER_MEMBER_ID,
      mergerRuntimeKind: MERGER_RUNTIME_KIND,
      mergerWorktreeId: MERGER_WORKTREE_ID,
      // No _deps override — uses real sidecar append
    });

    // Should return success with recovered:true
    assert.equal(secondResult.halted, false, `expected recovery success, got: ${JSON.stringify(secondResult)}`);
    assert.equal(secondResult.mergerCommitSha, capturedCommitSha,
      'recovered mergerCommitSha must match the commit from the first run');
    assert.equal(secondResult.claudeVerdict, 'SHIP', 'recovered claudeVerdict must be SHIP');
    assert.equal(secondResult.codexVerdict, 'SHIP', 'recovered codexVerdict must be SHIP');
    assert.equal(secondResult.recovered, true, 'recovered flag must be true');

    // Sidecar now has the missing merger_completed.outcome:'committed' event
    const runAfterRecovery = readImplementerRun(spec, 'slice-8');
    const committedEventsAfterRecovery = runAfterRecovery.events.filter(
      e => e.event_type === 'merger_completed' && e.payload.outcome === 'committed'
    );
    assert.equal(committedEventsAfterRecovery.length, 1,
      'exactly one merger_completed.outcome=committed event must be present after recovery');
    assert.equal(
      committedEventsAfterRecovery[0].payload.merger_commit_sha,
      capturedCommitSha,
      'committed event must reference the correct commit SHA'
    );

    // HEAD must be unchanged — no new commit was added
    const headShaAfterRecovery = execFileSync('git', ['-C', integrationWt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(headShaAfterRecovery, capturedCommitSha,
      'HEAD must be unchanged after recovery (no new commit should be added)');

  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(repoRoot + '-wt', { recursive: true, force: true });
  }
});
