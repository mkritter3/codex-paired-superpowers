# Plan 4 — Canonical execution-model doc + cross-links

**Spec:** `docs/specs/2026-05-29-unified-execution-driver-design.md`

Final plan of the app-scoped unified-execution-driver rollout. Plans 1–3 built the
split dispatcher, the unified `execution` skill + commands, and the reviewer-naming
migration. Plan 4 makes the three-choice mental model discoverable in exactly one
canonical place and stops it from being duplicated.

This is a documentation + structure-test plan. The canonical doc text is pinned
verbatim in the shipped spec (§ "Canonical mental model", lines 58–84), so there is
no new design surface — only authoring + guards.

## Goal coverage

- **Goal 6** — one short canonical three-choice doc. `docs/execution-model.md` is the
  single driver/split/review mental-model document; README and skills link to it; a
  grep guard prevents duplicate full matrices; `app-autopilot` is marked outside v1.

## Out of scope (deferred to future cleanup, per spec § Deferred)

- Renaming the `experts` JSON key in `agents/dispatchers.json`.
- Removing any `expert-*` compatibility shim.
- Renaming historical architecture docs.

---

## Slice 1: Canonical execution-model doc + cross-links + grep guard
**Validation:** standard

The whole plan is one slice — the deliverables are mutually dependent (the tests
pin the doc + links + guard together; splitting them would leave RED tests with no
independent green state).

### Tests required (`tests/skills/skill-structure.test.js`)

1. **doc exists + contains the matrix.** `docs/execution-model.md` exists and
   contains the canonical driver/split table header
   `| Driver | single | two-disjoint | hybrid-ui-backend |` plus both the
   `interactive` and `autopilot` rows. Inputs: file read. Expected: all present.
   Integration (real file), no mocks.
2. **doc marks app-autopilot outside v1.** `docs/execution-model.md` mentions the
   experimental multi-plan app driver is outside the table / outside v1.
3. **README links to the doc.** `README.md` contains `docs/execution-model.md` and
   lists `execution` as the stable implementation entry point with `/autopilot`
   documented as a compatibility alias.
4. **execution skill links to the doc.** `skills/execution/SKILL.md` contains
   `docs/execution-model.md`.
5. **writing-plans documents `**Split:**` and `**Reviewers:**`.** Both canonical
   directives appear in `skills/writing-plans/SKILL.md`.
6. **brainstorming handoff offers `execution` with driver choices.** The Phase 5
   handoff section names `execution` and the `interactive`/`autopilot` driver choices.
7. **grep guard.** No file under `docs/`, `skills/`, `README.md` other than
   `docs/execution-model.md` contains the full matrix header
   `| Driver | single | two-disjoint | hybrid-ui-backend |` unless that file also
   references `docs/execution-model.md`. This prevents a second canonical matrix from
   drifting out of sync.

### Tasks

1. (RED) Add tests 1–7 above to `tests/skills/skill-structure.test.js`. Confirm RED.
2. (GREEN) Create `docs/execution-model.md` with the verbatim canonical text from the
   spec (§ "Canonical mental model"), including the matrix and the app-autopilot note.
3. (GREEN) Add `execution` to the README skill table as the stable entry point, note
   `/autopilot` as a compatibility alias, and link `docs/execution-model.md`.
4. (GREEN) Add a one-line link to `docs/execution-model.md` near the top of
   `skills/execution/SKILL.md`.
5. (GREEN) Update `skills/brainstorming/SKILL.md` Phase 5 handoff prose to offer the
   `execution` skill with `interactive`/`autopilot` driver choices (keep the existing
   autopilot-default rationale).
6. (GREEN) Add a per-slice `**Split:**` directive subsection to
   `skills/writing-plans/SKILL.md` (canonical `single|two-disjoint|hybrid-ui-backend`;
   note legacy `**Implementers:**` / `**Orchestration:** hybrid` are accepted on read).
   `**Reviewers:**` is already documented (Plan 3 Slice 8).
7. (REFACTOR) Re-read README/skills to ensure no second full matrix was introduced.

## Verification (whole plan)

```bash
node --test tests/skills/skill-structure.test.js tests/skills/skill-dispatch-integration.test.js
node scripts/generate-role-prompts-lock.mjs --check
npm run test:affected
```

All green before Plan 4 — and the app-scoped rollout — is considered shipped.
