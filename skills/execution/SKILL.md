---
name: execution
description: The single stable entry point for running or resuming reviewed implementation work. Takes an explicit driver — `interactive` (step-by-step with you in the loop) or `autopilot` (unattended) — and a plan path, normalizes the plan's split directive, then delegates to the matching driver flow. Invoked by `/execute`; `/autopilot` is a thin alias that calls this with `driver: autopilot`.
---

# Execution

## What this is
The canonical front door for turning a reviewed, double-SHIP'd plan into code. There is exactly one
execution skill; both ways of running a plan — with you in the loop, or unattended — live here behind
a single `driver` choice. This skill is intentionally thin: it picks the driver, normalizes the plan's
split directive, and hands off to the existing flow that does the real work.

## Inputs

```
driver: interactive | autopilot
plan:   docs/plans/<plan>.md | omitted-for-resume
```

- `driver: interactive` — run the plan step-by-step with the user in the loop, pausing for review.
- `driver: autopilot` — run the plan unattended end-to-end, persisting progress to the sidecar.
- `plan` — the path to a reviewed plan. May be omitted only for autopilot resume (see selection rules).

## Selection rules

1. **Invoked by `/autopilot`.** The command supplies `driver: autopilot` and forwards its arguments
   unchanged. This is the thin-alias path — behavior is identical to running `/execute` with
   `driver: autopilot`.
2. **Invoked by `/execute` with a plan path.** Require an explicit `driver` of either `interactive` or
   `autopilot`. If `driver` is missing, apply rule 5.
3. **Invoked by `/execute` with no arguments.** Resume is **autopilot-only** in v1: scan the sidecars
   exactly like a no-argument `/autopilot` does, resume only if exactly one autopilot run is in
   progress, and otherwise show the same "no run / several runs" choice or error that `/autopilot`
   shows. No-argument invocation never starts or resumes an interactive run.
4. **`driver: interactive` is not resumable in v1.** It must be invoked with a plan path. If a session
   ends mid-work, the user restarts interactive execution by pointing at the plan again and choosing
   the next unfinished work item. This skill must **not** infer an interactive run from sidecar state,
   because no interactive active-run contract exists today.
5. **Invoked directly as a skill with a plan path but no `driver`.** Ask exactly one short question:
   "Run this step-by-step with you in the loop, or let autopilot continue the reviewed plan?" Then
   proceed with the chosen driver.
6. **`driver: interactive`** delegates to the existing interactive driver flow after split
   normalization (see `## Driver: interactive`).
7. **`driver: autopilot`** delegates to the existing autopilot flow after split normalization (see
   `## Driver: autopilot`).

## What this delegates to

- `driver: interactive` → `codex-paired-superpowers:subagent-driven-development` (the step-by-step,
  user-in-the-loop flow).
- `driver: autopilot` → `codex-paired-superpowers:autopilot` (the unattended, self-continuing flow).

Both flows already normalize the plan's split directive before dispatching work; this skill simply
routes to the right one based on `driver`.

## User-visible output

Write status updates in plain English. Do **not** leak internal labels — words like `slice`, `SHIP`,
or `Phase B` — into anything the user sees. Describe what is happening in terms the user recognizes:
"working through the first piece of the plan", "ready for your review", "all done". Internal artifacts
(commit messages, sidecar records, test names) may use the precise terms; user-facing prose may not.

## Driver: interactive

(Wired in a later step.) Normalizes the plan's split directive and runs the plan step-by-step with the
user in the loop, delegating to `subagent-driven-development`.

## Driver: autopilot

(Wired in a later step.) Normalizes the plan's split directive and runs the plan unattended,
delegating to `autopilot`.
