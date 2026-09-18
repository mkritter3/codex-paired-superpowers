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

For the one-page mental model of the three independent choices (driver, split, review), see the
canonical [docs/execution-model.md](../../docs/execution-model.md). This skill is the selection layer
over the engines described there; do not restate the matrix here.

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
8. **Stale-run surfacing (v0.15.0).** On every entry, run
   `node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-scan-stale --repoRoot <repo>` and,
   if it returns any entries, tell the user in plain English before proceeding: which plan, which
   step it stopped at, and how long it has been idle (e.g. "an unattended run for <plan> stopped at
   slice 4 planning 11 days ago — resume it, or mark it halted?"). A quiet in-flight run is
   otherwise indistinguishable from one running in another session, and replay found one sitting
   silently resumable for 11 days.

## Execution thread (v0.16.0 — do this once per feature at hand-off)

Planning ran on the `paired-reviewer` thread at the `planning` model role (GPT-6 Astra, `xhigh`).
Slice reviews run on a second, cheaper thread at the `review` role. Before delegating to either
driver, open it if `role_sessions["execution-reviewer"]` is absent from the sidecar (resume paths
skip this):

0. `node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format json --repoRoot <repo>` → read `cli`. **If `agy`** (v0.17.0): skip steps 1, 4 and 5 — instead pipe the seed prompt from step 3 to `node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" reviewer-thread-open --role review --specPath <spec> --repoRoot <repo> --planPath <plan> --prompt-stdin`, which opens the Gemini conversation in a throwaway checkout and records it in the sidecar itself. If `codex`, continue:
1. `node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format mcp --repoRoot <repo>` → `{ model, config }`. Exit 2 → stop and show the error.
2. `node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-replay-context --specPath <spec>` → replay JSON.
3. Seed prompt = `composeSeedPrompt(replay, { reason: 'execution-thread', specPath, planPath, pendingPrompt })` from `lib/codex-bridge/thread-recovery.js`, prefixed with `system-rubric.md` + `verdict-format.md`. The seed tells Codex to read the spec and plan from disk.
4. Call the `codex` MCP tool with that prompt and the `model` + `config` from step 1.
5. `sidecar-rotate-thread-id --specPath <spec> --role execution-reviewer --newThreadId <id> --reason execution-thread --phase execution --threadConfig '{"role":"review","cli":"codex","model":"<model>","effort":"<effort>"}'`.

See `skills/brainstorming/codex-pairing.md` "Two threads per feature" for the rationale.

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

Run the plan step-by-step with the user in the loop. The implementation flow lives in
`codex-paired-superpowers:subagent-driven-development`; this driver reaches it through `execution` so
the user-facing entry point stays `execution`.

For each work item in the plan:

1. **Normalize the split directive** for the work item and route it through `runSplit` (the same
   normalize-then-route seam autopilot uses). `runSplit` resolves the work item to one of three split
   paths: `single`, `two-disjoint`, or `hybrid-ui-backend`.
   **Route check (v0.19.0):** when a multi-member **review** panel is configured, `runSplit` (and the
   fan-out and hybrid runners, before creating any checkout) halts `two-disjoint` and
   `hybrid-ui-backend` work items with `panel-unsupported-route`; those routes' review gates do not
   support a panel yet. Tell the user, and suggest either the `single` split or removing
   `review_panel.review`. Unconfigured projects and the `single` split are unaffected.
2. **Run the corresponding split path** (see below).
3. **Run the domain reviewers** for the work item using the reviewer-named APIs.
4. **Claude reviews first** (SDD Step C0: findings list, at most two `runFixPass` fix passes), then
   **the Codex paired review** on the execution thread; both SHIP the same `reviewed_sha`.
5. **Show plain-English progress and blockers** to the user, pausing for review between steps.

Split-specific behavior (interactive uses the same split it would under autopilot):

- **`single`** → `runSplit` returns a `dispatch-single` directive. Act on it by running Step A of
  `subagent-driven-development` — the implementer ladder (Codex at `implement`, then Codex at
  `implement_fallback`, then the Sonnet subagent), then the reviewer checks, Claude's review, and the
  Codex review.
- **`two-disjoint`** → use the existing implementer worktree fan-out and `dispatchImplementers`, then
  the existing merge coordinator and post-merge review. The interactive driver may pause between
  dispatch, merge, and review, but it is the same split reachable under autopilot.
- **`hybrid-ui-backend`** → call `runHybridSlice({ mode: 'interactive', ... })`. The UI owner runs as
  `claude-inline`; the backend owner runs as `codex-background-bash`. This reuses the runner behavior
  already in `lib/codex-bridge/hybrid/runner.js` — no new runner.

**Dirty working tree before a hybrid step.** `runHybridSlice` in `interactive` mode refuses to start if
the working tree has uncommitted changes (internal halt `hybrid-preflight-dirty`). Do not show that
code to the user. Instead say, in plain English: "Your working tree has uncommitted changes; commit or
stash them before running a hybrid step, then re-run." Then stop and wait for the user.

Interactive execution has no no-argument resume in v1 and always requires a plan path (see selection
rules 3-4).

## Driver: autopilot

Delegate to the `codex-paired-superpowers:autopilot` skill unchanged. The only thing this driver adds
is reading the canonical `**Split:**` directive at autopilot's existing Phase B decision point — the
point where Phase B already chooses among single, implementer-experts, and hybrid — via
`normalizeSplit`.

- For a `single` work item, the router returns the `dispatch-single` directive (the Plan 1 split
  router), and autopilot runs its **existing single-implementer phase** on that directive. Autopilot —
  not the router — still owns that dispatch. Do not bypass the router and call the single-implementer
  phase directly; always go through `dispatch-single` so the split decision stays in one place.
- For `two-disjoint`, autopilot's existing implementer-experts branch runs (`dispatchImplementers`).
- For `hybrid-ui-backend`, autopilot's existing hybrid branch runs
  (`runHybridSlice({ mode: 'autopilot', ... })`).

Everything else stays owned by `autopilot`: resume discovery, sidecar state, the halt envelope,
outer-mode behavior, and self-continuation across sessions. This driver introduces no new resume path,
no new flags, and no new prompts.
