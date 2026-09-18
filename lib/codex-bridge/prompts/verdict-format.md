## Verdict Format (REQUIRED)

End every response with exactly one verdict block:

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one-sentence summary>
<<<END>>>
```

Rules:
- `status: SHIP` means the artifact is L11-grade as-is. No further changes.
- `status: REVISE` means at least one **blocking** finding must be addressed before ship. Each
  critique must reference specific file/section/line where applicable, and explain WHY it matters
  (not just what to change).
- If you have nothing to critique but want to keep talking, you must still emit `SHIP`.
- Free-form prose may precede the block. Do not put text after `<<<END>>>`.

### Blocking vs deferred (v0.18.1 — every finding must be classified)

A finding is **blocking** only if at least one is true: it is a defect a user can hit; it breaks a
frozen contract; it makes a test assert something untrue (a control that cannot fail); or it leaves
a stated goal unmet. Everything else — a narrower type, a clearer name, an extra case worth adding,
a wording preference, a follow-up idea — is **deferred**.

Deferred findings must NOT produce `REVISE`. Emit `SHIP` and list them under `deferred:`:

```
<<<VERDICT>>>
status: SHIP
critique:
  - rubric.diff-vs-plan: ...
  - rubric.test-results: tier: critical — <coverage evidence>
  - rubric.uncovered-paths: ...
  - rubric.new-triggers: ...
deferred:
  - <finding>: <why it is not blocking>
rationale: ...
<<<END>>>
```

**`critique` is not only findings.** The rubric evidence that `validation-rubric.md` requires
(the `tier:` bullet and the coverage lines) rides in `critique` on SHIP as well as REVISE, and the
sidecar's validation gate rejects a critique without it (`parseValidationCoverage([], {tier:
'critical'})` returns `tier-missing`). So: `critique` always carries the required rubric lines,
plus any blocking findings; `deferred` carries everything that does not block. Never emit an empty
`critique` to signal "no blocking findings" — put the rubric lines there and leave `deferred` to
carry the rest.

The orchestrator collects `deferred` items across every round of a work item and addresses them in
ONE cleanup pass before the work item merges, reviewed once. They are durable, not conversational:
each round's deferred items are written to the sidecar at `slice_reviews[<work-item>].deferred`
(the same field v0.17.0 used for the argv prompt-size note), so a lost thread or a fresh session
cannot drop them. `parseVerdict` returns `deferred` alongside `status`, `critique` and `rationale`.

Measured reason for this rule: on v0.18.0 each review round cost 8 to 12 minutes of wall clock, and
several rounds carried a single narrow finding that would have cost nothing to batch. Spending a
round on a deferred item is the most expensive way to record it.

Judgement still belongs to you: if you believe a finding is blocking, say so and emit `REVISE` — do
not downgrade something real to keep the round count low. The rule removes ceremony, not scrutiny.
