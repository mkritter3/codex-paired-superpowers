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
  ├─ plan-slice + test-list review   Codex confirms task list AND test list are L11-grade
  ├─ implement                       subagent does TDD per the agreed test list, commits per task
  ├─ review-slice                    Claude↔Codex review the diff scoped to slice
  └─ docs-update                     Claude drafts doc changes; Codex inspects diff and reviews

round-loop (already built — 7 rounds, both must SHIP)
```

The 7-round cap resets per phase. A single slice may consume up to 4×7 = 28 rounds. Most finish each phase in 1–2 rounds.

## Non-blocking Codex (UI sense, not concurrency sense)

Codex MCP calls block the caller. v0.3 makes the *orchestrator* non-blocking — Claude can do unrelated prep work while a Codex call is in flight — but **all Codex calls against the feature's threadId are serialized through the orchestrator**. The plugin's "one persistent thread per feature" guarantee precludes true concurrent codex-reply against the same thread; ordering would be non-deterministic and would corrupt the round-by-round verdict context.

Mechanism:

- Claude dispatches a background subagent (`run_in_background: true`) whose only job is to call `mcp__plugin_codex-paired-superpowers_codex__codex-reply` with a given prompt + threadId and return Codex's reply.
- Claude continues *unrelated* work concurrently — reading files, running tests, drafting commit messages, evaluating the *same* artifact independently for its own verdict.
- Claude does NOT issue another `codex-reply` against the same threadId while a previous one is in flight. The orchestrator owns single-writer access to the thread.
- When the subagent completes, Claude integrates Codex's verdict into the round.

**What this actually buys (be honest):**
- Within a round: Claude evaluates the artifact concurrently with Codex evaluating it. Real parallelism — different evaluators, no shared write.
- Across phases of the same slice: limited. Pre-drafting docs while review-slice runs is *opportunistic*; if review forces code changes, the pre-drafted docs are discarded. Useful only when review tends to ship in 1 round.
- Across slices: NOT supported in v0.3. Would require thread forking. Deferred to v0.4.

Implementation: thin wrapper subagent prompt `skills/autopilot/codex-via-subagent-prompt.md` standardizes the background call shape. The subagent receives `{threadId, prompt, role}` and returns `{content, verdict}`. The orchestrator must own a mutex on the threadId — only one subagent in flight per thread at any time.

## Slice phase definitions

### Phase A: plan-slice + test-list review
Send Codex two things in sequence (one round-loop, but two artifacts):
1. **The slice's task list.** Codex reviews for L11 — granularity, missing files, slice-scope ambiguity, TDD adequacy of the steps.
2. **The slice's test list** (extracted from the task list — every "Write failing test for X" step is a test entry). Codex reviews per the existing `test-driven-development` SKILL.md rubric: edge cases, mocks-vs-integration, redundancy, test boundary correctness.

Both must double-SHIP within the same 7-round budget for this phase. If either is REVISE, both get revised together and the round counts once.

This is mandatory for any slice with non-trivial tests. Skip only when: the slice has zero new tests (rare — usually a docs-only slice). If the slice has tests but they're trivial (one-test-one-function, obvious design), Codex is empowered to SHIP quickly without forcing iteration.

### Phase B: implement
Dispatch implementing subagent (the existing `subagent-driven-development` pattern). Subagent:
- Receives the slice's full task list AND the test-list (both already double-SHIP'd in Phase A).
- Receives the Commit Conventions § as part of its dispatch prompt and is required to follow them on every commit.
- Follows TDD strictly — red, green, commit per task with `feat(slice:N):` / `test(slice:N):` subject and `Co-Authored-By: Claude` trailer. The agreed test list is the contract.
- Reports DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.

Codex is NOT involved during implementation execution itself — that would block on every test write. Codex's say happened in Phase A (test list) and happens again in Phase C (review-slice on the actual diff).

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

On double-SHIP: commit docs as a separate commit using the Commit Conventions § (`docs(slice:N): <summary>` subject + `Co-Authored-By: Claude` trailer) so blame is clean and recovery can verify the commit.

## Commit conventions (required contract)

All commits made by the autopilot — directly or via subagents — MUST follow these conventions. Recovery, the hook, and downstream tooling depend on them.

**Trailer (every autopilot commit):**
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

**Subject prefix (one of):**
- `feat(slice:N): <description>` — new behavior or production code in slice N (Phase B).
- `test(slice:N): <description>` — test additions or changes in slice N (Phase B).
- `fix(slice:N): <description>` — bug fix during a slice's review iterations (Phase C).
- `docs(slice:N): <description>` — doc updates for slice N (Phase D).
- `refactor(slice:N): <description>` — refactoring during slice work, no behavior change.
- `chore(slice:N): <description>` — non-functional cleanup within a slice.

**Slice completion is NOT a commit.** It's a state change in the sidecar (`slice_reviews[slice:N].shipped = true`). No commit is made specifically to "mark the slice shipped."

Subagents executing Phase B receive these conventions in their dispatch prompt and must follow them. The hook (below) and the recovery logic (Sidecar additions §) verify the conventions.

## Docs-freshness enforcement

Primary enforcement is the **docs-update phase (Phase D)** itself, not the hook. The phase explicitly inspects the slice's diff and asks Codex: "Given this diff, what doc files need updates?" Codex's reply lists required updates; if Claude's draft doesn't cover them, the round REVISEs. Both must double-SHIP that the docs are complete before the slice is marked shipped (sidecar state change).

The hook is a **provenance check** — it verifies commits made during an active autopilot session conform to the commit conventions. PostToolUse on `Bash` matching `git commit`, runs `${CLAUDE_PLUGIN_ROOT}/hooks/check-commit-provenance.sh`:

- Reads the active spec path from a deterministic anchor file at `<repo-root>/.codex-paired/active.json`, which contains `{ "specPath": "<absolute path to spec.md>" }`. The autopilot writes this file when starting a run and removes it when halting/completing. The hook reads `specPath` from it, then loads the sidecar at `<specPath>.codex.json`. If the anchor file doesn't exist, the hook treats this as "no active autopilot run" and allows everything.
- If `autopilot.current_slice` is set (autopilot is running):
  - Parses the most recent commit's subject and trailer.
  - If subject doesn't match `(feat|test|fix|docs|refactor|chore)\(slice:<current_slice>\):` **OR** the `Co-Authored-By: Claude` trailer is missing → exit nonzero ("looks like an external commit during active autopilot session"). Both conventions must be present.
  - Otherwise allow.
- If `autopilot.current_slice` is null (no active autopilot run): allow everything (autopilot isn't running; hook stays out of the way).

**Slice id format:** `autopilot.current_slice` stores the bare numeric id (e.g., `"3"`), matching what appears in commit subjects (`feat(slice:3):`). The sidecar's `slice_reviews` keys are the readable form (`"slice-3"`); converters between forms live in `lib/codex-bridge/sidecar.js`.

The hook does NOT enforce docs freshness directly — that's Phase D's job. The hook prevents accidental external commits from contaminating the autopilot's commit range, which would make recovery confusing.

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
    "current_slice": "3",
    "current_phase": "review-slice",
    "phase_attempt": 1,
    "phase_started_at": "...",
    "slice_start_sha": "abc123",
    "phase_start_sha": "def456",
    "last_commit_sha": "ghi789",
    "inflight_subagent_id": null,
    "halt_reason": null
  }
}
```

The `autopilot` block is the resumption anchor for ralph-loop.

**State invariants (required before reading any recovery rule):**
- When a phase starts, the orchestrator writes `phase_start_sha = HEAD` AND `last_commit_sha = HEAD` to the sidecar atomically. This makes `last_commit_sha..HEAD` an empty range at phase start, and any later commit in the phase becomes the first commit in that range.
- After every **orchestrator-direct** commit, the orchestrator updates `last_commit_sha = HEAD` in the sidecar before any further work.
- After every **subagent return**, the orchestrator walks `last_commit_sha..HEAD`, verifies every commit conforms to Commit Conventions §, then updates `last_commit_sha = HEAD`. (Subagents commit per task without invoking the bridge themselves; the orchestrator reconciles in batch.)
- If the orchestrator crashes between a commit and the sidecar update, recovery handles it via the `last_commit_sha != HEAD` branch (which performs the same range walk).
- `current_slice` and `current_phase` are written together with `phase_start_sha` to keep the recovery view consistent.

**Subagent durability assumption:** background subagents are session-local. After a Claude-session crash, the subagent is gone; ralph cannot query it. Cross-session recovery uses git state + sidecar markers ONLY. The `inflight_subagent_id` field is meaningful WITHIN a Claude session as a single-writer guard against double-dispatch; it is treated as `null` after a session boundary.

**Within-session resume** (Claude is alive, autopilot is paused mid-phase):
1. If `inflight_subagent_id` is set, query that subagent's status before doing anything (it may have completed during the gap or it may have been killed). Integrate its result if present.
2. Continue the current phase from the round it was on.

**Cross-session resume** (ralph tick after a Claude crash):
1. Treat `inflight_subagent_id` as `null` (subagent is gone).
2. Compute `git rev-parse HEAD`. Determine whether HEAD descends from `phase_start_sha`:
   - `HEAD == phase_start_sha`: phase produced no commits yet. Safe to retry the phase from scratch.
   - `HEAD descends from phase_start_sha` AND `last_commit_sha == HEAD`: previous orchestrator action committed and updated the sidecar. State is consistent. Resume the *next* round of the current phase.
   - `HEAD descends from phase_start_sha` AND `last_commit_sha != HEAD`: one or more commits exist in the range `last_commit_sha..HEAD`. Verify **every** commit in that range conforms to the Commit Conventions §:
     - Each commit's subject must match `(feat|test|fix|docs|refactor|chore)\(slice:<current_slice>\):` AND have the `Co-Authored-By: Claude` trailer.
     - If all commits conform: orchestrator committed but crashed before updating the sidecar. Update `last_commit_sha = HEAD` and resume the *next* round of the current phase.
     - If any commit doesn't conform: halt with `halt_reason: "external-commit-detected"`, citing the offending SHA, and ping user.
   - `HEAD does NOT descend from phase_start_sha` (force-push, branch switch, history rewrite): halt with `halt_reason: "history-divergence"` and ping user.

**Rollback policy (v0.3):** the autopilot does NOT auto-rollback. If a phase needs to retry and dirty/uncommitted work exists, halt with `halt_reason: "dirty-tree-on-phase-retry"` and ping user. The user decides whether to `git stash`, `git reset`, or amend the autopilot's plan. Auto-rollback (e.g., `reset --hard phase_start_sha`) is destructive and explicitly out of scope until v0.4.

## Failure modes

| Condition | Autopilot behavior |
|---|---|
| Phase deadlock (round 7, no double-SHIP) | Halt; record `halt_reason: "phase-deadlock:<phase>:<slice>"`; ping user; ralph stops on next tick (completion-promise unmet) |
| Subagent BLOCKED | Halt; record `halt_reason: "subagent-blocked"` with the subagent's blocker text; ping user |
| Subagent NEEDS_CONTEXT | Halt; record `halt_reason: "subagent-needs-context"` with the missing-context request; ping user. On user response, retry phase from the same `phase_start_sha`. |
| Subagent DONE_WITH_CONCERNS | Continue to review-slice phase; concerns appended to sidecar's `slice_reviews[N].phases.implement.concerns` |
| Tests fail in implement phase | Subagent retries up to 2x; then escalates to BLOCKED |
| Provenance hook fails on commit | The commit looks external (wrong prefix or missing trailer). Halt with `halt_reason: "external-commit-detected"`, cite the offending SHA, ping user. Do NOT retry — retrying would not fix git history. |
| User sends a message mid-phase | Halt at next *atomic boundary* (between rounds within a phase, or between phases); set `halt_reason: "user-interrupt"`. KillShell any in-flight background subagent; mark `inflight_subagent_id: null`. Resume on next `/autopilot` or ralph tick. |
| Codex MCP unreachable | Retry once with backoff (10s); on second failure, halt with `halt_reason: "codex-unavailable"`; ping user. |
| Mid-phase crash (Claude session died) | On next ralph tick, the resume logic (see Sidecar additions §) reconciles `last_commit_sha`/`HEAD` and either retries the phase from `phase_start_sha` or surfaces a state mismatch to user. |

## Components to build

1. **`skills/autopilot/SKILL.md`** — orchestrator instructions Claude follows when invoked.
2. **`skills/autopilot/codex-via-subagent-prompt.md`** — template for non-blocking Codex calls via background subagents.
3. **`hooks/check-commit-provenance.sh`** — provenance hook script (verifies commits during active runs follow Commit Conventions). Renamed from earlier draft `check-slice-docs.sh` since the role evolved from docs-freshness to provenance during the spec review.
4. **`hooks/hooks.json`** — hook registration in plugin.
5. **`commands/autopilot.md`** — slash command `/autopilot <plan-path>` (optional convenience; ralph-loop can also drive it directly).
6. **Update `lib/codex-bridge/prompts/system-rubric.md`** — pre-SHIP checklist.
7. **Update `lib/codex-bridge/sidecar.js`** — support nested slice phases + autopilot block.
8. **Update `lib/codex-bridge/cli.js`** — add `sidecar-set-phase`, `sidecar-set-autopilot` subcommands.
9. **Tests** — sidecar phase nesting; hook script behavior with mocked git.
10. **README + CHANGELOG** — document autopilot + ralph integration.

## Out of scope (v0.4+)

- Parallel slice implementation (rare; most plans are sequential).
- Cross-slice Codex parallelism (would require thread forking — see "Non-blocking Codex" §).
- Auto-recovery from deadlocks via opus escalation.
- Auto-rollback on dirty tree at phase retry (v0.3 halts; user arbitrates).
- Sophisticated MCP retry policies (per-error-type backoff, circuit breakers). v0.3 does ONE retry with 10s backoff per the failure table; nothing more.
- Visual UI for autopilot state.

## Success criteria

- A 10-slice plan can run end-to-end unattended via `/ralph-loop /autopilot <plan-path>`.
- Each slice ships with all four phases double-SHIP'd OR ralph halts cleanly with the deadlock recorded.
- Docs are current at the slice-shipped boundary: every shipped slice has README + CHANGELOG + plan checkboxes + (where relevant) AGENTS.md/CLAUDE.md/auto-memory reflecting its diff. Within a slice's phases, docs may lag; at the boundary they don't.
- Codex's SHIP rate before pre-SHIP checklist vs. after measurably drops (anecdotal — we'll watch the smoke runs).
- After a Claude-session crash, ralph's next tick resumes safely from the sidecar without redoing committed work and without claiming uncommitted work as done.
- Total wall-clock time per slice (mock conditions: small slice, no real review issues) ≈ 1–3 min, dominated by Codex latency.

## Open contentions
*(none yet)*
