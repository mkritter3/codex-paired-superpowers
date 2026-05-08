---
description: "Run an implementation plan slice-by-slice unattended via codex-paired autopilot"
argument-hint: "<plan-path>"
---

# /autopilot

Run the codex-paired-superpowers:autopilot skill against the given plan.

## Usage
`/autopilot <plan-path>`

The plan must:
1. Live at the given path (typically `docs/superpowers/plans/...`).
2. Have a frontmatter line `**Spec:** <spec-path>` pointing at a sibling spec.
3. The spec must have a sidecar at `<spec-path>.codex.json` with a `codex_session` threadId (i.e., it must have been brainstormed via `codex-paired-superpowers:brainstorming` and plan-reviewed via `codex-paired-superpowers:writing-plans`).

## What happens
Invokes the `codex-paired-superpowers:autopilot` skill with the plan path. The skill takes over from there — see its SKILL.md for full lifecycle. To get cross-session continuity, wrap this command in `/ralph-loop`.

## Example
```
/ralph-loop /autopilot docs/superpowers/plans/2026-05-08-myfeature.md --completion-promise "autopilot completed"
```

The plan: $ARGUMENTS
