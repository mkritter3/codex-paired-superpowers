# Autopilot — Design

**Status:** draft for review
**Date:** 2026-05-08
**Owner:** mkr
**Target version:** v0.3.0

## Goal

Take a written, double-SHIP'd plan and run it to completion unattended: implement each slice, run the Codex slice review, update relevant docs, mark the slice shipped, move to the next. Halts only on genuine deadlock or all-done. Compatible with cross-session continuity via ralph-loop.

## Operating shape — 4 nested loops

```
ralph-loop (cross-session driver)
  └─ ticks self-paced; pure resumption from sidecar state on each tick

autopilot (cross-slice)
  └─ pick next unfinished slice → run slice phases → mark shipped → repeat

slice phases (per slice — each phase = its own 7-round budget)
  ├─ plan-slice    Codex confirms the slice's task list is L11-grade
  ├─ implement     subagent does TDD, commits at end
  ├─ review-slice  Claude↔Codex review the diff scoped to slice
  └─ docs-update   Claude drafts doc changes, Codex reviews

round-loop (already built — 7 rounds, both must SHIP)
```

The 7-round cap resets per phase. A single slice may consume up to 4×7 = 28 rounds. Most finish each phase in 1–2 rounds.

## Non-blocking Codex via background subagents

Codex MCP calls block the caller. To make them non-blocking for Claude:

- Claude dispatches a *background* subagent (`run_in_background: true`) whose only job is to call `mcp__plugin_codex-paired-superpowers_codex__codex-reply` with a given prompt + threadId and return Codex's reply.
- Claude continues other prep work concurrently.
- When the subagent completes, Claude integrates the verdict into the round.

**Real parallelism unlocked:**
- Within a round: Claude evaluates the artifact while Codex evaluates it.
- Across phases: while Codex reviews slice N's diff, Claude pre-drafts slice N's docs update.
- Across slices (rare; only when independent): two slices reviewed in parallel.

Implementation note: a thin wrapper subagent prompt `skills/autopilot/codex-via-subagent-prompt.md` standardizes the background call shape. The subagent receives `{threadId, prompt, role}` and returns `{content, verdict}`.

## Slice phase definitions

### Phase A: plan-slice (optional, can skip)
Send Codex the slice's task list (extracted from the plan) and ask for L11 review of *that slice's tasks specifically* — not the whole plan. Critiques: missing TDD steps, wrong granularity, missing files, slice-scope ambiguity. 7-round budget. On double-SHIP, slice's task list is locked.

Skip when: the plan as a whole was already double-SHIP'd in `writing-plans` and slice boundaries are unambiguous.

### Phase B: implement
Dispatch implementing subagent (the existing `subagent-driven-development` pattern). Subagent:
- Receives the slice's full task list (no plan reading).
- Follows TDD strictly — red, green, commit per task.
- Reports DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.

No Codex involvement during implementation itself. Codex enters at review.

### Phase C: review-slice
Existing slice-review flow. Codex reviews the diff scoped to slice N's tasks. 7-round budget. Out-of-slice issues go to `## Deferred`. On double-SHIP, slice's code is locked.

### Phase D: docs-update
Claude drafts doc changes touching:
1. **Plan checkbox** — flip `- [ ]` to `- [x]` for each task in the slice. Mechanical, always required.
2. **README.md** — if the slice changed public surface (new commands, flags, MCP tools, file structure), update relevant sections.
3. **CHANGELOG.md** — one-line entry under the in-progress version.
4. **AGENTS.md / CLAUDE.md** — if the slice changed how agents should operate (e.g., new commands they should prefer, new conventions). Update only if relevant.
5. **Auto-memory** (`~/.claude/projects/<project>/memory/MEMORY.md` and linked memory files) — if the slice locked in a non-obvious decision, save it. Use the same auto-memory rules already in CLAUDE.md.

Codex reviews the docs diff with this rubric: "Are docs accurate? Complete? Are they overstating what shipped? Are they referencing files/symbols that don't exist?" 7-round budget.

On double-SHIP: commit docs as a separate commit (`docs(slice:N): ...`) so blame is clean.

## Docs-freshness hook

A PostToolUse hook on `Bash` (matching `git commit`) runs `${CLAUDE_PLUGIN_ROOT}/hooks/check-slice-docs.sh`:

- Parses the most recent commit's message for `slice:N` markers.
- Runs `git diff HEAD~1..HEAD --name-only`.
- If any plan-task tasks for slice N are unchecked AND the commit message claims slice completion → exit nonzero with explanatory message.
- If commit touches `lib/` or `skills/` significantly without touching `README.md` AND no recent `docs:` commit exists → warn (not block) with rationale.
- Always allows commits that don't claim slice completion.

The autopilot reads hook failures from the commit attempt and re-enters docs-update phase.

## Codex anti-yes-man sharpening

Append to `lib/codex-bridge/prompts/system-rubric.md`:

```
### Pre-SHIP checklist (do this every time before emitting status: SHIP)
Internally answer all three. If you cannot answer any with specifics, you are not at SHIP — emit REVISE.

1. **Strongest critique a senior engineer could make of this artifact?**
   (If your answer is "none", look harder.)
2. **What edge case or failure mode did this artifact gloss over?**
   (Empty input. Concurrent access. Failure of a dependency. Adversarial input. Scale.)
3. **What test, if it existed, would actually fail because of an assumption being made?**
   (If no test could fail, the artifact has no testable claims — that's a problem.)

Then in your verdict, even on SHIP, briefly note in `rationale` what your strongest residual concern is. SHIP doesn't mean "perfect"; it means "no required changes before progress." Residual concerns belong in rationale, not in critique.
```

This makes Codex's `rationale` line meaningful — not just "looks good."

## Sidecar additions

Existing fields preserved. New per-slice tracking:

```json
{
  "slice_reviews": {
    "slice-1": {
      "phases": {
        "plan-slice": { "rounds": [...], "shipped": true, "skipped": false },
        "implement":  { "subagent_status": "DONE", "commits": ["abc123", "def456"] },
        "review-slice": { "rounds": [...], "shipped": true, "deferred": [...] },
        "docs-update": { "rounds": [...], "shipped": true, "files_touched": ["README.md", "CHANGELOG.md", "docs/plans/...md"] }
      },
      "shipped": true,
      "shipped_at": "2026-05-08T..."
    }
  },
  "autopilot": {
    "started_at": "...",
    "last_tick_at": "...",
    "current_slice": "slice-3",
    "current_phase": "review-slice",
    "halt_reason": null
  }
}
```

The `autopilot` block is the resumption anchor for ralph-loop — every tick reads this and continues.

## Failure modes

| Condition | Autopilot behavior |
|---|---|
| Phase deadlock (round 7, no double-SHIP) | Halt; record halt_reason; ping user; ralph stops on next tick (completion-promise unmet) |
| Subagent BLOCKED | Halt; record blocker; ping user |
| Subagent DONE_WITH_CONCERNS | Continue to review-slice phase; concerns logged in sidecar |
| Tests fail in implement phase | Subagent retries up to 2x; then BLOCKED |
| Docs hook fails on commit | Re-enter docs-update phase; if it fails twice in a row, halt |
| User sends a message | Halt at next safe checkpoint (between phases); resume on next /autopilot or ralph tick |

## Components to build

1. **`skills/autopilot/SKILL.md`** — orchestrator instructions Claude follows when invoked.
2. **`skills/autopilot/codex-via-subagent-prompt.md`** — template for non-blocking Codex calls via background subagents.
3. **`hooks/check-slice-docs.sh`** — docs-freshness hook script.
4. **`hooks/hooks.json`** — hook registration in plugin.
5. **`commands/autopilot.md`** — slash command `/autopilot <plan-path>` (optional convenience; ralph-loop can also drive it directly).
6. **Update `lib/codex-bridge/prompts/system-rubric.md`** — pre-SHIP checklist.
7. **Update `lib/codex-bridge/sidecar.js`** — support nested slice phases + autopilot block.
8. **Update `lib/codex-bridge/cli.js`** — add `sidecar-set-phase`, `sidecar-set-autopilot` subcommands.
9. **Tests** — sidecar phase nesting; hook script behavior with mocked git.
10. **README + CHANGELOG** — document autopilot + ralph integration.

## Out of scope (v0.4+)

- Parallel slice implementation (rare; most plans are sequential).
- Auto-recovery from deadlocks via opus escalation.
- Visual UI for autopilot state.
- Network failure retry logic for codex MCP calls (assume MCP server is stable for now).

## Success criteria

- A 10-slice plan can run end-to-end unattended via `/ralph-loop /autopilot <plan-path>`.
- Each slice ships with all four phases double-SHIP'd OR ralph halts cleanly with the deadlock recorded.
- Docs are never stale: every shipped slice's docs reflect its diff.
- Codex's SHIP rate before pre-SHIP checklist vs. after measurably drops (anecdotal — we'll watch the smoke runs).
- Total wall-clock time per slice (mock conditions: small slice, no real review issues) ≈ 1–3 min, dominated by Codex latency.

## Open contentions
*(none yet)*
