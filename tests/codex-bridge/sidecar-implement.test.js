import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  initSidecar,
  loadSidecar,
  setImplementMeta,
  setImplementBootstrap,
  appendImplementDispatch,
  sidecarPathFor,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-impl-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'f', codexSession: 's', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

test('setImplementMeta writes preferred/fallback/parallel/worktree fields under phases.implement', () => {
  const { dir, spec } = makeSpec();
  setImplementMeta(spec, 'slice-3', {
    preferred_implementer: 'codex',
    fallback_implementer: 'sonnet',
    parallel_group: 'parallel-2026-05-08T12:00:00.000Z-3-5',
    parallel_suppressed_reason: null,
    worktree: '/repo/.git-worktrees/slice-3',
  });
  const sc = loadSidecar(spec);
  const impl = sc.slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.preferred_implementer, 'codex');
  assert.equal(impl.fallback_implementer, 'sonnet');
  assert.equal(impl.parallel_group, 'parallel-2026-05-08T12:00:00.000Z-3-5');
  assert.equal(impl.parallel_suppressed_reason, null);
  assert.equal(impl.worktree, '/repo/.git-worktrees/slice-3');
  rmSync(dir, { recursive: true, force: true });
});

test('setImplementMeta is overwrite-on-write (second call replaces fields)', () => {
  const { dir, spec } = makeSpec();
  setImplementMeta(spec, 'slice-3', {
    preferred_implementer: 'codex',
    fallback_implementer: 'sonnet',
    parallel_group: null,
    parallel_suppressed_reason: null,
    worktree: '/a',
  });
  setImplementMeta(spec, 'slice-3', {
    preferred_implementer: 'sonnet',
    fallback_implementer: 'codex',
    parallel_group: 'pg-1',
    parallel_suppressed_reason: 'overlap',
    worktree: '/b',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.preferred_implementer, 'sonnet');
  assert.equal(impl.fallback_implementer, 'codex');
  assert.equal(impl.parallel_group, 'pg-1');
  assert.equal(impl.parallel_suppressed_reason, 'overlap');
  assert.equal(impl.worktree, '/b');
  rmSync(dir, { recursive: true, force: true });
});

test('setImplementMeta preserves dispatches and other implement fields', () => {
  const { dir, spec } = makeSpec();
  setImplementMeta(spec, 'slice-3', {
    preferred_implementer: 'codex',
    fallback_implementer: 'sonnet',
    parallel_group: null,
    parallel_suppressed_reason: null,
    worktree: '/w',
  });
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'codex',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  setImplementMeta(spec, 'slice-3', {
    preferred_implementer: 'sonnet',
    fallback_implementer: 'codex',
    parallel_group: null,
    parallel_suppressed_reason: null,
    worktree: '/w2',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches.length, 1);
  assert.equal(impl.preferred_implementer, 'sonnet');
  rmSync(dir, { recursive: true, force: true });
});

test('setImplementBootstrap writes symlinks and completed_at under phases.implement.bootstrap', () => {
  const { dir, spec } = makeSpec();
  setImplementBootstrap(spec, 'slice-3', {
    symlinks: ['node_modules', 'custom_dir'],
    completed_at: '2026-05-08T12:00:02.000Z',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.deepEqual(impl.bootstrap.symlinks, ['node_modules', 'custom_dir']);
  assert.equal(impl.bootstrap.completed_at, '2026-05-08T12:00:02.000Z');
  rmSync(dir, { recursive: true, force: true });
});

test('setImplementBootstrap is overwrite-on-write', () => {
  const { dir, spec } = makeSpec();
  setImplementBootstrap(spec, 'slice-3', {
    symlinks: ['node_modules'],
    completed_at: '2026-05-08T12:00:00.000Z',
  });
  setImplementBootstrap(spec, 'slice-3', {
    symlinks: ['node_modules', '.venv'],
    completed_at: '2026-05-08T13:00:00.000Z',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.deepEqual(impl.bootstrap.symlinks, ['node_modules', '.venv']);
  assert.equal(impl.bootstrap.completed_at, '2026-05-08T13:00:00.000Z');
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch produces an append-only array (two calls, two entries)', () => {
  const { dir, spec } = makeSpec();
  const d1 = {
    slice_id: 'slice-3',
    agent: 'codex',
    thread_id: '019e-aaa',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    completed_at: '2026-05-08T12:01:00.000Z',
    worktree: '/w',
    head_sha: 'abc123',
    commit_count: 0,
    outcome: 'failed-fallback-pending',
  };
  const d2 = {
    slice_id: 'slice-3',
    agent: 'sonnet',
    thread_id: null,
    dispatched_at: '2026-05-08T12:02:00.000Z',
    completed_at: '2026-05-08T12:05:00.000Z',
    worktree: '/w',
    head_sha: 'def456',
    commit_count: 2,
    outcome: 'shipped',
  };
  appendImplementDispatch(spec, 'slice-3', d1);
  appendImplementDispatch(spec, 'slice-3', d2);
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches.length, 2);
  assert.deepEqual(impl.dispatches[0], d1);
  assert.deepEqual(impl.dispatches[1], d2);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch preserves both dispatches across fallback (failed preferred + shipped fallback)', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'codex',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'failed-fallback-pending',
  });
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-08T12:02:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches.length, 2);
  assert.equal(impl.dispatches[0].outcome, 'failed-fallback-pending');
  assert.equal(impl.dispatches[0].agent, 'codex');
  assert.equal(impl.dispatches[1].outcome, 'shipped');
  assert.equal(impl.dispatches[1].agent, 'sonnet');
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch rejects unknown agent values', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'gpt4',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    });
  }, /agent/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch rejects unknown outcome values', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'maybe',
    });
  }, /outcome/i);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch requires slice_id', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    });
  }, /slice_id/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch requires agent', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    });
  }, /agent/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch requires dispatched_at', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'codex',
      worktree: '/w',
      outcome: 'shipped',
    });
  }, /dispatched_at/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch requires worktree', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      outcome: 'shipped',
    });
  }, /worktree/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch requires outcome', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
    });
  }, /outcome/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch accepts null thread_id (Sonnet path)', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    thread_id: null,
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches[0].thread_id, null);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch accepts missing thread_id (omitted entirely)', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'sonnet',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch accepts all valid outcomes', () => {
  const { dir, spec } = makeSpec();
  for (const outcome of ['shipped', 'failed-fallback-pending', 'failed-halted']) {
    appendImplementDispatch(spec, `slice-${outcome}`, {
      slice_id: `slice-${outcome}`,
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome,
    });
  }
  rmSync(dir, { recursive: true, force: true });
});

test('appendImplementDispatch accepts both valid agents', () => {
  const { dir, spec } = makeSpec();
  for (const agent of ['codex', 'sonnet']) {
    appendImplementDispatch(spec, `slice-${agent}`, {
      slice_id: `slice-${agent}`,
      agent,
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    });
  }
  rmSync(dir, { recursive: true, force: true });
});

test('atomic write: no .tmp file remains in sidecar dir after a successful write', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'codex',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  const target = sidecarPathFor(spec);
  const parentDir = dirname(target);
  const leftovers = readdirSync(parentDir).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftovers, [], `expected no .tmp.* files; found: ${leftovers.join(', ')}`);
  rmSync(dir, { recursive: true, force: true });
});

test('atomic write: rejected dispatch (validation throw) does not corrupt sidecar', () => {
  const { dir, spec } = makeSpec();
  appendImplementDispatch(spec, 'slice-3', {
    slice_id: 'slice-3',
    agent: 'codex',
    dispatched_at: '2026-05-08T12:00:00.000Z',
    worktree: '/w',
    outcome: 'shipped',
  });
  const before = readFileSync(sidecarPathFor(spec), 'utf8');
  assert.throws(() => {
    appendImplementDispatch(spec, 'slice-3', {
      slice_id: 'slice-3',
      agent: 'wrong-agent',
      dispatched_at: '2026-05-08T12:01:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    });
  });
  const after = readFileSync(sidecarPathFor(spec), 'utf8');
  assert.equal(before, after, 'sidecar must be unchanged after rejected validation');
  // No .tmp leftover after a thrown validation either.
  const parentDir = dirname(sidecarPathFor(spec));
  const leftovers = readdirSync(parentDir).filter((f) => f.includes('.tmp.'));
  assert.deepEqual(leftovers, []);
  rmSync(dir, { recursive: true, force: true });
});

// CLI subcommand tests.
const CLI = join(process.cwd(), 'lib/codex-bridge/cli.js');

function runCli(args, opts = {}) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
}

test('CLI sidecar-set-implement-meta writes meta fields', () => {
  const { dir, spec } = makeSpec();
  runCli([
    'sidecar-set-implement-meta',
    '--specPath', spec,
    '--sliceId', 'slice-3',
    '--meta', JSON.stringify({
      preferred_implementer: 'codex',
      fallback_implementer: 'sonnet',
      parallel_group: null,
      parallel_suppressed_reason: null,
      worktree: '/w',
    }),
  ]);
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.preferred_implementer, 'codex');
  assert.equal(impl.worktree, '/w');
  rmSync(dir, { recursive: true, force: true });
});

test('CLI sidecar-set-implement-bootstrap writes bootstrap fields', () => {
  const { dir, spec } = makeSpec();
  runCli([
    'sidecar-set-implement-bootstrap',
    '--specPath', spec,
    '--sliceId', 'slice-3',
    '--bootstrap', JSON.stringify({
      symlinks: ['node_modules'],
      completed_at: '2026-05-08T12:00:02.000Z',
    }),
  ]);
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.deepEqual(impl.bootstrap.symlinks, ['node_modules']);
  assert.equal(impl.bootstrap.completed_at, '2026-05-08T12:00:02.000Z');
  rmSync(dir, { recursive: true, force: true });
});

test('CLI sidecar-append-implement-dispatch appends entries', () => {
  const { dir, spec } = makeSpec();
  runCli([
    'sidecar-append-implement-dispatch',
    '--specPath', spec,
    '--sliceId', 'slice-3',
    '--dispatch', JSON.stringify({
      slice_id: 'slice-3',
      agent: 'codex',
      dispatched_at: '2026-05-08T12:00:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    }),
  ]);
  runCli([
    'sidecar-append-implement-dispatch',
    '--specPath', spec,
    '--sliceId', 'slice-3',
    '--dispatch', JSON.stringify({
      slice_id: 'slice-3',
      agent: 'sonnet',
      dispatched_at: '2026-05-08T12:01:00.000Z',
      worktree: '/w',
      outcome: 'shipped',
    }),
  ]);
  const impl = loadSidecar(spec).slice_reviews['slice-3'].phases.implement;
  assert.equal(impl.dispatches.length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI sidecar-append-implement-dispatch exits non-zero on invalid agent', () => {
  const { dir, spec } = makeSpec();
  let threw = false;
  try {
    runCli([
      'sidecar-append-implement-dispatch',
      '--specPath', spec,
      '--sliceId', 'slice-3',
      '--dispatch', JSON.stringify({
        slice_id: 'slice-3',
        agent: 'bogus',
        dispatched_at: '2026-05-08T12:00:00.000Z',
        worktree: '/w',
        outcome: 'shipped',
      }),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    threw = true;
    assert.notEqual(e.status, 0);
  }
  assert.equal(threw, true);
  rmSync(dir, { recursive: true, force: true });
});
