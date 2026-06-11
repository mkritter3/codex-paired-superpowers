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
The plan must be born from a double-SHIP'd spec. Read the spec's frontmatter or use the convention `<plan>` ↔ `<spec>` mapping (plans live under `docs/plans/`, specs under `docs/specs/`, same date prefix and name).

Verify the sidecar exists and the spec is double-SHIP'd:

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-show --specPath "<spec-path>" | jq '.rounds[-1]'
```

Expected: most recent spec-phase round shows `claude: SHIP` and `codex: SHIP`. If not, halt — the spec needs to be shipped first.

## Phase 1 — Draft the plan (Claude alone)
Write the plan locally to `docs/plans/YYYY-MM-DD-<feature>.md`. Follow the upstream `superpowers:writing-plans` discipline: file structure first, slices, then bite-sized tasks, exact file paths, no placeholders, complete code.

The plan MUST include in its frontmatter the spec path:

```markdown
**Spec:** `docs/specs/YYYY-MM-DD-<feature>-design.md`
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

### Per-slice reviewer directive (optional)
A slice MAY name an explicit reviewer set in its header. The canonical directive is **Reviewers:** — a comma-separated list of reviewer roles that the composer merges into (never replaces) its signal-inferred selection:

```markdown
## Slice 3: Auth token refresh
**Reviewers:** security, architecture
**Validation:** critical

[task list...]
```

The downstream driver reads this as `sliceFrontmatter.reviewers` and passes it to the composer as `reviewersDirective`.

The older **Experts:** directive is **deprecated** but still accepted on read for one migration window: legacy plans that declare `**Experts:**` continue to work (the driver falls back to `sliceFrontmatter.experts`). When emitting a new plan, always write `**Reviewers:**`, never `**Experts:**`. If a slice declares both, **Reviewers:** wins and the composer surfaces a deprecation warning.

### Per-slice split directive (optional)
A slice MAY declare how its work item is written via the canonical **Split:** directive. The downstream `execution` skill normalizes it before dispatch:

```markdown
## Slice 3: Auth token refresh
**Split:** two-disjoint
**Validation:** critical

[task list...]
```

Allowed values:
- **single** (default) — one implementer writes the slice. Omit `**Split:**` for this.
- **two-disjoint** — two implementers write in parallel on disjoint files, then merge. Declare the two implementers' files in the slice; exactly two are allowed under the canonical directive.
- **hybrid-ui-backend** — Claude builds the UI half while Codex builds the backend half, joined by a published contract (see the hybrid orchestration section below).

The legacy forms `**Implementers:**` (→ two-disjoint) and `**Orchestration:** hybrid` (→ hybrid-ui-backend) are still accepted on read, but new plans should prefer `**Split:**`. See [docs/execution-model.md](../../docs/execution-model.md) for how driver and split combine.

## Phase 2 — Codex plan review (counted, max 7 rounds)

Look up the existing threadId from the sidecar:

```bash
THREAD_ID=$(node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-thread-id --specPath "<spec-path>")
```

### Goals extraction (do this once, before Round 1)

Open the spec and extract the **goals**, not the implementation. A goal is a sentence of the form *"After this ships, the user can do X"* or *"The system will guarantee invariant Y."* It is NOT a file path, a task list item, or a slice header. Concretely:

- Pull from the spec's `## Goal` / `## Goals` / `## Success criteria` sections.
- If the spec lacks an explicit goals section, derive 3-6 bullets from the user-intent block and the acceptance criteria. Each bullet is one observable outcome from the user's perspective.
- Cross-check against archived user asks: `mcp__plugin_episodic-memory_episodic-memory__search` with the feature name. If the user has historically asked for a capability adjacent to this work, that's a goal candidate — include it or explicitly defer it under the goals block with rationale.
- Store the extracted goals in the sidecar so they persist across rounds. The block is read on every round to keep prompt composition byte-deterministic:

  ```bash
  printf '<<<GOALS>>>\n- Goal 1...\n- Goal 2...\n<<<END_GOALS>>>' | \
    node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-goals --specPath "<spec-path>"
  ```

  Read it back any time:

  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-get-goals --specPath "<spec-path>" | jq -r .block
  ```

  Goals are normally pinned during brainstorming (Phase 2). If the spec arrived without a persisted goals block (legacy specs from before v0.10.1, or specs imported from elsewhere), extract and persist them here before invoking Round 1. Goals can be revised between rounds by the user — `sidecar-set-goals` overwrites the prior value.

The goals block is what Codex critiques against — NOT the plan as written. This is how both sides aim at the right result instead of optimizing the wrong target.

### Round 1 prompt

Build the plan-review prompt and invoke **`mcp__plugin_codex-paired-superpowers_codex__codex-reply`**:

```json
{
  "threadId": "<THREAD_ID>",
  "prompt": "Phase: plan-review\nRound: 1\n\n<<<GOALS>>>\n<extracted goals — one bullet per observable user outcome; NO implementation references>\n<<<END_GOALS>>>\n\nThe spec we shipped together is at <spec-path>. I have drafted the implementation plan at <plan-path>.\n\nYour job in this round has two parts:\n\nPART A — Independent codebase audit. Use your file-system tools. Do NOT take the plan's claims at face value. Specifically:\n  1. For every file path the plan cites as NEW, verify it does not already exist: `find <repo-root> -path '<cited-path>'`.\n  2. For every primitive the plan proposes to build (new module, new schema, new dispatcher, new audit format), grep the repo for prior art: `grep -rn '<capability-keyword>' lib/ src/ skills/` and `git log --all --oneline --grep='<keyword>'`. If the primitive exists, the plan MUST reuse or explicitly justify replacement. Reinvention without rationale is a SHIP-blocking critique.\n  3. If the goals reference a user-historical capability, search for prior implementations in git history. The codex-paired-superpowers repo has multiple prior features (v0.7.3 dependency-graph, v0.7.3 mailbox peer writes, v0.8.0 expert composer, v0.9.0 panel mode) — check whether the new plan reaches for them.\n  4. Record each audit command + result in your response under `## Audit log`.\n\nPART B — Plan critique against goals. With the audit in hand, critique the plan with L11 rigor. Specifically check:\n  1. Goal coverage: every goal in <<<GOALS>>> has at least one slice that delivers it. Goals without slices → REVISE.\n  2. Reuse vs rebuild: every new primitive either reuses an audited existing primitive or has a written rationale for why a new one is needed.\n  3. Slice boundaries: does each slice produce something testable on its own?\n  4. Task granularity: are steps 2-5 minutes each?\n  5. Missing tasks: any spec requirement without a covering task?\n  6. TDD adequacy: is the red-green-refactor explicit per slice?\n  7. File decomposition: any file growing too large?\n  8. Type/name consistency across tasks?\n\nEnd with the required verdict block. In your rationale, include a one-line audit summary AND a one-line goal-coverage summary.\n\n<<<PLAN>>>\n<full plan text>\n<<<END_PLAN>>>"
}
```

The response's `content` is Codex's audit log + review + verdict block.

### Preparing the audit payload (recorded atomically with the round)

Extract Codex's `## Audit log` section and build a structured audit object per side claiming SHIP. Do
NOT persist it separately on the happy path — you pass it to the atomic `sidecar-append-round-with-audits`
command below. Each audit object has this shape:

```json
{"phase": "plan", "round": 1, "side": "codex|claude",
 "commands": [{"cmd": "<command reported / verified>", "summary": "<one-line result>", "kind": "inspection"}],
 "verdict_basis": "<one-line: how the audit informed the verdict>"}
```

Every command requires a `kind` (`inspection` | `verification` | `other`). Plan review is a design
phase, so inspection evidence suffices; code-bearing phases (`implement:<slice>`,
`review-slice:<slice>`, …) additionally need an executed `"kind": "verification"` command with
`"exit_code": 0` before a SHIP can be logged.

If Codex's response has no `## Audit log` section, **do not log a SHIP verdict** — push back via a round-(N+1) prompt asking Codex to perform the audit. Goal-aligned critique without codebase verification is exactly the failure mode this gate exists to prevent.

Claude's own verdict ALSO needs an audit entry (`side: "claude"`) — Claude must verify the same claims independently against the repo. The gate enforces this symmetrically: a Claude SHIP verdict without a matching audit entry is also blocked.

**Consistency sweep before every re-submission (v0.15.0).** Sidecar replay shows late plan
rounds are dominated by staleness churn — a stale count here, an un-updated cross-reference
there, each costing a full revise + re-audit round (three of the four observed 7-round cap hits
were plans whose tail rounds fixed one stale item each). After applying a round's edits and
BEFORE sending the revision back, sweep the whole plan for what the edits invalidated:
- numbers and counts (test counts, slice counts, file counts) mentioned anywhere else;
- cross-references to renamed/renumbered slices, sections, or files;
- wording that describes the pre-edit design ("as above", "the single X" after adding a second);
- the slice list / summary table at the top vs. the slice bodies.
Fix everything the sweep finds in the SAME revision. One extra read of your own plan is cheaper
than a review round.

Subsequent rounds: send the revised plan + both prior critiques + the same `<<<GOALS>>>` block (goals are invariant across rounds unless the user explicitly revises them). Codex re-runs PART A only when the plan changes file paths or proposes new primitives; otherwise PART A is "no change since round N, audit still valid" — and you still record an audit entry referencing the prior round's audit (the (phase, round, side) triple must be present for the Stop-gate to clear). Same anti-yes-man rules as brainstorming. Same sidecar round logging (`phase: "plan"`).

After each round, record the audits **and** the round in ONE atomic command (v0.13.0). This replaces
the old two-step `sidecar-append-audit` ×N then `sidecar-append-round`, which could mis-order at
runtime and trip the audit gate as a hook error. The atomic command validates every audit and the
round's SHIP-backing under one lock and writes them together (or nothing):

```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round-with-audits \
  --specPath "<spec-path>" \
  --payload '{
    "audits": [
      {"phase":"plan","round":N,"side":"claude","commands":[{"cmd":"rg ...","summary":"...","kind":"inspection"}],"verdict_basis":"..."},
      {"phase":"plan","round":N,"side":"codex","commands":[{"cmd":"rg ...","summary":"...","kind":"inspection"}],"verdict_basis":"..."}
    ],
    "round": {"phase":"plan","round":N,"claude":"...","codex":"..."}
  }'
```

For REVISE rounds the `audits` array may be empty. `sidecar-append-audit` and `sidecar-append-round`
remain available for manual recovery. Plan review is a design phase, so inspection evidence suffices.

### If the Codex thread is lost mid-review

If a `codex-reply` returns `isError: true` with `Session not found for thread_id:` (the MCP server
was restarted — threads are process-local), recover instead of halting:

1. Build replay context: `node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-replay-context --specPath "<spec-path>"` (includes the goals block, prior rounds, contentions, rotations).
2. Open a NEW thread with the initial `codex` tool, seeding it with that replay + the pending prompt.
3. Persist the rotation: `node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-rotate-thread-id --specPath "<spec-path>" --oldThreadId <old> --newThreadId <new> --reason session-not-found --phase plan --round N`.
4. Tell the user in one line: "Codex thread was lost; opened a new thread and replayed the sidecar context." Then continue the round. Do not discard prior review history.

## high_stakes frontmatter (v0.9.0)

Each plan slice MAY declare `**high_stakes: true**` in its frontmatter. This is a **user-controlled signal** (per spec § 4): it opts that slice's `reviewer-security` + `reviewer-architecture` reviews into **panel mode** (cross-model consensus) instead of single-model dispatch.

```markdown
## Slice 3: Auth token refresh
**high_stakes: true**
**Validation:** critical

[task list...]
```

`high_stakes` defaults to `false`. There is no silent escalation via keyword detection — the user opts in explicitly per slice. The plan-writing skill SHOULD recommend `high_stakes: true` for slices that touch authentication, credentials, payment flows, multi-tenant isolation, or any surface where single-model bias is unacceptable. Recommendation is non-binding; the user decides.

Panel mode is N× cost vs single (3× for default `panel_max_size=3`). Reserve it for foundational decisions.

## TDD test-list review (mandatory) (v0.9.0)

After Phase 2 plan-review converges to double-SHIP and BEFORE Phase 3 user sign-off, the orchestrator MUST run an **`reviewer-test` panel review** of every slice's test list. This makes TDD non-skippable in `writing-plans` — the "skip TDD for trivial slices" escape hatch is removed (per spec § 3).

### Step 1 — Extract per-slice test lists

For each slice in the plan, locate its `## Tests required` block (or equivalent test-list section). Each entry should specify:
1. What invariant/behavior the test pins.
2. Inputs / preconditions.
3. Expected outcome.
4. Mocks-vs-integration choice + justification.

If any slice is missing a test list, halt — `writing-plans` cannot ship a plan without per-slice test coverage in v0.9.0.

### Step 2 — Build the `reviewer-test` panel dispatch

`reviewer-test` is **always panel mode** in `writing-plans` (per spec § 4 table). Preference ladder is `[codex, claude]`. Build the `dispatchFns: Map<member_id, fn>` by probing CLI availability and resolving the ladder:

```js
const { detectAvailableCLIs, availableCLISet } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/availability/detector.js');
const { resolveAdapter } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/role-routing/resolver.js');
const { runTurnWithDeps } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/reviewer-turn.js');
const { dispatchPanel } =
  await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/panel/dispatcher.js');

const detectorResult = await detectAvailableCLIs(repoRoot);
const availableCLIs  = availableCLISet(detectorResult);

// reviewer-test preference ladder: [codex, claude]. The map key is the
// member_id composite "role@cli"; the value carries the dispatch_fn AND
// the runtime_kind metadata the panel dispatcher reads.
const dispatchFns = new Map();
for (const cli of ['codex', 'claude']) {
  if (!availableCLIs.has(cli)) continue;
  // The sidecar 'adapter' audit field must match the actual transport. The
  // wrapper injects it into the request BEFORE calling runTurnWithDeps —
  // otherwise slice 5b defaults to 'claude-task' and codex panelists would
  // be audited as claude (the round-2 critique fix).
  const adapter = cli === 'claude' ? 'claude-task' : `cli-harness:${cli}`;
  dispatchFns.set(`reviewer-test@${cli}`, {
    fn: async (req) => {
      let responseText;
      if (cli === 'claude') {
        responseText = await /* dispatch via the Agent tool (Task) */;
      } else {
        // v0.15.0 — NON-claude panelists go through the cli-harness
        // dispatcher, NEVER a hand-rolled `codex exec` in background Bash.
        // The harness owns the timeout, SIGTERM→SIGKILL escalation,
        // process-group reaping, and stderr capture. A raw background
        // `codex exec` with stderr suppressed parks invisibly on auth
        // prompts (observed: 25min and 3h24m panelist hangs, both caught
        // by the USER, not the orchestrator).
        const { dispatch } =
          await import('${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli-harness/harness.js');
        const result = await dispatch(
          { cli, variant: 'read-only' },
          req.systemPrompt,
          req.userPrompt,
          { timeout_ms: 15 * 60 * 1000 },  // review turns: 15min hard cap
        );
        responseText = result.responseText;
      }
      return runTurnWithDeps({ ...req, adapter }, { agentDispatch: async () => responseText });
    },
    runtime_kind: cli === 'claude' ? 'claude-task' : 'cli-harness',
  });
}
```

**Hard rule (v0.15.0): no unsupervised background `codex exec`.** Reviewer/panelist
work is synchronous and bounded — it goes through `cli-harness/harness.js` `dispatch`
with an explicit `timeout_ms` as above. Background Bash is reserved for the
implementer path, and ONLY via `scripts/codex-exec-with-status.sh` (status file +
`codex_dispatch.max_runtime_ms` kill semantics). Never pipe a codex dispatch through
`tail`, never send stderr to `/dev/null`, and never wait on a background codex task
without a deadline you check every turn.

### Step 3 — Dispatch the panel

```js
const panelOutcome = await dispatchPanel(
  'reviewer-test',
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

For each slice with `high_stakes: true`, ALSO run **panel-mode `reviewer-security` + `reviewer-architecture` reviews** of that slice (per spec § 4 table). Build a separate `dispatchFns` per role; the same `dispatchPanel(role, request, dispatchFns)` contract applies. Both panel outcomes must be `panel-SHIP` (or technically-overridden) before the high-stakes slice ships.

If `reviewer-security` or `reviewer-architecture` returns `panel-REVISE` on a high-stakes slice, revise the plan and re-enter Phase 2.

### Step 6 — Composer-augmented advisories

For non-`reviewer-test`/non-high-stakes review, the orchestrator MAY invoke `composeReviewers` (single mode) to dispatch advisory experts (e.g., `reviewer-ui` for UI-touching slices). These run via `runTurnWithDeps` (single dispatch) and feed findings into the Round-(N+1) prompt. They are advisory only — `panel-SHIP` from `reviewer-test` is the load-bearing gate.

## Phase 3 — User sign-off (uncounted)
After double-SHIP and after the TDD panel SHIPs, show the user the plan path and quote the slice list. Get a "yes" before handing off to implementation.

Once the user signs off, clear the honest-reporting marker (`node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" honest-reporting-clear` — v0.15.0) so the claim scanner doesn't police unrelated follow-on conversation; the execution skill's entry block re-marks it when implementation starts.

## Phase 4 — Hand off
Offer execution choice (matches upstream):
1. **Subagent-driven** (recommended) → `superpowers:subagent-driven-development` (forked when available in this plugin)
2. **Inline** → `superpowers:executing-plans`

In either path, the per-slice review fires from `subagent-driven-development` (forked) using the same Codex session via the sidecar.

## Failure modes
- **Sidecar missing:** the spec wasn't run through Codex-paired brainstorming. Halt and tell the user.
- **Spec not double-SHIP'd:** halt. Run brainstorming first.
- **Round-7 deadlock on plan:** annotate the plan with both positions, surface to user, record arbitration in sidecar.

## When to use implementer-experts (v0.10.0)

Recommended for slices where:
- file partitions are clear (disjoint claimed_files)
- the work is genuinely parallelizable (no inter-implementer dependencies)
- the cost increase (2-5× tokens) is justified by faster wall-clock

Avoid for:
- single-file edits
- tightly-coupled refactors
- low-risk diffs where serial implementation is just as fast

Frontmatter example:
```yaml
**Implementers:**
- member_id: expert-implementer@claude:kimi-k2.6:cloud#0
  adapter: claude-cli
  model: kimi-k2.6:cloud
  required: true
  files:
    - lib/codex-bridge/foo.js
- member_id: expert-implementer@codex:gpt-5.5#0
  adapter: codex
  model: gpt-5.5
  required: true
  files:
    - tests/foo.test.js
```

## When to use hybrid orchestration (v0.14.0)

Some slices split cleanly into a user-facing half and a server half joined by a single agreed interface — for example, a settings screen that calls a new backend route, where the route's request/response shape is the contract between them. For those, you can have Claude build the UI while a background Codex run builds the backend at the same time, instead of doing them one after the other.

Recommend hybrid orchestration when **all** of these hold:
- There is a clear split between front-end work and back-end work, with no file touched by both halves.
- The two halves meet at exactly one interface (a route, a type, a request/response shape) that you can write down as a contract.
- The backend half is the one that defines (publishes) that contract; the UI half consumes it.

Skip it when the work is mostly on one side, when the front-end and back-end changes are tangled across the same files, or when there is no clean contract boundary — a normal single-implementer slice is simpler.

To turn it on, add `**Orchestration:** hybrid` to the slice and declare exactly two owners: a `claude-ui` half and a `codex-backend` half. The UI half lists only front-end files; the backend half (which writes and publishes the contract) lists only server files. So the UI can compile before the backend lands, the UI half also claims a small local stand-in for the backend types under a `__hybrid_contracts__/` folder — the runner swaps this stand-in for the real backend contract once both halves are integrated.

```yaml
**Orchestration:** hybrid

**Implementers:**
- member_id: hybrid-ui@claude:sonnet#0
  owner: claude-ui
  adapter: claude-ui
  model: sonnet
  required: true
  files:
    - app/settings/SettingsScreen.tsx
    - app/settings/__hybrid_contracts__/account-preferences.ts
- member_id: hybrid-backend@codex:gpt-5.5#0
  owner: codex-backend
  adapter: codex-background-bash
  model: gpt-5.5
  required: true
  files:
    - lib/server/routes/account-preferences.ts
    - lib/server/contracts/account-preferences.ts
```

Rules to follow when writing the slice:
- Exactly two owners, both `required: true` — one `owner: claude-ui` and one `owner: codex-backend`. No more, no fewer.
- The UI owner uses the logical `adapter: claude-ui`; the runner picks the real runtime for you (foreground Claude when you run it yourself, a Claude subagent under autopilot). The backend owner must use `adapter: codex-background-bash`.
- Each owner lists at least one file, and no file appears under both owners. (If both genuinely must touch the same file, add an `overlap_rationale` saying why — otherwise overlap is rejected.)
- Every file in the slice `**Files:**` block must be claimed by exactly one owner, and every claimed file must appear in `**Files:**`.
- The `codex-backend` owner is the one that produces the contract; the UI owner consumes it through the `__hybrid_contracts__` stand-in.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
