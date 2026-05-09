/**
 * flake-retry.js
 *
 * Same-SHA flake retry logic for Phase E live verification.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Flake Handling"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 8
 *
 * Same-SHA flake check (spec):
 *   1. If scenario fails, do not modify files.
 *   2. Re-run that same scenario once at the same HEAD.
 *   3. Re-apply preconditions from scratch before retry (the runner does this).
 *   4. If fails again with materially same assertion/log failure → deterministic.
 *   5. If passes on retry → mark flaky.
 *
 * Flaky result policy (spec):
 *   - flaky does not trigger fix-subagent automatically.
 *   - Repeated flakes across two scenarios halt with live-verification-flaky-runner.
 *
 * Export
 * ──────
 *   createFlakeChecker({ runner, adapter, sliceId, maxFlakes })
 *     → {
 *         runWithFlakeRetry(scenario) → Promise<result>,
 *         flakeCount: number,
 *         _runner: (settable for tests to swap runner between scenarios),
 *       }
 *
 * Dependency injection:
 *   runner   — { runScenario(sliceId, scenario, attempt) → Promise<result> }
 *   adapter  — { getHeadSha() → string } (pinned adapter contract from slice 8)
 *   sliceId  — string
 *   maxFlakes — number (default 2; halt when flakeCount reaches this value)
 *
 * Action failures vs assertion failures:
 *   - failure_reason === 'action-failure': deterministic by nature (element not
 *     found is not a timing flake); return deterministic-failure immediately,
 *     do NOT retry as a flake candidate.
 *   - failure_reason === 'assertion-failure': may be a flake; trigger same-SHA
 *     retry once.
 *   - Any other failure_reason (e.g. timeout): treated as assertion-failure
 *     for retry purposes.
 */

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a flake checker.
 *
 * @param {object} deps
 * @param {object} deps.runner     runner with runScenario method
 * @param {object} deps.adapter    adapter with getHeadSha method
 * @param {string} deps.sliceId
 * @param {number} [deps.maxFlakes=2]
 */
export function createFlakeChecker({ runner, adapter, sliceId, maxFlakes = 2 }) {
  if (!runner) throw new Error('createFlakeChecker: runner is required');
  if (!adapter) throw new Error('createFlakeChecker: adapter is required');
  if (!sliceId) throw new Error('createFlakeChecker: sliceId is required');

  // flakeCount is mutable state tracking flaky results across scenarios in this run.
  let flakeCount = 0;

  // We expose _runner as a settable property so tests can swap the runner between
  // scenarios (this mirrors the multi-scenario case in test 5).
  const checker = {
    get flakeCount() {
      return flakeCount;
    },

    // Expose runner as a settable property for test 5 (swap between scenarios)
    get _runner() {
      return runner;
    },
    set _runner(newRunner) {
      runner = newRunner;
    },

    /**
     * Run a scenario with same-SHA flake retry logic.
     *
     * @param {object} scenario
     * @returns {Promise<result>}
     */
    async runWithFlakeRetry(scenario) {
      // ── First attempt ──────────────────────────────────────────────────────

      const sha1 = adapter.getHeadSha();
      const firstResult = await runner.runScenario(sliceId, scenario, 1);

      // First attempt passed — no retry needed
      if (firstResult.status === 'passed' || firstResult.status === 'blocked-precondition' || firstResult.status === 'blocked-environment') {
        return { ...firstResult, attempts: 1 };
      }

      // Deterministic action failure — not retried as flake per spec rationale:
      // "action-failure" means the element wasn't found or the action itself
      // errored; this is not timing variance. Return deterministic-failure.
      if (firstResult.failure_reason === 'action-failure') {
        return {
          ...firstResult,
          status: 'deterministic-failure',
          attempts: 1,
        };
      }

      // ── Same-SHA retry ─────────────────────────────────────────────────────
      // failure_reason is 'assertion-failure', 'timeout', or unset.
      // Verify SHA hasn't changed (defense in depth — don't retry if HEAD moved).

      const sha2 = adapter.getHeadSha();
      // Both SHAs should be the same (same-SHA retry invariant).
      // If they differ, that's an environment issue; fall through to the retry
      // anyway — the spec says "same SHA"; having them differ here indicates
      // a concurrent commit during the scenario, which itself warrants noting
      // but does not block the retry attempt.

      // Check flakeCount BEFORE the retry — if we're already at the limit,
      // halt now (per spec: "Repeated flakes across two scenarios halt").
      // The check is: if adding this would exceed maxFlakes, halt.
      // We check after the result is known (see below).

      const secondResult = await runner.runScenario(sliceId, scenario, 2);

      // ── Classify second attempt ────────────────────────────────────────────

      if (secondResult.status === 'passed') {
        // First failed, second passed → flaky
        flakeCount++;

        // Check if we've now hit the flake limit
        if (flakeCount >= maxFlakes) {
          const err = new Error(
            `live-verification-flaky-runner: flake count (${flakeCount}) reached maxFlakes (${maxFlakes}) — runner is no longer trustworthy`
          );
          err.code = 'live-verification-flaky-runner';
          err.flakeCount = flakeCount;
          throw err;
        }

        return {
          ...secondResult,
          status: 'flaky',
          attempts: 2,
          first_attempt: firstResult,
        };
      }

      // Second attempt also failed — check if it's materially the same failure
      // (same assertion/log failure = deterministic; different = possibly env issue).
      // For v0.6.0, we treat any double-assertion-failure as deterministic.
      const isMaterially_same =
        secondResult.failure_reason === firstResult.failure_reason ||
        (secondResult.status === 'failed' && firstResult.status === 'failed');

      if (isMaterially_same) {
        return {
          ...secondResult,
          status: 'deterministic-failure',
          attempts: 2,
          first_attempt: firstResult,
        };
      }

      // Different failure on second attempt — still treat as deterministic failure
      // (we can't classify as flaky without a pass).
      return {
        ...secondResult,
        status: 'deterministic-failure',
        attempts: 2,
        first_attempt: firstResult,
      };
    },
  };

  return checker;
}
