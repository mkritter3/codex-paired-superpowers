---
name: app-autopilot
description: EXPERIMENTAL OPT-IN. Multi-plan unattended app rollout driven by Claude Code's `/goal` command. Only use when the user explicitly asks for /goal-driven execution by name. Default path for multi-plan apps is the self-continuing `autopilot` (see `skills/autopilot/SKILL.md`), which has battle-tested loop-prevention this skill lacks.
---

# App-autopilot (experimental, opt-in)

> **⚠ Status: experimental (v0.11.0).** As of v0.12.0, this is NOT the default path for multi-plan apps. Use the self-continuing `autopilot` instead — the brainstorming Phase 5 handoff defaults there. Only invoke `app-autopilot` when the user explicitly asks for `/goal`-driven execution by name.
>
> **Why it's not the default.** Claude's `/goal` evaluator is transcript-only — it can re-trigger turns endlessly if the success sentinel (`Goals shipped: N/N`) or halt sentinel (`APP_HALT`) isn't surfaced cleanly by the headless child. Autopilot has halt-envelope classification (terminal vs transient), panel-quorum-lost handling, dirty-tree reconciliation on every resume, and other loop-prevention guards (`lib/codex-bridge/halt-envelope.js`, `tests/codex-bridge/halt-envelope-e2e.test.js`). app-autopilot inherits NONE of those guards — it relies entirely on the goal-condition string matching reliably.
>
> **Known failure modes.** (1) Headless `claude -p` child doesn't surface `<<<APP_AUTOPILOT_PROGRESS>>>` to the parent transcript → evaluator never sees "Goals shipped: N/N" → loops forever. (2) Codex disagreement in the next-plan drafting step burns the 7-round budget without converging → halt sentinel not emitted because the loop is still inside writing-plans.
>
> **If you're hitting any of these,** stop using `app-autopilot` and route through brainstorming → writing-plans → autopilot manually, one plan at a time. The sidecar's `app_state` block is still useful for tracking which goals shipped under which plan; just don't drive the loop from `/goal`.

## What this is

A thin orchestrator that sits ABOVE the existing `autopilot` skill. Where `autopilot` ships one plan slice-by-slice, `app-autopilot` ships an entire app — many plans, one after another, all driven by a single Claude Code `/goal` condition the user can leave running unattended.

The user prompts once with an app idea. Brainstorming produces an app-scoped spec with multiple ultimate goals. Claude↔Codex pair to draft the first plan. Claude shells out `claude -p "/goal '...'"` to kick off unattended execution. From there, each `/goal` turn:

1. Reconciles state (dirty tree, external commits).
2. Runs the existing `autopilot` skill on whatever plan is active.
3. When that plan ships, pairs with Codex to draft the next plan, then loops back.
4. Prints a plain-English progress update for the user, plus a machine-readable footer the `/goal` evaluator reads.

The `/goal` evaluator (Haiku) sees `Goals shipped: N/N` and clears the goal. Or it sees `APP_HALT` and the condition's OR-branch satisfies, ending the loop.

## Talk to the user like a human

Every user-facing line app-autopilot writes — progress updates, halt messages, the conversational handoff that fires `/goal` — is plain-English. No `slice`, no `SHIP`, no `phase D` jargon. Say "the next chunk of work", "Codex and I both signed off", "the documentation step." This is a durable user preference; treat it as load-bearing. See `templates/handoff-script.md` and the example output further down.

## Required inputs

- A double-SHIP'd **app-scoped** spec at `docs/superpowers/specs/<spec>.md`. The spec's `<<<GOALS>>>` block must list ≥ 1 user-observable outcome — typically 3+ for a real app. Brainstorming with `app-scoped: true` enforces this.
- A double-SHIP'd **first plan** at `docs/superpowers/plans/<plan-1>.md`, drafted by Codex-paired `writing-plans`, that delivers at least one of the spec's goals.
- The sidecar's `app_state` block, initialized via `app-state-init`. (Brainstorming does this automatically when the spec is app-scoped.)

If you arrive at app-autopilot without these in place, halt and route the user back to `brainstorming` (with app-scope) → `writing-plans`. Do NOT try to brainstorm or write a plan from inside app-autopilot.

## Honest-reporting activation

On entry, refresh the marker (24-hour TTL recommended for long unattended runs):

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active \
  --skill app-autopilot --spec <spec-path> --ttl-hours 24
```

## Kickoff: how `/goal` actually gets fired

The user does NOT type `/goal` themselves in the common path. After brainstorming + first-plan are done, **main Claude fires it** by shelling out:

```bash
claude -p "/goal '<rendered-condition>'" \
  --auto \
  --output-format=stream-json
```

The condition string is built from `templates/goal-condition.md`. The handoff conversation (`templates/handoff-script.md`) is what main Claude reads to the user *before* executing that Bash call — a plain-English summary + the technical condition + a yes/no nudge. Only on "yes" does the Bash call go out.

Run it via the Bash tool with `run_in_background=true` so main Claude stays interactive. Then use the Monitor tool to stream the child's stdout and surface each `<<<APP_AUTOPILOT_PROGRESS>>>` block back to the user as a friendly update. Foreground mode (no `run_in_background`) is fine for short runs but blocks the user for the duration; do it only if asked.

The headless child Claude reads the same workspace and the same `.superpowers-codex-paired/` sidecar, so all state survives. When `/goal` clears (condition met or APP_HALT seen), the child exits and `claude -p` returns.

## Per-`/goal`-turn procedure

This is the work that happens inside ONE turn of the child Claude session (i.e. one main-turn between `/goal`-evaluator checks). The headless child invokes app-autopilot on every turn until the goal clears.

### Step 1 — Reconcile state

Read the sidecar's `app_state`:

```bash
SPEC="<spec-path>"
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-get --specPath "$SPEC"
```

Check the working tree:

```bash
git status --porcelain
```

If the tree is dirty AND the dirt is not ours (no `Co-Authored-By: Claude` trailer on any leftover index entries), halt with `APP_HALT: dirty-tree-on-resume`. The user must clean up; on next `/goal` (or `/goal clear` then re-fire), reconciliation will retry.

Walk new commits since `app_state.plans[active_plan].shipped_at` (or repo HEAD if no active plan). If an external commit appeared, that's fine — app-autopilot doesn't lock the repo against the user. Just note it in the progress block.

### Step 2 — Decide what to do this turn

Compute from `app-state-get`:

- `unshipped_goals.length === 0` → all goals shipped. Print the "all done" progress block (see below) with `Goals shipped: N/N` and exit successfully. The `/goal` evaluator will clear on the next check.
- `active_plan != null` → autopilot has a plan in flight. Go to step 3.
- `active_plan == null` AND a never-started plan file exists from a prior writing-plans pass → set it active via `app-state-set-plan --started` and go to step 3.
- `active_plan == null` AND no pending plan → go to step 4 (draft next plan).

### Step 3 — Run autopilot on the active plan

Invoke the existing `autopilot` skill on `active_plan`, but in **outer-mode**:

- Set the environment flag or sidecar marker (see `skills/autopilot/SKILL.md` § Outer-mode under app-autopilot) so autopilot:
  - Does NOT self-continue/loop over further slices (we're the outer driver now — one pass per turn).
  - Prints `<<<PLAN_SHIPPED>>> path=<plan> goals_audited=[id1,id2]` when the plan finishes.
  - Prints `APP_HALT: <reason>` instead of just halting silently on a non-recoverable failure.

When `<<<PLAN_SHIPPED>>>` appears in the autopilot output, parse out the `path` and `goals_audited` list, then for each goal id:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-mark-goal-shipped \
  --specPath "$SPEC" --goalId "<id>" --planPath "<plan-path>"
```

And mark the plan shipped:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-set-plan \
  --specPath "$SPEC" --planPath "<plan-path>" --shipped
```

Then proceed to print the progress block (Step 5).

If autopilot prints `APP_HALT`, surface its reason in the progress block (Step 5) with `Halt: <reason>`. The `/goal` evaluator will see the halt sentinel and the OR branch of the condition will satisfy — goal clears.

### Step 4 — Draft the next plan (Claude↔Codex)

This step only fires when no plan is active. Reuse the **writing-plans** skill, parameterized with the unshipped goals as the goal block.

1. Read the next-plan context:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-next-plan-context --specPath "$SPEC"
   ```

   The output has `unshipped_goals[]`, `shipped_plans[]`, and the total. Pick which subset of unshipped goals the next plan should deliver. Heuristic: smallest cohesive subset that builds on what's already shipped. A plan can ship one goal or many — Claude↔Codex decide together. Aim for plans that ship in <1 day of work; smaller plans = faster progress feedback.

2. Compose a Codex prompt that includes:
   - The full `<<<GOALS>>>` block (from `sidecar-get-goals`).
   - The `shipped_plans` summary (so Codex knows what's done).
   - The candidate unshipped goal subset for this plan.
   - The repo state (recent commits since last plan, surfaced via `git log --oneline -10`).
   - A directive: "Draft an L11 implementation plan that ships ONLY these specific goals, building on the shipped state above. Same audit rules as standard writing-plans."

3. Run the standard writing-plans 7-round loop using the spec's existing Codex threadId. Reuse the existing skill verbatim — `writing-plans` already handles round counting, audit gates, panel TDD review, etc. Pass the spec path; it picks up the threadId from the sidecar.

4. When writing-plans returns a double-SHIP'd plan, write it to `docs/superpowers/plans/<date>-<auto-named>.md` and mark it active:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js app-state-set-plan \
     --specPath "$SPEC" --planPath "<new-plan>" --started
   ```

5. Print the progress block with a "wrote a new plan" friendly summary, then return — the next `/goal` turn will run autopilot on it (Step 3).

### Step 5 — Print progress (every turn ends with this)

Two parts. Plain-English first, machine-readable footer second. Both go to stdout so the `/goal` evaluator sees them in the transcript.

**Plain-English explainer** (one to three short paragraphs, friendly tone):

> Just finished the password-reset flow — that's our second feature shipped! It went smoothly: Codex and I both agreed the work was solid, the live test confirmed someone can actually reset their password from the login screen, and Codex independently double-checked the code against the goal "user can recover a forgotten password."
>
> Two of your six goals are done. Up next: profile pictures. Codex and I just wrote the plan for it together — it's a small one, probably a couple hours of work. Starting on it now.

Adapt to what actually happened this turn. Examples for other situations:

- *Plan still running:* "Still working on the login flow. Just finished the part that checks if the password matches. Two more chunks of work to go before we can show you it working end-to-end."
- *About to draft new plan:* "The signup flow shipped — that's one goal off the list. Codex and I are about to plan what comes next. Talking it over now."
- *Halt:* "Hit a snag — the email-sending library needs an API key I don't have. Can you set `EMAIL_API_KEY` in `.env`? Once you do, just paste this back to me: `/goal '...'` (same as before)."

**Machine-readable footer** (exactly this shape; the `/goal` evaluator pattern-matches on `Goals shipped: N/N`):

```
<<<APP_AUTOPILOT_PROGRESS>>>
Spec: docs/superpowers/specs/<spec>.md
Goals shipped: 2/6
Active plan: docs/superpowers/plans/2026-05-24-profile-pictures.md
Just shipped this turn: goal-password-reset (via docs/superpowers/plans/2026-05-23-password-reset.md)
Halt: none
<<<END_PROGRESS>>>
```

When all goals are shipped, the footer reads `Goals shipped: N/N` with N == total, `Active plan: none`, `Halt: none`. That's what triggers the `/goal` evaluator to clear.

When halting, the footer reads `Halt: <one-line reason>` AND the explainer above includes `APP_HALT: <reason>` literally so the `/goal` condition's OR-branch satisfies. Yes, both the human paragraph and the footer can include the sentinel — the goal evaluator only needs one match anywhere in the transcript.

## The `/goal` condition string (canonical)

Use `templates/goal-condition.md` to render. Substitutes `{{spec_path}}` and `{{total_goals}}`. The form:

```
transcript contains "Goals shipped: {{total_goals}}/{{total_goals}}" with spec "{{spec_path}}",
OR transcript contains "APP_HALT",
or stop after 200 turns.
```

The trailing turn-bound is a safety cap — at one plan-ship per turn average and 200 turns max, we cover apps with ~50 goals comfortably. Most apps clear in 5–20 turns.

## Halt vs self-continuing-autopilot semantics

| Default self-continuing autopilot | What we do now under `/goal` |
| --- | --- |
| Persists `halt_envelope` to the sidecar, surfaces it; the next `/autopilot` resume reads it and continues (transient) or stops for the operator (terminal) | Print `APP_HALT: <reason>` in this turn's stdout; goal evaluator sees it, OR-branch satisfies, child Claude exits clean |
| Recovered dirty tree on resume | Reconciliation in Step 1 of every turn; if recoverable, fix and continue; if not, halt with sentinel |
| Anchor file cleared on halt | Same — `anchor-clear` runs in autopilot's existing halt path; no change |
| Resume across sessions | Sidecar holds all state; `/goal` resumes via `claude --resume`; child Claude reads sidecar and continues from `active_plan` |

If a halt is recoverable by the user (missing env var, network blip, external repo edit they want kept), they fix it and either:

- Re-fire the same `/goal` string (most common — Claude offers the exact line in the halt explainer), or
- Run `claude --resume` if the child session is still in their session list.

Either way, Step 1's reconciliation picks up where it left off.

## Failure modes specific to app-autopilot

- **Spec lacks `<<<GOALS>>>` block or has zero goals.** Halt at entry with `APP_HALT: spec-not-app-scoped`. Route user back to brainstorming with app-scope.
- **`app_state` not initialized.** Halt at entry with `APP_HALT: app-state-uninitialized`. Brainstorming was supposed to do this; if it didn't, run `app-state-init` manually using the goals block, then re-fire `/goal`.
- **Codex disagrees with Claude about the next plan after 7 rounds.** Halt with `APP_HALT: next-plan-round-7-deadlock`. User arbitrates — they pick one position or rewrite the plan themselves; re-fire `/goal`.
- **All slices of a plan halt repeatedly with no progress.** After 3 consecutive halts on the same plan (track in `app_state.plans[].halt_count` — fall back to inspecting `autopilot.halt_reason`), surface as `APP_HALT: plan-stuck:<plan-path>`. User decides whether to revise or skip the plan.
- **`claude -p` child crashes (network, OOM).** Goal state in the parent session is unaffected — `/goal` re-fires on the next user prompt (or auto-resume). Re-running app-autopilot from a clean turn picks up via Step 1 reconciliation.

## Backward compatibility

If a user runs the existing `autopilot` skill directly (without app-autopilot wrapping), nothing changes. autopilot detects outer-mode via the presence of `app_state` in the sidecar (or an explicit env var; see `skills/autopilot/SKILL.md`). When outer-mode is OFF, autopilot prints no PLAN_SHIPPED or APP_HALT sentinels and runs in its self-continuing default mode (re-run `/autopilot` to resume; no external loop).

## Troubleshooting setup errors

If `Cannot find module`, `codex: command not found`, `proper-lockfile`, or any module-load / binary-not-found pattern appears, invoke `/codex-paired-superpowers:doctor` before re-firing the `/goal`. The doctor diagnoses the install and prints the exact fix commands.
