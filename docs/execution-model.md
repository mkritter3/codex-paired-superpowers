# Execution Model

This is the one canonical description of how implementation work runs. Other docs and
skills link here instead of repeating the matrix, so there is a single source of truth.

Choose three independent things before running implementation work:

1. Driver: who keeps the work moving.
   - `interactive`: you and Claude move one work item at a time.
   - `autopilot`: Claude keeps going across a reviewed plan until it finishes, needs help, or the session ends.

2. Split: how one work item is written.
   - `single`: one implementer writes it.
   - `two-disjoint`: two implementers work in parallel on separate files, then the branches are merged.
   - `hybrid-ui-backend`: Claude builds the UI side while Codex builds the backend side, joined by a published contract.

3. Review: who checks the result.
   - Codex paired review always runs.
   - Additional domain reviewers may be selected from the work item, affected files, or a `Reviewers` directive.

Stable combinations:

| Driver | single | two-disjoint | hybrid-ui-backend |
| --- | --- | --- | --- |
| interactive | yes | yes | yes |
| autopilot | yes | yes | yes |

The experimental multi-plan app driver (`app-autopilot`) is intentionally outside this
table for now — it is opt-in and lives in its own skill because it documents its own
transcript-loop failure modes. It is not part of v1 of the unified execution model.

## How to launch

- **Stable entry point:** the `execution` skill. Pick a `driver` (`interactive` or
  `autopilot`) and pass a plan path; the per-work-item split comes from each slice's
  `**Split:**` directive in the plan.
- **`/autopilot`** keeps working as a thin compatibility alias for
  `execution` with `driver: autopilot` (including no-argument resume of an in-progress
  run). Its behavior is unchanged.
- **`/execute`** launches the `execution` skill with an explicit driver.

The drivers and splits above map onto engines that already exist (the autopilot engine,
the interactive subagent-driven driver, the symmetric two-implementer orchestrator, and
the hybrid UI/backend runner). This model is the selection layer over them, not a new
engine.
