# Codex-Paired Superpowers — Design

**Status:** draft for review
**Date:** 2026-05-07
**Owner:** mkr

## Goal

Fork six superpowers skills into a standalone plugin that pairs Claude with Codex (GPT-5.5 via `codex exec`) as a co-equal L11-grade engineering partner. Codex drafts, critiques, and signs off; Claude translates user intent, pushes back when warranted, and never rubber-stamps. A persistent Codex thread carries context across every phase of a feature — brainstorm, plan, slice reviews — so Codex never restarts cold.

## Operating Rules

These rules apply to every plug-in point.

### Question routing
- **User questions** (asked of mkr): what to build, user experience, business intent, priorities, definition of "done", visible behavior trade-offs.
- **Codex questions** (asked of Codex): technical shape, library/API choices, data flow, test strategy, edge cases, optimization, idiomaticity, whether a design is sound.
- Claude must **never** punt a technical question to the user, and **never** punt a product question to Codex. If a question is ambiguous, Claude classifies it first.

### The 7-round revision loop
Counted rounds begin **only after Codex has produced a draft artifact** (spec, plan, slice review, debug hypothesis, test design). Pre-draft phases — collecting user intent, codebase exploration, Claude asking Codex technical questions, Codex drafting — are uncounted.

Each round:
1. Claude reads Codex's current draft, evaluates it against L11 standards (simple, optimal, DRY, no over-engineering, no scope creep).
2. Claude returns a structured response: `SHIP` or `REVISE: <numbered critique>`.
3. Codex responds: `SHIP` or `REVISE: <numbered counter or revision>`.
4. Loop exits when **both** emit `SHIP` in the same round.

Hard cap: **7 rounds**. If no double-`SHIP` by round 7, surface both final positions to the user with the disagreement and let the user arbitrate.

### Claude is not a rubber stamp
- Claude evaluates each Codex revision independently. Integrate when Codex is right, push back when wrong, name the disagreement when neither side has yet convinced the other.
- Codex's verdicts must include technical justification — not vibes.
- Disagreements that survive 2 rounds get logged in the artifact under `## Open Contentions` and bubble to the user.

### L11-grade standard
The shared rubric both sides advocate for:
- Simple over clever; small over big.
- DRY but not premature abstraction.
- Optimal in the local sense; no over-engineering for hypothetical futures.
- Honest about scope — what's in this slice vs. what's deferred.
- Tests at the boundary that would have caught the bug.

## Architecture

### Plugin shape
- New plugin: `codex-paired-superpowers` at `/Users/mkr/local-coding/plugins/codex-paired-superpowers/`.
- Standalone git repo. Built in place; `/Users/mkr/local-coding/plugins/` is registered as a personal local Claude Code marketplace so the plugin can be installed via `/plugin` without publishing. Plan will include exact registration + install commands.
- Six forked skills mirror the upstream superpowers skill names but live in this plugin. Users opt in by installing this plugin alongside (or instead of) `superpowers` for those six.
- Shared infrastructure: `lib/codex-bridge/` — pure shell + small node helpers — handles `codex exec` invocation, session UUID persistence, structured-verdict parsing, round counting.

### One Codex thread per feature
A single Codex session (UUID) is bound to a feature and persists across:
- Spec brainstorm
- Plan writing
- Each slice review during implementation
- Post-implementation debug or TDD work on the same feature

When Codex reviews slice 3, it remembers debating the spec, approving the plan, and reviewing slices 1–2. This is non-negotiable; cold-start reviews are explicitly the anti-goal.

### Sidecar persistence
Each spec gets a sidecar at `<spec-path>.codex.json`:

```json
{
  "version": 1,
  "feature": "codex-paired-superpowers",
  "codex_session": "019e0507-b485-7312-b71e-9fe96a7d2224",
  "model": "gpt-5.5",
  "reasoning_effort": "high",
  "created_at": "2026-05-07T...",
  "rounds": [
    { "phase": "spec", "round": 1, "claude": "REVISE: ...", "codex": "REVISE: ..." },
    { "phase": "spec", "round": 2, "claude": "SHIP", "codex": "SHIP" }
  ],
  "open_contentions": [],
  "slice_reviews": {
    "slice-1": { "rounds": [...], "shipped": true }
  }
}
```

The sidecar is the source of truth for session continuity. If lost, Codex can reconstruct from spec/plan content but loses prior-round nuance — treat as data loss.

**Sidecar discovery:** the spec path is the anchor. Plans, slice reviews, debug sessions, and TDD reviews for the same feature locate the sidecar by walking up from the plan/code path to find the matching spec, then reading `<spec-path>.codex.json`. The plan document's frontmatter records its parent spec path explicitly to make this lookup deterministic.

### Transport: direct `codex exec`
Verified on `codex-cli 0.128.0`, model `gpt-5.5`. Use:
- Initial: `codex exec --skip-git-repo-check -m gpt-5.5 -c model_reasoning_effort=high "<prompt>"` — capture session UUID from stdout.
- Resume: `codex exec resume <uuid> -m gpt-5.5 -c model_reasoning_effort=high "<prompt>"`.
- Output parsed for the structured verdict block (delimited markers).

**Model defaults:** GPT-5.5 with `model_reasoning_effort=high`. These are the defaults baked into the bridge. Overridable per-invocation via env var (`CODEX_PAIRED_MODEL`, `CODEX_PAIRED_REASONING`) for experimentation, but not surfaced as a per-skill option — the whole point is consistent L11 reasoning across the loop.

Sidecar records the model + reasoning effort that started the session; resumes use the same values for consistency.

Rejected: `mcp__zen__clink`. It works but adds a dependency on a third-party MCP whose model selection and update cadence we don't control. Direct CLI gives us model pinning and a stable session UUID we own.

### Verdict protocol
Both sides emit a fenced verdict block:

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one sentence>
<<<END>>>
```

Outside the block, free-form discussion is allowed. The bridge parser extracts only the block. Malformed verdict = automatic REVISE with a synthetic critique "verdict block missing or malformed; please re-emit."

## Plug-In Points (v1)

### 1. `brainstorming` (forked)
Replaces the upstream brainstorming flow. Order of operations:
1. Claude collects high-level intent from the **user**: what, why, who, success criteria. Multiple-choice preferred where possible.
2. Claude explores the codebase silently (Read, Grep).
3. Claude opens a Codex session, sends: user intent + codebase findings + the L11 rubric. Asks Codex to draft a spec.
4. Codex returns draft → 7-round loop.
5. On double-SHIP (or round-7 escalation), present spec to user for sign-off.
6. Hand off to `writing-plans`.

Codex receives all technical clarifying questions Claude would otherwise ask the user — library choices, schema, error semantics, edge cases.

### 2. `writing-plans` (forked)
After spec sign-off, Claude drafts the implementation plan, then sends to Codex for review. 7-round loop on plan structure: slice boundaries, task granularity, missing tasks, TDD adequacy, file decomposition. Same Codex session continues.

### 3. `subagent-driven-development` (forked) — per-slice review
After each slice's subagent reports completion, Claude:
1. Captures: slice scope (the specific tasks listed for this slice in the plan), the diff for that slice, test results.
2. Sends to Codex with explicit framing: **"Review only what is in this slice's scope. Out-of-slice issues = note for later in `## Deferred`, do not block on them."**
3. 7-round loop on the slice review. Common in practice: 1–2 rounds.
4. Slice ships only on double-SHIP.
5. Open contentions surface to user before next slice begins.

### 4. `receiving-code-review` (forked)
Governs how Claude evaluates Codex's verdicts (and human review feedback). Explicit anti-yes-man discipline:
- Read the critique slowly.
- Verify the claim against actual code state before accepting.
- If you disagree, articulate why with reference to specific file/line.
- Performative agreement is failure. Performative disagreement is also failure. Technical rigor only.

### 5. `systematic-debugging` (forked)
On hard bugs, Claude forms a hypothesis → sends to Codex with reproduction steps and code references → Codex critiques the hypothesis (Is it the simplest explanation? What did you miss? What experiment would falsify it?) → 7-round loop on the hypothesis until both agree on root cause. Then Claude implements the fix and Codex reviews it under the per-slice review rules.

### 6. `test-driven-development` (forked)
Before writing tests for a slice, Claude drafts the test list and sends to Codex. Codex critiques: missing edge cases, redundant tests, wrong boundary, mock/integration trade-off. 7-round loop on test design. Then standard TDD red-green-refactor proceeds, with Codex reviewing the final test suite at slice-review time.

## Out of Scope (v2)
- `verification-before-completion` Codex hook — defer until v1 patterns prove out.
- MCP-server packaging (currently CLI-only invocation).
- Multi-Codex / consensus voting.
- Cross-feature memory (Codex session is feature-scoped on purpose).
- UI for inspecting round history; for v1, the sidecar JSON is the UI.

## Failure Modes & Escape Hatches
- **Codex unreachable / errors:** retry once with backoff; on second failure, surface to user with the option to skip that round or abort the loop. Never silently drop the Codex check.
- **Round-7 deadlock:** spec is annotated with both positions; user arbitrates. The arbitration is recorded in the sidecar.
- **User overrides Codex:** allowed at any time; recorded in `open_contentions` with rationale.
- **Sidecar corruption:** treat as data loss; new session, no prior context. Surface to user.
- **Subagent skips a slice review:** plan execution halts until the slice is reviewed.

## Success Criteria
- A typical feature ships with: spec double-SHIP'd, plan double-SHIP'd, every slice double-SHIP'd, sidecar JSON intact, < 4 rounds average per artifact.
- User reports that Codex caught real issues Claude missed (and vice versa) at least once per feature.
- No instance of Claude rubber-stamping a Codex verdict it should have pushed back on (judged by post-hoc review of round history).
- Plugin survives at least one upstream superpowers update without breakage.

## Open Contentions
*(none yet — populated as the design evolves)*
