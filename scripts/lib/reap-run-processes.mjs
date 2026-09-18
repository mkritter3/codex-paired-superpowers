/**
 * Converging reap for the fresh-clone smoke's run-owned processes.
 *
 * Extracted from scripts/fresh-clone-smoke.mjs so the convergence behaviour can be tested with
 * scripted discovery results instead of real processes racing the cleanup that is under test.
 *
 * History, so the invariants are not re-broken:
 *   1. The original waited for a KNOWN pid list to disappear, then ran discovery ONCE and returned
 *      that snapshot as the survivor set. A process the smoke spawned during teardown, or one
 *      already killed but still visible for an instant, came back as an unsignalled "survivor"
 *      (CI: macos/Node 26 cancellation exited 1 with `incomplete cleanup: …` instead of 143).
 *   2. The first fix looped but signalled EITHER the fresh pids OR the already-signalled ones, so a
 *      producer that ignores SIGTERM and keeps spawning children starved escalation: the producer
 *      never received SIGKILL while new arrivals kept appearing.
 *
 * Each pass therefore signals BOTH partitions: SIGTERM for pids seen for the first time, SIGKILL
 * for pids already sent SIGTERM on an earlier pass. It returns [] as soon as discovery is empty and
 * reports survivors only once the bound expires.
 *
 * @param {object} deps
 * @param {() => number[]} deps.discover           — current run-owned pids
 * @param {(pids: number[], signal: string) => void} deps.signal
 * @param {(ms: number) => Promise<void>} deps.wait
 * @param {number} deps.limitMs                    — total budget
 * @param {() => number} [deps.now]
 * @param {number} [deps.pollMs]
 * @returns {Promise<number[]>} survivors ([] when everything was reaped)
 */
export async function reapRunProcesses({ discover, signal, wait, limitMs, now = Date.now, pollMs = 25 }) {
  const deadline = now() + limitMs;
  const termed = new Set();
  for (;;) {
    const current = discover();
    if (current.length === 0) return [];

    const fresh = current.filter((pid) => !termed.has(pid));
    const escalate = current.filter((pid) => termed.has(pid));
    // Both partitions, every pass: new arrivals must not postpone escalation of older survivors.
    if (escalate.length > 0) signal(escalate, 'SIGKILL');
    if (fresh.length > 0) {
      signal(fresh, 'SIGTERM');
      for (const pid of fresh) termed.add(pid);
    }

    if (now() >= deadline) return discover();
    await wait(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
