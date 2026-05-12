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

## high_stakes frontmatter (v0.9.0)

Each plan slice MAY declare `**high_stakes: true**` in its frontmatter. This is a **user-controlled signal** (per spec § 4): it opts that slice's `expert-security` + `expert-architecture` reviews into **panel mode** (cross-model consensus) instead of single-model dispatch.

```markdown
## Slice 3: Auth token refresh
**high_stakes: true**
**Validation:** critical

[task list...]
```

`high_stakes` defaults to `false`. There is no silent escalation via keyword detection — the user opts in explicitly per slice. The plan-writing skill SHOULD recommend `high_stakes: true` for slices that touch authentication, credentials, payment flows, multi-tenant isolation, or any surface where single-model bias is unacceptable. Recommendation is non-binding; the user decides.

Panel mode is N× cost vs single (3× for default `panel_max_size=3`). Reserve it for foundational decisions.

## TDD test-list review (mandatory) (v0.9.0)

After Phase 2 plan-review converges to double-SHIP and BEFORE Phase 3 user sign-off, the orchestrator MUST run an **`expert-test` panel review** of every slice's test list. This makes TDD non-skippable in `writing-plans` — the "skip TDD for trivial slices" escape hatch is removed (per spec § 3).

### Step 1 — Extract per-slice test lists

For each slice in the plan, locate its `## Tests required` block (or equivalent test-list section). Each entry should specify:
1. What invariant/behavior the test pins.
2. Inputs / preconditions.
3. Expected outcome.
4. Mocks-vs-integration choice + justification.

If any slice is missing a test list, halt — `writing-plans` cannot ship a plan without per-slice test coverage in v0.9.0.

### Step 2 — Build the `expert-test` panel dispatch

`expert-test` is **always panel mode** in `writing-plans` (per spec § 4 table). Preference ladder is `[codex, claude]`. Build the `dispatchFns: Map<member_id, fn>` by probing CLI availability and resolving the ladder:

```js
const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');
const { runTurnWithDeps } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/expert-turn.js');
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

// expert-test preference ladder: [codex, claude]
const dispatchFns = new Map();
for (const adapter of ['codex', 'claude']) {
  if (!availableCLIs.has(adapter)) continue;
  dispatchFns.set(`expert-test@${adapter}`, {
    fn: async (req) => {
      // adapter-specific: codex via cli-harness; claude via Task
      const responseText = await /* adapter-specific dispatch */;
      return runTurnWithDeps(req, { agentDispatch: async () => responseText });
    },
    runtime_kind: adapter === 'claude' ? 'claude-task' : 'cli-harness',
  });
}
```

### Step 3 — Dispatch the panel

```js
const panelOutcome = await dispatchPanel(
  'expert-test',
  {
    identity:    expertTestIdentity,
    repoRoot,
    specPath,
    specSnippet: planText,
    phase:       'tdd-review',
    sliceId:     null,           // panel covers ALL slices' test lists in one pass
    task:        'Review the per-slice test lists. Surface missing edge cases, ' +
                 'redundant tests, wrong boundaries, mock-vs-integration mistakes. ' +
                 'Emit verdict.',
  },
  dispatchFns,
  { panel_min_size: 2, panel_max_size: 3 },
);
// panelOutcome.outcome ∈ {'panel-SHIP', 'panel-REVISE',
//                         'panel-disagreement', 'panel-quorum-lost'}
```

The dispatcher applies `mode: 'panel'` semantics internally: snapshot members, fan out N parallel dispatches via the `dispatchFns` map, suppress peer DMs, aggregate verdicts deterministically.

### Step 4 — Apply the panel outcome

| Panel outcome              | Action                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `panel-SHIP`               | Proceed to Phase 3 user sign-off.                                                |
| `panel-REVISE`             | Surface findings; require plan revision; **re-enter Phase 2** at next round.    |
| `panel-disagreement`       | Halt; surface both positions; user arbitrates.                                  |
| `panel-quorum-lost`        | Halt with `panel-quorum-lost`; doctor + retry, or surface to user.              |
| `panel-quorum-unavailable` | Halt at Step 2 (before dispatch) — too few CLIs available for the panel floor. |

### Step 5 — high_stakes-slice escalation

For each slice with `high_stakes: true`, ALSO run **panel-mode `expert-security` + `expert-architecture` reviews** of that slice (per spec § 4 table). Build a separate `dispatchFns` per role; the same `dispatchPanel(role, request, dispatchFns)` contract applies. Both panel outcomes must be `panel-SHIP` (or technically-overridden) before the high-stakes slice ships.

If `expert-security` or `expert-architecture` returns `panel-REVISE` on a high-stakes slice, revise the plan and re-enter Phase 2.

### Step 6 — Composer-augmented advisories

For non-`expert-test`/non-high-stakes review, the orchestrator MAY invoke `composeExperts` (single mode) to dispatch advisory experts (e.g., `expert-ui` for UI-touching slices). These run via `runTurnWithDeps` (single dispatch) and feed findings into the Round-(N+1) prompt. They are advisory only — `panel-SHIP` from `expert-test` is the load-bearing gate.

## Phase 3 — User sign-off (uncounted)
After double-SHIP and after the TDD panel SHIPs, show the user the plan path and quote the slice list. Get a "yes" before handing off to implementation.

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
