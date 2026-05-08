Phase: slice-review
Slice ID: {{SLICE_ID}}
Round: {{ROUND}}
Validation tier: {{VALIDATION_TIER}}

## Slice scope (you must respect this boundary)
{{SLICE_TASKS}}

## Phase A's rubric coverage (what was promised)
{{PHASE_A_COVERAGE}}

## Diff to review

```diff
{{SLICE_DIFF}}
```

## Test output

```
{{TEST_OUTPUT}}
```

## Critique from previous round
{{PRIOR_CRITIQUES}}

## Your job
1. Review the diff against the slice scope only.
2. Apply the L11 rubric: simple, optimal, DRY, honest about scope.
3. Apply the **validation rubric in Phase C mode** (see `lib/codex-bridge/prompts/validation-rubric.md`). The verdict's `critique` array must include `rubric.diff-vs-plan`, `rubric.test-results`, `rubric.uncovered-paths`, `rubric.new-triggers` bullets verifying the implementation actually executed what Phase A promised.
4. If you find issues OUTSIDE this slice's scope, list them under `## Deferred` in your prose — do NOT include them in the verdict critique. Out-of-slice issues never block a slice from shipping.
5. End with the required verdict block.
