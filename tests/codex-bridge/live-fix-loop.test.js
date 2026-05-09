import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { packageFailureContext, createLiveFixLoop } from '../../lib/codex-bridge/live-fix-loop.js';

// Helper: init a fresh git repo with a conforming initial commit, return { dir, lastCommitSha }
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'flp-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'init');
  execSync('git add README.md', { cwd: dir });
  execSync(
    'git commit -m "feat(slice:1): init" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
    { cwd: dir }
  );
  const lastCommitSha = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  return { dir, lastCommitSha };
}

// ---------------------------------------------------------------------------
// 1. Failure context packaging — pure function, no side effects
// ---------------------------------------------------------------------------

test('packageFailureContext returns structured payload with all required fields', () => {
  const scenario = { id: 'lv-001', title: 'Save display name', risk: 'happy-path' };
  const evidence = {
    evidence_paths: ['evidence/slice-1/lv-001/attempt-1/before.png', 'evidence/slice-1/lv-001/attempt-1/after.png'],
    slice_diff: 'diff --git a/server.js b/server.js\n...',
    git_status: 'M server.js',
    test_output: 'AssertionError: displayed name not updated',
  };

  const ctx = packageFailureContext({ scenario, ...evidence });

  assert.deepEqual(ctx.scenario, scenario);
  assert.deepEqual(ctx.evidence_paths, evidence.evidence_paths);
  assert.equal(ctx.slice_diff, evidence.slice_diff);
  assert.equal(ctx.git_status, evidence.git_status);
  assert.equal(ctx.test_output, evidence.test_output);
  // All required keys must be present
  const allowedKeys = ['scenario', 'evidence_paths', 'slice_diff', 'git_status', 'test_output'];
  for (const k of allowedKeys) assert.ok(k in ctx, `missing key: ${k}`);
});

// ---------------------------------------------------------------------------
// 2. Codex diagnosis dispatch — stub Codex caller records call args
// ---------------------------------------------------------------------------

test('fix-loop calls codexCaller with the failure context payload', async () => {
  const { dir, lastCommitSha } = initRepo();

  const codexCalls = [];
  const scenarios = [
    { id: 'lv-001', title: 'Save display name' },
    { id: 'lv-002', title: 'Show recent saves' },
  ];

  const stubCodex = async (prompt) => {
    codexCalls.push(prompt);
    return { content: 'Diagnosis: save handler uses wrong field name' };
  };
  const stubSubagent = async () => ({ status: 'DONE', commits: [] });
  const stubRunner = { runScenario: async () => ({ status: 'passed' }) };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'fail' }];
  await loop.runFixLoop('slice-1', scenarios, initialFailures);

  assert.ok(codexCalls.length >= 1, 'codexCaller should have been called at least once');
  const firstCall = codexCalls[0];
  assert.ok(typeof firstCall === 'string', 'codexCaller prompt should be a string');
  assert.ok(
    firstCall.includes('lv-001') || firstCall.includes('Save display name'),
    'prompt should reference the failing scenario'
  );
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Fix-subagent dispatched with diagnosis + Commit Conventions
// ---------------------------------------------------------------------------

test('fix-loop dispatches subagent with diagnosis text + Commit Conventions + slice number', async () => {
  const { dir, lastCommitSha } = initRepo();

  const subagentCalls = [];
  const scenarios = [{ id: 'lv-001', title: 'Save display name' }];

  const stubCodex = async () => ({ content: 'The save handler writes to the wrong field.' });
  const stubSubagent = async (args) => {
    subagentCalls.push(args);
    return { status: 'DONE', commits: [] };
  };
  const stubRunner = { runScenario: async () => ({ status: 'passed' }) };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'failed' }];
  await loop.runFixLoop('slice-1', scenarios, initialFailures);

  assert.ok(subagentCalls.length >= 1, 'subagentDispatcher should have been called');
  const { prompt } = subagentCalls[0];
  assert.ok(typeof prompt === 'string', 'subagent prompt should be a string');
  // Must reference slice
  assert.ok(
    prompt.includes('slice-1') || prompt.includes('slice:1'),
    'prompt must reference the slice'
  );
  // Must include Commit Conventions
  assert.ok(prompt.includes('Co-Authored-By'), 'prompt must include Co-Authored-By trailer convention');
  assert.ok(
    prompt.includes('feat') || prompt.includes('fix') || prompt.includes('chore'),
    'prompt must include allowed commit type prefixes'
  );
  // Must include diagnosis text
  assert.ok(
    prompt.includes('The save handler writes to the wrong field.'),
    'prompt must include codex diagnosis text'
  );
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. Reconciliation walks last_commit_sha..HEAD and verifies conventions
// ---------------------------------------------------------------------------

test('reconciliation: conforming commit returns shipped outcome', async () => {
  const { dir, lastCommitSha } = initRepo();

  // Pre-seed a conforming commit that looks like a subagent fix
  writeFileSync(join(dir, 'fix.js'), 'fixed');
  execSync('git add fix.js', { cwd: dir });
  execSync(
    'git commit -m "fix(slice:1): live-verification fix - lv-001 save display name" -m "Co-Authored-By: Claude <noreply@anthropic.com>"',
    { cwd: dir }
  );

  const scenarios = [{ id: 'lv-001', title: 'Save display name' }];
  const stubCodex = async () => ({ content: 'Diagnosis here' });
  const stubSubagent = async () => ({ status: 'DONE', commits: [] });
  const stubRunner = { runScenario: async () => ({ status: 'passed' }) };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'failed' }];
  const result = await loop.runFixLoop('slice-1', scenarios, initialFailures);
  assert.equal(result.outcome, 'shipped', 'should ship when conforming commits + passing scenarios');
  rmSync(dir, { recursive: true, force: true });
});

test('reconciliation: non-conforming commit halts with subagent-broke-commit-conventions', async () => {
  const { dir, lastCommitSha } = initRepo();

  // Pre-seed a BAD commit (no Co-Authored-By, wrong prefix)
  writeFileSync(join(dir, 'fix.js'), 'bad fix');
  execSync('git add fix.js', { cwd: dir });
  execSync('git commit -m "WIP bad commit without conventions"', { cwd: dir });

  const scenarios = [{ id: 'lv-001', title: 'Save display name' }];
  const stubCodex = async () => ({ content: 'Diagnosis' });
  const stubSubagent = async () => ({ status: 'DONE', commits: [] });
  const stubRunner = { runScenario: async () => ({ status: 'passed' }) };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'failed' }];
  const result = await loop.runFixLoop('slice-1', scenarios, initialFailures);
  assert.equal(result.outcome, 'halt', 'should halt on bad commit conventions');
  assert.equal(result.halt_reason, 'subagent-broke-commit-conventions');
  assert.ok(result.sha, 'result should include the offending SHA');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. All-scenarios re-run after fix-subagent commit (not just failed)
// ---------------------------------------------------------------------------

test('all scenarios are re-run after fix commit, not just the failing one', async () => {
  const { dir, lastCommitSha } = initRepo();

  const runCalls = [];
  const scenarios = [
    { id: 'lv-001', title: 'Save display name' },
    { id: 'lv-002', title: 'Show recent saves' },
    { id: 'lv-003', title: 'Delete account' },
  ];

  const stubCodex = async () => ({ content: 'Diagnosis' });
  const stubSubagent = async () => ({ status: 'DONE', commits: [] });
  const stubRunner = {
    runScenario: async (_sliceId, scenario) => {
      runCalls.push(scenario.id);
      return { status: 'passed' };
    },
  };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  // Only lv-001 is failing initially
  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'failed' }];
  await loop.runFixLoop('slice-1', scenarios, initialFailures);

  // After a fix round, ALL scenarios should be re-run
  const rerunIds = new Set(runCalls);
  assert.ok(rerunIds.has('lv-001'), 'lv-001 (failed) must be re-run');
  assert.ok(rerunIds.has('lv-002'), 'lv-002 (passing) must also be re-run');
  assert.ok(rerunIds.has('lv-003'), 'lv-003 (passing) must also be re-run');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. 7-round budget enforced — always-failing scenarios hit deadlock
// ---------------------------------------------------------------------------

test('7-round budget enforced: deadlock after 7 rounds with persistent failures', async () => {
  const { dir, lastCommitSha } = initRepo();

  const scenarios = [{ id: 'lv-001', title: 'Always fails' }];

  const stubCodex = async () => ({ content: 'Diagnosis but cannot fix' });
  const stubSubagent = async () => ({ status: 'DONE', commits: [] });
  // Always fails on every run
  const stubRunner = {
    runScenario: async () => ({ status: 'failed', assertions_failed: ['still broken'] }),
  };
  const stubSidecar = { appendLiveVerificationRound: () => {}, appendRound: () => {} };

  const loop = createLiveFixLoop({
    codexCaller: stubCodex,
    subagentDispatcher: stubSubagent,
    scenarioRunner: stubRunner,
    evidenceStore: null,
    sidecarOps: stubSidecar,
    repoRoot: dir,
    threadId: 'thread-001',
    lastCommitSha,
  });

  const initialFailures = [{ scenario: scenarios[0], evidence_paths: [], slice_diff: '', git_status: '', test_output: 'failed' }];
  const result = await loop.runFixLoop('slice-1', scenarios, initialFailures);

  assert.equal(result.outcome, 'deadlock');
  assert.equal(result.halt_reason, 'live-verification-deadlock');
  assert.ok(Array.isArray(result.rounds));
  assert.equal(result.rounds.length, 7, 'exactly 7 rounds should have run');
  rmSync(dir, { recursive: true, force: true });
}, { timeout: 30000 });
