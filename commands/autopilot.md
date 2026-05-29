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
- **With no argument:** the spec/plan isn't known yet, so locate the in-progress run by scanning
  sidecars, then resume it:
  1. Enumerate sidecars under `.superpowers-codex-paired/` (they are `<spec-path>.json`).
  2. For each, inspect its state: an app-autopilot run has `app_state.active_plan` set
     (`app-state-get --specPath <that-spec>`); a single-plan run has an `autopilot` block with
     `current_phase` ≠ `all_done`. Treat either as "in progress" unless it carries a terminal
     `halt_reason` (those need the user to act first — surface the resume hint).
  3. If exactly one in-progress run is found, resume it (use its `active_plan`, or the plan the
     sidecar's spec frontmatter points to). If several, list them and ask which. If none, say so and
     point the user at `/autopilot <plan-path>`.

Because state is in the sidecar, **handing off to a brand-new session just means running `/autopilot`
again** — no need to remember the plan path or re-supply any flags.

## Preconditions (for a fresh start)

1. The plan lives at the given path (this repo uses `docs/plans/...`).
2. Its frontmatter has `**Spec:** <spec-path>` pointing at a sibling spec.
3. The spec has a sidecar (`<spec-path>.codex.json`) with a `codex_session` threadId — i.e. it was
   brainstormed via `codex-paired-superpowers:brainstorming` and plan-reviewed via
   `codex-paired-superpowers:writing-plans`.

## What happens

Invoke `codex-paired-superpowers:execution` with `driver: autopilot` and the plan path (or the
resolved in-progress plan). The execution skill forwards to the same autopilot flow — resume
discovery, sidecar state, halt-envelope behavior, and self-continuation are unchanged. That flow
drives each slice through its four phases (plan-slice + test-list review, implement, review-slice,
docs-update) with full Claude↔Codex review, persisting state to the sidecar after every step. It runs
slices until one of:

- **all slices ship** → autopilot reports completion and stops;
- **a real blocker** → autopilot halts with an actionable `halt_reason` and a resume hint;
- **the session ends** (context limit / you stop it) → just run `/autopilot` again to continue.

For fully unattended repetition on a timer you can still drive it with the built-in `/loop` skill
(e.g. `/loop /autopilot`), but that is optional — the default model is one self-resuming command.

Plan: $ARGUMENTS
