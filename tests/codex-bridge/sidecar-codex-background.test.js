// Tests for v0.7.2 sidecar additions: codex-background-bash dispatch fields,
// in-progress outcome, finalizeImplementDispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  appendImplementDispatch,
  finalizeImplementDispatch,
  setImplementMeta,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpecRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cps-sidecar-bg-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  const specPath = join(root, 'docs', 'specs', 'test.md');
  writeFileSync(specPath, '# Test spec');
  // Initialize sidecar via CLI to ensure proper layout.
  const cli = join(process.cwd(), 'lib', 'codex-bridge', 'cli.js');
  execFileSync('node', [cli, 'sidecar-init', '--specPath', specPath, '--feature', 'test', '--threadId', 'thread-x'], { cwd: root });
  return { root, specPath };
}

function readSidecar(root, specPath) {
  // Sidecar lives at <root>/.superpowers-codex-paired/<rel-spec-path>.json
  const rel = specPath.slice(root.length + 1);  // strip leading slash
  const sidecarPath = join(root, '.superpowers-codex-paired', `${rel}.json`);
  return JSON.parse(readFileSync(sidecarPath, 'utf8'));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ── transport field ────────────────────────────────────────────────────────

test('appendImplementDispatch accepts transport=claude-subagent', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'sonnet',
    transport: 'claude-subagent',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    completed_at: '2026-05-10T00:01:00.000Z',
    worktree: '/tmp/wt',
    head_sha: 'abc123',
    commit_count: 1,
    outcome: 'shipped',
  });
  const sc = readSidecar(root, specPath);
  assert.equal(sc.slice_reviews['slice-1'].phases.implement.dispatches[0].transport, 'claude-subagent');
  cleanup(root);
});

test('appendImplementDispatch accepts transport=codex-background-bash', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-abc',
    output_file: '/tmp/out.log',
    status_file: '/tmp/out.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  const sc = readSidecar(root, specPath);
  const d = sc.slice_reviews['slice-1'].phases.implement.dispatches[0];
  assert.equal(d.transport, 'codex-background-bash');
  assert.equal(d.task_id, 'task-abc');
  assert.equal(d.output_file, '/tmp/out.log');
  assert.equal(d.status_file, '/tmp/out.status.json');
  cleanup(root);
});

test('appendImplementDispatch rejects invalid transport', () => {
  const { root, specPath } = makeSpecRepo();
  assert.throws(
    () => appendImplementDispatch(specPath, 'slice-1', {
      slice_id: 'slice-1',
      agent: 'codex',
      transport: 'mcp-server',  // not allowed in v0.7.2
      dispatched_at: '2026-05-10T00:00:00.000Z',
      worktree: '/tmp/wt',
      outcome: 'shipped',
    }),
    /invalid transport/
  );
  cleanup(root);
});

// ── in-progress outcome ─────────────────────────────────────────────────────

test('appendImplementDispatch accepts outcome=in-progress', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-pending',
    output_file: '/tmp/o.log',
    status_file: '/tmp/o.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  const sc = readSidecar(root, specPath);
  assert.equal(sc.slice_reviews['slice-1'].phases.implement.dispatches[0].outcome, 'in-progress');
  cleanup(root);
});

test('appendImplementDispatch: codex-background-bash + in-progress requires task_id/output_file/status_file', () => {
  const { root, specPath } = makeSpecRepo();
  // Missing task_id
  assert.throws(
    () => appendImplementDispatch(specPath, 'slice-1', {
      slice_id: 'slice-1',
      agent: 'codex',
      transport: 'codex-background-bash',
      output_file: '/tmp/o.log',
      status_file: '/tmp/o.status.json',
      dispatched_at: '2026-05-10T00:00:00.000Z',
      worktree: '/tmp/wt',
      outcome: 'in-progress',
    }),
    /task_id/
  );
  // Missing output_file
  assert.throws(
    () => appendImplementDispatch(specPath, 'slice-1', {
      slice_id: 'slice-1',
      agent: 'codex',
      transport: 'codex-background-bash',
      task_id: 'task-abc',
      status_file: '/tmp/o.status.json',
      dispatched_at: '2026-05-10T00:00:00.000Z',
      worktree: '/tmp/wt',
      outcome: 'in-progress',
    }),
    /output_file/
  );
  cleanup(root);
});

test('appendImplementDispatch: empty string for task_id rejected', () => {
  const { root, specPath } = makeSpecRepo();
  assert.throws(
    () => appendImplementDispatch(specPath, 'slice-1', {
      slice_id: 'slice-1',
      agent: 'codex',
      transport: 'codex-background-bash',
      task_id: '',
      output_file: '/tmp/o.log',
      status_file: '/tmp/o.status.json',
      dispatched_at: '2026-05-10T00:00:00.000Z',
      worktree: '/tmp/wt',
      outcome: 'in-progress',
    }),
    /task_id/
  );
  cleanup(root);
});

// ── finalizeImplementDispatch ──────────────────────────────────────────────

test('finalizeImplementDispatch promotes in-progress → shipped with completion fields', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-1',
    output_file: '/tmp/o.log',
    status_file: '/tmp/o.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  finalizeImplementDispatch(specPath, 'slice-1', 'task-1', {
    outcome: 'shipped',
    head_sha: 'def456',
    commit_count: 2,
    completed_at: '2026-05-10T00:05:00.000Z',
  });
  const sc = readSidecar(root, specPath);
  const d = sc.slice_reviews['slice-1'].phases.implement.dispatches[0];
  assert.equal(d.outcome, 'shipped');
  assert.equal(d.head_sha, 'def456');
  assert.equal(d.commit_count, 2);
  assert.equal(d.completed_at, '2026-05-10T00:05:00.000Z');
  // Originals preserved
  assert.equal(d.task_id, 'task-1');
  assert.equal(d.output_file, '/tmp/o.log');
  cleanup(root);
});

test('finalizeImplementDispatch matches the most recent in-progress entry by task_id', () => {
  const { root, specPath } = makeSpecRepo();
  // Two background dispatches in-progress with different task_ids
  for (const taskId of ['task-A', 'task-B']) {
    appendImplementDispatch(specPath, 'slice-1', {
      slice_id: 'slice-1',
      agent: 'codex',
      transport: 'codex-background-bash',
      task_id: taskId,
      output_file: `/tmp/${taskId}.log`,
      status_file: `/tmp/${taskId}.status.json`,
      dispatched_at: '2026-05-10T00:00:00.000Z',
      worktree: '/tmp/wt',
      outcome: 'in-progress',
    });
  }
  // Finalize task-A specifically
  finalizeImplementDispatch(specPath, 'slice-1', 'task-A', {
    outcome: 'shipped',
    head_sha: 'aaa',
    commit_count: 1,
    completed_at: '2026-05-10T00:05:00.000Z',
  });
  const sc = readSidecar(root, specPath);
  const dispatches = sc.slice_reviews['slice-1'].phases.implement.dispatches;
  // task-A finalized
  assert.equal(dispatches.find(d => d.task_id === 'task-A').outcome, 'shipped');
  // task-B still in-progress
  assert.equal(dispatches.find(d => d.task_id === 'task-B').outcome, 'in-progress');
  cleanup(root);
});

test('finalizeImplementDispatch throws when no matching in-progress dispatch', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-1',
    output_file: '/tmp/o.log',
    status_file: '/tmp/o.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  assert.throws(
    () => finalizeImplementDispatch(specPath, 'slice-1', 'task-NOPE', {
      outcome: 'shipped',
      head_sha: 'aaa',
      commit_count: 1,
      completed_at: '2026-05-10T00:05:00.000Z',
    }),
    /no in-progress dispatch with task_id="task-NOPE"/
  );
  cleanup(root);
});

test('finalizeImplementDispatch rejects in-progress as terminal outcome', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-1',
    output_file: '/tmp/o.log',
    status_file: '/tmp/o.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  assert.throws(
    () => finalizeImplementDispatch(specPath, 'slice-1', 'task-1', {
      outcome: 'in-progress',
      completed_at: '2026-05-10T00:05:00.000Z',
    }),
    /non-in-progress outcome/
  );
  cleanup(root);
});

test('finalizeImplementDispatch supports failed-fallback-pending terminal', () => {
  const { root, specPath } = makeSpecRepo();
  appendImplementDispatch(specPath, 'slice-1', {
    slice_id: 'slice-1',
    agent: 'codex',
    transport: 'codex-background-bash',
    task_id: 'task-1',
    output_file: '/tmp/o.log',
    status_file: '/tmp/o.status.json',
    dispatched_at: '2026-05-10T00:00:00.000Z',
    worktree: '/tmp/wt',
    outcome: 'in-progress',
  });
  finalizeImplementDispatch(specPath, 'slice-1', 'task-1', {
    outcome: 'failed-fallback-pending',
    completed_at: '2026-05-10T00:05:00.000Z',
    concerns: ['codex exit 1'],
  });
  const sc = readSidecar(root, specPath);
  const d = sc.slice_reviews['slice-1'].phases.implement.dispatches[0];
  assert.equal(d.outcome, 'failed-fallback-pending');
  assert.deepEqual(d.concerns, ['codex exit 1']);
  cleanup(root);
});
