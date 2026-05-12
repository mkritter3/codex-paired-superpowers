// v0.9.0 slice 6 — panel verdict aggregator.
//
// Deterministic, pure-function reducer over panelist results. No semantic
// overlap detection, no LLM-as-judge, no probabilistic decisions. The rules
// are spelled out in docs/architecture/2026-05-11-v0.9.0-destination.md § 4.
//
// Input:
//   panelResults: Array<{
//     member_id: string,
//     parsed_result: { status: "SHIP" | "REVISE", blocking_findings: [],
//                      nonblocking_findings: [], ... } | null,
//     dispatch_result_raw?: object,        // slice 1's DispatchResult shape
//     parse_failure_reason?: string,       // present iff parsed_result is null
//   }>
//
// Output:
//   {
//     outcome: "panel-SHIP" | "panel-REVISE" | "mixed-needs-consensus"
//            | "panel-disagreement" | "degraded-N-proceeds"
//            | "panel-quorum-lost",
//     ship_count, revise_count, parse_failure_count,
//     quorum_size, has_quorum: boolean,
//     findings_by_member: Array<{member_id, blocking_findings,
//                                nonblocking_findings}>,  // verbatim, parse-success only
//   }
//
// Quorum rule: max(2, floor(N/2) + 1).
//
// NB: aggregator is run TWICE in the panel-dispatcher lifecycle:
//   1) First round — outputs the verdict above.
//   2) Consensus round (only if first outcome === "mixed-needs-consensus")
//      — re-runs aggregator on the second round's panelResults. The
//      dispatcher escalates a second "mixed-needs-consensus" to
//      "panel-disagreement" (one consensus round, max).

export function computeQuorumSize(n) {
  return Math.max(2, Math.floor(n / 2) + 1);
}

export function aggregateVerdicts(panelResults) {
  if (!Array.isArray(panelResults)) {
    throw new TypeError(
      `aggregateVerdicts: expected array of panelResults; got ${typeof panelResults}`,
    );
  }
  const n = panelResults.length;
  const quorumSize = computeQuorumSize(n);

  const findings_by_member = [];
  let ship_count = 0;
  let revise_count = 0;
  let parse_failure_count = 0;

  for (const item of panelResults) {
    if (!item || typeof item !== 'object' || !item.member_id) {
      // Treat malformed item as a parse failure (defensive — dispatcher
      // should never emit this, but the aggregator is the single source
      // of truth for verdict counts).
      parse_failure_count += 1;
      continue;
    }
    if (item.parsed_result === null || item.parsed_result === undefined) {
      parse_failure_count += 1;
      continue;
    }
    const parsed = item.parsed_result;
    const blocking = Array.isArray(parsed.blocking_findings)
      ? parsed.blocking_findings
      : [];
    const nonblocking = Array.isArray(parsed.nonblocking_findings)
      ? parsed.nonblocking_findings
      : [];
    findings_by_member.push({
      member_id: item.member_id,
      blocking_findings: blocking,
      nonblocking_findings: nonblocking,
    });
    if (parsed.status === 'SHIP') ship_count += 1;
    else if (parsed.status === 'REVISE') revise_count += 1;
    else {
      // Unknown status — count as parse failure, drop from findings.
      parse_failure_count += 1;
      findings_by_member.pop();
    }
  }

  const successful_parses = ship_count + revise_count;
  const has_quorum = successful_parses >= quorumSize;
  const base = {
    ship_count,
    revise_count,
    parse_failure_count,
    quorum_size: quorumSize,
    has_quorum,
    findings_by_member,
  };

  // Quorum-lost short-circuit.
  if (!has_quorum) {
    return { ...base, outcome: 'panel-quorum-lost' };
  }

  // Determine the "effective" verdict outcome over the successful parses.
  let coreOutcome;
  if (revise_count === 0 && ship_count > 0) {
    coreOutcome = 'panel-SHIP';
  } else if (ship_count === 0 && revise_count > 0) {
    coreOutcome = 'panel-REVISE';
  } else {
    // Mixed: depends on the ORIGINAL panel size n, not the surviving count.
    // Per spec § 4: "Mixed SHIP/REVISE (panel_size >= 3)" runs consensus.
    coreOutcome = n >= 3 ? 'mixed-needs-consensus' : 'panel-disagreement';
  }

  // If parse failures occurred but quorum is still met, mark "degraded-N-proceeds"
  // so the dispatcher (and audit) can see the degradation explicitly. The
  // underlying verdict (SHIP / REVISE / mixed-needs-consensus / disagreement)
  // is recorded as the dispatcher's downstream signal via the same outcome
  // field, BUT we wrap it under degraded-N-proceeds per spec § 4.
  //
  // Spec § 4 says: "Parse failure (post-repair) | Degraded-N proceeds if
  // quorum still met; else panel-quorum-lost." So the outcome SHOULD be
  // "degraded-N-proceeds" — the dispatcher consults
  // `aggregateVerdicts(...).degraded_core_outcome` to know what verdict to
  // apply (SHIP/REVISE/disagreement/needs-consensus).
  if (parse_failure_count > 0 && has_quorum) {
    return {
      ...base,
      outcome: 'degraded-N-proceeds',
      degraded_core_outcome: coreOutcome,
    };
  }

  return { ...base, outcome: coreOutcome };
}
