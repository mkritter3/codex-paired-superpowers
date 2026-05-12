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
//   3. Pass `suppressPeerMessages: true` (always — panel mode).
//   4. Aggregate the new results. If still mixed-needs-consensus,
//      escalate to "panel-disagreement" (NO open-ended loops).
//
// The dispatcher composes parseExpertOutput etc. — this module only
// builds the consensus context, runs the second fan-out, and applies
// the aggregator.

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
 *                           `suppressPeerMessages: true` is always set.
 * @param {Array<{member_id, dispatch_fn, runtime_kind?}>} members
 *                           — frozen snapshot from round 1.
 * @param {Array} firstRoundResults — round-1 panelResults (used for context).
 * @param {object} deps
 *   @param {Function} [deps.aggregateVerdicts]
 *   @param {Function} [deps.parseExpertOutput] — required if dispatch_fn returns
 *                          a DispatchResult (raw); the dispatcher hands this in.
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
  const parseExpertOutput = deps.parseExpertOutput;
  const augmentRequest = deps.augmentRequest || defaultAugmentRequest;

  const dispatches = members.map(async (m) => {
    const consensusContext = buildConsensusContext(m.member_id, firstRoundResults);
    const memberRequest = augmentRequest(request, consensusContext);
    let parsed_result = null;
    let parse_failure_reason = null;
    let dispatch_result_raw = null;
    try {
      dispatch_result_raw = await m.dispatch_fn(memberRequest);
      if (parseExpertOutput) {
        const responseText =
          dispatch_result_raw && typeof dispatch_result_raw.responseText === 'string'
            ? dispatch_result_raw.responseText
            : (typeof dispatch_result_raw === 'string' ? dispatch_result_raw : '');
        const r = parseExpertOutput(responseText, {
          expectedExpertId: m.member_id,
          expectedPhase: request.phase,
        });
        if (r.ok) parsed_result = r.result;
        else parse_failure_reason = r.reason || 'parse-failed';
      } else if (
        dispatch_result_raw &&
        typeof dispatch_result_raw === 'object' &&
        dispatch_result_raw.parsed_result
      ) {
        parsed_result = dispatch_result_raw.parsed_result;
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
