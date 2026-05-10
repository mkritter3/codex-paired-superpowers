// Tests for v0.7.3 dependency-graph module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDAG,
  computeReadySet,
  maximalFirstFitNonOverlap,
  computeDigest,
  enumerateDescendants,
} from '../../lib/codex-bridge/dependency-graph.js';

function makePlanFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-dag-'));
  const path = join(dir, 'plan.md');
  writeFileSync(path, content);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── buildDAG: basic ─────────────────────────────────────────────────────────

test('buildDAG with linear deps (1 → 2 → 3) succeeds', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-2

**Files:**
- c.js
`);
  const r = buildDAG(path);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.dag.nodes['slice-1'].dependsOn, []);
  assert.deepEqual(r.dag.nodes['slice-2'].dependsOn, ['slice-1']);
  assert.deepEqual(r.dag.nodes['slice-3'].dependsOn, ['slice-2']);
  assert.deepEqual([...r.filesIndex['slice-2']], ['b.js']);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  cleanup();
});

test('buildDAG with no deps loads cleanly', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**Files:**
- a.js
`);
  const r = buildDAG(path);
  assert.ok(r.ok);
  assert.deepEqual(r.dag.nodes['slice-1'].dependsOn, []);
  cleanup();
});

// ── buildDAG: error paths ─────────────────────────────────────────────────

test('buildDAG halts dep-unknown-slice when DependsOn references missing slice', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**DependsOn:**
- slice-99

**Files:**
- a.js
`);
  const r = buildDAG(path);
  assert.equal(r.ok, false);
  assert.equal(r.halt.reason, 'dep-unknown-slice');
  assert.match(r.halt.detail, /slice-99/);
  cleanup();
});

test('buildDAG halts dep-cycle on simple 2-cycle', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**DependsOn:**
- slice-2

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js
`);
  const r = buildDAG(path);
  assert.equal(r.ok, false);
  assert.equal(r.halt.reason, 'dep-cycle');
  assert.match(r.halt.detail, /slice-1/);
  assert.match(r.halt.detail, /slice-2/);
  cleanup();
});

test('buildDAG halts dep-cycle on 3-cycle', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**DependsOn:**
- slice-3

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-2

**Files:**
- c.js
`);
  const r = buildDAG(path);
  assert.equal(r.ok, false);
  assert.equal(r.halt.reason, 'dep-cycle');
  cleanup();
});

test('buildDAG halts dep-self-reference (caught at parse layer)', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**DependsOn:**
- slice-1

**Files:**
- a.js
`);
  const r = buildDAG(path);
  assert.equal(r.ok, false);
  assert.equal(r.halt.reason, 'dep-self-reference');
  cleanup();
});

test('buildDAG with diamond (A → B,C → D) is acyclic', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-1

**Files:**
- c.js

## Slice 4: d

**DependsOn:**
- slice-2
- slice-3

**Files:**
- d.js
`);
  const r = buildDAG(path);
  assert.ok(r.ok);
  cleanup();
});

// ── computeDigest: determinism ────────────────────────────────────────────

test('computeDigest is stable across DependsOn ordering', () => {
  const dag1 = { nodes: { 'slice-1': { dependsOn: [] }, 'slice-2': { dependsOn: ['slice-1'] } } };
  const dag2 = { nodes: { 'slice-2': { dependsOn: ['slice-1'] }, 'slice-1': { dependsOn: [] } } };
  // Same logical structure, different declaration order
  assert.equal(computeDigest(dag1), computeDigest(dag2));
});

test('computeDigest changes when deps change', () => {
  const dag1 = { nodes: { 'slice-1': { dependsOn: [] }, 'slice-2': { dependsOn: ['slice-1'] } } };
  const dag2 = { nodes: { 'slice-1': { dependsOn: [] }, 'slice-2': { dependsOn: [] } } };
  assert.notEqual(computeDigest(dag1), computeDigest(dag2));
});

// ── computeReadySet ───────────────────────────────────────────────────────

test('computeReadySet returns no-deps slices when nothing started', () => {
  const dag = {
    nodes: {
      'slice-1': { dependsOn: [] },
      'slice-2': { dependsOn: ['slice-1'] },
      'slice-3': { dependsOn: ['slice-1'] },
    },
  };
  const ready = computeReadySet(dag, {});
  // slice-1 has no deps → ready. slice-2 + slice-3 wait for slice-1 to ship.
  assert.deepEqual(ready, ['slice-1']);
});

test('computeReadySet returns next layer after deps ship', () => {
  const dag = {
    nodes: {
      'slice-1': { dependsOn: [] },
      'slice-2': { dependsOn: ['slice-1'] },
      'slice-3': { dependsOn: ['slice-1'] },
    },
  };
  const ready = computeReadySet(dag, { 'slice-1': 'shipped' });
  assert.deepEqual(ready.sort(), ['slice-2', 'slice-3']);
});

test('computeReadySet does not return shipped or in-progress', () => {
  const dag = {
    nodes: {
      'slice-1': { dependsOn: [] },
      'slice-2': { dependsOn: [] },
      'slice-3': { dependsOn: [] },
    },
  };
  const ready = computeReadySet(dag, {
    'slice-1': 'shipped',
    'slice-2': 'in-progress',
    'slice-3': 'pending',
  });
  assert.deepEqual(ready, ['slice-3']);
});

test('computeReadySet excludes failed slices', () => {
  const dag = { nodes: { 'slice-1': { dependsOn: [] } } };
  const ready = computeReadySet(dag, { 'slice-1': 'failed' });
  assert.deepEqual(ready, []);
});

// ── maximalFirstFitNonOverlap ─────────────────────────────────────────────

test('maximalFirstFitNonOverlap picks all when Files disjoint', () => {
  const filesIndex = {
    'slice-1': new Set(['a.js']),
    'slice-2': new Set(['b.js']),
    'slice-3': new Set(['c.js']),
  };
  const r = maximalFirstFitNonOverlap(['slice-1', 'slice-2', 'slice-3'], filesIndex);
  assert.deepEqual(r, ['slice-1', 'slice-2', 'slice-3']);
});

test('maximalFirstFitNonOverlap excludes a slice that overlaps', () => {
  const filesIndex = {
    'slice-1': new Set(['a.js', 'shared.js']),
    'slice-2': new Set(['shared.js']),
    'slice-3': new Set(['c.js']),
  };
  // First-fit by numeric order: pick slice-1, skip slice-2 (overlap), pick slice-3
  const r = maximalFirstFitNonOverlap(['slice-1', 'slice-2', 'slice-3'], filesIndex);
  assert.deepEqual(r, ['slice-1', 'slice-3']);
});

test('maximalFirstFitNonOverlap is deterministic by numeric order', () => {
  const filesIndex = {
    'slice-1': new Set(['shared.js']),
    'slice-2': new Set(['shared.js']),
  };
  // Even when input order is reversed, numeric order picks slice-1
  const r1 = maximalFirstFitNonOverlap(['slice-2', 'slice-1'], filesIndex);
  const r2 = maximalFirstFitNonOverlap(['slice-1', 'slice-2'], filesIndex);
  assert.deepEqual(r1, ['slice-1']);
  assert.deepEqual(r2, ['slice-1']);
});

test('maximalFirstFitNonOverlap returns [] for empty readySet', () => {
  assert.deepEqual(maximalFirstFitNonOverlap([], {}), []);
});

test('maximalFirstFitNonOverlap handles slices with empty Files', () => {
  const filesIndex = {
    'slice-1': new Set(),
    'slice-2': new Set(['b.js']),
  };
  // Empty Files set never overlaps with anything
  const r = maximalFirstFitNonOverlap(['slice-1', 'slice-2'], filesIndex);
  assert.deepEqual(r, ['slice-1', 'slice-2']);
});

// ── enumerateDescendants ──────────────────────────────────────────────────

test('enumerateDescendants returns transitive dependents', () => {
  const dag = {
    nodes: {
      'slice-1': { dependsOn: [] },
      'slice-2': { dependsOn: ['slice-1'] },
      'slice-3': { dependsOn: ['slice-1'] },
      'slice-4': { dependsOn: ['slice-2'] },
      'slice-5': { dependsOn: ['slice-3', 'slice-4'] },
    },
  };
  const r = enumerateDescendants(dag, 'slice-1');
  assert.deepEqual(r.sort(), ['slice-2', 'slice-3', 'slice-4', 'slice-5']);
});

test('enumerateDescendants returns [] when slice has no descendants', () => {
  const dag = {
    nodes: {
      'slice-1': { dependsOn: [] },
      'slice-2': { dependsOn: ['slice-1'] },
    },
  };
  assert.deepEqual(enumerateDescendants(dag, 'slice-2'), []);
});

// ── full integration: linear plan ─────────────────────────────────────────

test('full pipeline: linear plan dispatches one slice at a time', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-2

**Files:**
- c.js
`);
  const built = buildDAG(path);
  assert.ok(built.ok);

  // Initial state: only slice-1 is ready
  let ready = computeReadySet(built.dag, {});
  let batch = maximalFirstFitNonOverlap(ready, built.filesIndex);
  assert.deepEqual(batch, ['slice-1']);

  // After slice-1 ships, slice-2 ready
  ready = computeReadySet(built.dag, { 'slice-1': 'shipped' });
  batch = maximalFirstFitNonOverlap(ready, built.filesIndex);
  assert.deepEqual(batch, ['slice-2']);

  // After slice-2 ships, slice-3 ready
  ready = computeReadySet(built.dag, { 'slice-1': 'shipped', 'slice-2': 'shipped' });
  batch = maximalFirstFitNonOverlap(ready, built.filesIndex);
  assert.deepEqual(batch, ['slice-3']);

  cleanup();
});

test('full pipeline: diamond plan dispatches 2 in parallel after root', () => {
  const { path, cleanup } = makePlanFile(`
## Slice 1: a

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-1

**Files:**
- c.js

## Slice 4: d

**DependsOn:**
- slice-2
- slice-3

**Files:**
- d.js
`);
  const built = buildDAG(path);
  assert.ok(built.ok);

  // Layer 1: only slice-1
  let batch = maximalFirstFitNonOverlap(computeReadySet(built.dag, {}), built.filesIndex);
  assert.deepEqual(batch, ['slice-1']);

  // Layer 2: slice-2 + slice-3 in parallel (different Files)
  batch = maximalFirstFitNonOverlap(
    computeReadySet(built.dag, { 'slice-1': 'shipped' }),
    built.filesIndex
  );
  assert.deepEqual(batch.sort(), ['slice-2', 'slice-3']);

  // Layer 3: slice-4
  batch = maximalFirstFitNonOverlap(
    computeReadySet(built.dag, {
      'slice-1': 'shipped',
      'slice-2': 'shipped',
      'slice-3': 'shipped',
    }),
    built.filesIndex
  );
  assert.deepEqual(batch, ['slice-4']);

  cleanup();
});
