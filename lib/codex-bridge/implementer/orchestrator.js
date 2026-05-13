// v0.10.0 implementer-experts — orchestrator (fake-adapter only at this slice).
//
// Dispatches implementers in parallel, records sidecar events, aggregates
// outcomes, and aborts the shared signal on required-member failure.

import { createHash, randomUUID } from 'node:crypto';

import {
  startImplementerRun,
  appendImplementerEventLocked,
  readImplementerRun,
} from '../sidecar.js';
import { wrapAsHaltEnvelope } from '../halt-envelope.js';

// ── internal helpers ──────────────────────────────────────────────────────────

function sha256hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

function payloadHash(payload) {
  return 'sha256:' + sha256hex(JSON.stringify(payload));
}

function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'AbortError') return true;
  if (err.code === 'ERR_ABORTED') return true;
  return false;
}

// ── public exports ────────────────────────────────────────────────────────────

/**
 * Dispatch implementers in parallel.
 *
 * Two modes:
 *
 * 1. CREATE mode (implementerRunId omitted / undefined):
 *    The orchestrator calls startImplementerRun to create a new run, registers
 *    all members, and returns the generated run id in the result. Use this
 *    when the caller has not yet created the run (e.g. the orchestrator owns
 *    the full lifecycle).
 *
 * 2. REUSE mode (implementerRunId supplied and non-empty):
 *    The caller (e.g. slice 2's run-creation layer) has already created the run
 *    via startImplementerRun. The orchestrator looks up the existing run on the
 *    sidecar via readImplementerRun, verifies that the recorded
 *    implementer_run_id matches the supplied id, and then dispatches into it
 *    WITHOUT re-creating the run or re-registering members. All persisted events
 *    will carry the supplied implementerRunId.
 *
 * @param {{
 *   specPath: string,
 *   repoRoot: string,
 *   sliceId: string,
 *   implementerRunId?: string,  — omit to create a new run; supply to reuse an existing one
 *   baseSha: string,
 *   implementers: Array<{
 *     memberId: string,
 *     adapter: string,
 *     model: string,
 *     required?: boolean,
 *     worktreePath: string,
 *     branchName: string,
 *     claimedFiles?: string[],
 *   }>,
 *   dispatchFn: (input: import('./types.js').ImplementerDispatchInput) => Promise<import('./types.js').ImplementerDispatchResult>,
 *   _deps?: object,  — dependency injection for tests
 * }} opts
 * @returns {Promise<{success: object[], failed: object[], cancelled: object[], implementerRunId: string}>}
 */
export async function dispatchImplementers({
  specPath,
  repoRoot,
  sliceId,
  implementerRunId,
  baseSha,
  implementers,
  dispatchFn,
  _deps = {},
}) {
  // specPath is required.
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new Error('dispatchImplementers: specPath is required');
  }
  if (!Array.isArray(implementers) || implementers.length === 0) {
    throw new Error('dispatchImplementers: implementers must be a non-empty array');
  }

  // Resolve sidecar helpers (allow DI override for tests).
  const _startImplementerRun = _deps.startImplementerRun ?? startImplementerRun;
  const _readImplementerRun = _deps.readImplementerRun ?? readImplementerRun;
  const _appendImplementerEventLocked =
    _deps.appendImplementerEventLocked ?? appendImplementerEventLocked;

  let activeRunId;

  if (typeof implementerRunId === 'string' && implementerRunId.length > 0) {
    // ── REUSE mode: caller pre-created the run ───────────────────────────
    // Verify the supplied id matches the run already persisted on the sidecar.
    // Members are already registered; do NOT call startImplementerRun again.
    const existingRun = _readImplementerRun(specPath, sliceId);
    if (!existingRun) {
      throw new Error(
        `dispatchImplementers: implementerRunId "${implementerRunId}" was supplied but ` +
          `slice "${sliceId}" has no implementer_experts run on the sidecar`
      );
    }
    if (existingRun.implementer_run_id !== implementerRunId) {
      throw new Error(
        `dispatchImplementers: supplied implementerRunId "${implementerRunId}" does not match ` +
          `the active run "${existingRun.implementer_run_id}" on slice "${sliceId}"`
      );
    }
    activeRunId = implementerRunId;
  } else {
    // ── CREATE mode: orchestrator owns run creation ──────────────────────
    const members = {};
    for (const impl of implementers) {
      const runtimeKind = `${impl.adapter.replace(/-cli$/, '')}-cli`;
      members[impl.memberId] = {
        adapter: runtimeKind,
        model: impl.model,
        required: impl.required ?? true,
        worktree_id: impl.branchName ?? impl.memberId,
        branch: impl.branchName ?? impl.memberId,
        claimed_files: impl.claimedFiles ?? [],
      };
    }
    const { implementer_run_id: newRunId } = await _startImplementerRun(specPath, sliceId, {
      base_sha: baseSha,
      members,
    });
    activeRunId = newRunId;
  }

  // ── shared abort controller ───────────────────────────────────────────────
  const abortController = new AbortController();
  const sharedSignal = abortController.signal;

  // ── per-implementer wrapper ───────────────────────────────────────────────
  async function runOne(impl) {
    const runtimeKind = `${impl.adapter.replace(/-cli$/, '')}-cli`;
    const worktreeId = impl.branchName ?? impl.memberId;

    // Record `started` event.
    const startPayload = { phase: 'dispatch-start' };
    await _appendImplementerEventLocked(specPath, {
      event_type: 'started',
      implementer_run_id: activeRunId,
      slice_id: sliceId,
      member_id: impl.memberId,
      runtime_kind: runtimeKind,
      worktree_id: worktreeId,
      payload_hash: payloadHash(startPayload),
      payload: startPayload,
    });

    try {
      /** @type {import('./types.js').ImplementerDispatchInput} */
      const input = {
        sliceId,
        implementerRunId: activeRunId,
        memberId: impl.memberId,
        runtimeKind,
        worktreePath: impl.worktreePath ?? '',
        branchName: impl.branchName ?? '',
        baseSha,
        claimedFiles: impl.claimedFiles ?? [],
        prompt: impl.prompt ?? '',
        abortSignal: sharedSignal,
        env: impl.env ?? {},
      };

      const result = await dispatchFn(input);

      // Classify outcome based on the returned outcome field.
      // "completed"           → success
      // "failed" | "halted"   → failed (halted is terminal; preserve haltEnvelope)
      // "cancelled"           → cancelled
      // anything else         → failed (defensive default)
      const outcome = result && result.outcome;
      if (outcome === 'cancelled') {
        return { kind: 'cancelled', memberId: impl.memberId, result };
      }
      if (outcome === 'failed' || outcome === 'halted') {
        return { kind: 'failed', memberId: impl.memberId, result };
      }
      if (outcome === 'completed') {
        return { kind: 'success', memberId: impl.memberId, result };
      }
      // Defensive: treat any unrecognised outcome as failed.
      return { kind: 'failed', memberId: impl.memberId, result };
    } catch (err) {
      // Classify aborted errors as cancelled.
      if (isAbortError(err)) {
        return {
          kind: 'cancelled',
          memberId: impl.memberId,
          result: {
            memberId: impl.memberId,
            outcome: 'cancelled',
            exitCode: null,
            headSha: null,
            diffHash: null,
            changedFiles: [],
            haltEnvelope: null,
          },
        };
      }

      // Wrap dispatch errors as halt envelopes.
      const haltEnvelope = wrapAsHaltEnvelope('implementer-required-child-failed', {
        memberId: impl.memberId,
        cause: err.message,
      });

      // Abort the shared signal immediately if this is a required member.
      // This must happen BEFORE returning from runOne so that other parallel
      // dispatchFn calls (polling signal.aborted) can unblock.
      if (impl.required !== false) {
        abortController.abort();
      }

      return {
        kind: 'failed',
        memberId: impl.memberId,
        result: {
          memberId: impl.memberId,
          outcome: 'failed',
          exitCode: null,
          headSha: null,
          diffHash: null,
          changedFiles: [],
          haltEnvelope,
        },
        originalError: err,
      };
    }
  }

  // ── run all in parallel ───────────────────────────────────────────────────
  const promises = implementers.map((impl) => runOne(impl));
  const outcomes = await Promise.all(promises);

  // ── aggregate ────────────────────────────────────────────────────────────
  const success = [];
  const failed = [];
  const cancelled = [];

  for (const outcome of outcomes) {
    if (outcome.kind === 'success') {
      success.push(outcome);
    } else if (outcome.kind === 'failed') {
      failed.push(outcome);
    } else {
      cancelled.push(outcome);
    }
  }

  return { success, failed, cancelled, implementerRunId: activeRunId };
}
