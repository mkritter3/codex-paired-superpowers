# Hybrid Development Mode — implementation plan

**Spec:** `docs/specs/2026-05-28-hybrid-dev-mode-design.md`
**Date:** 2026-05-28
**Owner:** mkr
**Validation:** critical

## Orientation

Implements the double-SHIP'd hybrid-mode spec: inline Claude (UI/UX) + background Codex
(backend/contracts/routing), non-overlapping, contract-first, runnable by autopilot. The spec's §11
(files/modules) and §13 (test plan) are the design source of truth; this plan sequences them into
dependency-ordered TDD slices. Each slice cites the spec section that fully specifies its behavior —
implementers MUST read that section, not re-derive it.

Reuse-over-rebuild is load-bearing here (the spec's audit confirmed the primitives): the existing
`claimed_files` overlap-rejection (`implementer/frontmatter.js`), `codex-background-bash` +
`claude-subagent` transports (`dispatchers.js`), `mailbox.js`, `dependency-graph.js`,
`worktree-integrate.js`, `halt-envelope.js`, and `phases.implementer_experts` sidecar state are
**extended**, not replaced. The only new module tree is `lib/codex-bridge/hybrid/`.

### Goal → slice map

| Goal | Slice(s) |
| --- | --- |
| G2 per-slice owner declaration | Slice 1 |
| G3 contract publish/consume (+ shim) | Slices 2, 3 |
| G5 halt classification | Slice 4 |
| (audit substrate) | Slice 5 |
| G1 non-overlapping hybrid session | Slices 1, 6 |
| G4 autopilot unattended hybrid | Slices 6, 7 |

### Dependency order

Slice 1 (ownership) → Slice 5 (sidecar owner state) and Slice 6 (runner).
Slice 2 (mailbox persist) → Slice 3 (contracts). Slice 4 (halts) is independent.
Slice 6 (runner) depends on 1–5. Slice 7 (skills/autopilot) depends on 6.

### Files (from spec §11)

| File | Slice | New/modified |
| --- | --- | --- |
| `lib/codex-bridge/implementer/frontmatter.js` | 1 | modified — parse `owner`; extract shared overlap validator |
| `lib/codex-bridge/hybrid/ownership.js` | 1 | new — `parseHybridOwners`, `validateHybridOwnership` |
| `lib/codex-bridge/mailbox.js` | 2 | modified — persist optional metadata; add `contract` to `VALID_KINDS` |
| `lib/codex-bridge/hybrid/contracts.js` | 3 | new — `publishContract`, `readLatestContract`, `recordContractConsumed` |
| `lib/codex-bridge/halt-envelope.js` | 4 | modified — register hybrid halt reasons |
| `lib/codex-bridge/sidecar.js` | 5 | modified — owner metadata on members; hybrid status block |
| `lib/codex-bridge/hybrid/runner.js` | 6 | new — preflight, dispatch, polling, contract handoff, verify, integrate |
| `lib/codex-bridge/hybrid/types.js` | 6 | new — runtime-kind witness (`claude-inline`/`claude-subagent`/`codex-background-bash`) |
| `skills/writing-plans/SKILL.md`, `skills/autopilot/SKILL.md` | 7 | modified — `**Orchestration:** hybrid` + Phase B hybrid branch |
| `tests/codex-bridge/hybrid/{ownership,contracts,runner}.test.js` | 1,3,6 | new |

---

## Slice 1: Per-slice owner parsing + shared overlap validation

**Validation:** critical
**Goal:** G2 (owner declaration) + the parsing half of G1. Spec §5 (plan syntax) + §6 (preflight rules).

### Tests required (`tests/codex-bridge/hybrid/ownership.test.js`)
1. Accepts exactly one `claude-ui` + one `codex-backend` owner. (Unit.)
2. Rejects missing / duplicate / unknown (`owner` outside the two) / optional (`required:false`) owners → `hybrid-ownership-malformed`. (Unit, per case.)
3. Rejects a slice `**Files:**` entry not claimed by either owner, and an owner-claimed file absent from `**Files:**` → `hybrid-owner-files-unclaimed`. (Unit.)
4. Overlap rejection **delegates** to the extracted frontmatter validator: overlapping owner files with no `overlap_rationale` → `hybrid-owner-files-overlap`; a rationalized overlap is preserved in parsed output. (Unit — assert it calls the shared helper, not a duplicate checker.)
5. `frontmatter.js` still parses non-hybrid `**Implementers:**` blocks unchanged (regression). (Unit.)

### Tasks
1. **RED:** write `ownership.test.js` cases 1–5 against `parseHybridOwners(planMarkdown, sliceSection)` + `validateHybridOwnership({ sliceFiles, implementers })` (not yet existing).
2. **GREEN — frontmatter:** in `implementer/frontmatter.js`, parse optional `owner` (preserve when present); extract the existing claimed-file overlap logic (currently ~line 367) into an exported `validateClaimedFileOverlap(members)` helper; the existing `validateImplementers` calls it (no behavior change for non-hybrid).
3. **GREEN — ownership module:** create `lib/codex-bridge/hybrid/ownership.js` per spec §5/§6 rules. `validateHybridOwnership` calls the shared overlap helper from task 2 — NO second overlap checker (spec §5 closing requirement). Emit the exact halt reasons from spec §6.
4. **REFACTOR/verify:** `node --test tests/codex-bridge/hybrid/ownership.test.js` + the existing frontmatter/implementer tests (regression).

---

## Slice 2: Mailbox contract-metadata persistence

**Validation:** standard
**Goal:** G3 substrate. Spec §7 (the mailbox today validates but DROPS `kind`/`priority`/`implementer_run_id`/`slice_id`/`body_hash` on persist).

### Tests required (extend `tests/codex-bridge/mailbox.test.js`)
1. `writeToMailbox` persists the optional metadata it already validates (`kind`, `priority`, `implementer_run_id`, `slice_id`, `body_hash`) — round-trips through `readMailbox`. (Unit.)
2. `VALID_KINDS` includes `contract`; a `kind:"contract"` message is accepted. (Unit.)
3. Back-compat: older messages without these fields still read cleanly (no field → omitted/null, not a throw). (Unit.)

### Tasks
1. **RED:** add the 3 cases to `mailbox.test.js`.
2. **GREEN:** in `mailbox.js`, extend the persisted message shape (currently `id/from/to/text/timestamp/summary/color/read_at`) to also persist the already-validated optional fields when present; add `contract` to `VALID_KINDS`.
3. **Verify:** `node --test tests/codex-bridge/mailbox.test.js` (incl. existing cases — back-compat).

---

## Slice 3: Contract publication/consumption + UI shim protocol

**Validation:** critical
**Goal:** G3. Spec §7 (contract protocol + shim) — the trickiest slice; read §7 in full before coding.

### Tests required (`tests/codex-bridge/hybrid/contracts.test.js`)
1. `publishContract(...)` writes a `kind:"contract"` mailbox message to the UI owner with `body_hash = sha256:<hash of exact message text>`, AND appends a sidecar `checkpoint` event with `payload.kind="contract_published"` + the same hash. (Integration, fake repo.)
2. `readLatestContract({repoRoot, sliceId})` returns the highest `contract_version` message + its hash. (Unit.)
3. `recordContractConsumed({specPath, sliceId, memberId, bodyHash})` appends a `contract_consumed` checkpoint and updates `latest_contract_hash`/owner `contract_consumed_hash`. (Unit.)
4. Contract-change detection: publishing version 2 after a consumed version 1 surfaces the resync state (`hybrid-contract-changed`), NOT a terminal halt, until UI consumes v2 (spec §7/§10 reconciliation). (Unit.)
5. Shim invariants (spec §7 shim block): the `ui_shim_file` must equal a path in `claude-ui.files` — a shim path outside the UI claim → `hybrid-owner-files-unclaimed`; the shim header records the consumed `body_hash`. (Unit.)
6. **Shim render happy path:** `renderContractShim(contractJson)` produces a valid TS shim from the contract's `types`/`routes` (structural types + route constants/helpers), with a header comment recording the consumed `body_hash`. Round-trip: the rendered shim's recorded hash equals the contract's `body_hash`. (Unit.)
7. **Contract integrity (TDD-panel addition):** `recordContractConsumed` rejects a non-latest or unknown `body_hash`; a publication with a non-monotonic `contract_version` or a wrong `previous_body_hash` is rejected/ignored and does NOT update sidecar `latest_contract_hash`/`contract_version`. (Unit.)

### Tasks
1. **RED:** write `contracts.test.js` cases 1–5.
2. **GREEN:** create `lib/codex-bridge/hybrid/contracts.js` with `publishContract`/`readLatestContract`/`recordContractConsumed` per spec §7. Compute `body_hash` over the exact message text; reuse Slice 2's mailbox persistence; write sidecar checkpoints via the existing implementer-event append path (spec §7 says checkpoint events).
3. **GREEN — shim render + validation:** implement `renderContractShim(contractJson)` (types/routes → TS structural shim + header recording the consumed `body_hash`), the `ui_shim_file` ∈ `claude-ui.files` check, and shim-header hash recording (spec §7 shim rules). The swap-to-real + `hybrid-contract-realization-mismatch` post-integration check is exercised in Slice 6 (runner) — here the publish/consume/render/shim-path mechanics.
4. **Verify:** `node --test tests/codex-bridge/hybrid/contracts.test.js`.

---

## Slice 4: Hybrid halt reasons

**Validation:** standard
**Goal:** G5 classification + G1/G2/G3 halts. Spec §6, §7, §10 (the full hybrid halt list).

### Tests required (extend `tests/codex-bridge/halt-envelope.test.js`)
1. Every new hybrid halt reason is registered and classified **terminal**: `hybrid-ownership-malformed`, `hybrid-owner-files-overlap`, `hybrid-owner-files-unclaimed`, `hybrid-preflight-dirty`, `hybrid-dispatcher-invalid`, `hybrid-contract-not-published`, `hybrid-contract-not-consumed`, `hybrid-contract-stale-at-completion`, `hybrid-codex-backend-failed`, `hybrid-codex-background-lost`, `hybrid-codex-background-timeout`, `hybrid-contract-realization-mismatch`. (Unit, table-driven.)
2. `hybrid-contract-changed` is **NOT registered as a halt reason at all** — per spec §10 it is in-progress sidecar/mailbox resync state, never a halt. Assert it is absent from the halt registry, so autopilot can never treat a normal mid-run contract update as a retryable halt. (Unit — the resync→completion behavior itself is tested in Slice 6 as sidecar state, with `hybrid-contract-stale-at-completion` as the only terminal outcome.)
3. Each terminal reason carries a non-empty `resume_hint` (the actionable hints from spec §6/§10). (Unit.)
4. Unknown `hybrid-*` reasons still fail closed → terminal (existing `isTerminalHalt` behavior). (Unit.)

### Tasks
1. **RED:** add the table-driven cases to `halt-envelope.test.js`.
2. **GREEN:** register the hybrid reasons + hints in `halt-envelope.js` per spec §6/§10 as terminal-with-hint. Do **NOT** register `hybrid-contract-changed` — it is sidecar resync state, not a halt (spec §10); the only contract-change terminal outcome is `hybrid-contract-stale-at-completion`.
3. **Verify:** `node --test tests/codex-bridge/halt-envelope.test.js`.

---

## Slice 5: Sidecar hybrid owner state

**Validation:** critical
**Goal:** audit substrate for G1/G3/G4. Spec §9 (the `hybrid` status block) + §6.9 (members carry `owner`).

### Tests required (extend `tests/codex-bridge/sidecar-*.test.js`)
1. An implementer member may carry an `owner` field (`claude-ui`/`codex-backend`) + actual `runtime_kind`; persisted + round-tripped; legacy members without `owner` still valid. (Unit.)
2. A hybrid status block (spec §9 shape: `owners.{claude-ui,codex-backend}` with status/claimed_files/contract hashes + `latest_contract_hash`/`contract_version`) can be written under the slice phase and read back, WITHOUT replacing `phases.implementer_experts` (the event stream stays the audit trail). (Unit.)
3. Back-compat: existing `implementer_experts` events + `appendImplementDispatch`/`finalizeImplementDispatch` unaffected. (Unit/regression.)
4. **`overlap_rationale` preserved in sidecar member metadata (TDD-panel addition):** AC-G1 requires a rationalized overlap to survive into sidecar member state, not just the parsed plan output — assert a member's `overlap_rationale` round-trips through the sidecar. (Unit.)

### Tasks
1. **RED:** add cases to the relevant sidecar test file.
2. **GREEN:** extend `sidecar.js` to allow `owner`/`runtime_kind` on members and a hybrid status block under the slice phase (additive; unknown fields ignored by legacy readers per spec §6.9/§9). Add a setter/getter mirroring existing phase-state helpers.
3. **Verify:** focused sidecar tests + the full sidecar suite (regression — this file is heavily used).

---

## Slice 6: Hybrid runner (interactive + autopilot)

**Validation:** critical
**Goal:** G1 (enforcement), G4 (autopilot dispatch), G5 (recovery). Spec §6, §8, §9, §10. Largest slice.

### Tests required (`tests/codex-bridge/hybrid/runner.test.js`, deps-injected — no real shell/MCP)
1. Preflight (spec §6): rejects each malformed case before dispatch; clean-checkout requirement for interactive; **worktree creation differs by mode** — interactive creates/reuses ONLY the backend worktree (UI is foreground in the main checkout, soft-enforced); **autopilot creates BOTH a UI worktree and a backend worktree from the same slice-start SHA** (hard isolation for both halves, per spec §9 / the C2 resolution). Starts the two-member sidecar run. (Unit, injected fs/git.)
2. Concurrent dispatch (spec §8/§9): UI owner via the resolved runtime (`claude-inline` interactive / `claude-subagent` autopilot) + backend via `codex-background-bash`, under one `implementer_run_id`, via injected `dispatchFns`. **Autopilot integrates BOTH owner branches** (UI worktree branch + backend worktree branch) via the existing `integrate(...)`, in a deterministic order, onto the integration branch. (Unit.)
3. Contract handoff: runner waits boundedly (`contract_wait_ms`); distinguish (a) timeout with backend still live → non-terminal "blocked/waiting" status (UI may keep doing UI-only work); (b) backend reaches terminal WITHOUT publishing a contract → `hybrid-contract-not-published`. Blocks UI completion until the latest contract hash is consumed. (Unit.)
4. Claimed-file verification (spec §8.7/§8.8), **table-driven for BOTH owners**: a `claude-ui` change outside its claim (foreground diff interactive / UI-worktree diff autopilot) AND a `codex-backend` change outside its claim (backend-worktree diff) each → halt (`implementer-claimed-file-violation` / hybrid wrapper); a rationalized overlap is allowed on either side. (Unit, injected diff.)
5. Background classification (spec §10): status-file states map to completed / `hybrid-codex-backend-failed` / transient-continue / `hybrid-codex-background-lost` / `hybrid-codex-background-timeout`. (Unit, table-driven.)
6. Shim realization (spec §7), BOTH paths: (a) **success** — post-integration the runner swaps the UI shim to re-export the real backend contract, and the final typecheck against the real backend file passes; (b) **failure** — a real backend export mismatching the consumed shim hash → `hybrid-contract-realization-mismatch`. (Unit, injected typecheck result.)
7. `isTerminalHalt` is consulted before any retry; unknown hybrid halts terminal. (Unit.)
8. **Required-owner failure aborts the sibling (TDD-panel addition, spec §9.9):** when a required owner fails, the runner aborts the live sibling (or marks it blocked if it can't be interrupted) and surfaces the halt via the halt-envelope path — never leaves the sibling silently running/waiting. (Unit, injected dispatch that fails one owner.)
9. **Autopilot batch selection reuses DAG non-overlap (TDD-panel addition, AC-G4):** two hybrid slices whose slice-level `**Files:**` overlap are NOT placed in the same ready batch (`maximalFirstFitNonOverlap` at slice level); disjoint hybrid slices may co-run. (Unit, injected DAG/ready-set.)

### Tasks
1. **RED:** write `runner.test.js` cases 1–7 with injected dispatch/fs/git/mailbox deps.
2. **GREEN — types:** create `hybrid/types.js` runtime-kind witness (spec §11) — `claude-inline`, `claude-subagent`, `codex-background-bash`; do not disturb the implementer-experts witness.
3. **GREEN — runner:** create `hybrid/runner.js` composing preflight (Slice 1 ownership) → worktree create (existing `worktree.js`) → concurrent dispatch (existing transports) → contract polling (Slice 3) → claimed-file verification → worktree integrate (existing `integrate(...)`) → shim swap-to-real + final typecheck (spec §7) → halts (Slice 4). DI for all shell/MCP/fs (spec §11 requires injectable deps for unit tests). Interactive vs autopilot differ in: (a) UI runtime kind (`claude-inline` vs `claude-subagent`); (b) foreground-vs-subagent dispatch; AND (c) **worktree topology** — interactive isolates only the backend (UI foreground, soft-enforced); autopilot isolates BOTH halves in separate worktrees from the slice-start SHA and integrates BOTH owner branches (spec §8 vs §9).
4. **Verify:** `node --test tests/codex-bridge/hybrid/runner.test.js`.

---

## Slice 7: Skill + autopilot integration

**Validation:** critical
**Goal:** G2 (plan-writing guidance) + G4 (autopilot Phase B hybrid branch). Spec §8, §9, §11.

### Tests required (extend `tests/skills/skill-structure.test.js`)
1. `writing-plans/SKILL.md` documents `**Orchestration:** hybrid`, the two-owner block, per-owner claimed files, and that a contract-producing backend slice declares the `codex-backend` owner. (Structure.)
2. `autopilot/SKILL.md` has a Phase B **hybrid branch** documenting: routing hybrid slices away from the symmetric implementer-experts branch, UI-subagent + background-Codex concurrent dispatch, contract wait, contract-change resync, background-Codex recovery, and claimed-file verification. (Structure.)
3. The hybrid orchestration type is named consistently (`**Orchestration:** hybrid`) across both skills. (Structure.)

### Tasks
1. **RED:** add the structure assertions.
2. **GREEN — writing-plans:** document the hybrid plan syntax (spec §5) + when to recommend it (clear UI/backend split with a contract boundary).
3. **GREEN — autopilot:** add the Phase B hybrid branch (spec §9) — detect `**Orchestration:** hybrid`, route to `hybrid/runner.js` in autopilot mode (UI subagent + background Codex), integrate + surface halts via the existing halt-envelope path. Cross-reference the existing per-phase thread-loss recovery.
4. **Verify:** `node --test tests/skills/skill-structure.test.js`.

---

## Validation

```bash
npm test                                  # full suite (source of truth)
npm run test:affected                     # fast local: only impacted tests (TIA)
node --test tests/codex-bridge/hybrid/    # the new module tree
```

Per spec §13: unit (ownership/contracts/runner/halt-envelope), integration (fixture hybrid plans:
disjoint files → preflight + two members; two hybrid slices → DAG `maximalFirstFitNonOverlap`; backend
publishes contract → UI consumes → integrate; backend exits without contract → `hybrid-contract-not-published`),
and smoke/manual (interactive: Claude edits a UI file in the main checkout while Codex writes a
route/type file in a worktree, verify no same-file edit + clean cherry-pick; autopilot: UI subagent +
background Codex unattended produce equivalent sidecar events).

## Acceptance criteria

Mirrors spec §12 AC-G1..AC-G5. The plan ships when all five slices' tests are green and the
interactive + autopilot smoke runs demonstrate non-overlap, contract publish/consume, and clean
integration.

## Non-goals (spec §14)

>2 owners per slice; contract schema inference from source; mid-run push into `codex exec`;
general-purpose ownership roles beyond `claude-ui`/`codex-backend`.
