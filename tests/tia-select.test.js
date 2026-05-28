// Tests for the pure TIA selection logic (scripts/tia.mjs selectTests).
// The selection decision is the load-bearing correctness surface: it must never return a narrower
// set than required ("never skip a test that should run"), so these cases pin the fallbacks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTests, isGlobalTrigger, isTrackedSource } from '../scripts/tia.mjs';

const NODE = 'v26.0.0';
const ALL = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js'];

// A map where: a depends on lib/x.js, b depends on lib/y.js, c depends on bin/z.js
function baseMap(overrides = {}) {
  return {
    version: 1,
    node: NODE,
    tests: {
      'tests/a.test.js': { hash: 'ha', deps: ['lib/x.js'] },
      'tests/b.test.js': { hash: 'hb', deps: ['lib/y.js'] },
      'tests/c.test.js': { hash: 'hc', deps: ['bin/z.js'] },
      ...overrides,
    },
  };
}

// hashOf returns the "current" hash; default matches the map (nothing changed content-wise).
const hashOfMatching = (rel) => ({ 'tests/a.test.js': 'ha', 'tests/b.test.js': 'hb', 'tests/c.test.js': 'hc' }[rel] || null);

function run(changed, { map = baseMap(), hashOf = hashOfMatching } = {}) {
  return selectTests({ changed, map, allTestFiles: ALL, hashOf, nodeVersion: NODE });
}

test('no map → run all', () => {
  const d = selectTests({ changed: ['lib/x.js'], map: null, allTestFiles: ALL, hashOf: hashOfMatching, nodeVersion: NODE });
  assert.equal(d.mode, 'all');
  assert.match(d.reason, /no-map/);
});

test('node version mismatch → run all', () => {
  const d = selectTests({ changed: ['lib/x.js'], map: baseMap(), allTestFiles: ALL, hashOf: hashOfMatching, nodeVersion: 'v27.0.0' });
  assert.equal(d.mode, 'all');
  assert.match(d.reason, /node-version-changed/);
});

test('global triggers force full run', () => {
  for (const f of ['package.json', 'package-lock.json', 'scripts/tia.mjs', 'tests/fixtures/foo.json', '.claude-plugin/plugin.json']) {
    const d = run([f]);
    assert.equal(d.mode, 'all', `${f} should force full run`);
    assert.match(d.reason, /global-trigger/);
  }
});

test('dep change selects only the impacted test', () => {
  const d = run(['lib/y.js']);
  assert.equal(d.mode, 'selected');
  assert.deepEqual(d.tests, ['tests/b.test.js']);
});

test('cross-process dep (bin/) selects its test', () => {
  const d = run(['bin/z.js']);
  assert.equal(d.mode, 'selected');
  assert.deepEqual(d.tests, ['tests/c.test.js']);
});

test('changed test file (hash differs) is selected', () => {
  const hashOf = (rel) => (rel === 'tests/a.test.js' ? 'CHANGED' : hashOfMatching(rel));
  const d = run(['tests/a.test.js'], { hashOf });
  assert.equal(d.mode, 'selected');
  assert.deepEqual(d.tests, ['tests/a.test.js']);
});

test('new test file (absent from map) is always selected', () => {
  const allWithNew = [...ALL, 'tests/new.test.js'];
  const d = selectTests({ changed: ['tests/new.test.js'], map: baseMap(), allTestFiles: allWithNew, hashOf: hashOfMatching, nodeVersion: NODE });
  assert.equal(d.mode, 'selected');
  assert.ok(d.tests.includes('tests/new.test.js'));
});

test('changed source NOT covered by any test → conservative full run', () => {
  const d = run(['lib/brand-new-module.js']);
  assert.equal(d.mode, 'all');
  assert.match(d.reason, /not covered by map/);
});

test('clean working tree (no changes) → run nothing', () => {
  const d = run([]);
  assert.equal(d.mode, 'none');
});

test('non-source change (e.g. README) with no test deps → run nothing', () => {
  const d = run(['README.md']);
  assert.equal(d.mode, 'none');
});

test('isGlobalTrigger / isTrackedSource classifiers', () => {
  assert.equal(isGlobalTrigger('scripts/x.mjs'), true);
  assert.equal(isGlobalTrigger('lib/x.js'), false);
  assert.equal(isTrackedSource('lib/codex-bridge/sidecar.js'), true);
  assert.equal(isTrackedSource('bin/codex-paired-doctor'), true);
  assert.equal(isTrackedSource('docs/x.md'), false);
});
