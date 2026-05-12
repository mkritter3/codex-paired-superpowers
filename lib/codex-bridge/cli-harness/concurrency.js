// v0.9.0 slice 1 — max-concurrent dispatch queue.
//
// `enforceMaxConcurrent(maxN, fn)` returns a wrapping function that
// queues calls past `maxN` active dispatches. The default cap is 4
// (matches the v0.9.0 plan: panel mode dispatches up to 4 reviewers in
// parallel). Cap=0 is interpreted as "serialize to 1-at-a-time" rather
// than "deadlock"; the architecture spec doesn't ask for a "no
// concurrency" mode, but tests assert the serialize-on-zero contract so
// callers can opt in to single-file dispatch deterministically.
//
// Implementation is a Promise-based semaphore: each call awaits a slot,
// runs the underlying fn, and releases the slot in `finally`. No
// external deps.

const DEFAULT_CAP = 4;

export function enforceMaxConcurrent(maxN, fn) {
  const cap = resolveCap(maxN);
  let active = 0;
  const waiters = [];

  function acquire() {
    if (active < cap) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    active -= 1;
    if (active < cap && waiters.length > 0) {
      const next = waiters.shift();
      active += 1;
      next();
    }
  }

  return async function wrapped(...args) {
    await acquire();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}

function resolveCap(maxN) {
  if (maxN === undefined || maxN === null) return DEFAULT_CAP;
  if (!Number.isFinite(maxN)) return DEFAULT_CAP;
  if (maxN <= 0) return 1;
  return Math.floor(maxN);
}
