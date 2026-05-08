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
Each round:
1. Read the current Codex draft + verdict.
2. Apply the L11 rubric independently. Form your own verdict (SHIP or REVISE).
3. Write your verdict to a control file the bridge can read:

   ```bash
   cat > "<spec-path>.codex-claude-turn.json" <<EOF
   {"status": "REVISE", "critique": ["..."], "rationale": "..."}
   EOF
   ```

4. Send the next round to Codex with both critiques:

   ```bash
   echo "<round-N-prompt>" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-resume \
     --specPath "<spec-path>"
   ```

   Round-N prompt: phase header, round number, the artifact (current draft), `## Critique from previous round` containing both Claude's and Codex's prior critique items, and instruction to revise.

5. Append the round to the sidecar:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round \
     --specPath "<spec-path>" \
     --round '{"phase":"spec","round":N,"claude":"...","codex":"..."}'
   ```

   (See `codex-pairing.md` in this skill folder for full bridge protocol.)

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
