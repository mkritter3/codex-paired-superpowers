// v0.9.0 slice 1 — concurrency.js: max-concurrent dispatch queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enforceMaxConcurrent } from '../../../lib/codex-bridge/cli-harness/concurrency.js';

function makeSlowDispatch(durationMs = 50) {
  let active = 0;
  let maxObserved = 0;
  const fn = () =>
    new Promise((resolve) => {
      active += 1;
      if (active > maxObserved) maxObserved = active;
      setTimeout(() => {
        active -= 1;
        resolve('ok');
      }, durationMs);
    });
  return { fn, getMaxObserved: () => maxObserved };
}

test('enforceMaxConcurrent caps active dispatches at N=2', async () => {
  const { fn, getMaxObserved } = makeSlowDispatch(30);
  const wrapped = enforceMaxConcurrent(2, fn);
  await Promise.all([wrapped(), wrapped(), wrapped(), wrapped(), wrapped()]);
  assert.ok(
    getMaxObserved() <= 2,
    `expected max ≤ 2, observed ${getMaxObserved()}`,
  );
  assert.ok(
    getMaxObserved() >= 1,
    'at least one dispatch must have run',
  );
});

test('enforceMaxConcurrent with cap=0 serializes (single-file)', async () => {
  const { fn, getMaxObserved } = makeSlowDispatch(20);
  const wrapped = enforceMaxConcurrent(0, fn);
  await Promise.all([wrapped(), wrapped(), wrapped()]);
  assert.equal(getMaxObserved(), 1, 'cap=0 must serialize to 1-at-a-time');
});

test('enforceMaxConcurrent default cap is 4', async () => {
  const { fn, getMaxObserved } = makeSlowDispatch(40);
  const wrapped = enforceMaxConcurrent(undefined, fn);
  await Promise.all([
    wrapped(),
    wrapped(),
    wrapped(),
    wrapped(),
    wrapped(),
    wrapped(),
  ]);
  assert.ok(
    getMaxObserved() <= 4,
    `expected default cap ≤ 4, observed ${getMaxObserved()}`,
  );
});

test('enforceMaxConcurrent forwards args and return values', async () => {
  const dispatched = [];
  const fn = async (x, y) => {
    dispatched.push([x, y]);
    return x + y;
  };
  const wrapped = enforceMaxConcurrent(2, fn);
  const results = await Promise.all([wrapped(1, 2), wrapped(3, 4)]);
  assert.deepEqual(results.sort(), [3, 7]);
});

test('enforceMaxConcurrent propagates rejection without blocking the queue', async () => {
  let count = 0;
  const fn = async (shouldThrow) => {
    count += 1;
    if (shouldThrow) throw new Error('boom');
    return count;
  };
  const wrapped = enforceMaxConcurrent(1, fn);
  await assert.rejects(() => wrapped(true), /boom/);
  // The queue must still serve the next call.
  const ok = await wrapped(false);
  assert.equal(typeof ok, 'number');
});
