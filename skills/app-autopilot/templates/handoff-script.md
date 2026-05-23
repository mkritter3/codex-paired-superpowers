# Conversational handoff: brainstorming → first plan → `/goal` kickoff

Main Claude reads this template after `brainstorming` has shipped an app-scoped spec AND `writing-plans` has shipped the first plan. The goal is to hand off to unattended execution conversationally — the user is not expected to know what `/goal` is or how to type it.

## Tone rules (load-bearing)

- Plain English. No `slice`, `SHIP`, `phase`, `sidecar`, `autopilot`, `Codex thread`. Use "chunk of work", "we agreed it's done", "the documentation step", "the project notes".
- Talk to the user like a smart friend who doesn't write code.
- Be specific about what's about to happen. Don't undersell scope or oversell speed.
- If something might go wrong, name it.

## Script

After the first plan is double-SHIP'd, before exiting `writing-plans` Phase 5 (hand off), say something like:

> Alright — we've got the design locked in and Codex and I just finished the plan for the first feature together. Here's what I'm about to do, in case you want to be in the loop:
>
> **The whole app, when it's done:**
> - {{goal_1_plain_english}}
> - {{goal_2_plain_english}}
> - {{goal_3_plain_english}}
> - ({{N - 3}} more...)  ← only if more than 3 goals
>
> **First up:** {{first_plan_summary_plain_english}}. Codex and I think this'll take roughly {{rough_estimate}} of work, ship in {{first_plan_slice_count}} smaller chunks, and check off {{first_plan_goal_count}} of the {{total_goals}} goals above.
>
> Then I'll plan the next feature with Codex, build it, check in with you, and keep going until all {{total_goals}} goals are done.
>
> **What you'll see:** I'll send you a progress update each time I finish a chunk — what just shipped, what's next, anything I'm stuck on. If I hit something I can't fix on my own (like a missing API key or a tough decision), I'll stop and ask.
>
> Want me to kick it off? Just say "yes" or "go" — or if you want to look the plan over first, the file is at `{{first_plan_path}}`.

## After the user says yes

Build the `/goal` condition by rendering `goal-condition.md`:

```bash
SPEC_PATH="<spec-path>"
TOTAL_GOALS=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" app-state-get --specPath "$SPEC_PATH" | jq -r '.goals | length')
```

Substitute `{{spec_path}}` and `{{total_goals}}` into the template. Then fire the goal via the Bash tool:

```bash
# Bash tool call, run_in_background=true
claude -p "/goal '<rendered condition>'" \
  --auto \
  --output-format=stream-json
```

Confirm to the user, briefly:

> Started — I'll talk you through it as I go. You can hit Ctrl+C at any time if you want me to stop, or just keep doing your own thing and I'll check in.

## What main Claude does after firing

Use the Monitor tool on the backgrounded `claude -p` process. Each time the child emits an `<<<APP_AUTOPILOT_PROGRESS>>>` block, the plain-English paragraph above it is what gets surfaced to the user (relay it verbatim or lightly paraphrased — the explainer is already written to be user-friendly).

If `APP_HALT` appears, foreground the user immediately:

> Hit a snag. {{halt_reason_explained_plainly}}. {{what_user_can_do}}. Once you've sorted it, just say "go again" and I'll pick up from where I left off.

When `Goals shipped: N/N` matches the total, the child exits cleanly:

> Done — all {{total_goals}} goals are shipped. {{one_sentence_recap}}. Want to take a look at the app?

## If the user says no, or wants to review

Skip the `claude -p` call. Tell them where the plan is, offer to walk through it, and stand by. They can come back and say "go" later — the spec and plan persist, the sidecar's `app_state` is initialized, and main Claude can fire the goal then.

## If the user wants to watch live (foreground)

Re-run the same `claude -p` command without `run_in_background=true`. The Bash tool blocks until the child exits, and the user sees every progress update as it streams. Warn first: "This will tie up our chat until everything ships — could be hours. Sure?"

## What NOT to do in this handoff

- Don't ask the user a clarifying question about a goal. Brainstorming is over; goals are locked. If they want a goal changed, route back to brainstorming.
- Don't dump the technical `/goal` condition string as the main thing — show it as a "the technical details, if you're curious" footnote, not the headline.
- Don't promise "this will be fully autonomous and you don't need to do anything" — halts happen, and the user will be needed for things like API keys, design decisions, and arbitration on Codex/Claude disagreements.
