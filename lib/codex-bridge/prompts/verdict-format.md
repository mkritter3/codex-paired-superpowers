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

Deferred findings must NOT produce `REVISE`. Emit `SHIP` and list them:

```
<<<VERDICT>>>
status: SHIP
critique:
  - <blocking findings only; empty is fine>
deferred:
  - <finding>: <why it is not blocking>
rationale: ...
<<<END>>>
```

The orchestrator collects `deferred` items across every round of a work item and addresses them in
ONE cleanup pass before the work item merges, reviewed once. Measured reason for this rule: on
v0.18.0 each review round cost 8 to 12 minutes of wall clock, and several rounds carried a single
narrow finding that would have cost nothing to batch. Spending a round on a deferred item is the
most expensive way to record it.

Judgement still belongs to you: if you believe a finding is blocking, say so and emit `REVISE` — do
not downgrade something real to keep the round count low. The rule removes ceremony, not scrutiny.
