import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memberIdSlug } from '../../../lib/codex-bridge/implementer/member-id.js';
import { dispatchImplementers } from '../../../lib/codex-bridge/implementer/orchestrator.js';
import {
  appendImplementerEventLocked,
  initSidecar,
  readImplementerRun,
} from '../../../lib/codex-bridge/sidecar.js';
import {
  dispatchCodexCliImplementer,
  observeDirectCliAttempt,
  readDirectCliAttempt,
} from '../../../lib/codex-bridge/implementer/codex-cli-dispatch.js';

function repoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'cps-cli-dispatch-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'a@b'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'a'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'base.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repoRoot });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const command = join(repoRoot, 'fake-codex');
  const argvFile = join(repoRoot, 'argv');
  writeFileSync(command, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" >> '${argvFile}'`,
    'cat >/dev/null',
    'if [[ "$FAKE_COMMIT" == "1" ]]; then',
    '  printf "done\\n" > result.txt',
    '  git add result.txt',
    '  git commit -qm result',
    'fi',
    'if [[ "$FAKE_BLOCKED" == "1" ]]; then echo codex:blocked >&2; fi',
    'if [[ -n "$FAKE_WAIT_FILE" ]]; then while [[ ! -e "$FAKE_WAIT_FILE" ]]; do sleep 0.05; done; fi',
    'if [[ -n "$FAKE_EXIT" ]]; then exit "$FAKE_EXIT"; fi',
    `printf '{"type":"assistant-text","text":"ok"}\\n'`,
  ].join('\n'));
  chmodSync(command, 0o755);
  const input = {
    sliceId: 'slice-4', implementerRunId: 'run-1',
    memberId: 'expert-implementer@codex:gpt-5.5#0', runtimeKind: 'codex-cli',
    worktreePath: repoRoot, branchName: 'main', baseSha, claimedFiles: [], prompt: 'implement',
    abortSignal: new AbortController().signal, env: { FAKE_COMMIT: '1' }, repoRoot,
    modelRole: 'implement', model: 'gpt-5.6-terra', effort: 'high',
  };
  return { repoRoot, command, argvFile, input };
}

test('direct Codex launcher records snapshot, argv, git result, and exited evidence', async () => {
  const f = repoFixture();
  try {
    const result = await dispatchCodexCliImplementer(f.input, { command: f.command });
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.changedFiles, ['result.txt']);
    assert.match(result.diffHash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(result.modelSnapshot, {
      model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high',
    });
    const argv = readFileSync(f.argvFile, 'utf8');
    assert.match(argv, /gpt-5\.6-terra/);
    assert.match(argv, /model_reasoning_effort=high/);
    const attempt = await readDirectCliAttempt(f.input);
    assert.equal(attempt.state, 'exited');
    assert.equal(attempt.outcome, 'completed');
    assert.equal(attempt.pidAlive, false);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('direct Codex launcher streams a diff larger than one MiB into its hash', async () => {
  const f = repoFixture();
  try {
    writeFileSync(join(f.repoRoot, 'large.txt'), 'x'.repeat(2 * 1024 * 1024));
    execFileSync('git', ['add', 'large.txt'], { cwd: f.repoRoot });
    execFileSync('git', ['commit', '-qm', 'large diff'], { cwd: f.repoRoot });
    f.input.env = {};

    const result = await dispatchCodexCliImplementer(f.input, { command: f.command });

    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.changedFiles, ['large.txt']);
    assert.match(result.diffHash, /^sha256:[0-9a-f]{64}$/);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('successful CLI exit becomes failed evidence when git verification fails', async () => {
  const f = repoFixture();
  try {
    f.input.env = {};
    const gitError = Object.assign(new Error('git diff output exceeded buffer'), { code: 'ENOBUFS' });
    const result = await dispatchCodexCliImplementer(f.input, {
      command: f.command,
      deps: {
        execFileSync(command, args, options) {
          if (args[0] === 'diff') throw gitError;
          return execFileSync(command, args, options);
        },
      },
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.diffHash, null);
    const evidence = await readDirectCliAttempt(f.input);
    assert.equal(evidence.outcome, 'failed');
    assert.match(evidence.error, /git diff output exceeded buffer/);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('direct Codex launcher gives haltEnvelope precedence over exit zero', async () => {
  const f = repoFixture();
  try {
    f.input.env = { FAKE_BLOCKED: '1' };
    const result = await dispatchCodexCliImplementer(f.input, { command: f.command });
    assert.equal(result.exitCode, 0);
    assert.equal(result.outcome, 'halted');
    assert.equal(result.haltEnvelope.halt, 'codex-cli-blocked');
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('direct Codex launcher validates snapshot and absolute repoRoot before evidence or spawn', async () => {
  const f = repoFixture();
  try {
    const evidence = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1', `${memberIdSlug(f.input.memberId)}.json`);
    await assert.rejects(
      dispatchCodexCliImplementer({ ...f.input, model: undefined }, { command: f.command }),
      /missing model snapshot/,
    );
    await assert.rejects(
      dispatchCodexCliImplementer({ ...f.input, repoRoot: 'relative' }, { command: f.command }),
      /repoRoot.*absolute/,
    );
    assert.equal(existsSync(evidence), false);
    assert.equal(existsSync(f.argvFile), false);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('direct Codex launcher publishes launching before spawn and running from onSpawn', async () => {
  const f = repoFixture();
  let launched;
  let running;
  try {
    f.input.env = {};
    f.input.onLaunched = (snapshot) => {
      launched = JSON.parse(readFileSync(snapshot.status_file, 'utf8'));
    };
    await dispatchCodexCliImplementer(f.input, {
      command: f.command,
      deps: { afterSpawnPublish: async (evidence) => { running = evidence; } },
    });
    assert.equal(launched.state, 'launching');
    assert.equal(launched.pid, null);
    assert.equal(running.state, 'running');
    assert.ok(Number.isInteger(running.pid));
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('observer times out without ending or killing a live attempt', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  const waitFile = join(f.repoRoot, 'release');
  let launchPromise;
  try {
    const spec = join(f.repoRoot, 'timeout-spec.md');
    writeFileSync(spec, '# timeout');
    initSidecar(spec, { feature: 'slice-4', codexSession: 's', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const snapshot = { model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high' };
    const implementer = {
      memberId: f.input.memberId, adapter: 'codex-cli', model: 'gpt-5.5', required: true,
      worktreePath: f.repoRoot, branchName: 'timeout-member', claimedFiles: [],
      env: { FAKE_WAIT_FILE: waitFile },
    };
    launchPromise = dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementers: [implementer], modelSnapshot: snapshot,
      dispatchFn: (input) => dispatchCodexCliImplementer(input, { command: f.command }),
    });
    let run;
    while (!(run = readImplementerRun(spec, 'slice-4'))?.events?.some((event) => event.event_type === 'started')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const attemptInput = { ...f.input, implementerRunId: run.implementer_run_id };
    let attempt = null;
    const deadline = Date.now() + 3000;
    while ((!attempt || attempt.state !== 'running') && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      attempt = await readDirectCliAttempt(attemptInput);
    }
    const observed = await observeDirectCliAttempt(attemptInput, { timeout_ms: 150, poll_ms: 25 });
    assert.equal(observed.outcome, 'halted');
    assert.equal(observed.attemptInFlight, true);
    assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-timeout');
    assert.equal((await readDirectCliAttempt(attemptInput)).pidAlive, true);

    const timedOutResume = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementerRunId: run.implementer_run_id, resumeInFlight: true,
      implementers: [implementer],
      dispatchFn: async () => { throw new Error('must not relaunch a live attempt'); },
      observeFn: (input) => observeDirectCliAttempt(input, { timeout_ms: 150, poll_ms: 25 }),
    });
    assert.equal(timedOutResume.failed[0].result.attemptInFlight, true);
    assert.equal(readImplementerRun(spec, 'slice-4').events.at(-1).payload.phase, 'observation-timeout');

    writeFileSync(waitFile, 'go');
    const completed = await launchPromise;
    assert.equal(completed.success[0].result.outcome, 'completed');
    const finalResume = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementerRunId: run.implementer_run_id, resumeInFlight: true,
      implementers: [implementer],
      dispatchFn: async () => { throw new Error('must not relaunch a completed attempt'); },
    });
    assert.equal(finalResume.success.length, 1);
    assert.deepEqual(finalResume.success[0].result.modelSnapshot, snapshot);
    assert.equal(readFileSync(f.argvFile, 'utf8').split('\n').filter((line) => line === 'exec').length, 1);
  } finally {
    if (launchPromise) writeFileSync(waitFile, 'go');
    await launchPromise?.catch(() => {});
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('observer reports missing and expired-launch evidence as lost', async () => {
  const f = repoFixture();
  try {
    const missing = await observeDirectCliAttempt(f.input, { poll_ms: 10 });
    assert.equal(missing.haltEnvelope.halt, 'implementer-attempt-lost');
    const path = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1', `${memberIdSlug(f.input.memberId)}.json`);
    mkdirSync(join(f.repoRoot, '.codex-paired', 'attempts', 'run-1'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      state: 'launching', pid: null, launched_at: '2000-01-01T00:00:00.000Z',
      model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high',
    }));
    const expired = await observeDirectCliAttempt(f.input, { poll_ms: 10, launch_grace_ms: 10 });
    assert.equal(expired.haltEnvelope.halt, 'implementer-attempt-lost');
    assert.equal(expired.modelSnapshot.model, 'gpt-5.6-terra');
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('malformed attempt evidence is treated as missing and observes as lost', async () => {
  const f = repoFixture();
  try {
    const dir = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1');
    const path = join(dir, `${memberIdSlug(f.input.memberId)}.json`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{not-json');

    assert.equal(readDirectCliAttempt(f.input), null);
    const observed = await observeDirectCliAttempt(f.input, { poll_ms: 10 });
    assert.equal(observed.outcome, 'halted');
    assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-lost');
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

// Regression: syntactically valid JSON that is not a plain object (null, a
// bare number/string, or an array) must not crash `readDirectCliAttempt`
// with a TypeError when it tries to read `.state` off a non-object — it
// must be treated the same as a missing/malformed record.
test('valid JSON that is not a plain object is treated as missing, never throws', async () => {
  const f = repoFixture();
  const dir = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1');
  const path = join(dir, `${memberIdSlug(f.input.memberId)}.json`);
  mkdirSync(dir, { recursive: true });
  try {
    for (const payload of ['null', '[]', '"x"', '42', 'true']) {
      writeFileSync(path, payload);
      assert.equal(readDirectCliAttempt(f.input), null,
        `expected null for JSON payload ${payload}`);
      const observed = await observeDirectCliAttempt(f.input, { poll_ms: 10 });
      assert.equal(observed.outcome, 'halted');
      assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-lost');
    }
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

// Regression: a JSON object that IS a plain object but is missing the
// terminal fields resultFromEvidence() reads (a truncated/partial "exited"
// write) must not be accepted as a completed attempt.
test('incomplete exited evidence is treated as lost, never surfaced as completed', async () => {
  const f = repoFixture();
  const dir = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1');
  const path = join(dir, `${memberIdSlug(f.input.memberId)}.json`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path, JSON.stringify({ state: 'exited', outcome: 'completed' }));
    const attempt = readDirectCliAttempt(f.input);
    assert.equal(attempt.state, 'exited');
    assert.equal(attempt.outcome, 'completed');
    const observed = await observeDirectCliAttempt(f.input, { poll_ms: 10 });
    assert.notEqual(observed.outcome, 'completed');
    assert.equal(observed.outcome, 'halted');
    assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-lost');
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('observer waits through the launcher finalization window', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  let release;
  let childExited;
  try {
    f.input.env = {};
    const gate = new Promise((resolve) => { release = resolve; });
    const atSeam = new Promise((resolve) => { childExited = resolve; });
    const launch = dispatchCodexCliImplementer(f.input, {
      command: f.command,
      deps: { beforePublishTerminal: async () => { childExited(); await gate; } },
    });
    await atSeam;
    let settled = false;
    const observation = observeDirectCliAttempt(f.input, { poll_ms: 25, finalize_grace_ms: 1000 })
      .then((value) => { settled = true; return value; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(settled, false);
    release();
    const [launched, observed] = await Promise.all([launch, observation]);
    assert.equal(observed.outcome, 'completed');
    assert.equal(observed.headSha, launched.headSha);
  } finally { release?.(); rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('observer declares a dead running attempt lost after finalization grace', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  let childExited;
  try {
    f.input.env = {};
    const atSeam = new Promise((resolve) => { childExited = resolve; });
    void dispatchCodexCliImplementer(f.input, {
      command: f.command,
      deps: { beforePublishTerminal: async () => { childExited(); await new Promise(() => {}); } },
    });
    await atSeam;
    const observed = await observeDirectCliAttempt(f.input, { poll_ms: 20, finalize_grace_ms: 100 });
    assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-lost');
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('live observer joins one launcher and returns identical git evidence', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  const release = join(f.repoRoot, 'release-live');
  const unrelated = mkdtempSync(join(tmpdir(), 'cps-cli-observer-cwd-'));
  const originalCwd = process.cwd();
  try {
    process.chdir(unrelated);
    f.input.env = { FAKE_WAIT_FILE: release, FAKE_COMMIT: '1' };
    const launch = dispatchCodexCliImplementer(f.input, { command: f.command });
    let evidence;
    while ((evidence = await readDirectCliAttempt(f.input))?.state !== 'running') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    let settled = false;
    const observation = observeDirectCliAttempt(f.input, { poll_ms: 20 }).then((value) => { settled = true; return value; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(settled, false);
    writeFileSync(release, 'go');
    const [launched, observed] = await Promise.all([launch, observation]);
    assert.equal(observed.headSha, launched.headSha);
    assert.equal(observed.diffHash, launched.diffHash);
    assert.equal(readFileSync(f.argvFile, 'utf8').split('\n').filter((line) => line === 'exec').length, 1);
  } finally {
    writeFileSync(release, 'go');
    process.chdir(originalCwd);
    rmSync(unrelated, { recursive: true, force: true });
    rmSync(f.repoRoot, { recursive: true, force: true });
  }
});

test('spawn failure publishes terminal failed evidence with the adapter error', async () => {
  const f = repoFixture();
  try {
    const result = await dispatchCodexCliImplementer(f.input, { command: join(f.repoRoot, 'missing') });
    assert.equal(result.outcome, 'failed');
    const evidence = await readDirectCliAttempt(f.input);
    assert.equal(evidence.state, 'exited');
    assert.equal(evidence.outcome, 'failed');
    assert.equal(evidence.exit_code, null);
    assert.equal(result.exitCode, null);
    assert.match(evidence.error, /ENOENT|no such file/i);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('orchestrator launches two direct Codex members once and reuses both completions', async () => {
  const f = repoFixture();
  try {
    const spec = join(f.repoRoot, 'spec.md');
    writeFileSync(spec, '# spec');
    initSidecar(spec, { feature: 'slice-4', codexSession: 's', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const implementers = [0, 1].map((ordinal) => ({
      memberId: `expert-implementer@codex:gpt-5.5#${ordinal}`,
      adapter: 'codex-cli', model: 'gpt-5.5', required: true,
      worktreePath: f.repoRoot, branchName: `branch-${ordinal}`, claimedFiles: [], env: {},
    }));
    const dispatchFn = (input) => dispatchCodexCliImplementer(input, { command: f.command });
    const first = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementers, modelSnapshot: { model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high' }, dispatchFn,
    });
    assert.equal(first.success.length, 2);
    assert.equal(readImplementerRun(spec, 'slice-4').events.filter((event) => event.event_type === 'completed').length, 2);
    const resumed = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementerRunId: first.implementerRunId, resumeInFlight: true, implementers,
      dispatchFn: async () => { throw new Error('must not relaunch'); },
    });
    assert.equal(resumed.success.length, 2);
    const launchCount = () => readFileSync(f.argvFile, 'utf8').split('\n').filter((line) => line === 'exec').length;
    assert.equal(launchCount(), 2);

    const member = implementers[0];
    const attemptPath = join(
      f.repoRoot, '.codex-paired', 'attempts', first.implementerRunId,
      `${memberIdSlug(member.memberId)}.json`,
    );
    const appendStarted = async () => {
      const payload = { phase: 'dispatch-start', model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high' };
      await appendImplementerEventLocked(spec, {
        event_type: 'started', implementer_run_id: first.implementerRunId,
        slice_id: 'slice-4', member_id: member.memberId,
        runtime_kind: 'codex-cli', worktree_id: member.branchName,
        payload_hash: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
        payload,
      });
    };

    const completedEvidence = JSON.parse(readFileSync(attemptPath, 'utf8'));
    writeFileSync(attemptPath, JSON.stringify({
      ...completedEvidence, state: 'running', pid: 2_147_483_647,
      completed_at: null, exit_code: null, outcome: null,
    }));
    await appendStarted();
    const deadPidResume = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementerRunId: first.implementerRunId, resumeInFlight: true, implementers: [member],
      dispatchFn: async () => { throw new Error('must not invoke CLI for a lost attempt'); },
      observeFn: (input) => observeDirectCliAttempt(input, { poll_ms: 10, finalize_grace_ms: 20 }),
    });
    assert.equal(deadPidResume.failed[0].result.outcome, 'halted');
    assert.equal(deadPidResume.failed[0].result.haltEnvelope.halt, 'implementer-attempt-lost');
    assert.equal(launchCount(), 2);

    writeFileSync(attemptPath, JSON.stringify({
      ...completedEvidence, state: 'launching', pid: null,
      launched_at: '2000-01-01T00:00:00.000Z', spawned_at: null,
      completed_at: null, exit_code: null, outcome: null,
    }));
    await appendStarted();
    const expiredLaunchResume = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementerRunId: first.implementerRunId, resumeInFlight: true, implementers: [member],
      dispatchFn: async () => { throw new Error('must not invoke CLI for an expired launch'); },
      observeFn: (input) => observeDirectCliAttempt(input, { poll_ms: 10, launch_grace_ms: 20 }),
    });
    assert.equal(expiredLaunchResume.failed[0].result.haltEnvelope.halt, 'implementer-attempt-lost');
    assert.equal(launchCount(), 2);
  } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('startup ordering exposes running evidence with the spawned process pid', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  const startSignal = join(f.repoRoot, 'start');
  const seenEvidence = join(f.repoRoot, 'seen-evidence');
  const selfPid = join(f.repoRoot, 'self-pid');
  let spawned;
  try {
    writeFileSync(f.command, [
      '#!/usr/bin/env bash',
      'cat >/dev/null',
      'while [[ ! -e "$START_SIGNAL" ]]; do sleep 0.02; done',
      'cp "$EVIDENCE_FILE" "$SEEN_EVIDENCE"',
      'printf "%s" "$$" > "$SELF_PID"',
      `printf '{"type":"assistant-text","text":"ok"}\\n'`,
    ].join('\n'));
    chmodSync(f.command, 0o755);
    f.input.env = { START_SIGNAL: startSignal, SEEN_EVIDENCE: seenEvidence, SELF_PID: selfPid };
    f.input.onLaunched = ({ status_file }) => {
      const launching = JSON.parse(readFileSync(status_file, 'utf8'));
      assert.equal(launching.state, 'launching');
      assert.equal(launching.pid, null);
      f.input.env.EVIDENCE_FILE = status_file;
    };
    const spawnedSignal = new Promise((resolve) => { spawned = resolve; });
    const launch = dispatchCodexCliImplementer(f.input, {
      command: f.command,
      deps: { afterSpawnPublish: () => spawned() },
    });
    await spawnedSignal;
    writeFileSync(startSignal, 'go');
    await launch;
    const running = JSON.parse(readFileSync(seenEvidence, 'utf8'));
    assert.equal(running.state, 'running');
    assert.equal(running.pid, Number(readFileSync(selfPid, 'utf8')));
  } finally { writeFileSync(startSignal, 'go'); rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('launcher maps external abort to cancelled and terminal evidence', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  const release = join(f.repoRoot, 'never-release');
  const controller = new AbortController();
  try {
    f.input.abortSignal = controller.signal;
    f.input.env = { FAKE_WAIT_FILE: release };
    const launch = dispatchCodexCliImplementer(f.input, { command: f.command, timeout_ms: 5000 });
    while ((await readDirectCliAttempt(f.input))?.state !== 'running') {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    controller.abort();
    const result = await launch;
    assert.equal(result.outcome, 'cancelled');
    const evidence = await readDirectCliAttempt(f.input);
    assert.equal(evidence.state, 'exited');
    assert.equal(evidence.outcome, 'cancelled');
    assert.equal(evidence.pidAlive, false);
  } finally { writeFileSync(release, 'go'); rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('required direct-Codex failure cancels a hanging sibling', { timeout: 10_000 }, async () => {
  const f = repoFixture();
  const release = join(f.repoRoot, 'sibling-release');
  try {
    const spec = join(f.repoRoot, 'siblings.md');
    writeFileSync(spec, '# siblings');
    initSidecar(spec, { feature: 'slice-4', codexSession: 's', model: 'gpt-6-astra', reasoningEffort: 'high' });
    const implementers = [
      {
        memberId: 'expert-implementer@codex:gpt-5.5#0', adapter: 'codex-cli', model: 'gpt-5.5', required: true,
        worktreePath: f.repoRoot, branchName: 'failure', claimedFiles: [], env: { FAKE_EXIT: '1' },
      },
      {
        memberId: 'expert-implementer@codex:gpt-5.5#1', adapter: 'codex-cli', model: 'gpt-5.5', required: true,
        worktreePath: f.repoRoot, branchName: 'hanging', claimedFiles: [], env: { FAKE_WAIT_FILE: release },
      },
    ];
    const result = await dispatchImplementers({
      specPath: spec, repoRoot: f.repoRoot, sliceId: 'slice-4', baseSha: f.input.baseSha,
      implementers, modelSnapshot: { model_role: 'implement', model: 'gpt-5.6-terra', effort: 'high' },
      dispatchFn: (input) => dispatchCodexCliImplementer(input, { command: f.command, timeout_ms: 5000 }),
    });
    assert.equal(result.failed.length, 1);
    assert.equal(result.cancelled.length, 1);
  } finally { writeFileSync(release, 'go'); rmSync(f.repoRoot, { recursive: true, force: true }); }
});

test('running evidence without a pid and launching evidence without launched_at are lost, never polled', async () => {
  for (const record of [
    { state: 'running', spawned_at: new Date().toISOString() },
    { state: 'running', pid: 'not-a-pid', spawned_at: new Date().toISOString() },
    { state: 'launching' },
    { state: 'bogus' },
  ]) {
    const f = repoFixture();
    const dir = join(f.repoRoot, '.codex-paired', 'attempts', 'run-1');
    const path = join(dir, `${memberIdSlug(f.input.memberId)}.json`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, JSON.stringify(record));
      const observed = await observeDirectCliAttempt(f.input, { poll_ms: 10, timeout_ms: 2_000 });
      assert.equal(observed.outcome, 'halted', JSON.stringify(record));
      assert.equal(observed.haltEnvelope.halt, 'implementer-attempt-lost', JSON.stringify(record));
    } finally { rmSync(f.repoRoot, { recursive: true, force: true }); }
  }
});
