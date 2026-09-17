// v0.10.0 implementer-experts — parallel implementer orchestration.

import { createHash } from 'node:crypto';
import { startImplementerRun, appendImplementerEventLocked, readImplementerRun } from '../sidecar.js';
import { wrapAsHaltEnvelope } from '../halt-envelope.js';
import { resolveModelRoles } from '../models.js';
import { readDirectCliAttempt, observeDirectCliAttempt } from './codex-cli-dispatch.js';

const LIFECYCLE_EVENTS = new Set(['started', 'checkpoint', 'completed', 'failed', 'cancelled', 'halted']);

function payloadHash(payload) {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
function isAbortError(err) {
  return Boolean(err && typeof err === 'object' && (err.name === 'AbortError' || err.code === 'ERR_ABORTED'));
}
function runtimeKindFor(impl) {
  return `${impl.adapter.replace(/-cli$/, '')}-cli`;
}
function isCodex(impl) {
  return runtimeKindFor(impl) === 'codex-cli';
}
function normalizeSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    model_role: snapshot.model_role ?? snapshot.modelRole,
    model: snapshot.model,
    effort: snapshot.effort ?? snapshot.reasoningEffort,
  };
}
function snapshotFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.model_role && payload?.model && payload?.effort) return normalizeSnapshot(payload);
  }
  return null;
}
function latestLifecycleEvent(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (LIFECYCLE_EVENTS.has(events[index]?.event_type)) return events[index];
  }
  return null;
}
function resultFromCompleted(memberId, payload) {
  const snapshot = normalizeSnapshot(payload);
  return {
    memberId,
    outcome: payload.outcome ?? 'completed',
    exitCode: payload.exit_code ?? 0,
    headSha: payload.head_sha ?? null,
    changedFiles: Array.isArray(payload.changed_files) ? payload.changed_files : [],
    diffHash: payload.diff_hash ?? null,
    haltEnvelope: payload.halt_envelope ?? null,
    modelSnapshot: snapshot?.model_role ? snapshot : null,
  };
}
function inputFor({ impl, sliceId, activeRunId, repoRoot, baseSha, signal, snapshot }) {
  const input = {
    sliceId,
    implementerRunId: activeRunId,
    memberId: impl.memberId,
    runtimeKind: runtimeKindFor(impl),
    worktreePath: impl.worktreePath ?? '',
    branchName: impl.branchName ?? '',
    baseSha,
    claimedFiles: impl.claimedFiles ?? [],
    prompt: impl.prompt ?? '',
    abortSignal: signal,
    env: impl.env ?? {},
    repoRoot,
  };
  if (isCodex(impl) && snapshot) {
    input.modelRole = snapshot.model_role;
    input.model = snapshot.model;
    input.effort = snapshot.effort;
  }
  if (typeof impl.onLaunched === 'function') input.onLaunched = impl.onLaunched;
  return input;
}
function terminalPayload(result, snapshot, cause) {
  const payload = {
    outcome: result?.outcome ?? 'failed',
    exit_code: result?.exitCode ?? null,
    head_sha: result?.headSha ?? null,
    changed_files: Array.isArray(result?.changedFiles) ? result.changedFiles : [],
    diff_hash: result?.diffHash ?? null,
  };
  const resultSnapshot = normalizeSnapshot(result?.modelSnapshot) ?? snapshot;
  if (resultSnapshot?.model_role) Object.assign(payload, resultSnapshot);
  if (result?.haltEnvelope) payload.halt_envelope = result.haltEnvelope;
  if (cause) payload.cause = cause;
  return payload;
}
function terminalEventType(result) {
  if (result?.outcome === 'completed') return 'completed';
  if (result?.outcome === 'cancelled') return 'cancelled';
  if (result?.outcome === 'halted') return 'halted';
  return 'failed';
}
function attemptIsObservable(evidence, now = Date.now()) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (evidence.state === 'running') {
    if (evidence.pidAlive === true) return true;
    if (evidence.pidAlive === false || !Number.isInteger(evidence.pid)) return false;
    try {
      process.kill(evidence.pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }
  if (evidence.state === 'launching') {
    const launchedAt = Date.parse(evidence.launched_at);
    return Number.isFinite(launchedAt) && now - launchedAt <= 60_000;
  }
  return false;
}

/**
 * Dispatch, resume, and audit a fan-out of implementers.
 * Implements spec §4 direct-adapter snapshot ownership and §7 continuation.
 */
export async function dispatchImplementers({
  specPath, repoRoot, sliceId, implementerRunId, baseSha, implementers, dispatchFn,
  modelSnapshot, resumeInFlight = false, observeFn, readAttemptEvidence, _deps = {},
}) {
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new Error('dispatchImplementers: specPath is required');
  }
  if (!Array.isArray(implementers) || implementers.length === 0) {
    throw new Error('dispatchImplementers: implementers must be a non-empty array');
  }
  if (resumeInFlight && !(typeof implementerRunId === 'string' && implementerRunId.length > 0)) {
    throw new Error('dispatchImplementers: resumeInFlight requires implementerRunId');
  }

  const startRun = _deps.startImplementerRun ?? startImplementerRun;
  const readRun = _deps.readImplementerRun ?? readImplementerRun;
  const appendEvent = _deps.appendImplementerEventLocked ?? appendImplementerEventLocked;
  const observe = observeFn ?? observeDirectCliAttempt;
  const readEvidence = readAttemptEvidence ?? readDirectCliAttempt;
  let activeRunId;
  let existingRun = null;

  if (typeof implementerRunId === 'string' && implementerRunId.length > 0) {
    existingRun = readRun(specPath, sliceId);
    if (!existingRun) {
      throw new Error(`dispatchImplementers: implementerRunId "${implementerRunId}" was supplied but slice "${sliceId}" has no implementer_experts run on the sidecar`);
    }
    if (existingRun.implementer_run_id !== implementerRunId) {
      throw new Error(`dispatchImplementers: supplied implementerRunId "${implementerRunId}" does not match the active run "${existingRun.implementer_run_id}" on slice "${sliceId}"`);
    }
    activeRunId = implementerRunId;
  } else {
    const members = {};
    for (const impl of implementers) {
      members[impl.memberId] = {
        adapter: runtimeKindFor(impl), model: impl.model, required: impl.required ?? true,
        worktree_id: impl.branchName ?? impl.memberId,
        branch: impl.branchName ?? impl.memberId,
        claimed_files: impl.claimedFiles ?? [],
      };
    }
    activeRunId = (await startRun(specPath, sliceId, { base_sha: baseSha, members })).implementer_run_id;
  }

  let currentSnapshot = normalizeSnapshot(modelSnapshot);
  let snapshotResolved = currentSnapshot !== null;
  function getCurrentSnapshot(impl) {
    if (!isCodex(impl)) return null;
    if (!snapshotResolved) {
      const implement = (_deps.resolveModelRoles ?? resolveModelRoles)({ repoRoot }).roles.implement;
      currentSnapshot = { model_role: 'implement', model: implement.model, effort: implement.effort };
      snapshotResolved = true;
    }
    return currentSnapshot;
  }
  const abortController = new AbortController();
  const sharedSignal = abortController.signal;

  async function persistEvent(impl, eventType, payload) {
    await appendEvent(specPath, {
      event_type: eventType,
      implementer_run_id: activeRunId,
      slice_id: sliceId,
      member_id: impl.memberId,
      runtime_kind: runtimeKindFor(impl),
      worktree_id: impl.branchName ?? impl.memberId,
      payload_hash: payloadHash(payload),
      payload,
    });
  }
  async function persistResult(impl, result, snapshot, cause) {
    if (result?.attemptInFlight === true) {
      await persistEvent(impl, 'checkpoint', { phase: 'observation-timeout' });
    } else {
      await persistEvent(impl, terminalEventType(result), terminalPayload(result, snapshot, cause));
    }
  }
  function classify(impl, result, originalError) {
    const kind = result?.outcome === 'completed'
      ? 'success'
      : result?.outcome === 'cancelled' ? 'cancelled' : 'failed';
    return { kind, memberId: impl.memberId, result, ...(originalError ? { originalError } : {}) };
  }

  async function runOne(impl) {
    let selectedSnapshot = null;
    try {
      const memberEvents = existingRun?.events?.filter((event) => event.member_id === impl.memberId) ?? [];
      const latest = resumeInFlight ? latestLifecycleEvent(memberEvents) : null;
      const recordedSnapshot = snapshotFromEvents(memberEvents);
      if (resumeInFlight && latest?.event_type === 'completed') {
        return classify(impl, resultFromCompleted(impl.memberId, latest.payload));
      }

      let shouldObserve = resumeInFlight && (latest?.event_type === 'started' || latest?.event_type === 'checkpoint');
      selectedSnapshot = shouldObserve
        ? recordedSnapshot
        : (resumeInFlight ? null : getCurrentSnapshot(impl));
      let input = inputFor({ impl, sliceId, activeRunId, repoRoot, baseSha, signal: sharedSignal, snapshot: selectedSnapshot });
      if (resumeInFlight && !shouldObserve) {
        const evidence = await readEvidence(input);
        if (attemptIsObservable(evidence)) {
          shouldObserve = true;
          selectedSnapshot = normalizeSnapshot(evidence) ?? recordedSnapshot;
          input = inputFor({ impl, sliceId, activeRunId, repoRoot, baseSha, signal: sharedSignal, snapshot: selectedSnapshot });
        }
      }
      if (!shouldObserve) {
        selectedSnapshot ??= getCurrentSnapshot(impl);
        input = inputFor({ impl, sliceId, activeRunId, repoRoot, baseSha, signal: sharedSignal, snapshot: selectedSnapshot });
        const startPayload = { phase: 'dispatch-start' };
        if (isCodex(impl) && selectedSnapshot) Object.assign(startPayload, selectedSnapshot);
        await persistEvent(impl, 'started', startPayload);
      }

      const result = shouldObserve ? await observe(input) : await dispatchFn(input);
      if (
        result?.attemptInFlight !== true &&
        (result?.outcome === 'failed' || result?.outcome === 'halted') &&
        impl.required !== false
      ) abortController.abort();
      await persistResult(impl, result, selectedSnapshot);
      return classify(impl, result);
    } catch (err) {
      if (isAbortError(err)) {
        const result = {
          memberId: impl.memberId, outcome: 'cancelled', exitCode: null, headSha: null,
          diffHash: null, changedFiles: [], haltEnvelope: null, modelSnapshot: selectedSnapshot,
        };
        try { await persistResult(impl, result, selectedSnapshot); } catch { /* persistence is already unavailable */ }
        return classify(impl, result);
      }
      if (impl.required !== false) abortController.abort();
      const haltEnvelope = wrapAsHaltEnvelope('implementer-required-child-failed', { memberId: impl.memberId, cause: err.message });
      const result = {
        memberId: impl.memberId, outcome: 'failed', exitCode: null, headSha: null,
        diffHash: null, changedFiles: [], haltEnvelope, modelSnapshot: selectedSnapshot,
      };
      try { await persistResult(impl, result, selectedSnapshot, err.message); } catch { /* do not mask or delay sibling cancellation */ }
      return classify(impl, result, err);
    }
  }

  const outcomes = await Promise.all(implementers.map((impl) => runOne(impl)));
  const success = [];
  const failed = [];
  const cancelled = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'success') success.push(outcome);
    else if (outcome.kind === 'cancelled') cancelled.push(outcome);
    else failed.push(outcome);
  }
  return { success, failed, cancelled, implementerRunId: activeRunId };
}
