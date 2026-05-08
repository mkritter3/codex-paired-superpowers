Phase: slice-review
Slice ID: {{SLICE_ID}}
Round: {{ROUND}}

## Slice scope (you must respect this boundary)
{{SLICE_TASKS}}

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
3. If you find issues OUTSIDE this slice's scope, list them under `## Deferred` in your prose — do NOT include them in the verdict critique. Out-of-slice issues never block a slice from shipping.
4. End with the required verdict block.
