// v0.9.0 slice 6 — panel dispatcher.
//
// Coordinates N parallel reviewer dispatches across mixed runtime kinds
// (claude-task via the orchestrator's Task tool + cli-harness via slice 1's
// harness) and applies deterministic verdict aggregation with at most ONE
// consensus round.
//
// TWO-STEP ORCHESTRATION:
//   This Node module does NOT know how to invoke Claude Code's Agent tool
//   (Task) — only the orchestrator (the running Claude session, driven by
//   slice 7a's skill prose) does. So the orchestrator builds a
//   `dispatchFns: Map<member_id, async (request) => DispatchResult>` map
//   BEFORE calling dispatchPanel. For claude-task members, dispatch_fn
//   wraps the orchestrator's Task invocation. For cli-harness members,
//   dispatch_fn wraps the harness.dispatch call.
//
//   This dispatcher iterates dispatchFns in parallel, awaits each
//   DispatchResult, runs the verdict aggregator, optionally re-dispatches
//   the SAME members for a single consensus round when first-round verdicts
//   are mixed-needs-consensus.
//
// Contract:
//
//   dispatchPanel(role, request, dispatchFns, deps) ->
//     {
//       panel_id: string,
//       outcome: "panel-SHIP" | "panel-REVISE" | "panel-disagreement"
//              | "panel-quorum-lost",
//       member_results: Array<{
//         member_id, runtime_kind, parsed_result, parse_failure_reason,
//         dispatch_result_raw,
//       }>,
//       findings_by_member: Array<{member_id, blocking_findings,
//                                  nonblocking_findings}>,
//       skipped_candidates: string[],   // member_ids dropped by panel_max_size
//       consensus_round_ran: boolean,
//       aggregate: object,              // aggregator output (final round)
//     }
//
//   Throws PanelDispatchError code "panel-quorum-unavailable" if
//   dispatchFns.size < panel_min_size.

import { randomBytes } from 'node:crypto';

import { aggregateVerdicts as defaultAggregateVerdicts } from './verdict-aggregator.js';
import { runConsensusRound as defaultRunConsensusRound } from './consensus-round.js';
import { parseExpertOutput as defaultParseExpertOutput } from '../expert-output-parser.js';
import { appendExpertTurn as defaultAppendExpertTurn } from '../sidecar.js';

const DEFAULT_PANEL_MIN_SIZE = 2;
const DEFAULT_PANEL_MAX_SIZE = 3;

export class PanelDispatchError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PanelDispatchError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function generatePanelId(now) {
  const iso = (now ? new Date(now) : new Date()).toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  return `panel-${iso}-${rand}`;
}

/**
 * Build a member snapshot from `dispatchFns`.
 *
 * `dispatchFns` may be:
 *   - Map<member_id, fn>                         (preferred)
 *   - Map<member_id, {fn, runtime_kind?}>
 *   - Iterable<[member_id, fn|object]>           (Map-like)
 *
 * Returns: Array<{member_id, dispatch_fn, runtime_kind}>
 */
function snapshotMembers(dispatchFns) {
  if (!dispatchFns || typeof dispatchFns[Symbol.iterator] !== 'function') {
    throw new PanelDispatchError(
      'invalid-dispatch-fns',
      'dispatchPanel: dispatchFns must be a Map or iterable of [member_id, fn] entries',
    );
  }
  const members = [];
  for (const [member_id, value] of dispatchFns) {
    if (typeof member_id !== 'string' || member_id.length === 0) {
      throw new PanelDispatchError(
        'invalid-dispatch-fns',
        `dispatchPanel: dispatchFns entry has invalid member_id ${JSON.stringify(member_id)}`,
      );
    }
    let dispatch_fn;
    let runtime_kind = null;
    if (typeof value === 'function') {
      dispatch_fn = value;
    } else if (value && typeof value === 'object' && typeof value.fn === 'function') {
      dispatch_fn = value.fn;
      runtime_kind = typeof value.runtime_kind === 'string' ? value.runtime_kind : null;
    } else {
      throw new PanelDispatchError(
        'invalid-dispatch-fns',
        `dispatchPanel: dispatchFns[${member_id}] must be a function or {fn, runtime_kind?}`,
      );
    }
    members.push({ member_id, dispatch_fn, runtime_kind });
  }
  return members;
}

/**
 * Dispatch one panelist (round 1). Returns a normalized per-member result
 * suitable for the aggregator.
 */
async function dispatchOne(member, requestWithPanel, parseExpertOutput, phase) {
  let dispatch_result_raw = null;
  let parsed_result = null;
  let parse_failure_reason = null;
  try {
    dispatch_result_raw = await member.dispatch_fn(requestWithPanel);
    const responseText =
      dispatch_result_raw && typeof dispatch_result_raw.responseText === 'string'
        ? dispatch_result_raw.responseText
        : (typeof dispatch_result_raw === 'string' ? dispatch_result_raw : '');
    const r = parseExpertOutput(responseText, {
      expectedExpertId: member.member_id,
      expectedPhase: phase,
    });
    if (r.ok) parsed_result = r.result;
    else parse_failure_reason = r.reason || 'parse-failed';
  } catch (err) {
    parse_failure_reason = err && err.message ? err.message : 'dispatch-error';
  }
  return {
    member_id: member.member_id,
    runtime_kind: member.runtime_kind,
    parsed_result,
    parse_failure_reason,
    dispatch_result_raw,
  };
}

/**
 * Persist a per-panelist sidecar turn record.
 *
 * Best-effort: errors are swallowed (the in-memory result is the source of
 * truth for the caller; sidecar persistence is for audit).
 */
async function persistPanelTurn(deps, request, panelId, panelSize, memberIndex, panelResult, now) {
  if (!request.specPath) return; // no spec → no sidecar persistence
  const startedAt = (now ? new Date(now) : new Date()).toISOString();
  const completedAt = startedAt; // dispatcher doesn't time-split; orchestrator owns ts
  const parsed = panelResult.parsed_result;
  const verdict =
    parsed && (parsed.status === 'SHIP' || parsed.status === 'REVISE')
      ? parsed.status
      : 'REVISE';
  const blockCount =
    parsed && Array.isArray(parsed.blocking_findings) ? parsed.blocking_findings.length : 0;
  const nonblockCount =
    parsed && Array.isArray(parsed.nonblocking_findings)
      ? parsed.nonblocking_findings.length
      : 0;
  const summary =
    panelResult.parse_failure_reason
      ? `panel parse failure: ${panelResult.parse_failure_reason}`
      : (verdict === 'SHIP'
          ? 'SHIP'
          : `REVISE: ${blockCount} blocking, ${nonblockCount} nonblocking`);

  const turn = {
    expert_id: panelResult.member_id,
    phase: request.phase,
    slice_id: request.sliceId || null,
    mailbox_message_ids_injected: [],
    started_at: startedAt,
    completed_at: completedAt,
    result_summary: summary,
    verdict,
    failure_reason: panelResult.parse_failure_reason ? 'unparseable-output' : null,
    panel_id: panelId,
    panel_member_index: memberIndex,
    panel_size: panelSize,
  };
  if (parsed && Array.isArray(parsed.blocking_findings)) {
    turn.blocking_findings = parsed.blocking_findings;
  }
  if (parsed && Array.isArray(parsed.nonblocking_findings)) {
    turn.nonblocking_findings = parsed.nonblocking_findings;
  }
  // runtime_kind is recorded under `adapter` so it lands in the existing
  // replay audit field shape introduced in slice 5b. claude-task members
  // record "claude-task"; cli-harness members record "cli-harness:<cli>"
  // (or whatever the orchestrator passes in).
  if (panelResult.runtime_kind) {
    turn.adapter = panelResult.runtime_kind;
  }
  try {
    await deps.appendExpertTurn(request.specPath, turn);
  } catch {
    /* best-effort */
  }
}

/**
 * Dispatch a panel of N reviewers in parallel.
 *
 * @param {string} role
 * @param {object} request — same shape passed to runTurnWithDeps, MINUS
 *                           `suppressPeerMessages` (this dispatcher always
 *                           sets it to true when calling dispatch_fns).
 * @param {Map|Iterable} dispatchFns — pre-built by the orchestrator.
 * @param {object} [deps] — DI seam.
 */
export async function dispatchPanel(role, request, dispatchFns, deps = {}) {
  const panel_min_size =
    typeof deps.panel_min_size === 'number' ? deps.panel_min_size : DEFAULT_PANEL_MIN_SIZE;
  const panel_max_size =
    typeof deps.panel_max_size === 'number' ? deps.panel_max_size : DEFAULT_PANEL_MAX_SIZE;
  const aggregateVerdicts = deps.aggregateVerdicts || defaultAggregateVerdicts;
  const runConsensusRound = deps.runConsensusRound || defaultRunConsensusRound;
  const parseExpertOutput = deps.parseExpertOutput || defaultParseExpertOutput;
  const appendExpertTurn = deps.appendExpertTurn || defaultAppendExpertTurn;
  const now = deps.now || (() => new Date().toISOString());

  // 1. Snapshot members from dispatchFns.
  const allMembers = snapshotMembers(dispatchFns);

  // 2. panel_min_size enforcement — hard halt, no silent degradation.
  if (allMembers.length < panel_min_size) {
    throw new PanelDispatchError(
      'panel-quorum-unavailable',
      `panel mode requires at least ${panel_min_size} dispatchFns; got ${allMembers.length}`,
      { available: allMembers.length, panel_min_size },
    );
  }

  // 3. panel_max_size: take first N, audit the rest.
  let members = allMembers;
  let skipped_candidates = [];
  if (allMembers.length > panel_max_size) {
    members = allMembers.slice(0, panel_max_size);
    skipped_candidates = allMembers.slice(panel_max_size).map((m) => m.member_id);
  }

  const panelSize = members.length;
  const panelId = deps.panelId || generatePanelId(typeof now === 'function' ? now() : now);

  // 4. Augment request: suppressPeerMessages always true for panelists.
  const requestWithPanel = {
    ...request,
    suppressPeerMessages: true,
  };

  // 5. First-round fan-out.
  const firstRoundResults = await Promise.all(
    members.map((m) => dispatchOne(m, requestWithPanel, parseExpertOutput, request.phase)),
  );

  // 6. Aggregate first round.
  const firstAggregate = aggregateVerdicts(firstRoundResults);

  // 7. Persist round-1 turns (best-effort).
  for (let i = 0; i < firstRoundResults.length; i++) {
    await persistPanelTurn(
      { appendExpertTurn },
      request,
      panelId,
      panelSize,
      i,
      firstRoundResults[i],
      typeof now === 'function' ? now() : now,
    );
  }

  // 8. Consensus round if needed (only mixed-needs-consensus → run; degraded
  //    with core mixed-needs-consensus also runs — spec § 4 treats degraded
  //    quorum as still proceeding under normal verdict rules).
  let consensus_round_ran = false;
  let finalAggregate = firstAggregate;
  let finalResults = firstRoundResults;
  let finalOutcome = mapAggregateToOutcome(firstAggregate);

  const triggersConsensus =
    firstAggregate.outcome === 'mixed-needs-consensus' ||
    (firstAggregate.outcome === 'degraded-N-proceeds' &&
      firstAggregate.degraded_core_outcome === 'mixed-needs-consensus');

  if (triggersConsensus) {
    consensus_round_ran = true;
    const consensus = await runConsensusRound(
      role,
      requestWithPanel,
      members,                  // SAME frozen snapshot
      firstRoundResults,
      {
        aggregateVerdicts,
        parseExpertOutput,
      },
    );
    finalAggregate = consensus.aggregate;
    finalResults = consensus.panelResults;
    finalOutcome = consensus.final_outcome;

    // Persist round-2 turns. We index after round-1 turns to keep audit
    // ordering clear; orchestrator can still group by panel_id.
    for (let i = 0; i < finalResults.length; i++) {
      await persistPanelTurn(
        { appendExpertTurn },
        request,
        panelId,
        panelSize,
        i,
        finalResults[i],
        typeof now === 'function' ? now() : now,
      );
    }
  }

  return {
    panel_id: panelId,
    outcome: finalOutcome,
    member_results: finalResults,
    findings_by_member: finalAggregate.findings_by_member,
    skipped_candidates,
    consensus_round_ran,
    aggregate: finalAggregate,
  };
}

// Map first-round aggregate outcome to the dispatcher's final outcome. Used
// only when consensus did NOT run.
function mapAggregateToOutcome(agg) {
  if (agg.outcome === 'mixed-needs-consensus') {
    // Should be impossible at the dispatcher's final-outcome stage because
    // mixed-needs-consensus always triggers consensus. Defensive fallback.
    return 'panel-disagreement';
  }
  if (agg.outcome === 'degraded-N-proceeds') {
    const core = agg.degraded_core_outcome;
    if (core === 'mixed-needs-consensus') return 'panel-disagreement';
    return core;
  }
  return agg.outcome;
}
