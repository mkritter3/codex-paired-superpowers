# Canonical `/goal` condition string for app-autopilot

This is the literal text passed to `/goal` (after substitution). Keep it ≤ 4000 chars (the documented `/goal` limit) and make sure every check is something Claude's transcript output can satisfy — the `/goal` evaluator only reads what's surfaced in the conversation, it can't read files.

## Template

```
The app whose design lives at {{spec_path}} is fully shipped when the assistant has surfaced the line "Goals shipped: {{total_goals}}/{{total_goals}}" in its progress block for that spec. This goal is also satisfied if the assistant surfaces "APP_HALT" — that means it hit something it can't recover from on its own and is handing back to the user. As a safety cap, stop after 200 turns regardless.

Read the most recent <<<APP_AUTOPILOT_PROGRESS>>> block in the transcript. If "Goals shipped" matches "{{total_goals}}/{{total_goals}}", the goal is met. If "APP_HALT" appears anywhere in the most recent turn, the goal is met (the human will take it from here). Otherwise the goal is NOT met and the assistant should keep working — its next turn should run app-autopilot again on the same spec.
```

## Substitutions

- `{{spec_path}}` — full path to the app-scoped spec, e.g. `docs/specs/2026-05-22-todo-app-design.md`. Use the same path string the sidecar was initialized with.
- `{{total_goals}}` — integer count of goals in the spec's `<<<GOALS>>>` block. Get it from `app-state-get` (`.goals.length` or `.total_goals` from `app-state-next-plan-context`).

## Worked example

For a spec at `docs/specs/2026-05-22-todo-app-design.md` with 4 goals, the rendered condition becomes:

```
The app whose design lives at docs/specs/2026-05-22-todo-app-design.md is fully shipped when the assistant has surfaced the line "Goals shipped: 4/4" in its progress block for that spec. This goal is also satisfied if the assistant surfaces "APP_HALT" — that means it hit something it can't recover from on its own and is handing back to the user. As a safety cap, stop after 200 turns regardless.

Read the most recent <<<APP_AUTOPILOT_PROGRESS>>> block in the transcript. If "Goals shipped" matches "4/4", the goal is met. If "APP_HALT" appears anywhere in the most recent turn, the goal is met (the human will take it from here). Otherwise the goal is NOT met and the assistant should keep working — its next turn should run app-autopilot again on the same spec.
```

## How main Claude fires it

Inside the handoff conversation (`handoff-script.md`), after the user says yes:

```bash
# run via the Bash tool, run_in_background=true
claude -p "/goal '<rendered condition above, with single quotes escaped>'" \
  --auto \
  --output-format=stream-json
```

`--auto` removes per-tool prompts inside the child session (per `/goal` docs: "`auto mode` and `/goal` are complementary"). `--output-format=stream-json` lets main Claude tail the child's output via the Monitor tool and surface `<<<APP_AUTOPILOT_PROGRESS>>>` blocks back to the user in plain English.

## Why this exact shape

- **One concrete pass condition** ("Goals shipped: N/N" in the progress block) — the `/goal` docs explicitly recommend "one measurable end state."
- **Stated check** — names where to look (`<<<APP_AUTOPILOT_PROGRESS>>>` block, "most recent turn").
- **OR-branch for halts** — `APP_HALT` lets the goal clear gracefully when the assistant can't proceed unattended, instead of looping forever.
- **Turn cap** — the `/goal` docs recommend "include a turn or time clause" for safety; 200 turns covers very large apps (one plan-ship per turn average) while preventing runaway evaluator costs.
