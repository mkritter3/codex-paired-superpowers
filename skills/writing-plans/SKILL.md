---
name: writing-plans
description: Use after a Codex-paired spec is double-SHIP'd. Claude drafts the implementation plan; Codex reviews via the same session in a 7-round revision loop. Plan ships on double-SHIP.
---

# Writing Plans (Codex-paired)

## What this changes vs. upstream
- Reuses the Codex session opened by `brainstorming` (via the spec's sidecar).
- After Claude drafts the plan, Codex reviews structure: slice boundaries, task granularity, missing tasks, TDD adequacy, file decomposition.
- 7-round loop applies. Both must SHIP.

## Honest-reporting activation (v0.8.1, do this first)
Before Phase 0, write the honest-reporting marker so the Stop/PreToolUse hook can keep claims sourced for this session:

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill writing-plans
```

The marker has an 8-hour TTL and auto-expires; no cleanup needed.

## Phase 0 — Locate the sidecar
The plan must be born from a double-SHIP'd spec. Read the spec's frontmatter or use the convention `<plan>` ↔ `<spec>` mapping (plans live under `docs/superpowers/plans/`, specs under `docs/superpowers/specs/`, same date prefix and name).

Verify the sidecar exists and the spec is double-SHIP'd:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-show --specPath "<spec-path>" | jq '.rounds[-1]'
```

Expected: most recent spec-phase round shows `claude: SHIP` and `codex: SHIP`. If not, halt — the spec needs to be shipped first.

## Phase 1 — Draft the plan (Claude alone)
Write the plan locally to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Follow the upstream `superpowers:writing-plans` discipline: file structure first, slices, then bite-sized tasks, exact file paths, no placeholders, complete code.

The plan MUST include in its frontmatter the spec path:

```markdown
**Spec:** `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`
```

This makes sidecar discovery deterministic for downstream slice-review.

### Per-slice validation tier (optional, v0.4+)
Each slice MAY declare a validation tier in its section header (default `standard`):

```markdown
## Slice 3: Auth token refresh
**Validation:** critical

[task list...]
```

Allowed values:
- **light** — for trivial slices (docs-only, single-line tweak). Tier-1 happy path required; other Tier-1 subcategories may be N/A with evidence.
- **standard** (default) — full Tier-1 prescriptive baseline + applicable Tier-2 triggers.
- **critical** — Tier 1+2 plus Tier 3 (paranoid-senior-engineer residual-risk question). Use for security-sensitive slices, breaking changes, or anything where a missed edge case has high blast radius.

Codex applies the validation rubric (`lib/codex-bridge/prompts/validation-rubric.md`) at the declared tier in Phase A and Phase C of autopilot. If autopilot is not used, this declaration is informational.

## Phase 2 — Codex plan review (counted, max 7 rounds)

Look up the existing threadId from the sidecar:

```bash
THREAD_ID=$(node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-thread-id --specPath "<spec-path>")
```

Round 1 prompt: build the plan-review prompt and invoke **`mcp__plugin_codex-paired-superpowers_codex__codex-reply`**:

```json
{
  "threadId": "<THREAD_ID>",
  "prompt": "Phase: plan-review\nRound: 1\nThe spec we shipped together is at <spec-path>. I have drafted the implementation plan at <plan-path>.\nReview the plan against this spec. Critique with L11 rigor. Specifically check:\n  1. Slice boundaries: does each slice produce something testable on its own?\n  2. Task granularity: are steps 2-5 minutes each?\n  3. Missing tasks: any spec requirement without a covering task?\n  4. TDD adequacy: is the red-green-refactor explicit?\n  5. File decomposition: any file growing too large?\n  6. Type/name consistency across tasks?\n\nEnd with the required verdict block.\n<<<PLAN>>>\n<full plan text>\n<<<END_PLAN>>>"
}
```

The response's `content` is Codex's review + verdict block.

Subsequent rounds: send the revised plan + both prior critiques. Same anti-yes-man rules as brainstorming. Same sidecar round logging (`phase: "plan"`).

After each round, append:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round \
  --specPath "<spec-path>" \
  --round '{"phase":"plan","round":N,"claude":"...","codex":"..."}'
```

## Phase 3 — User sign-off (uncounted)
After double-SHIP, show the user the plan path and quote the slice list. Get a "yes" before handing off to implementation.

## Phase 4 — Hand off
Offer execution choice (matches upstream):
1. **Subagent-driven** (recommended) → `superpowers:subagent-driven-development` (forked when available in this plugin)
2. **Inline** → `superpowers:executing-plans`

In either path, the per-slice review fires from `subagent-driven-development` (forked) using the same Codex session via the sidecar.

## Failure modes
- **Sidecar missing:** the spec wasn't run through Codex-paired brainstorming. Halt and tell the user.
- **Spec not double-SHIP'd:** halt. Run brainstorming first.
- **Round-7 deadlock on plan:** annotate the plan with both positions, surface to user, record arbitration in sidecar.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
