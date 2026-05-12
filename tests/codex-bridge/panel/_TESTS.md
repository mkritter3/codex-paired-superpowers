# Slice 6 — Panel Dispatcher Test Inventory

Critical-tier coverage. Tests live next to this file under
`tests/codex-bridge/panel/`.

## verdict-aggregator.test.js (~8 tests)

Pure-function aggregator over `panelResults` (array of `{member_id,
parsed_result, dispatch_result_raw}` items). Deterministic rules per
spec § 4. Returns
`{outcome, ship_count, revise_count, parse_failure_count, quorum_size,
has_quorum, findings_by_member}`.

1. All-SHIP (N=2) → `panel-SHIP`. `ship_count=2`,
   `revise_count=0`, `parse_failure_count=0`, `quorum_size=2`,
   `has_quorum=true`. `findings_by_member` preserves each panelist's
   `blocking_findings`+`nonblocking_findings` verbatim.
2. All-SHIP (N=3) → `panel-SHIP`.
3. All-REVISE (N=2) → `panel-REVISE`; `findings_by_member` preserves
   each panelist's blocking_findings verbatim (no overlap dedup).
4. Mixed N=2 (1 SHIP, 1 REVISE) → `panel-disagreement` (no consensus
   for N<3).
5. Mixed N=3 (2 SHIP, 1 REVISE) → `mixed-needs-consensus` (signal for
   dispatcher to run one consensus round).
6. Mixed N=3 (1 SHIP, 2 REVISE) → `mixed-needs-consensus`.
7. Parse failures with quorum met: N=3 with 1 parse-failure, surviving
   2 both SHIP → outcome `degraded-N-proceeds`. `parse_failure_count=1`,
   `has_quorum=true`, downstream rule applied (both surviving SHIP).
   `findings_by_member` only includes successful parses.
8. Parse failures with quorum lost: N=3 with 2 parse-failures, 1
   surviving SHIP → outcome `panel-quorum-lost`. `has_quorum=false`.

## dispatcher.test.js (~10 tests)

Orchestrates fan-out + aggregation + (conditional) consensus round.
Receives a pre-built `dispatchFns: Map<member_id, fn>` from the
orchestrator. Each fn returns `DispatchResult` from slice 1.

9. Happy path N=2: both dispatchFns return SHIP → outcome `panel-SHIP`,
   2 sidecar turns persisted with `panel_id` + `panel_member_index` +
   `panel_size: 2`.
10. `panel_min_size` enforcement: `dispatchFns.size=1` with
    `panel_min_size=2` → throws `PanelDispatchError` code
    `panel-quorum-unavailable`.
11. `panel_max_size` enforcement: `dispatchFns.size=5` with
    `panel_max_size=3` → uses first 3; returned `skipped_candidates`
    lists member_ids of the 2 dropped.
12. Members snapshot ONCE: dispatcher passes the EXACT SAME member
    objects to `runConsensusRound` (referential equality on the
    member-list array entries' `dispatch_fn`).
13. `suppressPeerMessages: true` is added to each member's request
    when calling dispatch_fn. Assert by inspecting the request each
    stub fn received.
14. `panel_id` is generated (matches `^panel-\d{4}-\d{2}-\d{2}T…-\w+$`)
    and present on each persisted turn.
15. Sidecar persistence preserves each panelist's `blocking_findings`
    + `nonblocking_findings` verbatim.
16. Mixed N=3 triggers `runConsensusRound`. Verify it's invoked once.
17. Mixed N=2 does NOT trigger consensus (panel-disagreement directly).
18. `runtime_kind` on member metadata is propagated to the sidecar
    turn record under `adapter` (e.g. `claude-task`, `cli-harness:codex`).

## consensus-round.test.js (~4 tests)

Helper for mixed-N>=3 result. Same members, augmented request, one
round max.

19. Receives mixed first-round results; assembles a consensus context
    string and passes it into the dispatch_fn call (each panelist sees
    others' findings).
20. Re-dispatches SAME members (referential equality on dispatch_fn).
21. All converge to SHIP after consensus → outcome `panel-SHIP`,
    `consensus_round_ran: true`.
22. Still mixed after consensus → outcome `panel-disagreement` (no
    second consensus loop).

## expert-archive.test extension (~2 tests)

23. `HALT_REASONS_PRESERVE` includes the four new v0.9.0 codes:
    `panel-quorum-unavailable`, `panel-disagreement`,
    `panel-quorum-lost`, `cli-dispatch-failed`.
24. `archive(identity, "panel-quorum-unavailable")` returns
    `preserved-for-resume` (no archiveAndReset call).
