---
description: "Run (or resume) a double-SHIP'd implementation plan slice-by-slice via codex-paired autopilot"
argument-hint: "[plan-path]  (omit to resume the in-progress run)"
---

# /autopilot

Run the `codex-paired-superpowers:autopilot` skill against a plan — or, with no argument, **resume the
in-progress run**. Autopilot is *self-continuing*: all progress lives in the sidecar, so re-running
`/autopilot` picks up exactly where the last session left off. There is no separate loop command to
wrap it in.

## Usage

```
/autopilot                       # resume the in-progress autopilot run (handoff-friendly)
/autopilot docs/plans/<plan>.md  # start (or resume) a specific plan
```

## How resume works (read this for session handoff)

- **With a plan path:** start that plan, or resume it if its sidecar already has autopilot progress.
- **With no argument:** locate the in-progress run and resume it. Find it by, in order:
  1. `node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-get --specPath <spec>` if an
     app-autopilot `active_plan` is set, else
  2. the most recently modified sidecar under `.superpowers-codex-paired/` whose `autopilot` block has
     `current_phase` ≠ `all_done` and no terminal `halt_reason`.
  If exactly one in-progress run is found, resume it. If several are found, list them and ask which.
  If none, say so and point the user at `/autopilot <plan-path>`.

Because state is in the sidecar, **handing off to a brand-new session just means running `/autopilot`
again** — no need to remember the plan path or re-supply any flags.

## Preconditions (for a fresh start)

1. The plan lives at the given path (this repo uses `docs/plans/...`).
2. Its frontmatter has `**Spec:** <spec-path>` pointing at a sibling spec.
3. The spec has a sidecar (`<spec-path>.codex.json`) with a `codex_session` threadId — i.e. it was
   brainstormed via `codex-paired-superpowers:brainstorming` and plan-reviewed via
   `codex-paired-superpowers:writing-plans`.

## What happens

Invoke the `codex-paired-superpowers:autopilot` skill with the plan path (or the resolved in-progress
plan). The skill drives each slice through its four phases (plan-slice + test-list review, implement,
review-slice, docs-update) with full Claude↔Codex review, persisting state to the sidecar after every
step. It runs slices until one of:

- **all slices ship** → autopilot reports completion and stops;
- **a real blocker** → autopilot halts with an actionable `halt_reason` and a resume hint;
- **the session ends** (context limit / you stop it) → just run `/autopilot` again to continue.

For fully unattended repetition on a timer you can still drive it with the built-in `/loop` skill
(e.g. `/loop /autopilot`), but that is optional — the default model is one self-resuming command.

Plan: $ARGUMENTS
