import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchReviewerViaHarness } from '../../lib/codex-bridge/reviewer-dispatch.js';

function fixture(phase = 'tdd-review') {
  const dir = mkdtempSync(join(tmpdir(), 'cps-reviewer-dispatch-'));
  const promptPath = join(dir, 'role.md');
  const argsPath = join(dir, 'args');
  const stdinPath = join(dir, 'stdin');
  const command = join(dir, 'codex');
  writeFileSync(promptPath, '# Reviewer Role\nBe exact.\n');
  writeFileSync(command, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$@" > '${argsPath}'`,
    `cat > '${stdinPath}'`,
    `printf '{"type":"assistant-text","text":"reviewed"}\\n'`,
  ].join('\n'));
  chmodSync(command, 0o755);
  return {
    dir, argsPath, stdinPath, command,
    request: {
      identity: { id: 'reviewer-test', role: 'test-reviewer', source: 'project', promptPath },
      repoRoot: dir,
      specPath: join(dir, 'spec.md'),
      specSnippet: 'SPEC SNIPPET',
      phase,
      sliceId: 'slice-4',
      sidecarParticipantState: '',
      task: 'CHECK THE TEST LIST',
    },
  };
}

for (const [phase, effort] of [
  ['tdd-review', 'xhigh'],
  ['hypothesis-review', 'xhigh'],
  ['post-implementation-review', 'high'],
]) {
  test(`reviewer dispatch maps ${phase} to ${effort}`, async () => {
    const f = fixture(phase);
    try {
      const result = await dispatchReviewerViaHarness(f.request, {
        cli: 'codex',
        repoRoot: f.dir,
        env: {},
        harnessOptions: { command: f.command },
        deps: { readUnreadMessages: async () => [] },
      });
      const argv = readFileSync(f.argsPath, 'utf8').trim().split('\n');
      assert.ok(argv.includes('gpt-6-astra'));
      assert.ok(argv.includes(`model_reasoning_effort=${effort}`));
      const stdin = readFileSync(f.stdinPath, 'utf8');
      assert.match(stdin, /CHECK THE TEST LIST/);
      assert.match(stdin, /SPEC SNIPPET/);
      assert.match(stdin, /# Reviewer Role/);
      assert.equal(result.responseText, 'reviewed');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('reviewer dispatch records unknown phase warning', async () => {
  const f = fixture('weird-phase');
  try {
    const result = await dispatchReviewerViaHarness(f.request, {
      cli: 'codex', repoRoot: f.dir, env: {}, harnessOptions: { command: f.command },
      deps: { readUnreadMessages: async () => [] },
    });
    assert.equal(result.modelRole, 'review');
    assert.equal(result.reasoningEffort, 'high');
    assert.ok(result.warning);
    assert.equal(result.requestForTurn.modelRoleWarning, result.warning);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('reviewer dispatch does not apply Codex model options to other CLIs', async () => {
  const f = fixture();
  const calls = [];
  try {
    await dispatchReviewerViaHarness(f.request, {
      cli: 'ollama', repoRoot: f.dir, env: {},
      deps: {
        readUnreadMessages: async () => [],
        adapters: new Map([['ollama', { dispatch: async (...args) => {
          calls.push(args);
          return { responseText: 'ok', exit: 0, warnings: [], adapterMeta: {} };
        } }]]),
      },
    });
    assert.equal(calls[0][2].model, undefined);
    assert.equal(calls[0][2].reasoningEffort, undefined);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('reviewer dispatch rejects forbidden harness overrides', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      dispatchReviewerViaHarness(f.request, {
        cli: 'codex', repoRoot: f.dir, harnessOptions: { model: 'x' },
        deps: { readUnreadMessages: async () => [] },
      }),
      /harnessOptions may only set timeout_ms\|maxBufferBytes\|command\|env/,
    );
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('reviewer dispatch returns the turn request audit fields and injects unread mail', async () => {
  const f = fixture('plan-review');
  try {
    const result = await dispatchReviewerViaHarness(f.request, {
      cli: 'codex', repoRoot: f.dir, env: {}, harnessOptions: { command: f.command },
      deps: { readUnreadMessages: async () => [{
        id: 'msg-1', from: 'orchestrator', timestamp: '2026-09-17T00:00:00Z', text: 'MAIL CONTENT',
      }] },
    });
    assert.equal(result.requestForTurn.adapter, 'cli-harness:codex');
    assert.equal(result.requestForTurn.modelRole, 'planning');
    assert.equal(result.requestForTurn.modelRoleWarning, null);
    assert.match(readFileSync(f.stdinPath, 'utf8'), /MAIL CONTENT/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
