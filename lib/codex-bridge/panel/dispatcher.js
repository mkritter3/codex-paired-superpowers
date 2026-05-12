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
//   `dispatchFns: Map<member_id, async (request) => RunTurnResult>` map
//   BEFORE calling dispatchPanel. Each dispatch_fn wraps `runTurnWithDeps`
//   (from expert-turn.js) with an adapter-specific `agentDispatch` —
//   claude-task wraps the orchestrator's Task invocation, cli-harness wraps
//   harness.dispatch.
//
//   dispatch_fn return shape (matches runTurnWithDeps):
//     { ok: true,  result: <parsedMachineResult>, peer_dm_summary }
//     { ok: false, reason, parseResult?, error? }
//
//   This dispatcher iterates dispatchFns in parallel, awaits each result,
//   builds normalized per-member entries for the aggregator, optionally
//   re-dispatches the SAME members for a single consensus round when
//   first-round verdicts are mixed-needs-consensus.
//
// MEMBER IDENTITY (v0.9.0 slice 6 round-1 fix):
//   The dispatcher's internal `member_id` is an ADAPTER-SPECIFIC composite
//   handle used only as the dispatchFns Map key — e.g. "expert-test@codex",
//   "expert-test@claude-task", "expert-test@ollama{kimi-k2.6}". It is NOT
//   what the Machine Result's `expert_id` field carries — that field is the
//   ROLE (e.g. "expert-test"). All panelists in a panel share the same role
//   on different adapters; they differ in `panel_member_index` + `adapter`.
//
// PERSISTENCE (v0.9.0 slice 6 round-1 fix):
//   The dispatcher does NOT persist turns. Each dispatch_fn wraps
//   runTurnWithDeps, which owns the full slice-5b persistence contract:
//   response_hash, response_ref/inline, inputs_hash, role_prompt_hash,
//   spec_path, spec_snippet_hash, mailbox_message_ids, adapter,
//   panel_peer_messages_suppressed, panel_id, panel_member_index,
//   panel_size. The dispatcher's responsibility is to PASS the panel
//   metadata into each member's request so runTurnWithDeps can record it
//   under the slice-5b whitelist.
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
 * The `member_id` is an internal Map-key handle (adapter-specific composite
 * like "expert-test@codex"). It is NOT the role id and is NOT what the
 * Machine Result's `expert_id` field carries.
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
 * Dispatch one panelist. Returns a normalized per-member result suitable
 * for the aggregator.
 *
 * The dispatch_fn is expected to wrap runTurnWithDeps and return its shape:
 *   { ok: true,  result: parsed, peer_dm_summary }
 *   { ok: false, reason, parseResult?, error? }
 *
 * The dispatcher does NOT parse Machine Result text — runTurnWithDeps owns
 * parsing, identity matching (using the ROLE id, not member_id), and
 * sidecar persistence.
 */
async function dispatchOne(member, requestWithPanel) {
  let dispatch_result_raw = null;
  let parsed_result = null;
  let parse_failure_reason = null;
  try {
    dispatch_result_raw = await member.dispatch_fn(requestWithPanel);
    if (dispatch_result_raw && typeof dispatch_result_raw === 'object') {
      if (dispatch_result_raw.ok === true && dispatch_result_raw.result) {
        parsed_result = dispatch_result_raw.result;
      } else if (dispatch_result_raw.ok === false) {
        parse_failure_reason =
          typeof dispatch_result_raw.reason === 'string'
            ? dispatch_result_raw.reason
            : 'dispatch-failed';
      } else {
        // dispatch_fn returned something other than the runTurnWithDeps
        // shape. Surface that as a parse failure rather than silently
        // succeeding with no parsed_result.
        parse_failure_reason = 'dispatch-fn-bad-shape';
      }
    } else {
      parse_failure_reason = 'dispatch-fn-bad-shape';
    }
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
 * Dispatch a panel of N reviewers in parallel.
 *
 * @param {string} role
 * @param {object} request — same shape passed to runTurnWithDeps, MINUS
 *                           `suppressPeerMessages`/`panelId`/
 *                           `panelMemberIndex`/`panelSize` (this dispatcher
 *                           sets those when calling each dispatch_fn).
 * @param {Map|Iterable} dispatchFns — pre-built by the orchestrator. Each
 *                                     fn wraps runTurnWithDeps with an
 *                                     adapter-specific identity + dispatch.
 * @param {object} [deps] — DI seam.
 */
export async function dispatchPanel(role, request, dispatchFns, deps = {}) {
  const panel_min_size =
    typeof deps.panel_min_size === 'number' ? deps.panel_min_size : DEFAULT_PANEL_MIN_SIZE;
  const panel_max_size =
    typeof deps.panel_max_size === 'number' ? deps.panel_max_size : DEFAULT_PANEL_MAX_SIZE;
  const aggregateVerdicts = deps.aggregateVerdicts || defaultAggregateVerdicts;
  const runConsensusRound = deps.runConsensusRound || defaultRunConsensusRound;
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

  // 4. Per-member request augmentation: each panelist receives its own
  //    panel metadata so runTurnWithDeps records it under the slice-5b
  //    whitelist (panel_id, panel_member_index, panel_size, adapter).
  function memberRequestFor(memberIndex) {
    return {
      ...request,
      suppressPeerMessages: true,
      panelId,
      panelMemberIndex: memberIndex,
      panelSize,
    };
  }

  // 5. First-round fan-out. The dispatcher does NOT persist turns; each
  //    dispatch_fn wraps runTurnWithDeps which appends a fully-formed
  //    slice-5b turn record with all replay/audit fields.
  const firstRoundResults = await Promise.all(
    members.map((m, i) => dispatchOne(m, memberRequestFor(i))),
  );

  // 6. Aggregate first round.
  const firstAggregate = aggregateVerdicts(firstRoundResults);

  // 7. Consensus round if needed (only mixed-needs-consensus → run; degraded
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
    // The consensus round receives a request shape with panel metadata
    // already attached. It will set per-member panelMemberIndex on top.
    const consensusRequest = {
      ...request,
      suppressPeerMessages: true,
      panelId,
      panelSize,
    };
    const consensus = await runConsensusRound(
      role,
      consensusRequest,
      members,                  // SAME frozen snapshot
      firstRoundResults,
      {
        aggregateVerdicts,
      },
    );
    finalAggregate = consensus.aggregate;
    finalResults = consensus.panelResults;
    finalOutcome = consensus.final_outcome;
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
