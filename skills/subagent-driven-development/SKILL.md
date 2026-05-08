---
name: subagent-driven-development
description: Use when executing a Codex-paired plan. After each slice's subagent reports done, runs a scoped Codex review on that slice's diff (max 7 rounds). Codex must respect slice boundaries — out-of-slice issues go to a Deferred list, not blockers.
---

# Subagent-Driven Development (Codex-paired)

## What this changes vs. upstream
After each slice's implementing subagent reports completion, Claude runs a **scoped Codex review** before moving to the next slice. The review is locked to the slice's tasks; out-of-scope issues are noted but cannot block.

## Per-slice flow

### Step A: dispatch implementing subagent
Same as upstream — dispatch a subagent for slice N with the slice's tasks. Wait for completion + tests passing.

### Step B: capture slice artifacts
Collect:
- Slice scope: the exact task list from the plan for slice N (literal markdown, the bullet list).
- Diff: `git diff <slice-start-sha>..HEAD -- <files-this-slice-was-meant-to-touch>`
- Test output: pasted verbatim from the subagent's last test run.

### Step C: open Codex slice review
Resume the session. Build the prompt from `slice-review-prompt.md` (in this skill folder), substituting `{{SLICE_ID}}`, `{{ROUND}}`, `{{SLICE_TASKS}}`, `{{SLICE_DIFF}}`, `{{TEST_OUTPUT}}`, and (rounds 2+) `{{PRIOR_CRITIQUES}}`.

The prompt explicitly states:
> Review only what is in this slice's scope. Out-of-slice issues = note for later in `## Deferred`, do not block on them. If you find an out-of-slice critical bug, name it in `## Deferred` with severity, but ship the slice.

Send via `session-resume`:

```bash
echo "$PROMPT" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-resume --specPath "<spec-path>"
```

### Step D: 7-round loop
Same as brainstorming. Both must SHIP. Sidecar phase is `slice:<slice-id>` (e.g., `slice:2`). On double-SHIP, mark slice shipped:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-slice \
  --specPath "<spec-path>" \
  --sliceId "<slice-id>" \
  --state '{"rounds":[…],"shipped":true,"deferred":[…]}'
```

### Step E: surface deferred items
If the slice review produced any `## Deferred` items, show them to the user before starting the next slice. They might warrant a new task in a future slice or a separate plan.

### Step F: proceed to next slice
Only after slice N is shipped and any user-arbitrated deferreds are decided.

## Anti-scope-creep enforcement
If Codex emits a critique that targets code outside the slice's scope, Claude pushes back: "this is out of slice; either move to Deferred or justify why it must be fixed inside this slice." This is a structural disagreement Codex must justify with concrete reasoning (e.g., "the slice introduces a public API I'm critiquing", which is in-scope).

## Stalled-slice escape
If a slice can't reach double-SHIP in 7 rounds, halt the implementation. Surface the deadlock to the user with both positions. Don't silently downgrade or skip.

## Required upstream sub-skills
- `superpowers:subagent-driven-development` — for the implementer + spec-reviewer + code-quality-reviewer pattern. This forked skill ADDS the Codex slice review on top.
- `pr-review-toolkit:silent-failure-hunter` — recommended for the code-quality reviewer in slices that touch error-handling.
