---
name: brainstorming
description: Use when starting any creative work — features, components, behavior changes. Pairs Claude with Codex (GPT-5.5 high) to draft and harden a spec through a 7-round revision loop. Product questions go to the user; technical questions go to Codex.
---

# Brainstorming with Codex (paired)

## What this changes vs. upstream
This skill forks `superpowers:brainstorming`. The user-facing question loop is replaced by a Codex-paired drafting loop. The user is consulted only for **product/UX/business** questions. **All technical questions** (libraries, schema, edge cases, idiomaticity) are routed to Codex, who also drafts the spec. Claude and Codex then revise the spec for up to 7 rounds; both must emit `SHIP` to advance.

## Hard gate
Do NOT invoke any implementation skill, write production code, or scaffold a project until the spec is double-SHIP'd and the user has approved it. Trivially small projects still go through this flow; the rounds may resolve in 1.

## Phase 0 — User intent (uncounted)
Ask the **user** a small number of multiple-choice questions to establish: what to build, who it's for, what "done" looks like, scope boundaries. Each question is one message. Never ask the user a technical question.

## Phase 1 — Codebase exploration (uncounted)
Read relevant files. Build a short context note: existing patterns, conventions, file organization, prior art. This becomes context for Codex.

## Phase 2 — Open Codex session (uncounted)
Pick a spec path: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (or user override).

Compose the initial Codex prompt:
- Prepend `lib/codex-bridge/prompts/system-rubric.md`.
- Prepend `lib/codex-bridge/prompts/verdict-format.md`.
- Append: "Phase: spec-draft. Here is the user intent (verbatim) and the codebase context. Draft a complete L11-grade spec. End with the required verdict block."

Run:

```bash
mkdir -p $(dirname "<spec-path>") && touch "<spec-path>"
echo "<prompt>" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-start \
  --specPath "<spec-path>" --feature "<feature-name>"
```

This writes the sidecar at `<spec-path>.codex.json` and returns Codex's first draft (with verdict).

## Phase 3 — Revision loop (counted, max 7 rounds)

### Round semantics (read this once, then never confuse it again)
**One round = one Codex artifact + one Claude verdict on it.**

- Phase 2's initial draft IS round 1's Codex turn. `session-start` produced Codex's draft + Codex's verdict. Round 1 is therefore not a fresh Codex call — round 1's Codex side is already in hand.
- Round N (N ≥ 2) means: send Claude's critique back via `session-resume` → Codex returns a revised draft + new verdict → Claude verdicts on the revision. Both verdicts logged together as round N.
- The loop exits when **both** verdicts within the same round are `SHIP`.

### Per-round procedure

For each round N starting at 1:

1. **Form Claude's verdict** on the current Codex draft. Apply the L11 rubric independently. Verify any specific claim against actual code/files before accepting.

2. **Append the round to the sidecar** with both verdicts:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round \
     --specPath "<spec-path>" \
     --round '{"phase":"spec","round":N,"claude":"SHIP|REVISE: ...","codex":"SHIP|REVISE: ..."}'
   ```

3. **If both shipped, exit.** Move to Phase 4.

4. **Otherwise, send round N+1 to Codex.** Build the prompt: phase header, round number, the current draft (or a reference to it), `## Critique from previous round` listing Claude's REVISE items and Codex's REVISE items (whichever were non-SHIP), and instruction to revise.

   ```bash
   echo "<round-(N+1)-prompt>" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-resume \
     --specPath "<spec-path>"
   ```

   This returns Codex's new draft + new verdict. Goto step 1 with N := N+1.

(See `codex-pairing.md` in this skill folder for full bridge protocol.)

### Worked example (2-round flow)
Codex's initial draft from Phase 2 SHIP'd. Claude evaluates and finds two real gaps (language + test runner unspecified).

```
sidecar.rounds = [
  {"phase": "spec", "round": 1, "claude": "REVISE: language unspecified; test runner unspecified", "codex": "SHIP"}
]
```

Round 1 does not exit (Claude REVISE, Codex SHIP — not double-SHIP). Claude sends critique via `session-resume`. Codex returns a revision pinning POSIX sh + bash smoke test, with a new SHIP verdict. Claude evaluates the revision and genuinely SHIPs.

```
sidecar.rounds = [
  {"phase": "spec", "round": 1, "claude": "REVISE: language unspecified; test runner unspecified", "codex": "SHIP"},
  {"phase": "spec", "round": 2, "claude": "SHIP", "codex": "SHIP"}
]
```

Round 2 is double-SHIP. Loop exits. `result.rounds === 2`.

Loop exits when **both** Claude and Codex emit SHIP in the same round, OR after round 7.

### Anti-yes-man rules
- Never accept Codex's revision without independent verification.
- If you disagree, say so explicitly with file/line references.
- Performative agreement is failure. Performative disagreement is also failure.
- See `superpowers:receiving-code-review` (forked version in this plugin once shipped).

### Open contentions
If a critique survives 2 rounds (both sides keep restating opposing views without converging), record it under `## Open Contentions` in the spec AND in the sidecar via `sidecar-add-contention`. Bring it to the user.

## Phase 4 — User sign-off (uncounted)
Show the user the final spec path. Quote the goal + open contentions if any. Wait for explicit "yes" or revisions. If the user requests changes, re-enter the loop at round 1 with the user's input as additional critique.

## Phase 5 — Hand off
Invoke `superpowers:writing-plans` (or this plugin's forked version once shipped). Pass the spec path. The plan-writing skill resumes the same Codex session via the sidecar.

## Failure modes
- **Codex unreachable:** retry once, then surface to user with option to abort or skip the round.
- **Round-7 deadlock:** annotate spec with both positions; user arbitrates; arbitration recorded in sidecar.
- **User overrides Codex:** allowed; recorded under `open_contentions`.
- **Sidecar corruption:** treat as data loss; restart with new session, surface to user.
