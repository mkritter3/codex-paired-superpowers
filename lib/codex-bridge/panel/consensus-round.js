// v0.9.0 slice 6 — single-round consensus pass.
//
// Triggered by dispatchPanel when the first-round aggregator returns
// `mixed-needs-consensus`. Re-dispatches the SAME members (frozen
// snapshot — do NOT re-resolve adapters) with an augmented request:
// each panelist sees the other panelists' round-1 findings.
//
// Algorithm (spec § 4):
//   1. Build a consensus context block from round-1 panel results
//      (each panelist's findings labelled by member_id).
//   2. For each member, dispatch with request.task appended (or a
//      dedicated `consensusContext` field set) so the spawn prompt
//      surfaces prior findings.
//   3. Pass `suppressPeerMessages: true` (always — panel mode) and
//      slice-5b panel metadata (panelId, panelMemberIndex, panelSize)
//      so runTurnWithDeps records them under the slice-5b whitelist.
//   4. Aggregate the new results. If still mixed-needs-consensus,
//      escalate to "panel-disagreement" (NO open-ended loops).
//
// PERSISTENCE (v0.9.0 slice 6 round-1 fix):
//   Each dispatch_fn wraps runTurnWithDeps which owns sidecar
//   persistence (response_hash, inputs_hash, role_prompt_hash, etc.).
//   This module does NOT call appendExpertTurn and does NOT parse
//   Machine Result text — dispatch_fn returns the runTurnWithDeps
//   shape `{ok: true, result: parsed, ...}` and we read `result`
//   directly.

import { aggregateVerdicts as defaultAggregateVerdicts } from './verdict-aggregator.js';

/**
 * Build a Markdown-formatted "Prior Panel Findings" block summarizing
 * round-1 results for re-injection into round-2 prompts. Each panelist
 * (other than the one being prompted) contributes a block with its
 * verdict + blocking + nonblocking findings.
 *
 * Format:
 *   ## Prior Panel Findings (round 1)
 *
 *   ### <member_id> — <status>
 *   Blocking:
 *     - <finding text or JSON>
 *     - ...
 *   Nonblocking:
 *     - <finding text or JSON>
 *     - ...
 */
export function buildConsensusContext(forMemberId, firstRoundResults) {
  const lines = ['## Prior Panel Findings (round 1)', ''];
  let included = 0;
  for (const item of firstRoundResults) {
    if (!item || !item.member_id) continue;
    if (item.member_id === forMemberId) continue;
    if (!item.parsed_result) {
      lines.push(`### ${item.member_id} — (parse failure, no findings available)`);
      lines.push('');
      included += 1;
      continue;
    }
    const parsed = item.parsed_result;
    lines.push(`### ${item.member_id} — ${parsed.status || 'UNKNOWN'}`);
    lines.push('Blocking:');
    const blk = Array.isArray(parsed.blocking_findings) ? parsed.blocking_findings : [];
    if (blk.length === 0) lines.push('  - (none)');
    else for (const f of blk) lines.push(`  - ${formatFinding(f)}`);
    lines.push('Nonblocking:');
    const nb = Array.isArray(parsed.nonblocking_findings) ? parsed.nonblocking_findings : [];
    if (nb.length === 0) lines.push('  - (none)');
    else for (const f of nb) lines.push(`  - ${formatFinding(f)}`);
    lines.push('');
    included += 1;
  }
  if (included === 0) {
    lines.push('(no peer findings to display)');
  }
  return lines.join('\n');
}

function formatFinding(f) {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') {
    if (typeof f.message === 'string') return f.message;
    try {
      return JSON.stringify(f);
    } catch {
      return '[unstringifiable finding]';
    }
  }
  return String(f);
}

/**
 * Run a single consensus round.
 *
 * @param {string} role
 * @param {object} request — the same request shape passed to round-1.
 *                           `suppressPeerMessages: true`, `panelId`,
 *                           `panelSize` are expected to already be set
 *                           by the caller (dispatchPanel). This function
 *                           adds `panelMemberIndex` per member.
 * @param {Array<{member_id, dispatch_fn, runtime_kind?}>} members
 *                           — frozen snapshot from round 1.
 * @param {Array} firstRoundResults — round-1 panelResults (used for context).
 * @param {object} deps
 *   @param {Function} [deps.aggregateVerdicts]
 *   @param {Function} [deps.augmentRequest]    — test-seam to inspect the
 *                          augmented per-member request. Defaults to a function
 *                          that adds a `consensusContext` field.
 * @returns {Promise<{
 *   aggregate: object,             // aggregator output (post round-2)
 *   panelResults: Array,           // raw per-member parsed results
 *   final_outcome: string,         // panel-SHIP|panel-REVISE|panel-disagreement
 * }>}
 */
export async function runConsensusRound(
  role,
  request,
  members,
  firstRoundResults,
  deps = {},
) {
  const aggregateVerdicts = deps.aggregateVerdicts || defaultAggregateVerdicts;
  const augmentRequest = deps.augmentRequest || defaultAugmentRequest;

  const dispatches = members.map(async (m, i) => {
    const consensusContext = buildConsensusContext(m.member_id, firstRoundResults);
    const memberRequest = {
      ...augmentRequest(request, consensusContext),
      panelMemberIndex: i,
    };
    let parsed_result = null;
    let parse_failure_reason = null;
    let dispatch_result_raw = null;
    try {
      dispatch_result_raw = await m.dispatch_fn(memberRequest);
      if (dispatch_result_raw && typeof dispatch_result_raw === 'object') {
        if (dispatch_result_raw.ok === true && dispatch_result_raw.result) {
          parsed_result = dispatch_result_raw.result;
        } else if (dispatch_result_raw.ok === false) {
          parse_failure_reason =
            typeof dispatch_result_raw.reason === 'string'
              ? dispatch_result_raw.reason
              : 'dispatch-failed';
        } else {
          parse_failure_reason = 'dispatch-fn-bad-shape';
        }
      } else {
        parse_failure_reason = 'dispatch-fn-bad-shape';
      }
    } catch (err) {
      parse_failure_reason = err && err.message ? err.message : 'dispatch-error';
    }
    return {
      member_id: m.member_id,
      runtime_kind: m.runtime_kind || null,
      parsed_result,
      parse_failure_reason,
      dispatch_result_raw,
    };
  });

  const panelResults = await Promise.all(dispatches);
  const aggregate = aggregateVerdicts(panelResults);

  let final_outcome;
  if (aggregate.outcome === 'mixed-needs-consensus') {
    // ONE consensus round max. Spec § 4: "After 1 consensus round, still
    // mixed → panel-disagreement — user arbitrates (no open-ended
    // consensus loops)."
    final_outcome = 'panel-disagreement';
  } else if (aggregate.outcome === 'degraded-N-proceeds') {
    const core = aggregate.degraded_core_outcome;
    final_outcome = core === 'mixed-needs-consensus' ? 'panel-disagreement' : core;
  } else {
    final_outcome = aggregate.outcome;
  }

  return { aggregate, panelResults, final_outcome };
}

function defaultAugmentRequest(request, consensusContext) {
  // Two ways to expose the context to the dispatch_fn:
  //   1. Append into request.task so subagents that don't know about
  //      panel mode still see it.
  //   2. Also set a dedicated `consensusContext` field for any wrapper
  //      that wants to render it under a separate heading.
  const augmentedTask = [
    request.task || '',
    '',
    '---',
    '',
    consensusContext,
  ].join('\n');
  return {
    ...request,
    task: augmentedTask,
    consensusContext,
    suppressPeerMessages: true,
  };
}
