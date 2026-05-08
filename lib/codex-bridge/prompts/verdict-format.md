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
- `status: REVISE` means at least one critique item must be addressed before ship. Each critique must reference specific file/section/line where applicable, and explain WHY it matters (not just what to change).
- If you have nothing to critique but want to keep talking, you must still emit `SHIP`.
- Free-form prose may precede the block. Do not put text after `<<<END>>>`.
