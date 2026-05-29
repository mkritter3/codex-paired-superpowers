# Hybrid Development Mode Design

**Status:** spec-draft
**Date:** 2026-05-28
**Owner:** mkr
**Target version:** v0.14.0
**Validation:** critical
**Spec path:** `docs/specs/2026-05-28-hybrid-dev-mode-design.md`

## 1. Context and problem

The plugin already supports single-implementer autopilot, dependency-graph batching, background Codex dispatch, mailbox coordination, and v0.10.0 implementer-experts fanout. Those features are close to the requested hybrid workflow, but they do not yet express the specific product invariant:

- Claude owns UI/UX work in the foreground or as an autopilot subagent.
- Codex owns backend/contracts/routing/wiring in a background process.
- The two owners can run concurrently only when their file claims are mechanically disjoint or every overlap is explicitly rationalized.
- The backend owner publishes the contract before the UI owner commits to an API shape.
- Autopilot can run the same asymmetric mode unattended and recover from Codex background/thread loss without leaving the UI side blocked.

The core design choice is to extend the existing plan, claimed-files, mailbox, worktree, dispatch, sidecar, and halt-envelope primitives. Hybrid mode must not introduce a second scheduling or audit substrate.

## 2. Goals

<<<GOALS>>>
- Goal 1: A developer can run one "hybrid" development session where Claude works inline on UI/UX while Codex works concurrently in the background on backend/contracts/routing/wiring, and the two are guaranteed never to edit the same file. Overlap is rejected unless explicitly rationalized.
- Goal 2: Work ownership is assigned per plan slice as a UI owner vs a backend owner. Reading a plan shows which agent owns each slice, and a hybrid run refuses to start if two owners' file sets overlap without rationale or if ownership is ambiguous.
- Goal 3: The backend/contract owner publishes the contract, including types, API shapes, and routes, to a shared observable channel as soon as it is defined. The UI owner consumes that real contract, stubbing only briefly until it lands, and contract changes are surfaced rather than silently diverged.
- Goal 4: The same hybrid mode runs unattended under autopilot. Per hybrid slice it drives a Claude UI worker subagent and a background Codex backend worker concurrently, integrates results, and surfaces halts the same way single-agent autopilot does.
- Goal 5: If the background Codex side halts or loses its thread mid-run, the hybrid run detects it, classifies it terminal vs transient, recovers or surfaces an actionable hint, and never leaves the other side silently blocked.
<<<END_GOALS>>>

## 3. Codebase audit

- Audit: `sed -n '1,220p' lib/codex-bridge/prompts/system-rubric.md` -> loaded the L11 reviewer rubric. It requires independent codebase audit, reuse over rebuild, goal-first critique, and command/result evidence before SHIP.
- Audit: `sed -n '1,220p' lib/codex-bridge/prompts/verdict-format.md` -> loaded the required verdict block format.
- Audit: `sed -n '330,430p' lib/codex-bridge/implementer/frontmatter.js` -> existing `validateImplementers` rejects overlapping `files` unless all overlapping members have non-empty `overlap_rationale`. This directly satisfies the non-overlap guard for Goals 1 and 2 and must be reused.
- Audit: `sed -n '1,520p' lib/codex-bridge/implementer/frontmatter.js` -> current `**Implementers:**` parsing supports `member_id`, `adapter`, `model`, `required`, `files`, and `overlap_rationale`. It has no `owner`, `hybrid`, `contract`, or UI/backend role concept. Hybrid ownership is missing and must extend this parser/validator rather than create an unrelated plan syntax.
- Audit: `sed -n '1,280p' lib/codex-bridge/implementer/orchestrator.js` -> `dispatchImplementers` runs an array of implementers in symmetric `Promise.all` fanout, records `started` sidecar events, aborts siblings on required-member failure, and returns success/failed/cancelled arrays. It does not model one foreground Claude owner plus one background Codex owner, nor contract-first handoff. Hybrid should reuse its sidecar event conventions and abort semantics, but not treat it as a complete runner.
- Audit: `sed -n '1,380p' lib/codex-bridge/dispatchers.js` and `sed -n '1,220p' agents/dispatchers.json` -> dispatcher registry already supports `transport: "claude-subagent"` for Sonnet and `transport: "codex-background-bash"` for Codex. Codex requires `docs/codex-implementer-contract.md`. This satisfies the transport foundation for Goals 1 and 4.
- Audit: `sed -n '1,260p' lib/codex-bridge/dependency-graph.js` plus `sed -n '220,520p' tests/codex-bridge/dependency-graph.test.js` -> `buildDAG`, `computeReadySet`, and `maximalFirstFitNonOverlap` schedule disjoint plan slices by `**Files:**`. This is a cross-slice scheduling primitive. It does not validate two owners inside one hybrid slice, but it should still choose which hybrid slices may run concurrently under autopilot.
- Audit: `sed -n '1,560p' lib/codex-bridge/mailbox.js` -> mailbox gives a durable shared channel via `writeToMailbox`, `readUnreadMessages`, and `markManyAsRead`. It validates optional `kind`, `priority`, `implementer_run_id`, `slice_id`, and `body_hash`, but `writeToMailbox` currently persists only `id/from/to/text/timestamp/summary/color/read_at`. Contract metadata would be dropped today, so Goal 3 requires extending persistence, not building a new channel.
- Audit: `sed -n '1,560p' lib/codex-bridge/worktree.js` and `sed -n '1,560p' lib/codex-bridge/worktree-integrate.js` -> worktree creation/bootstrap/reset/remove and ordered cherry-pick integration already exist. Hybrid Codex backend work must use these for isolation and integration rather than inventing another git flow.
- Audit: `sed -n '600,690p' lib/codex-bridge/halt-envelope.js` -> `wrapAsHaltEnvelope` and `isTerminalHalt` fail closed on unknown or malformed halts. This satisfies the classification mechanism for Goal 5, but hybrid-specific halt reasons must be registered to provide actionable hints.
- Audit: `sed -n '1800,1895p' lib/codex-bridge/sidecar.js` -> v0.13.0 thread rotation exists through `setCodexThreadId`, `sidecar-rotate-thread-id`, `isStaleThreadResponse`, and `buildReplayContext`. This covers Codex MCP thread recovery for review sessions, but background `codex exec` also needs status-file/process-state classification.
- Audit: `sed -n '2010,2430p' lib/codex-bridge/sidecar.js` -> `phases.implementer_experts` stores `members`, `claimed_files`, locked events, global `event_seq`, merge, and post-merge review. It has no owner role or contract publication state, but it is the right audit home for hybrid owner events.
- Audit: `rg -n "status_file|finalizeImplementDispatch|appendImplementDispatch|codex-background" lib/codex-bridge skills/autopilot/SKILL.md tests -S` -> legacy Phase B already persists `codex-background-bash` in-progress dispatches with `task_id`, `output_file`, and `status_file`, and promotes them with `finalizeImplementDispatch`. Hybrid must reuse this status-file pattern for backend health.
- Audit: `sed -n '1,260p' skills/autopilot/SKILL.md` and `sed -n '1740,1810p' skills/autopilot/SKILL.md` -> autopilot has Phase B DAG batching, mailbox polling, codex background dispatch prose, halt-envelope usage, and an implementer-experts branch. The implementer-experts branch is symmetric and minimal; hybrid orchestration slots into Phase B as a separate asymmetric branch.
- Audit: `sed -n '250,330p' skills/writing-plans/SKILL.md` -> writing-plans recommends implementer-experts when file partitions are clear and shows an `**Implementers:**` block. It does not support per-slice `owner: claude-ui | codex-backend`, so Goal 2 needs plan-writing guidance and parser support.
- Audit: `rg -n "hybrid|claude-ui|codex-backend|contract_ready|contract_ack|contract_version|orchestration_type|owner:" lib skills agents docs tests -S` -> no existing hybrid mode, owner roles, contract-ready protocol, or orchestration type exists. Existing `**Owner:** mkr` fields in docs are document ownership only, not slice ownership.
- Audit: `find lib skills agents docs tests -iname '*hybrid*' -o -iname '*owner*' -o -iname '*contract*'` -> only `docs/codex-implementer-contract.md` and `tests/codex-bridge/implementer/types-contract.test.js` matched relevant contract filenames; no hybrid or owner module exists.
- Audit: `git log --all --oneline --grep='hybrid\|owner\|contract\|codex-background\|mailbox\|dependency-graph' --regexp-ignore-case --max-count=30` -> history shows prior mailbox, dependency graph, implementer-experts, thread rotation, and Codex contract work; no shipped hybrid feature was found.
- Audit: `git status --short` -> working tree was clean before writing this spec.
- Round 2 C1 audit: `rg -n "contract|stub|typecheck|symlink|bootstrap|worktree|shared" docs/specs/2026-05-28-hybrid-dev-mode-design.md lib/codex-bridge/worktree.js skills/autopilot/SKILL.md docs/specs/2026-05-10-v0.7.3-mailbox-and-deps.md docs/architecture/2026-05-12-v0.10.0-implementer-experts-design.md -S` -> existing worktree bootstrap symlinks share configured dependency artifacts such as `node_modules`, but there is no primitive that makes new backend contract files written inside a Codex worktree appear in the foreground checkout before integration.
- Round 2 C1 audit: `rg -n "bootstrap\(|verifyBootstrap|symlink|worktree-bootstrap|contracts|contract" tests lib skills docs -S` -> bootstrap/verifyBootstrap validate preconfigured symlinks; no existing generated contract shim or early contract-file publication primitive exists. Therefore the spec must define a file-level stub-to-real contract consumption protocol rather than relying on mailbox shape alone.

## 4. Existing primitives to extend

Hybrid mode reuses these existing primitives:

- Plan slice boundaries, `**Files:**`, `**DependsOn:**`, and `buildDAG` for cross-slice scheduling.
- `maximalFirstFitNonOverlap` for choosing which ready slices can run at the same time under autopilot. This remains slice-level scheduling, not owner-level validation.
- `**Implementers:**` claimed-file validation in `implementer/frontmatter.js` for owner file partitions.
- Dispatcher registry transports: `claude-subagent` for unattended UI work and `codex-background-bash` for backend work.
- Mailbox for contract publication and owner-to-owner notifications.
- Worktree creation and cherry-pick integration for the Codex backend half.
- Sidecar `phases.implementer_experts` events for auditability.
- Existing `appendImplementDispatch`/`finalizeImplementDispatch` status-file pattern for background Codex liveness.
- `wrapAsHaltEnvelope` and `isTerminalHalt` for terminal/transient classification.
- v0.13.0 thread rotation for stale Codex MCP review threads.

Hybrid mode introduces only the missing glue:

- A hybrid owner validator.
- A contract publication/acknowledgement protocol over mailbox plus sidecar events.
- An asymmetric hybrid runner that composes foreground or subagent Claude UI work with background Codex backend work.
- Hybrid-specific halt reasons and recovery hints.

## 5. Plan syntax

Hybrid mode is opt-in per slice.

```markdown
## Slice 4: Settings screen backed by account preferences API

**Orchestration:** hybrid
**DependsOn:**
- slice-2

**Files:**
- app/settings/SettingsScreen.tsx
- app/settings/useSettingsViewModel.ts
- app/settings/__hybrid_contracts__/account-preferences.ts
- lib/server/routes/account-preferences.ts
- lib/server/contracts/account-preferences.ts
- tests/account-preferences.test.ts

**Implementers:**
- member_id: hybrid-ui@claude:sonnet#0
  owner: claude-ui
  adapter: claude-ui
  model: sonnet
  required: true
  files:
    - app/settings/SettingsScreen.tsx
    - app/settings/useSettingsViewModel.ts
    - app/settings/__hybrid_contracts__/account-preferences.ts
- member_id: hybrid-backend@codex:gpt-5.5#0
  owner: codex-backend
  adapter: codex-background-bash
  model: gpt-5.5
  required: true
  files:
    - lib/server/routes/account-preferences.ts
    - lib/server/contracts/account-preferences.ts
    - tests/account-preferences.test.ts
```

Rules:

- `**Orchestration:** hybrid` activates hybrid validation. Without it, existing single-implementer and implementer-experts behavior remains unchanged.
- A hybrid slice must have exactly two required owners: one `owner: claude-ui` and one `owner: codex-backend`.
- The plan-level adapter for the UI owner is the logical value `adapter: claude-ui`. The runner maps it to the actual runtime for the selected mode:
  - interactive run: foreground Claude in the operator checkout, recorded as `runtime_kind: claude-inline` in sidecar events;
  - autopilot run: Claude subagent using the registry's `claude-subagent` transport, recorded as `runtime_kind: claude-subagent`.
- `codex-backend` must use `adapter: codex-background-bash`.
- Each owner must list at least one claimed file.
- If the UI needs compile-time contract types before backend integration, the UI owner must claim a UI-local contract shim file. Recommended path: `<ui-feature-dir>/__hybrid_contracts__/<contract-name>.ts`. This shim is the only pre-integration file the UI imports for backend types, route constants, and request/response helpers.
- Claimed file overlap is rejected by the same overlap rule as implementer-experts: every overlapping owner must have non-empty `overlap_rationale`. In the default case overlap is forbidden. A rationalized overlap is allowed only when the plan says why both owners must touch that file.
- Hybrid mode rejects ambiguous ownership:
  - missing `owner`;
  - any owner outside `claude-ui | codex-backend`;
  - duplicate owner;
  - optional owner (`required: false`);
  - unsupported adapter for the owner;
  - a `**Files:**` entry not claimed by either owner;
  - an owner claimed file missing from the slice `**Files:**` block.

Implementation requirement: extend `lib/codex-bridge/implementer/frontmatter.js` to parse and preserve optional `owner` and adapter values used by hybrid mode. Extract the existing claimed-file overlap validation into a shared helper if needed. Do not implement a second overlap checker with different behavior.

## 6. Hybrid preflight

Before a hybrid run starts, the runner performs these mechanical checks:

1. Parse the plan and slice section.
2. Verify `**Orchestration:** hybrid`.
3. Parse the `**Implementers:**` block with owner fields.
4. Validate exactly one `claude-ui` owner and one `codex-backend` owner.
5. Validate file partition rules from Section 5.
6. Load dispatcher registry and verify:
   - UI autopilot transport resolves to `claude-subagent`;
   - backend transport resolves to `codex-background-bash`;
   - the Codex contract file exists through the registry's current drift check.
7. Verify the main checkout is clean before interactive hybrid starts. The foreground UI half edits the current checkout, so dirty state would make later ownership and integration checks ambiguous.
8. Create or reuse the backend Codex worktree from the current HEAD using `worktree.create`.
9. Start a sidecar `implementer_experts` run with two members, including `owner` metadata on each member. The runner stores the actual runtime kind for this run (`claude-inline` or `claude-subagent` for UI, `codex-background-bash` for backend), while preserving the plan's logical owner. This extends the existing block; legacy readers ignore unknown fields.

If any preflight fails, wrap the halt through `wrapAsHaltEnvelope` and do not dispatch either owner.

New halt reasons:

- `hybrid-ownership-malformed`: invalid or ambiguous owner declarations.
- `hybrid-owner-files-overlap`: owner file sets overlap without required rationale.
- `hybrid-owner-files-unclaimed`: slice `**Files:**` and owner claimed files do not match.
- `hybrid-preflight-dirty`: interactive foreground checkout is dirty before dispatch.
- `hybrid-dispatcher-invalid`: registry transport or required contract doc is missing.

All five are terminal. The resume hint tells the user to fix the plan or clean the checkout, then rerun hybrid mode.

## 7. Contract publication protocol

The mailbox remains the shared channel. To make contract messages observable and machine-checkable, extend `mailbox.js` so `writeToMailbox` persists the optional metadata it already validates:

```json
{
  "kind": "contract",
  "priority": "urgent",
  "implementer_run_id": "uuid",
  "slice_id": "slice-4",
  "body_hash": "sha256:<64 hex>"
}
```

Also extend `VALID_KINDS` with `contract`.

The backend owner publishes the contract by writing a mailbox message to the UI owner recipient before it relies on the contract in code. The message text contains one fenced JSON object:

```json
{
  "schema": "hybrid-contract/v1",
  "slice_id": "slice-4",
  "contract_version": 1,
  "routes": [
    {
      "method": "GET",
      "path": "/api/account/preferences",
      "response_type": "AccountPreferencesResponse"
    }
  ],
  "types": [
    {
      "name": "AccountPreferencesResponse",
      "fields": {
        "timezone": "string",
        "emailDigest": "boolean"
      }
    }
  ],
  "source_files": [
    "lib/server/contracts/account-preferences.ts"
  ],
  "ui_shim_file": "app/settings/__hybrid_contracts__/account-preferences.ts",
  "notes": "Null values are not returned; missing preference fields use server defaults."
}
```

Contract rules:

- The runner computes `body_hash = sha256:<hash of exact message text>` and stores it in the mailbox message metadata and a sidecar `checkpoint` event with `payload.kind = "contract_published"`.
- The first contract message for a hybrid slice is `contract_version: 1`.
- Any backend contract change after publication must send a new `kind: contract` message with an incremented `contract_version`, the previous `body_hash`, and a short change summary.
- The UI owner must acknowledge the contract by sending a mailbox message to `orchestrator` and by recording a sidecar `checkpoint` event with `payload.kind = "contract_consumed"` and the consumed `body_hash`.
- The UI owner may create an empty or minimal shim only while no contract has been published. Once a contract is published, UI code must align its shim to the latest consumed hash.
- If the backend exits without publishing a contract on a hybrid slice, halt `hybrid-contract-not-published`.
- If the UI owner completes without consuming the latest contract hash, halt `hybrid-contract-not-consumed`.
- If a newer contract hash arrives after the UI consumed an earlier hash, the runner marks the UI owner `needs-contract-resync`, surfaces the change, and pauses UI completion until the UI consumes the newer hash. This is not terminal while the UI owner is still in progress.

### 7.1 File-level contract consumption

Backend contract/type files live in the Codex backend worktree until integration. They do not exist in the foreground checkout or UI subagent worktree during the concurrent phase. The mailbox message is therefore the source of truth for UI compile-time consumption before integration.

Hybrid uses a UI-owned contract shim:

```ts
// app/settings/__hybrid_contracts__/account-preferences.ts
// Generated from hybrid contract body_hash sha256:...
export type AccountPreferencesResponse = {
  timezone: string;
  emailDigest: boolean;
};

export const accountPreferencesRoute = "/api/account/preferences";
```

Rules:

- The shim file must be claimed by `claude-ui` and listed in the slice `**Files:**` block.
- The contract message's `ui_shim_file` must equal that claimed shim path. If it points outside `claude-ui.files`, preflight or consumption halts with `hybrid-owner-files-unclaimed`.
- UI feature code imports the shim, not the backend worktree file, during the concurrent phase.
- The shim header records the consumed `body_hash`. `recordContractConsumed` stores the same hash in sidecar state.
- Pre-integration UI typecheck/verification may run against the shim. This is expected and is the only supported pre-integration type path.
- After backend integration, the UI owner or runner performs the shim swap: replace the structural shim with re-exports from the real backend contract file, or keep only UI-local helpers that import the real backend type. Example:

```ts
export type {
  AccountPreferencesResponse,
} from "../../../lib/server/contracts/account-preferences";

export { accountPreferencesRoute } from "../../../lib/server/contracts/account-preferences";
```

- Final post-integration verification must typecheck the UI against the real backend contract file. If the real backend export does not match the shim shape for the consumed hash, halt `hybrid-contract-realization-mismatch`.
- The backend owner never writes the UI shim. The UI owner never writes the backend contract file. That preserves worktree isolation and claimed-file ownership.

Contract waiting is bounded only while a UI owner is blocked on contract-dependent work. The default `hybrid.contract_wait_ms` is 120000. During that interval the UI owner can work on UI-only shell, layout, copy, and local state inside its claimed files. Interactive mode does not impose a two-minute wall-clock limit on the whole UI session; the timer starts only when the foreground UI worker declares it is waiting for the backend contract. If the timeout expires with no contract publication and the backend is still in progress, the UI side pauses and the runner surfaces a non-terminal status line. If the backend is terminal and still no contract exists, the run halts.

## 8. Interactive hybrid run

Interactive hybrid mode is the developer-facing "Claude inline plus Codex background" workflow.

Flow:

1. Preflight from Section 6.
2. Create the backend worktree and spawn Codex through the existing `codex-background-bash` path. Immediately persist an in-progress dispatch with `task_id`, `output_file`, and `status_file`.
3. Record `started` events for both owners in `phases.implementer_experts`.
4. Inline Claude is both the orchestrator and the UI worker in one conversational thread. It interleaves UI edits with explicit poll checkpoints; there is no continuous background poll loop in the foreground thread.
5. Claude works in the foreground on only `claude-ui` claimed files.
6. The runner polls at explicit checkpoints:
   - backend status file;
   - backend and UI owner mailboxes;
   - orchestrator mailbox;
   - sidecar contract checkpoints.
7. When the backend publishes the contract, the runner injects or surfaces the contract to the foreground Claude UI work. Foreground Claude updates the UI-owned contract shim from Section 7.1 and records the consumed hash before completing the UI side.
8. On UI completion, compute the foreground diff and verify every changed file is in `claude-ui.files`, except rationalized overlaps.
9. On backend completion, reconcile the backend worktree and verify every changed file is in `codex-backend.files`, except rationalized overlaps.
10. Integrate the backend branch into the foreground checkout using the existing ordered cherry-pick integration path. If the foreground checkout has uncommitted UI work, the runner first requires the UI changes to be committed or stashed through the existing autopilot commit convention. No cherry-pick happens onto a dirty checkout.
11. Perform the shim swap from Section 7.1, then run final post-integration typecheck/verification.
12. Run the normal post-implementation review phases.

This design guarantees no silent same-file edits by checking both sides:

- before dispatch through owner file partition validation;
- after completion by comparing actual changed files to each owner claim;
- during integration by relying on git conflict detection and stopping on merge conflicts.

Enforcement is asymmetric in interactive mode. The backend half has hard isolation because Codex edits only its worktree. The foreground UI half is soft-enforced during editing because inline Claude can technically edit any file in the main checkout; violations are caught by checkpoint and completion diff checks, then halted before integration. The residual risk is wasted UI work if inline Claude edits outside its claim. That risk is accepted for interactive mode because foreground Claude is intentionally the operator-facing worker. Autopilot has stronger isolation for both halves because UI and backend both run in worktrees/subprocess contexts, but it still performs the same post-completion claimed-file verification.

## 9. Autopilot hybrid run

Autopilot uses the same plan syntax and contract protocol, but it never uses foreground inline edits. For each hybrid slice in a ready batch:

1. Phase B.PRE builds the DAG with existing `buildDAG`.
2. `computeReadySet` and `maximalFirstFitNonOverlap` choose non-overlapping ready slices. This continues to operate on slice-level `**Files:**`, so multiple hybrid slices can run concurrently only if their whole slice file sets are disjoint.
3. For each selected hybrid slice, the hybrid branch preflights owner partitions.
4. Autopilot creates one worktree per owner from the same slice start SHA. This gives both owners hard filesystem isolation; neither worker edits the integration checkout directly.
5. The UI owner is dispatched in the UI worktree as a Claude subagent using the existing `claude-subagent` transport.
6. The backend owner is dispatched in the backend worktree as background Codex using the existing `codex-background-bash` transport.
7. Both are registered under the same `implementer_run_id` and run concurrently.
8. The runner uses mailbox pre-injection and polling so the UI subagent sees contract messages. The Codex backend prompt includes the existing checkpoint polling instructions plus the new contract-publication requirement.
9. The UI subagent writes or updates the UI-owned contract shim from Section 7.1 and records the consumed hash. Pre-integration UI verification runs against that shim.
10. The runner waits for both owners to reach terminal state, classifies failures, verifies changed files against owner claims, then integrates both owner branches through the existing worktree integration flow.
11. After backend integration, the runner performs the shim swap and final typecheck against the real backend contract file before advancing the slice.
12. Required-owner failure aborts the sibling through the same shared-abort semantics as implementer-experts where a live child can be cancelled. If the sibling cannot be interrupted, the runner marks it blocked and surfaces the halt rather than waiting silently.

Autopilot state adds a small `hybrid` block under the slice phase:

```json
{
  "owners": {
    "claude-ui": {
      "member_id": "hybrid-ui@claude:sonnet#0",
      "status": "in-progress",
      "worktree": ".git-worktrees/slice-4-claude-ui",
      "claimed_files": [
        "app/settings/SettingsScreen.tsx",
        "app/settings/__hybrid_contracts__/account-preferences.ts"
      ],
      "contract_consumed_hash": null,
      "contract_shim_file": "app/settings/__hybrid_contracts__/account-preferences.ts",
      "shim_swapped_to_real_contract": false
    },
    "codex-backend": {
      "member_id": "hybrid-backend@codex:gpt-5.5#0",
      "status": "in-progress",
      "worktree": ".git-worktrees/slice-4-codex-backend",
      "claimed_files": ["lib/server/contracts/account-preferences.ts"],
      "contract_published_hash": null,
      "task_id": "task-abc",
      "status_file": "/abs/.codex-paired/codex/slice-4.status.json"
    }
  },
  "latest_contract_hash": null,
  "contract_version": 0,
  "contract_sync_state": "none|published|consumed|changed"
}
```

This is an extension of the existing sidecar phase state. It must not replace `phases.implementer_experts`; the event stream remains the durable audit trail.

## 10. Codex halt and thread recovery

Hybrid has two Codex failure surfaces:

1. Codex MCP review thread loss during review, plan, or post-merge phases. Reuse v0.13.0 `isStaleThreadResponse`, `buildReplayContext`, and `sidecar-rotate-thread-id`.
2. Background `codex exec` loss during the backend implementation half. Reuse the existing status-file pattern from `codex-background-bash`.

Background classification:

- Status file exists with `status: "completed"` and `exit_code: 0` -> backend owner completed.
- Status file exists with nonzero `exit_code` or blocked sentinel -> terminal halt `hybrid-codex-backend-failed`.
- Status file exists with explicit transient infrastructure marker, for example temporary lock timeout or process still running -> non-terminal status; continue polling until timeout.
- Status file missing while sidecar has an in-progress `task_id` and the Bash task is still known alive -> transient; continue polling.
- Status file missing and the Bash task is no longer known alive -> terminal halt `hybrid-codex-background-lost`.
- Runtime exceeds `hybrid.codex_max_runtime_ms` -> kill best effort and terminal halt `hybrid-codex-background-timeout`.

Register these halt reasons in `halt-envelope.js`:

- `hybrid-codex-backend-failed`: terminal. Hint: inspect backend output/status file and rerun after fixing.
- `hybrid-codex-background-lost`: terminal. Hint: inspect the sidecar task id and status path; rerun the hybrid slice after cleaning stale worktree state.
- `hybrid-codex-background-timeout`: terminal. Hint: inspect or raise the runtime limit only with rationale.
- `hybrid-contract-not-published`: terminal. Hint: backend owner must publish a contract message before UI can finish.
- `hybrid-contract-not-consumed`: terminal. Hint: UI owner must consume the latest contract hash and update code.
- `hybrid-contract-stale-at-completion`: terminal. Hint: UI owner completed against an older contract hash; consume the latest contract and update the shim.
- `hybrid-contract-realization-mismatch`: terminal. Hint: post-integration backend exports do not match the consumed shim; fix either the backend contract implementation or the UI shim and rerun verification.

`hybrid-contract-changed` is not a terminal halt reason. It is an in-progress resync state. The runner records it in sidecar state and mailbox output while the UI owner is still working, then clears it when the UI consumes the latest hash. It becomes terminal only if the UI owner tries to complete while still stale, at which point the halt reason is `hybrid-contract-stale-at-completion`.

The runner always calls `wrapAsHaltEnvelope` before surfacing a halt and always checks `isTerminalHalt` before retrying. Unknown hybrid halts fail closed.

## 11. Files and modules

Expected implementation changes:

- Extend `lib/codex-bridge/implementer/frontmatter.js`:
  - parse optional `owner`;
  - allow hybrid plan adapter values `claude-ui` and `codex-background-bash` only under hybrid validation;
  - expose a shared claimed-file partition validator.
- Add `lib/codex-bridge/hybrid/ownership.js`:
  - `parseHybridOwners(planMarkdown, sliceSection)`;
  - `validateHybridOwnership({ sliceFiles, implementers })`;
  - no duplicate overlap logic; call the extracted frontmatter validator.
- Add `lib/codex-bridge/hybrid/contracts.js`:
  - `publishContract({ repoRoot, specPath, sliceId, implementerRunId, fromMemberId, toOwner, text })`;
  - `readLatestContract({ repoRoot, sliceId })`;
  - `renderContractShim({ contractMessage, shimPath })`;
  - `recordContractConsumed({ specPath, sliceId, memberId, bodyHash, shimPath })`;
  - `verifyShimRealization({ shimPath, backendContractFiles, bodyHash })`.
- Add `lib/codex-bridge/hybrid/runner.js`:
  - compose preflight, dispatch, polling, contract handoff, claimed-file verification, and integration;
  - use dependency injection for tests instead of shelling directly in unit tests.
- Add `lib/codex-bridge/hybrid/types.js`:
  - export a runtime witness that pins the actual hybrid runtime kinds `claude-inline`, `claude-subagent`, and `codex-background-bash`;
  - keep the existing implementer-experts runtime witness unchanged unless the implementation deliberately unifies the two type surfaces.
- Extend `lib/codex-bridge/mailbox.js`:
  - persist validated optional metadata;
  - add `contract` to `VALID_KINDS`;
  - keep backwards compatibility for older messages without these fields.
- Extend `lib/codex-bridge/sidecar.js`:
  - allow owner metadata in implementer members;
  - preserve hybrid status block under the slice phase;
  - do not break legacy `appendImplementDispatch` and `implementer_experts`.
- Extend `lib/codex-bridge/halt-envelope.js` with hybrid halt reasons.
- Extend `skills/writing-plans/SKILL.md`:
  - explain `**Orchestration:** hybrid`;
  - require per-owner claimed files and owner labels;
  - require contract-producing backend slices to declare the backend owner.
- Extend `skills/autopilot/SKILL.md`:
  - add Phase B hybrid branch;
  - document contract wait, contract-change halt, Codex background recovery, and claimed-file verification.

## 12. Acceptance criteria

### AC-G1: Non-overlapping hybrid session

Maps to Goal 1.

- Given a hybrid slice whose `claude-ui.files` and `codex-backend.files` overlap without `overlap_rationale`, preflight halts with `hybrid-owner-files-overlap` before either owner starts.
- Given a hybrid slice with disjoint owner files, interactive hybrid starts Codex in a backend worktree while foreground Claude may edit only UI-owned files.
- Interactive mode documents soft foreground enforcement: inline Claude violations are caught by checkpoint/completion diff checks before integration, while backend Codex has hard worktree isolation.
- Autopilot mode runs both owners in isolated worker contexts and still performs claimed-file verification before integration.
- Given either owner changes a file outside its claim, completion halts with `implementer-claimed-file-violation` or a hybrid-specific wrapper that preserves that halt reason.
- Given a rationalized overlap, the rationale is preserved in parsed output and sidecar member metadata.

### AC-G2: Per-slice owner declaration

Maps to Goal 2.

- Reading a plan slice shows `**Orchestration:** hybrid` and exactly two owner entries: `claude-ui` and `codex-backend`.
- Missing, duplicate, optional, or unknown owners halt with `hybrid-ownership-malformed`.
- A slice `**Files:**` entry not claimed by either owner halts with `hybrid-owner-files-unclaimed`.
- An owner claimed file not listed in the slice `**Files:**` block halts with `hybrid-owner-files-unclaimed`.

### AC-G3: Contract publication and consumption

Maps to Goal 3.

- Backend owner can publish a `kind: contract` mailbox message whose metadata, including `body_hash`, persists on disk.
- The same publication appends a sidecar checkpoint with `payload.kind = "contract_published"` and the same hash.
- UI owner creates or updates a claimed UI-local contract shim from the mailbox contract shape, records `contract_consumed` for the latest hash, and can pass pre-integration UI typecheck against that shim.
- After backend integration, the shim is swapped to imports/re-exports from the real backend contract file and final typecheck verifies the real contract. A mismatch halts `hybrid-contract-realization-mismatch`.
- If backend publishes contract version 2 after UI consumed version 1, the runner enters `hybrid-contract-changed` resync state and rejects UI completion until the UI consumes version 2. If UI attempts to complete stale, halt `hybrid-contract-stale-at-completion`.
- If backend completes without any contract publication, the runner halts `hybrid-contract-not-published`.

### AC-G4: Autopilot unattended hybrid execution

Maps to Goal 4.

- Autopilot Phase B detects hybrid slices and routes them through the hybrid branch rather than the symmetric implementer-experts branch.
- For a hybrid slice, autopilot dispatches the UI owner through `claude-subagent` and the backend owner through `codex-background-bash` in the same Phase B turn.
- DAG batching still uses `maximalFirstFitNonOverlap` at the slice level, so two hybrid slices with overlapping `**Files:**` cannot run in the same batch.
- After both owners complete, the backend worktree is integrated through existing worktree integration and the standard review/verification phases run.
- Required-owner failure surfaces through the same halt-envelope path as existing autopilot halts.

### AC-G5: Codex halt and recovery behavior

Maps to Goal 5.

- A stale Codex MCP thread during review uses `buildReplayContext` and `sidecar-rotate-thread-id` rather than losing prior context.
- A missing background status file with a live task is treated as transient polling state, not a terminal halt.
- A missing background status file with no live task halts `hybrid-codex-background-lost` with an actionable resume hint.
- A nonzero backend status file halts `hybrid-codex-backend-failed` and does not leave the UI owner waiting.
- `isTerminalHalt` is used before any automatic retry, and unknown hybrid halt reasons are terminal.

## 13. Test plan

Unit tests:

- `tests/codex-bridge/hybrid/ownership.test.js`
  - accepts exactly one `claude-ui` and one `codex-backend`;
  - rejects missing/duplicate/unknown/optional owners;
  - rejects unclaimed slice files;
  - delegates overlap rejection to the shared frontmatter overlap validator.
- `tests/codex-bridge/hybrid/contracts.test.js`
  - persists mailbox `kind`, `priority`, `slice_id`, `implementer_run_id`, and `body_hash`;
  - appends contract published and consumed sidecar events;
  - renders a UI-local shim from a mailbox contract shape;
  - detects changed contract hash;
  - detects post-integration real-contract mismatch.
- `tests/codex-bridge/hybrid/runner.test.js`
  - dispatches UI and backend concurrently through injected dispatch functions;
  - waits boundedly for contract publication;
  - typechecks or structurally verifies UI against the shim before integration;
  - swaps the shim to the real backend contract after integration;
  - rejects out-of-claim changed files;
  - classifies background status-file states.
- `tests/codex-bridge/halt-envelope.test.js`
  - every new hybrid halt reason is registered and terminal unless explicitly documented otherwise.

Integration tests:

- Fixture plan with one hybrid slice and disjoint files runs preflight and records two sidecar members with owner metadata.
- Fixture plan with two hybrid slices uses `buildDAG` and `maximalFirstFitNonOverlap` to run only non-overlapping ready slices.
- Background Codex fixture writes a contract message, UI fixture consumes it, both complete, and integration runs.
- UI fixture imports only the UI-owned shim before integration; after integration the shim re-exports the real backend contract and final typecheck passes.
- Background Codex fixture exits without contract publication; runner halts `hybrid-contract-not-published`.

Smoke/manual:

- Interactive hybrid on a small local app: Claude edits a UI file in the main checkout while Codex writes a route/type file in a worktree. Verify no same-file edit, contract message visibility, and clean cherry-pick integration.
- Autopilot hybrid on the same fixture: UI subagent and background Codex run unattended and produce equivalent sidecar events.

## 14. Deferred

- More than two owners in one hybrid slice. The requested feature is exactly one UI owner and one backend owner.
- Contract schema inference from source code. v0.14.0 requires explicit backend publication; automatic extraction can be a later enhancement.
- Mid-run push injection into `codex exec`. The existing architecture cannot push context into an opaque subprocess; Codex uses cooperative mailbox checkpoints.
- General-purpose ownership roles beyond `claude-ui` and `codex-backend`.

## 15. Open implementation notes

- The writing-plans example currently shows `adapter: codex` in one implementer-experts snippet, while `parseImplementersBlock` accepts `codex-cli`. The hybrid implementation should correct the docs when adding owner syntax.
- Mailbox optional metadata validation already exists but persistence does not. This is a small but load-bearing compatibility change for contract observability.
- Existing `dispatchImplementers` remains valuable for symmetric implementer-experts. Hybrid should not force interactive foreground work through that API because foreground Claude is not a child process.
