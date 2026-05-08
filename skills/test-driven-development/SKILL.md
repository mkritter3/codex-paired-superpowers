---
name: test-driven-development
description: Use before writing any non-trivial test suite. Claude drafts the test list; Codex reviews coverage, edge cases, and mock/integration trade-offs in a 7-round loop. Then standard red-green-refactor proceeds.
---

# Test-Driven Development (Codex-paired)

## What this changes vs. upstream
Before red-green-refactor, the **test list** itself is reviewed by Codex. Catches: missing edge cases, redundant tests, wrong test boundaries, mock-vs-integration mistakes — before any test code is written.

## When to invoke
Any slice with non-trivial test design. Skip for one-test-one-function slices where the design is obvious.

## Phase 0 — Draft the test list (Claude)
Write a numbered list of test cases. Each entry:
1. What invariant or behavior it pins.
2. Inputs / preconditions.
3. Expected outcome.
4. Mocks/integration choice + justification.

## Phase 1 — Codex test-list review (counted, max 7 rounds)
Resume the session for this feature. Send:

```
Phase: tdd-review
Round: N

## Slice context
{{SLICE_NAME}} — {{SLICE_GOAL}}

## Test list under review
{{TEST_LIST}}

## Your job
- Missing edge cases? (zero, negative, null, off-by-one, concurrent, large input, …)
- Redundant tests testing the same path?
- Wrong boundary? (testing implementation when behavior is what matters, or vice versa)
- Mock/integration: are mocks hiding real failure modes?
- Pinning the right invariants?
- End with the required verdict block.
```

Sidecar phase is `tdd:<slice-id>`.

## Phase 2 — Implement red-green-refactor
After double-SHIP, write the failing tests in the agreed order. Standard TDD discipline applies — see upstream `superpowers:test-driven-development` for the red/green/refactor cadence; this fork adds only the up-front review.

## Phase 3 — Slice-review the test suite + implementation
At slice review time, the test suite is part of the diff. Codex's slice review will catch any divergence from the agreed test list (and may push for more, which is in-scope critique).

## Required upstream sub-skill
- `superpowers:test-driven-development` for the red-green-refactor mechanics. This forked skill ADDS the up-front test-list review.
