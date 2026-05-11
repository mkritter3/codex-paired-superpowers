# Domain Experts — Implementation Plan (rev3)

> **For agentic workers:** REQUIRED SUB-SKILL: `codex-paired-superpowers:subagent-driven-development`. Per-slice review via the same Codex session attached to the spec's sidecar. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/specs/2026-05-10-domain-experts-design.md` (double-SHIP'd round 2)

**Goal:** Implement the plugin-level recreation of Claude Code's native agent-teams feature per the double-SHIP'd spec — domain-expert teammates that work in parallel during BOTH brainstorming/spec-review AND implementation/autopilot, communicating via the existing v0.7.3.1 mailbox primitive, with no dependency on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Architecture:** Seven sequential slices, vertical: (1) mailbox identity → (2) prompt registry + role composer → (3) output protocol + parser → (4) sidecar schema + spec-review expert turns + runtime facade → (5) peer DM scheduling with sidecar checkpointing → (6) autopilot phase inserts → (7) archival + smoke + docs. Re-spawn semantics throughout (no long-lived teammates). Plugin runtime is the canonical path; native runtime adapter is deferred.

**Runtime facade contract:** All implementation slices contribute pieces of a single `PluginTeammateRuntime` facade (per spec §Native Agent-Teams Compatibility interface sketch). The facade lives at `lib/codex-bridge/expert-runtime.js` and re-exports the 5 methods (`resolveIdentity`, `selectTeammates`, `runTurn`, `pollInbox`, `archive`) from their respective implementation modules.

**Tech Stack:** Node.js 20+, zero net-new npm deps (proper-lockfile already vendored). Bash for smoke. JSON-only for sidecar/dispatch records. All identity-validation regexes pinned at CLI + module boundaries.

**Bumps target:** v0.7.3.2 → v0.8.0.

---

## File Structure

```
codex-paired-superpowers/
├── lib/codex-bridge/
│   ├── mailbox.js                          # MODIFY: extend RECIPIENT_RE for expert-*
│   ├── cli.js                              # MODIFY: accept expert-* in mailbox-* subcommands
│   ├── sidecar.js                          # MODIFY: 6 new exports for expert_teammates schema
│   ├── role-composer.js                    # CREATE: selectTeammates(input) — expert selection from signals
│   ├── expert-resolver.js                  # CREATE: resolveIdentity(role, repoRoot) — override > builtin > error
│   ├── expert-output-parser.js             # CREATE: parseExpertOutput + buildRepairPrompt
│   ├── expert-turn.js                      # CREATE: runTurnWithDeps + assembleSpawnPrompt
│   ├── expert-dm-scheduler.js              # CREATE: drainPeerDMs with sidecar-checkpointed turns + DI deps
│   ├── expert-archive.js                   # CREATE: archive(identity, haltReason) — halt-reason policy
│   ├── expert-runtime.js                   # CREATE: facade re-exporting the 5-method TeammateRuntime interface
│   └── prompts/
│       ├── expert-template.md              # CREATE: shared template defining the 7 required prompt sections
│       ├── expert-ui.md                    # CREATE
│       ├── expert-ux.md                    # CREATE
│       ├── expert-architecture.md          # CREATE
│       ├── expert-backend.md               # CREATE
│       ├── expert-ai-harness.md            # CREATE
│       ├── expert-test.md                  # CREATE
│       └── expert-security.md              # CREATE
├── agents/
│   └── dispatchers.json                    # MODIFY: add `experts` top-level key (7 roles)
├── skills/autopilot/SKILL.md               # MODIFY: B.0.5 / B.1.5 / B.4.5-update / B.5.5 inserts + override authority section
├── tests/codex-bridge/
│   ├── mailbox.test.js                     # MODIFY: + expert recipient validation
│   ├── role-composer.test.js               # CREATE
│   ├── expert-resolver.test.js             # CREATE
│   ├── expert-output-parser.test.js        # CREATE
│   ├── expert-turn.test.js                 # CREATE
│   ├── expert-dm-scheduler.test.js         # CREATE
│   ├── expert-archive.test.js              # CREATE
│   ├── expert-runtime-facade.test.js       # CREATE: facade shape + 5-method conformance
│   ├── sidecar-expert-teammates.test.js    # CREATE: 5 new sidecar exports + 1 reader + modified appendImplementDispatch
│   └── dispatchers-experts-registry.test.js # CREATE
├── tests/cli/
│   └── mailbox-cli.test.js                 # MODIFY: + expert-* CLI parsing/permission tests
├── tests/smoke/
│   ├── domain-experts-end-to-end.sh        # CREATE: real Agent dispatch + mailbox round-trip
│   └── autopilot-structural.sh             # MODIFY: assert B.0.5/B.1.5/B.5.5 phase prose present
├── docs/verification/
│   └── v0.8.0-domain-experts.md            # CREATE
├── README.md                               # MODIFY: + v0.8.0 changelog
├── package.json                            # MODIFY: 0.7.3.2 → 0.8.0
├── .claude-plugin/plugin.json              # MODIFY: 0.7.3.2 → 0.8.0
└── .claude-plugin/marketplace.json         # MODIFY: 0.7.3.2 → 0.8.0
```

---

## Slicing

| # | Slice | Validation | Outcome |
|---|---|---|---|
| 1 | Mailbox identity for `expert-*` | critical | `RECIPIENT_RE` accepts `expert-[a-z][a-z0-9-]{0,47}`; CLI surfaces accept expert-* wherever recipient/sender is accepted; permission contract unchanged. |
| 2 | Expert prompt registry + role composer | critical | Template + 7 built-in prompts; `expert-resolver.js` (override→builtin→error); `role-composer.js` selects experts from signals with fan-out rationale enforcement. |
| 3 | Expert output protocol + parser | critical | `expert-output-parser.js`: strict `Machine Result` JSON schema; lenient surrounding Markdown; one-shot repair flow; unread preservation on failure. |
| 4 | Sidecar schema + spec-review expert turns + runtime facade | critical | Sidecar gains 6 new exports (selection / turn / status / fan-out-rationale / read-turns / update-dispatch-blocker) + extended `appendImplementDispatch` validation. `expert-turn.js` implements full spawn-prompt assembly (all spec-mandated inputs incl. sidecar participant state) + dispatch + parse + repair + sidecar turn-append. `expert-runtime.js` facade composes the 5-method TeammateRuntime interface. Expert turn records carry explicit `slice_id?: string` for unambiguous restart-recovery filtering. |
| 5 | Peer DM scheduling | critical | `expert-dm-scheduler.js`: read-only against sidecar (uses `readExpertTurns` for restart-recovery); does NOT own sidecar writes (`runTurn` owns turn-append). Detection-only mailbox usage via `hasUnread`. Restart-recovery via `drainContext: {phase, sliceId}` filter on sidecar's turns array. Caps {2 respawns/expert, 8 total turns}. |
| 6 | Autopilot expert augmentation | critical | `dispatchers.json` gains 7-role `experts` registry. SKILL.md inserts B.0.5/B.1.5/B.4.5-update/B.5.5/override-authority. No new code — all integration is prose + registry. |
| 7 | Archival policy + end-to-end smoke + docs + release | standard | `expert-archive.js` with halt-reason policy table; all 9+ halt reasons enumerated in tests; **real-Agent end-to-end smoke MUST PASS** for v0.8.0 ship (no INCONCLUSIVE fallback). README + 3-place version bump + git tag. |

---

## Slice 1: Mailbox identity for `expert-*`

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** `lib/codex-bridge/mailbox.js`, `lib/codex-bridge/cli.js`, `tests/codex-bridge/mailbox.test.js`, `tests/cli/mailbox-cli.test.js`

### Tasks

- [ ] **Codex test-list review** via `codex-paired-superpowers:test-driven-development` (thread `019e1536-…`). Surface the test list below; address REVISE before red.
- [ ] **TDD red — mailbox.test.js extensions:**
  - Accepts `to: "expert-ui"`, `from: "expert-ux"`.
  - Rejects `to: "expert-../../x"`, `to: "expert-"`, `to: "expert_UI"`, `to: "expert-UI"`, `to: "expert-A-B"` (uppercase after first char).
  - Existing `orchestrator` / `slice-N` cases still pass.
  - `markManyAsRead(repoRoot, "expert-ui", [...])` works for expert recipients.
  - Run — confirm red.
- [ ] **TDD green:** in `mailbox.js`, replace `RECIPIENT_RE` with `/^(orchestrator|slice-\d+|expert-[a-z][a-z0-9-]{0,47})$/`. Re-run — confirm green.
- [ ] **TDD red — mailbox-cli.test.js extensions:**
  - `mailbox-write --to expert-ui --from expert-ux --text "x"` exits 0.
  - `mailbox-read --for expert-ui --actor expert-ui --unread` exits 0.
  - `mailbox-read --for expert-ui --actor orchestrator --unread` exits 0 (supervisory).
  - `mailbox-read --for expert-ui --actor expert-ux` exits 2 with `mailbox-permission-denied`.
  - `mailbox-mark-read-batch --for expert-ui --actor expert-ui --message-ids <ids>` exits 0.
  - `mailbox-write --to expert-../../x` exits 2 with `mailbox-recipient-malformed`.
  - Run — confirm red on new cases.
- [ ] **TDD green:** verify `cli.js` mailbox subcommands delegate to `mailbox.js` validation (no extra CLI-layer regex needed). Re-run — confirm green.
- [ ] **Slice review** via `codex-paired-superpowers:subagent-driven-development`. Address blockers; out-of-slice → Deferred list.
- [ ] **Commit:** `feat(slice:1): v0.8.0 — expert-* mailbox recipient identity`.

### Acceptance

All 31 existing mailbox tests pass + 4+ new expert-* cases pass. All 31 existing CLI tests pass + 6+ new expert-* CLI cases pass. Codex slice review SHIP'd.

---

## Slice 2: Expert prompt registry + role composer

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** 8 prompt files (template + 7 roles), `expert-resolver.js`, `role-composer.js`, two test files

### Tasks

- [ ] **Author the shared template** at `lib/codex-bridge/prompts/expert-template.md` with 7 required sections (role scope, what-to-inspect, what-not-to-decide, review rubric, output-format-pointer, mailbox-behavior-rules, implementation-allowed-flag).
- [ ] **Author `expert-ui.md`** filling in the template. Domain-specific content under each section.
- [ ] **Author 6 remaining prompts** (`expert-ux`, `expert-architecture`, `expert-backend`, `expert-ai-harness`, `expert-test`, `expert-security`) following the same template structure.
- [ ] **Codex test-list review** for both test files.
- [ ] **TDD red — `expert-resolver.test.js`:**
  - `resolveIdentity("ui", repoRoot)` with no override → `{id: "expert-ui", role: "ui", promptPath: <builtin>, source: "builtin"}`.
  - With `<repoRoot>/.codex-paired/experts/ui.md` existing → `{... source: "repo-override", promptPath: <repo-path>}`.
  - `resolveIdentity("nonexistent", repoRoot)` → throws `ExpertResolverError` code `expert-not-found`, message names role + searched paths.
  - Unreadable builtin (chmod 000) → throws `expert-prompt-unreadable`.
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-resolver.js` with `ExpertResolverError` + `resolveIdentity`. Re-run — confirm green.
- [ ] **TDD red — `role-composer.test.js`:**
  - UI signals → includes `expert-ui` + `expert-ux` + default `expert-architecture` + `expert-test`.
  - AI/provider signals → includes `expert-ai-harness`.
  - Security/credential signals → includes `expert-security`.
  - No strong signal → falls back to `["expert-architecture", "expert-test"]`.
  - `**Experts:** ui, architecture` directive merges (doesn't replace inferred set).
  - >5 selected experts WITHOUT a fan-out rationale → throws `role-composer-fan-out-unjustified`.
  - >5 selected WITH rationale → returns successfully; `fanOutRationale` in result.
  - Composer filters out experts whose `resolveIdentity` would throw (logs a warning).
  - Selection reasons are populated for every selected expert (`{[expertId]: string}`).
  - Run — confirm red.
- [ ] **TDD green:** implement `role-composer.js` with `composeExperts(input)`. Deterministic selection (no random). Re-run — confirm green.
- [ ] **Slice review** + commit: `feat(slice:2): v0.8.0 — expert prompt registry + role composer`.

### Acceptance

Template + 7 role prompts present + parseable. `expert-resolver` handles override-builtin-error resolution explicitly. `role-composer` enforces fan-out-rationale on >5-expert selections. All tests pass.

---

## Slice 3: Expert output protocol + parser

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** `expert-output-parser.js`, `expert-output-parser.test.js`

### Tasks

- [ ] **Codex test-list review** before red.
- [ ] **TDD red — `expert-output-parser.test.js`:**
  - **Valid path:** input with `## Machine Result` + fenced JSON matching schema → `{ok: true, result: {...}}`.
  - **Extra Markdown sections:** parser ignores everything outside the `## Machine Result` block.
  - **Section order independence:** `## Machine Result` block parsed regardless of position.
  - **Missing machine block:** returns `{ok: false, reason: "missing-machine-block"}` (no throw).
  - **Invalid JSON:** returns `{ok: false, reason: "invalid-json", rawBlock}`.
  - **Schema violation:** missing required field → `{ok: false, reason: "schema-violation", missingFields: [...]}`.
  - **Wrong expert_id:** parser given `expectedExpertId: "expert-ui"` with payload `expert_id: "expert-ux"` → `{ok: false, reason: "expert-id-mismatch"}`.
  - **Wrong phase:** parser given `expectedPhase: "spec-review"` with payload `phase: "post-implementation-review"` → `{ok: false, reason: "phase-mismatch"}`.
  - **Status enum:** accepts `SHIP` / `REVISE`; rejects others → `{ok: false, reason: "invalid-status"}`.
  - **Required arrays:** `blocking_findings` / `nonblocking_findings` / `peer_messages_sent` / `questions_for_orchestrator` must be arrays. Empty OK; non-array → `{ok: false, reason: "schema-violation"}`.
  - **Multiple machine blocks:** parser takes first, includes `warning: "multiple-machine-blocks"` in result.
  - **`buildRepairPrompt`:** given `{rawOutput, reason, expectedExpertId, expectedPhase}` returns a string containing the raw output + the specific reason + format-repair instruction referencing the schema.
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-output-parser.js` with `parseExpertOutput` + `buildRepairPrompt`. No external Markdown/JSON-schema deps. Re-run — confirm green.
- [ ] **Slice review** + commit: `feat(slice:3): v0.8.0 — expert output protocol + parser`.

### Acceptance

Parser passes all 12 test cases. Repair prompt builder produces correct text. Zero new npm deps.

---

## Slice 4: Sidecar schema + spec-review expert turns + runtime facade

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** `sidecar.js` (extend), `expert-turn.js`, `expert-runtime.js` (facade), `sidecar-expert-teammates.test.js`, `expert-turn.test.js`, `expert-runtime-facade.test.js`

### Sidecar schema additions (rev3 — corrected per spec's dispatch-record contract)

The sidecar gains:
- A top-level `expert_teammates` object with `selected[]`, `turns[]`, `fan_out_rationales[]` (NO top-level `blockers[]` — see below).
- Optional `expert_blockers[]` field on dispatch records (added to `appendImplementDispatch` validation).

Schema:

```json
{
  "expert_teammates": {
    "selected": [
      { "id": "...", "role": "...", "source": "builtin|repo-override",
        "selected_at_phase": "...", "selection_reason": "...", "status": "active|waiting|done|failed|archived" }
    ],
    "turns": [
      { "expert_id": "...", "phase": "...", "slice_id": "slice-3|null",
        "mailbox_message_ids_injected": ["..."],
        "started_at": "...", "completed_at": "...|null", "result_summary": "...",
        "verdict": "SHIP|REVISE", "failure_reason": null }
    ],
    "fan_out_rationales": [
      { "phase": "...", "selected_count": 6, "rationale": "..." }
    ]
  },
  "slice_reviews": {
    "slice-N": {
      "phases": {
        "implement": {
          "dispatches": [
            {
              "...existing dispatch fields (v0.7.3.1 schema)...": "...",
              "experts_selected": ["expert-ui"],
              "expert_turn_ids": ["turn-1"],
              "expert_blockers": [
                { "expert_id": "...", "finding_id": "...", "summary": "...", "location": "...",
                  "disposition": "open|resolved|technical-override|needs-user|deferred",
                  "rationale": "...|null", "evidence": ["..."] }
              ]
            }
          ]
        }
      }
    }
  }
}
```

**Rationale for the change from rev2:** Codex round-2 pointed out that the spec (§Sidecar Dispatch Records, ~line 722) explicitly places `experts_selected`, `expert_turn_ids`, and `expert_blockers` ON THE DISPATCH RECORD, not as a separate top-level array. Rev3 honors the spec: autopilot blockers live on the dispatch record where they originated; spec-review blockers (which have no dispatch) live in the parsed `blocking_findings[]` of the turn's Machine Result and are surfaced to Claude as merge-note inputs (not persisted as a separate top-level array).

### Sidecar API (rev3 — 6 new exports + 1 modified)

NEW exports in `sidecar.js`:
1. `appendExpertSelection(specPath, {id, role, source, phase, selectionReason})` — adds to top-level `expert_teammates.selected[]`.
2. `appendExpertTurn(specPath, {expert_id, phase, slice_id?, mailbox_message_ids_injected, started_at, completed_at, result_summary, verdict, failure_reason})` — adds to top-level `expert_teammates.turns[]`. `slice_id` is optional (null/absent for spec-review-phase turns; required-string for autopilot phases like `post-implementation-review` where the turn is anchored to a specific slice).
3. `updateExpertStatus(specPath, expertId, status)` — mutates `selected[].status`.
4. `appendFanOutRationale(specPath, {phase, selected_count, rationale})` — adds to top-level `expert_teammates.fan_out_rationales[]` (rejects `selected_count <= 5`).
5. **`readExpertTurns(specPath, {phase, sliceId?})`** — thin reader. Returns `expert_teammates.turns[]` filtered by exact `phase` match and (optional) exact `slice_id` match. Used by slice 5's scheduler for restart-recovery. Pure read; no mutation. Filtering keys off the explicit `slice_id` field on turn records (added per Codex round-4 critique to avoid the brittle `phase`-embedded-sliceId hack).
6. **`updateDispatchExpertBlocker(specPath, locator, findingId, {disposition, rationale?, evidence?})`** — `locator = {sliceId, dispatched_at}` (existing stable coordinates on every dispatch record; no schema change needed). Finds the matching dispatch in `slice_reviews[sliceId].phases.implement.dispatches[]` where `dispatched_at === locator.dispatched_at`; then finds the blocker in its `expert_blockers[]` by `finding_id`; mutates `disposition`. Disposition rules:
   - `technical-override` requires non-empty `rationale` AND non-empty `evidence` array.
   - `needs-user` requires non-empty `rationale`.
   - `deferred` requires non-empty `rationale`.
   - `resolved` requires nothing extra.
   - Throws on unknown disposition or missing dispatch/finding.

MODIFIED export in `sidecar.js`:
- `appendImplementDispatch(specPath, sliceId, dispatch)` — now validates optional `experts_selected: string[]`, `expert_turn_ids: string[]`, `expert_blockers: ExpertBlocker[]` fields when present. Initial blockers carry `disposition: "open"`. Empty array allowed; null/undefined treated as absent (back-compat with pre-v0.8.0 dispatches). Each blocker validated: required `expert_id`, `finding_id`, `summary`, `location`, `disposition`.

### Tasks

- [ ] **Codex test-list review** for all three test files.
- [ ] **TDD red — `sidecar-expert-teammates.test.js`** (covers 6 new exports + modified `appendImplementDispatch`):
  - **`appendExpertSelection(specPath, {id, role, source, phase, selectionReason})`** — adds to top-level `expert_teammates.selected[]`; rejects empty `id`/`role`; rejects `source` not in `{builtin, repo-override}`.
  - **`appendExpertTurn(specPath, {expert_id, phase, slice_id?, mailbox_message_ids_injected, started_at, completed_at, result_summary, verdict, failure_reason})`** — adds to top-level `expert_teammates.turns[]`; `mailbox_message_ids_injected` must be array of non-empty strings; `verdict` in `{SHIP, REVISE}`; `failure_reason` is `null` or non-empty string; `slice_id` is optional null/string — required string for autopilot phases (`post-implementation-review`, `pre-dispatch`), null/absent for spec-review-phase turns. Test cases: turn appended with `slice_id: "slice-3"` round-trips; turn appended without `slice_id` round-trips with `slice_id: null` in the persisted record; non-string `slice_id` rejected.
  - **`updateExpertStatus(specPath, expertId, status)`** — mutates `selected[].status`; rejects unknown status; throws if expert not in `selected[]`.
  - **`appendFanOutRationale(specPath, {phase, selected_count, rationale})`** — adds to top-level `expert_teammates.fan_out_rationales[]`; rejects when `selected_count <= 5` (only records when fan-out was actually broad).
  - **`appendImplementDispatch` (MODIFIED)** now validates optional `experts_selected: string[]`, `expert_turn_ids: string[]`, `expert_blockers: ExpertBlocker[]` fields when present on the dispatch object. Each blocker validated: required fields `expert_id`, `finding_id`, `summary`, `location`, `disposition`; initial `disposition` must be `"open"` (other values only valid via `updateDispatchExpertBlocker`). Empty array allowed; null/undefined treated as absent (back-compat with pre-v0.8.0 dispatches).
  - **`updateDispatchExpertBlocker(specPath, locator, findingId, {disposition, rationale?, evidence?})`** — `locator = {sliceId, dispatched_at}` (existing stable coordinates on every dispatch record per v0.7.0 schema; no schema change needed). Finds the dispatch in `slice_reviews[locator.sliceId].phases.implement.dispatches[]` matching `dispatched_at === locator.dispatched_at`; finds the blocker by `finding_id`; mutates `disposition`. Rules: `technical-override` requires non-empty `rationale` AND non-empty `evidence` array; `needs-user` requires non-empty `rationale`; `deferred` requires non-empty `rationale`; `resolved` requires nothing extra. Throws on unknown disposition, missing dispatch (no match on `sliceId`+`dispatched_at`), or missing finding.
  - **`readExpertTurns(specPath, {phase, sliceId?})`** — thin reader for slice 5's restart-recovery: returns sidecar's `expert_teammates.turns[]` filtered by `phase` and optional `sliceId`. Pure read; no mutation. Test cases: returns `[]` when no turns; filters by exact phase match; filters by sliceId when provided; works on old sidecar without `expert_teammates` field (returns `[]`).
  - Loading an old (pre-v0.8.0) sidecar without `expert_teammates` works; first append creates the field. Old dispatch records without `expert_*` fields are unaffected.
  - Run — confirm red.
- [ ] **TDD green:** in `sidecar.js`, add 6 new exports (the 4 expert_teammates writers + `readExpertTurns` reader + `updateDispatchExpertBlocker`) + extend `appendImplementDispatch` validation. Each validates input shape using the existing pattern. Re-run — confirm green.
- [ ] **TDD red — `expert-turn.test.js`** (DI-seam pattern matching v0.7.3.1's hook module):
  - **Spawn-prompt assembly (full contract — ALL spec-mandated inputs from spec §Spawn Pattern > Expert Turn Input):**
    - `assembleSpawnPrompt({identity, specPath, specSnippet, phase, sidecarParticipantState, unreadMessages, task, outputContractRef})` returns a string CONTAINING (by exact-substring assertions):
      - The expert's resolved prompt CONTENTS (not just a reference to its path).
      - Base L11 operating rules (from `prompts/system-rubric.md`).
      - The spec path AND the spec snippet (current draft content).
      - **The serialized sidecar participant state** (e.g., recent turn summaries, selection reason, fan-out context — formatted as a labelled section in the prompt; this is the rehydration mechanism that gives experts continuity across spawns despite being ephemeral). Test asserts `prompt.includes(sidecarParticipantStateSnippet)`.
      - Each unread message's body verbatim.
      - The current phase string.
      - The requested task text.
      - The Machine Result schema (output contract reference) — embedded enough for the expert to produce a parseable result.
      - The expert's mailbox identity (so the expert knows which CLI `--from` value to use for outbound DMs).
  - **Happy path:** stub `agentDispatch` returns valid output → `runTurnWithDeps` returns `{ok: true, result, turnId}`; messages marked read; turn appended to sidecar with `verdict: SHIP|REVISE`, `failure_reason: null`.
  - **Parse fail + repair succeeds:** first dispatch returns malformed; repair dispatch returns valid; messages marked read only after repaired parse.
  - **Parse fail + repair fails:** both dispatches malformed → messages NOT marked read; turn appended with `failure_reason: "unparseable-output"`; result `{ok: false}`.
  - **Agent dispatch throws (network/permission/etc):** messages NOT marked read; turn appended with `failure_reason: "dispatch-error"`; original error message preserved.
  - **Empty unread:** spawn prompt still assembled; `mailbox_message_ids_injected: []`; turn still recorded.
  - **Sidecar append throws:** breadcrumb written via `writeBreadcrumb` (analogous to hook); result still returned to caller (best-effort sidecar write).
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-turn.js`:
  - `export function assembleSpawnPrompt({...})` — pure function returning the prompt string.
  - `export async function runTurnWithDeps(request, deps = {})` — DI seam. Defaults: real `readUnreadMessages`, `markManyAsRead`, `parseExpertOutput`, `buildRepairPrompt`, `agentDispatch` (adapter to Agent tool — slice 7 wires this through autopilot), `appendExpertTurn`, `writeBreadcrumb`.
  - `export async function runTurn(request)` — production wrapper.
  - Order: read unread → assemble prompt → dispatch → parse → (repair if needed) → mark-read on success → append turn (best-effort) → return result.
  - Re-run — confirm green.
- [ ] **TDD red — `expert-runtime-facade.test.js`:**
  - Imports `expert-runtime.js`; asserts the module exports exactly 5 methods named `resolveIdentity`, `selectTeammates`, `runTurn`, `pollInbox`, `archive` (matches spec §Native Agent-Teams Compatibility interface).
  - Each method is async (returns Promise) OR sync as declared in interface.
  - `selectTeammates` is `composeExperts` from role-composer (alias).
  - `pollInbox(identity)` is a thin wrapper over `readUnreadMessages(repoRoot, identity.id)`.
  - `archive(identity, haltReason)` delegates to `expert-archive.js` (slice 7); for slice 4 it's a stub that records the call.
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-runtime.js` as a facade module:
  ```js
  export { resolveIdentity } from './expert-resolver.js';
  export { composeExperts as selectTeammates } from './role-composer.js';
  export { runTurn } from './expert-turn.js';
  // pollInbox + archive defined here as thin wrappers
  ```
  Re-run — confirm green.
- [ ] **Slice review** + commit: `feat(slice:4): v0.8.0 — sidecar expert schema + spec-review turns + runtime facade`.

### Acceptance

Sidecar accepts 6 new exports + 1 modified export with strict validation. Spawn-prompt assembly contract enforced by exact-substring assertions on ALL spec-mandated inputs (including sidecar participant state, addressed round-2 critique). `expert-turn.js` implements happy path + parse-fail-with-repair + dispatch-error paths with mark-read-after-success contract. `expert-runtime.js` facade exposes the 5-method TeammateRuntime interface explicitly. Blockers live on dispatch records per spec (no top-level `blockers[]` array).

---

## Slice 5: Peer DM scheduling with sidecar checkpointing

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** `expert-dm-scheduler.js`, `expert-dm-scheduler.test.js`

### Tasks

- [ ] **Codex test-list review** before red.
- [ ] **TDD red — `expert-dm-scheduler.test.js`** (mailbox-ownership clarified per Codex round-2 finding):
  - **Mailbox ownership boundary:** the scheduler uses `deps.hasUnread(expertId)` (or `deps.peekUnreadCount(expertId)`) for **DETECTION ONLY** — to answer "does this expert have queued DMs?". The scheduler does NOT call `markManyAsRead` directly. `deps.runTurn(expert, ...)` owns the full read→parse→mark-read cycle for one turn, including marking consumed messages read on parse success (or preserving on failure). This avoids the double-handling Codex flagged: scheduler detects; runTurn consumes.
  - **Empty inbox:** `drainPeerDMs(activeExperts, deps, opts)` with no unread → exits immediately, returns `{turns: [], halt: null}`.
  - **Single peer DM:** expert-ui has 1 unread from expert-ux → scheduler detects via `deps.hasUnread("expert-ui")`, invokes `deps.runTurn(expert-ui, …)`, runTurn (slice 4) handles read+mark internally, scheduler captures result.
  - **Chain DM:** expert-ui's turn writes a peer DM to expert-architecture (visible in `result.peer_messages_sent[]` AND detectable next loop iter via `deps.hasUnread("expert-architecture")`); scheduler spawns expert-architecture next.
  - **Per-expert respawn cap (default 2):** expert-ui keeps getting DMs; after 2 turns of expert-ui in same drain, scheduler skips it this drain.
  - **Total turn cap (default 8):** simulate fan-out exceeding 8; returns `{turns: <8 entries>, halt: "expert-peer-dm-drain-cap-exceeded"}`.
  - **Cap configurability:** `opts.maxRespawnsPerExpert` and `opts.maxTotalTurns` override defaults.
  - **Halt preserves inboxes:** when cap is hit, unconsumed DMs remain unread (verify via `deps.hasUnread` post-halt).
  - **Sidecar checkpointing:** scheduler does NOT call `appendExpertTurn` itself — that's `runTurn`'s job (slice 4). Scheduler's only sidecar interaction is the restart-recovery READ.
  - **Restart-recovery test:** simulate restart mid-drain by re-invoking `drainPeerDMs` with `opts.resumeFromSidecar: true` and `opts.drainContext: {phase, sliceId}`. Scheduler calls `deps.readExpertTurns(specPath, {phase, sliceId})` to load existing turns, filters to current drain context, populates respawn counts from those turns, resumes without double-counting (assert `totalTurns` and `respawnCounts` derived correctly).
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-dm-scheduler.js`:
  - `export async function drainPeerDMs(activeExperts, deps, opts = {})`.
  - **Deps shape (corrected):** `{hasUnread, runTurn, readExpertTurns, writeBreadcrumb}`.
    - `hasUnread(expertId): Promise<number>` — returns unread count; scheduler treats `>0` as "schedule this expert".
    - `runTurn(expert, drainContext): Promise<TurnResult>` — owns the read→dispatch→parse→mark-read cycle for ONE expert turn (delegates to slice 4's runTurn).
    - `readExpertTurns(specPath, {phase, sliceId}): Promise<Turn[]>` — loads sidecar's `expert_teammates.turns[]` filtered to phase + sliceId (added to sidecar.js in slice 4 as a thin wrapper or exposed via `loadSidecar`).
    - `writeBreadcrumb(repoRoot, slice, msg)` — best-effort diagnostic (already exists in v0.7.3.1 hook utility).
  - **No `markManyAsRead` in deps** — that lives inside runTurn.
  - **No `appendExpertTurn` in deps** — that's runTurn's job.
  - Opts shape: `{maxRespawnsPerExpert: 2, maxTotalTurns: 8, specPath, drainContext: {phase, sliceId}, resumeFromSidecar: false}`.
  - Loop body:
    1. If `opts.resumeFromSidecar`: prior = `await deps.readExpertTurns(specPath, opts.drainContext)`; populate `respawnCounts[expertId]` from prior; `totalTurns = prior.length`.
    2. For each `expert` in `activeExperts`: `n = await deps.hasUnread(expert.id)`.
    3. If all `n === 0`, exit `{turns, halt: null}`.
    4. Pick next expert with `n > 0` (round-robin, deterministic).
    5. Skip if `respawnCounts[expert.id] >= maxRespawnsPerExpert`.
    6. Halt if `totalTurns >= maxTotalTurns` → return `{turns, halt: "expert-peer-dm-drain-cap-exceeded"}`.
    7. `result = await deps.runTurn(expert, opts.drainContext)`.
    8. Increment counts; record `result` in local `turns[]`; loop.
  - **Add `readExpertTurns` export to `sidecar.js`** (mentioned in slice 4 sidecar additions list as a thin reader; called out here to ensure slice 4 ships it).
  - Re-run — confirm green.
- [ ] **Slice review** + commit: `feat(slice:5): v0.8.0 — peer DM scheduler with sidecar checkpointing + caps`.

### Acceptance

Scheduler converges on all 9 test cases (including restart-recovery, which addresses the round-1 mid-drain restart concern). Scheduler does NOT own sidecar writes — `runTurn` (from slice 4) owns turn-append behavior; scheduler is read-only against the sidecar (via `deps.readExpertTurns` for recovery). Scheduler tolerates `runTurn` returning failure results (records them in local `turns[]`, increments counts, continues until cap) without owning the persisted-failure semantics. Cap-exceeded halts preserve unconsumed DMs (verified by post-halt `deps.hasUnread` calls).

---

## Slice 6: Autopilot expert augmentation

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Files:** `agents/dispatchers.json`, `skills/autopilot/SKILL.md`, `tests/codex-bridge/dispatchers-experts-registry.test.js`, modifies `tests/smoke/autopilot-structural.sh`

### Tasks

- [ ] **TDD red — `dispatchers-experts-registry.test.js`:**
  - JSON parses.
  - Each of the 7 expert entries (`ui`, `ux`, `architecture`, `backend`, `ai-harness`, `test`, `security`) has required fields: `id`, `prompt`, `phases`, `domains`.
  - Every `prompt` path resolves to a real file in `lib/codex-bridge/prompts/`.
  - `phases` values are subset of `{"spec-review", "pre-dispatch", "post-implementation-review"}`.
  - `domains` is a non-empty array of strings.
  - Existing `codex` and `sonnet` entries are unchanged (no regression).
  - Run — confirm red.
- [ ] **TDD green:** add `experts` top-level key to `dispatchers.json`:
  ```json
  {
    "codex": { ...existing... },
    "sonnet": { ...existing... },
    "experts": {
      "ui":           { "id": "expert-ui",           "prompt": "lib/codex-bridge/prompts/expert-ui.md",           "phases": ["spec-review", "post-implementation-review"],                  "domains": ["ui"] },
      "ux":           { "id": "expert-ux",           "prompt": "lib/codex-bridge/prompts/expert-ux.md",           "phases": ["spec-review"],                                                "domains": ["ui"] },
      "architecture": { "id": "expert-architecture", "prompt": "lib/codex-bridge/prompts/expert-architecture.md", "phases": ["spec-review", "pre-dispatch", "post-implementation-review"], "domains": ["backend", "ai-harness", "general", "ui"] },
      "backend":      { "id": "expert-backend",      "prompt": "lib/codex-bridge/prompts/expert-backend.md",      "phases": ["spec-review", "post-implementation-review"],                  "domains": ["backend"] },
      "ai-harness":   { "id": "expert-ai-harness",   "prompt": "lib/codex-bridge/prompts/expert-ai-harness.md",   "phases": ["spec-review", "post-implementation-review"],                  "domains": ["ai-harness"] },
      "test":         { "id": "expert-test",         "prompt": "lib/codex-bridge/prompts/expert-test.md",         "phases": ["spec-review", "pre-dispatch", "post-implementation-review"], "domains": ["general"] },
      "security":     { "id": "expert-security",     "prompt": "lib/codex-bridge/prompts/expert-security.md",     "phases": ["spec-review", "post-implementation-review"],                  "domains": ["backend", "ai-harness"] }
    }
  }
  ```
  Re-run — confirm green.
- [ ] **SKILL.md — add B.0.5 (Expert selection per slice)** prose: orchestrator calls `expert-runtime.selectTeammates({phase: "implementation", signals: ...})`, records selection in sidecar via `appendExpertSelection`. >5 selections → `appendFanOutRationale`. References slice 2's role-composer and slice 4's sidecar functions explicitly.
- [ ] **SKILL.md — add B.1.5 (Optional expert pre-review)** prose: for each expert tagged with `pre-dispatch` in its registry phases, run `expert-runtime.runTurn(expert, {phase: "pre-dispatch", slice_id: <currentSliceId>, ...})` with slice plan as context.
  - **If all pre-review experts SHIP (no blocking findings):** held findings (turn records + any non-blocking findings) flow through to B.7 where they're attached to the dispatch record's `expert_blockers: []` (empty) + `experts_selected[]` + `expert_turn_ids[]`. Normal flow.
  - **If any pre-review expert emits blocking findings:** the slice does NOT proceed to B.4 dispatch. To preserve the durable-state requirement, the orchestrator immediately appends a **sentinel halted dispatch record** via `appendImplementDispatch(specPath, sliceId, {...required dispatch fields..., outcome: "failed-halted", failure_reason: "pre-dispatch-blocker", dispatched_at: <now-iso>, experts_selected, expert_turn_ids, expert_blockers: [...findings with disposition:"open"...]})`. This sentinel exists ONLY to anchor the pre-dispatch blockers on a durable record — it does NOT represent a real dispatch (no worker spawned, no commits made). The sentinel makes `updateDispatchExpertBlocker({sliceId, dispatched_at}, findingId, ...)` resolution work uniformly across pre-dispatch and post-dispatch blockers. After the sentinel is appended, halt with `expert-blocker-open` (preserves expert mailboxes per slice 7 archival policy). On resume, Claude reads the sentinel's `expert_blockers[]` and either: (a) overrides technical false-positives via `updateDispatchExpertBlocker`, (b) routes product/UX/business findings to the user. Once all blockers reach `disposition !== "open"`, the orchestrator may either advance to B.4 (treating the sentinel as a resolved pre-dispatch gate) or supersede it by appending a real dispatch.
- [ ] **SKILL.md — modify B.4.5 (Between-turns inbox polling)**: extend the existing prose to include active expert inboxes alongside orchestrator + in-flight slice inboxes. Unread expert messages at B.4.5 schedule the expert for B.5.5 (not immediate spawn — expert sees reconciled truth).
- [ ] **SKILL.md — add B.5.5 (Expert post-review and peer-DM drain)** prose: invoke `expert-dm-scheduler.drainPeerDMs(activeExperts, runtimeDeps, {maxRespawnsPerExpert: 2, maxTotalTurns: 8, specPath, drainContext: {phase: "post-implementation-review", sliceId: <currentSliceId>}, resumeFromSidecar: <true if recovering>})`. `drainContext` is REQUIRED for restart-recovery to filter sidecar turns correctly. Block integration if any unresolved blocking finding. Honor override authority per below.
- [ ] **SKILL.md — add Blocking-Finding Override Authority section** (separate sub-heading under Phase B):
  - **Technical overrides:** Claude may override a blocking expert finding ONLY when ALL of these are true: (a) finding is technical, not product/UX/business; (b) Claude writes a specific rationale citing concrete evidence (file/line/function/reconciler output); (c) the override is recorded on the dispatch record via `updateDispatchExpertBlocker(specPath, {sliceId, dispatched_at}, findingId, {disposition: "technical-override", rationale, evidence})`.
  - **Product/UX/business overrides:** require explicit human user authorization. Halt with `expert-blocker-needs-user`. Surface the finding to the user. On user response, record via `updateDispatchExpertBlocker(specPath, {sliceId, dispatched_at}, findingId, {disposition: "needs-user", rationale})` with the user's rationale.
  - **Examples of valid technical overrides:** stale slice version reference; misread command boundary; claimed-missing test that exists; flagged behavior reconciler proves absent.
  - **Examples requiring human:** workflow-confusing finding; visual-feel weakening; copy changes feature promise; scope mismatch with requested outcome.
- [ ] **MODIFY `tests/smoke/autopilot-structural.sh`:** add assertions that the rendered Phase B prose contains the strings `B.0.5 Expert selection`, `B.1.5 Optional expert pre-review`, `B.5.5 Expert post-review and peer-DM drain`, and the override-authority section heading. Mocked-outcome paths through B.0-B.8 still pass (no regression in existing ordering).
- [ ] **Codex test-list review** before red on the new test + smoke updates.
- [ ] **Slice review** + commit: `feat(slice:6): v0.8.0 — autopilot expert augmentation (B.0.5/B.1.5/B.5.5 + override authority)`.

### Acceptance

`dispatchers.json` registry test passes (JSON shape + prompt-file existence + enum values). SKILL.md Phase B prose includes all 4 new/modified sections. Override authority codified with concrete examples. Structural smoke confirms phase ordering preserved + new prose present.

---

## Slice 7: Archival policy + end-to-end smoke + docs + release

**Validation:** critical · **Domain:** ai-harness · **Implementer:** sonnet

**Note:** Per round-1 critique, validation is bumped to **critical** because this slice includes the **release gate** (real-Agent end-to-end smoke) which is load-bearing for v0.8.0's core claim. INCONCLUSIVE is not acceptable for ship.

**Files:** `expert-archive.js`, `expert-archive.test.js`, `tests/smoke/domain-experts-end-to-end.sh`, `docs/verification/v0.8.0-domain-experts.md`, `README.md`, `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, SKILL.md (mailbox archival policy section)

### Tasks

- [ ] **Codex test-list review** before red on archival + smoke.
- [ ] **TDD red — `expert-archive.test.js` enumerates ALL halt reasons from spec §Mailbox Archival:**
  - **ARCHIVE for halt reasons:** `completed`, `abandoned-by-user`. Test each: `archive(identity, haltReason)` calls `archiveAndReset(repoRoot, identity.id)` and records sidecar entry `{expert_id, status: "archived", archive_reason, archived_at}`.
  - **PRESERVE for halt reasons:** `external-commit-detected`, `slice-blocker-from-mailbox`, `expert-blocker-open`, `expert-peer-dm-drain-cap-exceeded`, `subagent-dispatch-failed`, `reconcile-failed`, `validation-failed`, `user-input-required`. Test each: `archive(identity, haltReason)` does NOT call `archiveAndReset`; sidecar records `{status: "preserved-for-resume", archive_reason: haltReason}` instead.
  - **Unknown halt reason:** throws `ExpertArchiveError` code `unknown-halt-reason`.
  - Run — confirm red.
- [ ] **TDD green:** implement `expert-archive.js`:
  ```js
  export const HALT_REASONS_ARCHIVE = new Set(["completed", "abandoned-by-user"]);
  export const HALT_REASONS_PRESERVE = new Set([
    "external-commit-detected", "slice-blocker-from-mailbox", "expert-blocker-open",
    "expert-peer-dm-drain-cap-exceeded", "subagent-dispatch-failed",
    "reconcile-failed", "validation-failed", "user-input-required"
  ]);
  export class ExpertArchiveError extends Error { ... }
  export async function archive(identity, haltReason, deps = {...}) { ... }
  ```
  Re-run — confirm green.
- [ ] **Wire `archive` into the facade** at `expert-runtime.js` (replacing the slice 4 stub).
- [ ] **TDD red — end-to-end smoke `tests/smoke/domain-experts-end-to-end.sh`:**
  1. Set up tmp repo with `.codex-paired/`.
  2. Write 2 unread messages to `expert-ui`'s inbox via the production CLI.
  3. Invoke `expert-runtime.runTurn(expert-ui, {phase: "spec-review", task: "Review the test spec"})` via a Node entry script.
  4. The runtime spawns a real Agent subagent (no mocks).
  5. Agent emits a parseable `## Machine Result` block with a SHIP verdict.
  6. Assert: messages marked read in mailbox.
  7. Assert: sidecar has 1 turn record with `verdict: SHIP`, `mailbox_message_ids_injected: [...2 ids...]`, `failure_reason: null`.
  8. Cleanup.
- [ ] **Run smoke; iterate until PASS.** Per critique 8 from round 1: **INCONCLUSIVE is not acceptable for v0.8.0 ship.** If the smoke fails, the v0.8.0 release is HELD until the underlying issue is resolved. If the Agent tool surface fundamentally precludes the smoke (e.g., no way to dispatch from a Node script outside Claude Code), document the smoke as requiring manual user execution from a Claude Code session (analogous to v0.7.3.1's hook-fires-in-task-subagent.sh) — but PASS still required, not INCONCLUSIVE.
- [ ] **Verification doc** at `docs/verification/v0.8.0-domain-experts.md`:
  - Status table: result (PASS / FAIL), date, plugin commit, Claude Code version, smoke transcript excerpt.
  - If FAIL: document the failure mode + decision (hold release vs ship subset).
- [ ] **README v0.8.0 changelog entry** (insert above v0.7.3.2):
  - Overview: domain-expert teammates, peer-negotiated coordination, Claude-driven role composition, no native agent-teams dependency.
  - File map: `lib/codex-bridge/prompts/expert-*.md` curated bundle; user overrides at `<repo>/.codex-paired/experts/<role>.md`.
  - Phase inserts: B.0.5 / B.1.5 / B.4.5-update / B.5.5.
  - Override authority: Claude technical-only with evidence / human product-UX-business.
  - Caps: 2 respawns/expert, 8 total turns per B.5.5 drain.
  - Compatibility: plugin recreation is canonical; native agent-teams adapter deferred.
- [ ] **SKILL.md mailbox archival policy section** added/updated to reflect the halt-reason table from `expert-archive.js`.
- [ ] **Version bumps** to `0.8.0` in 3 places.
- [ ] **Skill cross-refs** in brainstorming/autopilot/subagent-driven-development SKILL.md: mention experts compose with the existing Codex L11 reviewer.
- [ ] **Slice review** + commit: `chore(slice:7): v0.8.0 — archival policy + end-to-end smoke + docs + release`.
- [ ] **Tag `v0.8.0`** + push tag.

### Acceptance

`expert-archive` tests enumerate ALL 10 halt reasons (2 archive + 8 preserve). End-to-end smoke **PASSES** (real Agent dispatch + mailbox round-trip + sidecar turn record). README + 3-place version bumps committed. Tag pushed. Codex slice review SHIP'd.

---

## Verification Gates

After each slice commits:

1. Run all touched unit tests.
2. Run all CLI tests if CLI surfaces changed.
3. Run `bin/codex-paired-doctor` to confirm install health.
4. Per-slice Codex review via `codex-paired-superpowers:subagent-driven-development`.

After slice 7:

5. Run `npm test` (full plugin test suite serial, ~17 min) — zero regressions.
6. Run all v0.7.3.1 smokes (`mailbox-inject-hook.sh`, `hooks-coexist.sh`, `hooks-cross-slice-concurrency.sh`).
7. Run the new `domain-experts-end-to-end.sh` smoke — **PASS required**.
8. Update `docs/verification/v0.8.0-domain-experts.md` with results.

## Residual Concerns From Spec (mapped to slices)

- **Expert prompt file missing/corrupt error shape** → addressed in slice 2's `expert-resolver.test.js` (`expert-not-found` and `expert-prompt-unreadable` cases).
- **B.5.5 cap arithmetic empirical grounding** → exercised in slice 5 unit tests + slice 7 end-to-end smoke. Tune defaults in slice 7 if pathological.
- **Mid-drain restart recovery** → addressed in slice 5 via sidecar checkpointing per turn + explicit restart-recovery test reading sidecar's `turns[]` to compute cap-counts.

## Deferred (out of v0.8.0 scope)

- Experts as primary implementers (vs reviewers).
- Native agent-teams runtime adapter (`NativeTeammateRuntime`).
- Hook-based expert auto-injection via `CODEX_PAIRED_MAILBOX_IDENTITY` env hatch.
- Long-running background teammate simulation.
- User-facing expert management UI.
- Cross-feature expert memory.
- Automatic expert prompt generation.
- Prompt hashing / replay audit.

## Open Contentions

(none)
