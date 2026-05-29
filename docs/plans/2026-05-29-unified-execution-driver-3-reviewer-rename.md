# Plan 3 — Reviewer naming migration

**Spec:** `docs/specs/2026-05-29-unified-execution-driver-design.md`

This is plan 3 of the app-scoped unified-execution-driver rollout. It performs the **reviewer
naming migration** (spec §"Reviewer naming migration", lines 247-318). The reviewer sense of "expert"
becomes "reviewer". Writer-side naming (`implementer`, `two-disjoint`, `hybrid-ui`/`hybrid-backend`)
is untouched.

Out of scope (later plans): `docs/execution-model.md`, README cross-links, and the brainstorming/
writing-plans handoff doc edits — those are **Plan 4**.

## Goals (what "done" means)

1. New canonical reviewer-named APIs exist (`composeReviewers`, `reviewer-*` modules, `reviewer-*`
   role ids, `reviewer_teammates` sidecar fields, `**Reviewers:**` plan directive).
2. **Nothing legacy is removed.** Every existing `expert-*` module, the `expert-*` role ids, the
   `**Experts:**` directive, and the `expert_teammates` sidecar shape keep working for one migration
   window. Old sidecars, plans, prompts, and docs stay readable.
3. New writes and new user-facing prose use reviewer naming; old names are accepted on read. This
   includes the operational **skill prose** that drives reviewer dispatch and sidecar writes — new
   prose names the reviewer APIs/fields (Slice 7), not just the runtime functions.

## Design decisions (read before slicing)

1. **Prompt compatibility = loader aliasing + frontmatter rename, NOT byte-identical files.** The 7
   role prompts are renamed `expert-<x>.md` → `reviewer-<x>.md` via `git mv`, and **each renamed
   file's frontmatter `role_id:` is changed `expert-<x>` → `reviewer-<x>`**. This is required because
   `loadRolePrompt` (`role-prompts-loader.js:185`) throws when `frontmatter.role_id !== <canonical
   roleId>`. Because the frontmatter byte changes, the file's sha256 changes too — so "content
   unchanged" is false; the lock MUST be regenerated (Task 5). `roleIdToFilename` maps BOTH
   `reviewer-<x>` and `expert-<x>` → `reviewer-<x>.md`. To keep `loadRolePrompt('expert-ui')` working,
   the loader **canonicalizes** the requested id (`expert-<x>` → `reviewer-<x>`) before the role_id
   strict-equality check and before the lock-hash lookup. `expert-template.md` is NOT a role id (never
   resolved through `resolveIdentity`), so it stays as-is; the lock generator still emits an
   `expert-template` key for it (acceptable — it is not a reviewer role).
2. **Canonical id is `reviewer-<role>`; `expert-<role>` is accepted on input.** `resolveIdentity`
   returns `id: 'reviewer-<role>'`. The resolver accepts a role name (`ui`, `security`, …) exactly as
   today — role names are unprefixed, so no caller changes there. Code that passes a full id
   (`expert-ui`) keeps working because the loader canonicalizes + aliases it.
3. **expert-* modules become re-export shims.** Each `lib/codex-bridge/expert-*.js` re-exports from
   its `reviewer-*.js` sibling. No behavior lives in two places. `composeExperts` becomes a thin
   wrapper around `composeReviewers`; `selectTeammates` keeps its name but returns reviewer
   identities. `PHASE_DEFAULTS`/`SIGNAL_ROLES` are currently **module-local** in `role-composer.js`
   (not exported) — they move into `reviewer-composer.js` and are re-exported only if a grep shows an
   external importer (today there is none).
4. **Composer stays pure; the directive warning is returned, not written.** When both `**Reviewers:**`
   and `**Experts:**` are present, `composeReviewers` uses Reviewers and returns a
   `directiveWarning` string. The calling skill writes that warning to the sidecar audit (the composer
   does not touch the sidecar today and must not start).
5. **Sidecar: canonical `reviewer_teammates`, dual-read, migrate-on-load via `migrateIfNeeded`.** New
   writes use `reviewer_teammates` + `reviewers_selected`/`reviewer_turn_ids`/`reviewer_blockers`.
   Readers accept both. The migration runs in the **existing `migrateIfNeeded` seam**
   (`sidecar.js:146`), not in a per-read accessor, so it is guarded and runs at most once: migrate
   only when `expert_teammates && !reviewer_teammates`, then append a migration record matching the
   established shape `{ from_schema, to_schema, action, migrated_at }` to `sidecarData.migrations[]`
   and `saveSidecar`. The migration record uses
   `{ from_schema: 'expert_teammates', to_schema: 'reviewer_teammates', action: 'expert_teammates →
   reviewer_teammates', migrated_at: <iso> }`. `getTeammatesBlock(sidecar)` is a **pure read**:
   returns `reviewer_teammates ?? expert_teammates` (no write, no record append), so repeated reads
   never double-append. `appendExpert*` functions delegate to the `appendReviewer*` canonical
   functions.
6. **Old error codes survive one release.** `role-composer-fan-out-unjustified` is still thrown (tests
   and `expert-archive` HALT_REASONS_PRESERVE depend on the literal). New reviewer-named code may add a
   reviewer-named alias message but must keep emitting the old `.code`.
7. **dispatchers.json keeps its `experts` JSON key during the window; entries gain reviewer
   canonical + a `legacy_id`.** `dispatchers.js` treats `experts` as a reserved non-implementer key
   (`RESERVED_NON_IMPLEMENTER_KEYS = new Set(['experts'])`, `dispatchers.js:33`) — the implementer
   loader skips it; the actual consumers are the reviewer/expert runtime + the registry test (no
   `registry.experts.<role>` reader exists in `dispatchers.js` itself). Renaming the JSON key would
   break those consumers, so the key stays `experts` for now (renaming it is deferred to a future
   cleanup release — see Out of scope). Each role entry's `id` becomes `reviewer-<role>` and `prompt`
   becomes `lib/codex-bridge/prompts/reviewer-<x>.md` (canonical), and a `legacy_id: "expert-<role>"`
   field is added so the old id is still discoverable. Legacy `expert-<role>` ids keep resolving
   because `resolveIdentity` takes the unprefixed role name and the loader aliases the full id — the
   registry change does not alter resolution, only the stamped canonical id + prompt path.
8. **Role-routing resolver accepts `reviewer-*`; recommendation registry stays expert-keyed this
   window (canonicalize on lookup).** This is the load-bearing downstream consequence of decision 2:
   once `composeReviewers` returns `reviewer-*` identities, orchestrator code calls
   `resolveAdapter(identity.id, …)` with a `reviewer-*` id. Today `resolver.js` gates ids on
   `REVIEWER_ROLE_PREFIX = /^(paired-reviewer|expert-)/` (`resolver.js:37`) and looks them up in the
   `expert-*`-keyed `role-recommendations.json` via `pickRecommendations`, which throws `UNKNOWN_ROLE`
   for an unknown key. So Slice 3 extends the prefix to `/^(paired-reviewer|reviewer-|expert-)/` and
   makes `pickRecommendations` canonicalize the lookup key `reviewer-<x>` → `expert-<x>` when the
   reviewer key is absent. The recommendation JSON keeps its `expert-*` keys (single source of truth)
   for this window; renaming those keys is deferred to Plan 4. Both `resolveAdapter('reviewer-test')`
   and the legacy `resolveAdapter('expert-test')` therefore resolve to the same ladder.

## Slice dependency order

1 (prompts/loader/lock) → 2 (resolver/ids/dispatchers) → 3 (role-routing accepts reviewer-*) →
4 (composer) → 5 (runtime family) ; 6 (sidecar) is independent of 1-5 ; 7 (plan directive) depends on
4 ; 8 (skill prose) depends on 3 (resolveAdapter accepts reviewer-*), 4 (composeReviewers),
6 (reviewer sidecar fields), and 7 (`**Reviewers:**` directive).

---

## Slice 1: Reviewer prompt files + frontmatter rename + loader canonicalize + lock `--check`

**Validation:** critical

Spec authority: §"Prompt and role ids" lines 281-299. Foundation slice: reviewer-* ids must load real
content, and legacy expert-* ids must alias to the same file without tripping the loader's strict
`role_id` check.

### Files

- `lib/codex-bridge/prompts/reviewer-{ui,ux,architecture,backend,ai-harness,test,security}.md` (new
  via `git mv` from `expert-*.md`; frontmatter `role_id:` edited to `reviewer-<x>`).
- `lib/codex-bridge/role-prompts-loader.js` (modify `roleIdToFilename` for dual-accept; add
  `canonicalizeRoleId`; use it in `loadRolePrompt`'s strict check + hash lookup).
- `lib/codex-bridge/role-prompts.lock.json` (regenerate — hashes change because frontmatter changed).
- `scripts/generate-role-prompts-lock.mjs` (modify: `filenameToRoleId` maps `reviewer-<x>.md` →
  `reviewer-<x>`; add a `--check` mode that recomputes the `prompts` map and compares it to the
  on-disk lock, **ignoring `generated_at`**, exiting non-zero on drift).
- `tests/codex-bridge/role-prompts-loader.test.js` (modify: dual-accept + canonicalize assertions).
- `tests/codex-bridge/role-prompts-lock-check.test.js` (new: `--check` passes on a fresh lock, fails
  on a tampered one).

### Tasks

1. (RED) In `role-prompts-loader.test.js`, add tests:
   - `loadRolePrompt('reviewer-ui')` resolves and returns content with a non-empty `hash`.
   - `loadRolePrompt('expert-ui')` returns the **same** `.content` and `.hash` as `reviewer-ui` (alias
     proof) and `.roleId === 'reviewer-ui'` (canonicalized).
   - `roleIdToFilename('reviewer-security') === 'reviewer-security.md'` and
     `roleIdToFilename('expert-security') === 'reviewer-security.md'`.
   - `roleIdToFilename('paired-reviewer') === 'system-rubric.md'` (unchanged).
   - An unknown id (`'reviewer-nope'` with no file) still throws `RolePromptError`.
   Run — fails (files not renamed, frontmatter still `expert-*`, no canonicalize).
2. (GREEN) `git mv` the 7 role prompt files `expert-<x>.md` → `reviewer-<x>.md`. Leave
   `expert-template.md` untouched. In each renamed file, change frontmatter `role_id: expert-<x>` →
   `role_id: reviewer-<x>` (the only content edit).
3. (GREEN) Edit `role-prompts-loader.js`:
   ```js
   function canonicalizeRoleId(roleId) {
     if (typeof roleId === 'string') {
       const m = roleId.match(/^expert-(.+)$/);
       if (m) return `reviewer-${m[1]}`;
     }
     return roleId;
   }
   function roleIdToFilename(roleId) {
     if (roleId === 'paired-reviewer') return 'system-rubric.md';
     if (typeof roleId === 'string') {
       const m = roleId.match(/^(?:reviewer|expert)-(.+)$/);
       if (m) return `reviewer-${m[1]}.md`;
     }
     throw new RolePromptError(
       `unknown role id "${roleId}" — expected "paired-reviewer", "reviewer-*", or "expert-*"`,
       { roleId },
     );
   }
   ```
   In `loadRolePrompt`, compute `const canonical = canonicalizeRoleId(roleId);` and compare
   `frontmatter.role_id !== canonical` (instead of `!== roleId`), return `roleId: canonical`, and key
   the hash/lock lookup by `canonical`. Legacy `expert-ui` thus loads `reviewer-ui.md` (declaring
   `role_id: reviewer-ui`) without a mismatch throw.
4. (GREEN) Update `scripts/generate-role-prompts-lock.mjs`:
   - `filenameToRoleId`: map `reviewer-<x>.md` → `reviewer-<x>` (and keep `system-rubric.md` →
     `paired-reviewer`; `expert-template.md` → `expert-template` as today).
   - Add `--check`: build the `prompts` map in memory, read the existing lock, and assert
     `deepEqual(existing.prompts, computed.prompts)` (compare ONLY the `prompts` object — ignore
     `generated_at`). On drift, write a diff summary to stderr and `process.exit(1)`; on match, print
     `lock up to date` and exit 0. Default (no `--check`) still writes the lock.
   - Run `node scripts/generate-role-prompts-lock.mjs` to regenerate `role-prompts.lock.json`.
5. (RED→GREEN) In `role-prompts-lock-check.test.js`: after regen, spawn
   `node scripts/generate-role-prompts-lock.mjs --check` and assert exit 0; then write a tampered
   lock to a temp path (or monkeypatch) and assert exit 1. (Use the existing child-process test shape
   in the repo if one exists; otherwise import a `check()` export.)
6. Run `node --test tests/codex-bridge/role-prompts-loader.test.js tests/codex-bridge/role-prompts-lock-check.test.js` — green.

### Tests required

1. **`reviewer-*` ids load real prompt content.** `loadRolePrompt('reviewer-ui')` returns
   frontmatter+body with a hash that matches the lock. Pins the rename + frontmatter edit + lock regen.
2. **`expert-*` ids alias to the same content (no regression).** `loadRolePrompt('expert-ui')` returns
   identical `.content`+`.hash` to `reviewer-ui` and canonical `.roleId`. Pins Goal 2 + the loader
   canonicalize fix (the round-1 strict-check finding).
3. **`roleIdToFilename` maps both prefixes + `paired-reviewer`.** Direct unit on the mapping function.
4. **Unknown id throws.** Negative test: a `reviewer-*`/`expert-*` id with no backing file still
   throws `RolePromptError`; the loader does NOT silently empty-load.
5. **Lock integrity + `--check`.** Every `reviewer-*` key in the lock has a backing file and matching
   sha256; `generate-role-prompts-lock.mjs --check` exits 0 on a fresh lock and non-zero on a tampered
   one (ignoring `generated_at`).

---

## Slice 2: Reviewer resolver + canonical `reviewer-*` ids + dispatchers registry

**Validation:** critical

Spec authority: §"Module and API migration" lines 263-279, §"Prompt and role ids" line 297. The
resolver stamps the canonical id onto every selected reviewer; downstream sidecar records and mailbox
ids flow from here.

### Files

- `lib/codex-bridge/reviewer-resolver.js` (new — canonical `resolveIdentity`).
- `lib/codex-bridge/expert-resolver.js` (modify — re-export from reviewer-resolver; keep
  `ExpertResolverError` name exported for back-compat).
- `agents/dispatchers.json` (modify — per design decision 7: each `experts.<role>` entry gets
  `id: reviewer-<role>`, `prompt: …/reviewer-<x>.md`, and a new `legacy_id: "expert-<role>"`; the
  `experts` JSON key is retained).
- `tests/codex-bridge/expert-resolver.test.js` (modify) + `tests/codex-bridge/reviewer-resolver.test.js`
  (new).
- `tests/codex-bridge/dispatchers-experts-registry.test.js` (modify).

### Tasks

1. (RED) In a new `reviewer-resolver.test.js`, assert:
   - `resolveIdentity('ui', repoRoot)` returns `{ id: 'reviewer-ui', role: 'ui', promptPath: <ends
     with reviewer-ui.md>, source: 'builtin' }`.
   - `resolveIdentity('UI', …)`/invalid names throw `ReviewerResolverError` with code
     `invalid-role-name` (regex `^[a-z][a-z0-9-]{0,47}$` unchanged).
   - A missing role throws code `reviewer-not-found`.
   In `expert-resolver.test.js`, add: `resolveIdentity` imported from `expert-resolver.js` returns the
   SAME `id: 'reviewer-ui'` (proves the shim delegates) and `ExpertResolverError` is still exported and
   is the same class object as `ReviewerResolverError` (alias — so `role-composer.js:98`'s
   `instanceof ExpertResolverError` keeps working).
   Run — fails (no reviewer-resolver; expert-resolver still returns `expert-ui`).
2. (GREEN) Create `reviewer-resolver.js`: move the resolver body here. Export `resolveIdentity` and
   `ReviewerResolverError`. Construct ids as `reviewer-${role}`. Error codes become
   `invalid-role-name`, `reviewer-prompt-unreadable`, `reviewer-not-found`. Prompt path resolution
   uses the `reviewer-<role>.md` convention (a repo-override path may check `reviewer-<role>.md` then
   fall back). Keep the path-traversal guard.
3. (GREEN) Rewrite `expert-resolver.js` as a shim:
   ```js
   export { resolveIdentity, ReviewerResolverError as ExpertResolverError } from './reviewer-resolver.js';
   ```
   Grep `from './expert-resolver` and `new ExpertResolverError` / `instanceof ExpertResolverError`
   across lib/ to confirm no other code constructs the error directly except via this export.
4. (GREEN) In `agents/dispatchers.json`, for each of the 7 `experts.<role>` entries: set
   `id: "reviewer-<role>"`, `prompt: "lib/codex-bridge/prompts/reviewer-<x>.md"`, and add
   `legacy_id: "expert-<role>"`. Keep the `experts` key. Confirm `dispatchers.js:227`'s consumer still
   reads what it needs (it reads `id`/`prompt`/`phases`/`domains`).
5. (GREEN) Update `dispatchers-experts-registry.test.js`: assert each role's `id` is `reviewer-<role>`,
   `legacy_id` is `expert-<role>`, `prompt` ends `reviewer-<x>.md`, AND that resolving the legacy id
   path still works (loader alias).
6. Run `node --test tests/codex-bridge/reviewer-resolver.test.js tests/codex-bridge/expert-resolver.test.js tests/codex-bridge/dispatchers-experts-registry.test.js`.

### Tests required

1. **Canonical id is `reviewer-<role>`.** `reviewer-resolver` returns `reviewer-ui`. Pins Goal 1.
2. **expert-resolver shim returns the canonical id + shares the error class.** Proves the rename is a
   re-export, not a fork (Goal 2 + decision 3), and that `instanceof ExpertResolverError` is preserved.
3. **Resolver error taxonomy preserved.** `invalid-role-name` still thrown for bad names; new
   `reviewer-not-found`/`reviewer-prompt-unreadable` codes present.
4. **dispatchers.json: reviewer canonical id + prompt + legacy_id per role.** Registry test asserts the
   exact dual shape from decision 7 (not "a list").

---

## Slice 3: Role-routing resolver accepts `reviewer-*` ids

**Validation:** critical

Spec authority: §"Module and API migration" lines 263-279 (canonical lookups use `reviewer-*`). This
slice removes the load-bearing break that decision 2 introduces: `composeReviewers` (Slice 4) returns
`reviewer-*` identities, and orchestrator code passes `identity.id` to `resolveAdapter`. Without this
slice, `resolveAdapter('reviewer-architecture')` throws `UNKNOWN_ROLE`. It lands BEFORE the composer
flips ids so reviewer ids resolve everywhere by the time they are produced.

This slice also covers the two role-routing **override** paths (round-3 finding): the project
`.codex-paired/role-routing.json` validator rejects override keys absent from the recommendation set
(`config-loader.js:215`), and `resolveAdapter`'s `routing.has(role)` lookup is exact
(`resolver.js:97`) — so a `reviewer-*` override key would be rejected at load, and a legacy
`expert-*` override key would NOT apply when a caller resolves the `reviewer-*` twin. Both must accept
the canonicalized form for the migration window.

### Files

- `lib/codex-bridge/role-routing/resolver.js` (modify: extend `REVIEWER_ROLE_PREFIX`; canonicalize the
  recommendation lookup key `reviewer-<x>` → `expert-<x>` in `pickRecommendations`; canonicalize the
  user-override lookup so a legacy `expert-<x>` override applies to a requested `reviewer-<x>` role).
- `lib/codex-bridge/role-routing/config-loader.js` (modify `validateUserRouting`: accept a
  `reviewer-<x>` override key by canonicalizing to `expert-<x>` for the `recommendations.has` check;
  keep rejecting genuinely-unknown roles).
- `tests/codex-bridge/role-routing/resolver.test.js` (modify) +
  `tests/codex-bridge/role-routing/config-loader.test.js` (modify).

### Tasks

1. (RED) In the resolver test, assert:
   - `resolveAdapter('reviewer-architecture', availableCLIs)` returns the SAME resolved ladder/adapter
     as `resolveAdapter('expert-architecture', availableCLIs)` (canonicalized recommendation lookup).
   - `resolveAdapter('reviewer-test', …)` resolves (does not throw `UNKNOWN_ROLE`).
   - `resolveAdapter('expert-test', …)` still resolves unchanged (regression guard).
   - **Override aliasing:** with `userRouting` containing only a legacy `expert-test` entry,
     `resolveAdapter('reviewer-test', …, userRouting)` applies that override; and a `reviewer-test`
     override entry applies to a `resolveAdapter('reviewer-test', …)` call.
   - `isReviewerRole('reviewer-ui') === true` and `isReviewerRole('expert-ui') === true`.
   - **Reviewer audit-warning preserved:** `resolveAdapter('reviewer-test', …, userRouting that
     routes the role write-allowed)` returns `audit_warnings` including `reviewer-role-write-allowed`
     (the `resolver.js:71` `isReviewerRole && write-allowed` path must fire for the new `reviewer-*`
     prefix); and a legacy `expert-test` override that maps to write-allowed, applied to a requested
     `reviewer-test`, still produces the same reviewer-class warning.
   In `config-loader.test.js`: a `.codex-paired/role-routing.json` with a `reviewer-test` key loads
   without the `references unknown role` error; a genuinely-unknown role (`reviewer-nope`) still
   throws.
   Run — fails (prefix rejects/`UNKNOWN_ROLE`; override key rejected; exact override miss).
2. (GREEN) Change `REVIEWER_ROLE_PREFIX` to `/^(paired-reviewer|reviewer-|expert-)/`. In
   `pickRecommendations`, before throwing `UNKNOWN_ROLE`: if `!recs.has(role)` and `role` matches
   `^reviewer-`, retry with `role.replace(/^reviewer-/, 'expert-')`; if that key exists, use it.
   Preserve the original `UNKNOWN_ROLE` (with the originally-requested role in `details.role`) when
   neither key exists, and keep explicit-override error codes
   (`override-cli-unavailable`/`override-variant-unknown`) untouched.
3. (GREEN) In `resolveAdapter`, when `!routing.has(role)` and `role` matches `^reviewer-`, also check
   `routing.has(role.replace(/^reviewer-/, 'expert-'))` so legacy override files keep applying.
4. (GREEN) In `validateUserRouting` (config-loader.js), canonicalize the override key
   `reviewer-<x>` → `expert-<x>` before the `recommendations.has(role)` check so reviewer override
   keys are accepted.
5. Run `node --test tests/codex-bridge/role-routing/resolver.test.js tests/codex-bridge/role-routing/config-loader.test.js` + `npm run test:affected`.

### Tests required

1. **`reviewer-*` ids resolve to the same ladder as their `expert-*` twin.** Canonicalized lookup.
   Pins decision 8.
2. **Legacy `expert-*` ids still resolve unchanged.** Regression guard (Goal 2).
3. **Override aliasing both directions.** A legacy `expert-*` override applies to a requested
   `reviewer-*` role, AND a new `reviewer-*` override key loads + applies (round-3 finding).
4. **`isReviewerRole` accepts both prefixes.** Direct unit on the prefix predicate.
5. **Unknown reviewer/expert id still throws `UNKNOWN_ROLE`** with the requested role in details (no
   silent fallback to a wrong ladder); unknown override role still rejected at load.
6. **Reviewer-class audit warning fires for `reviewer-*` ids.** `resolveAdapter('reviewer-test', …)`
   routed write-allowed returns `audit_warnings` containing `reviewer-role-write-allowed`
   (`resolver.js:71` `isReviewerRole && write-allowed`), AND a legacy `expert-test` write-allowed
   override applied to a requested `reviewer-test` still emits that reviewer-class warning. Pins that
   extending `isReviewerRole` to the `reviewer-` prefix preserves the downstream audit-warning path
   (TDD-review finding).

---

## Slice 4: `composeReviewers` canonical + `composeExperts` wrapper

**Validation:** standard

Spec authority: §"Module and API migration" lines 263-279. Selection logic moves to a reviewer-named
module; the old name becomes a wrapper. The fan-out error code literal is preserved (decision 6).

### Files

- `lib/codex-bridge/reviewer-composer.js` (new — canonical `composeReviewers`; owns `PHASE_DEFAULTS`/
  `SIGNAL_ROLES`).
- `lib/codex-bridge/role-composer.js` (modify — `composeExperts` wraps `composeReviewers`; keep
  `role-composer.js` exporting `composeExperts` for back-compat).
- `tests/codex-bridge/role-composer.test.js` (modify) + `tests/codex-bridge/reviewer-composer.test.js`
  (new).

### Tasks

1. (RED) In `reviewer-composer.test.js`:
   - `composeReviewers({ phase: 'spec-review', signals: {}, repoRoot })` returns
     `{ selected, fanOutRationale, selectionReasons, directiveWarning }`; `selected[].id` is
     `reviewer-*`; `selectionReasons` keys are `reviewer-<role>`; `directiveWarning === null`.
   - `>5` selected with no `fanOutRationale` throws with `.code === 'role-composer-fan-out-unjustified'`
     (literal preserved).
   In `role-composer.test.js` add: `composeExperts(args)` returns deep-equal output to
   `composeReviewers(args)` (wrapper proof).
   Run — fails (no reviewer-composer; composeExperts still returns `expert-*` reason keys).
2. (GREEN) Create `reviewer-composer.js` with the composition body + `PHASE_DEFAULTS`/`SIGNAL_ROLES`.
   `selectionReasons` keys become `reviewer-${role}`. Identities come from the reviewer-resolver
   (already `reviewer-*` after Slice 2). Add `directiveWarning: null` to the return (populated in
   Slice 7).
3. (GREEN) Rewrite `role-composer.js`:
   ```js
   export { composeReviewers } from './reviewer-composer.js';
   import { composeReviewers } from './reviewer-composer.js';
   export function composeExperts(args) { return composeReviewers(args); }
   ```
   Grep `from './role-composer'` for `PHASE_DEFAULTS`/`SIGNAL_ROLES` importers first; if any exist,
   re-export them from `role-composer.js`. (Audit showed they are module-local today, so likely no
   re-export needed.)
4. Run the two composer test files + `tests/skills/skill-dispatch-integration.test.js` (which calls
   `composeExperts`) — all green.

### Tests required

1. **`composeReviewers` returns reviewer-keyed selection.** `selected[].id` and `selectionReasons`
   keys are `reviewer-*`; `directiveWarning` present (null). Pins Goal 1 + decision 2.
2. **`composeExperts` is a faithful wrapper.** Deep-equal to `composeReviewers` for the same args.
   Pins Goal 2.
3. **Fan-out error code literal preserved.** `.code === 'role-composer-fan-out-unjustified'` still
   thrown (decision 6 — `expert-archive` HALT_REASONS_PRESERVE depends on it).
4. **Existing composeExperts callers unaffected.** `skill-dispatch-integration.test.js` stays green
   (regression guard).

---

## Slice 5: Reviewer runtime family (runtime / turn / output-parser / dm-scheduler / archive)

**Validation:** standard

Spec authority: §"Module and API migration" lines 267-279. These are mechanical re-export shims: the
canonical module gets the reviewer name; the `expert-*` file re-exports it. No behavior changes.

### Files (each new reviewer module + its expert shim)

- `reviewer-runtime.js` (new) ← `expert-runtime.js` becomes a shim. Canonical exports:
  `selectReviewers` (= `composeReviewers`), `runTurn`, `archive`, `resolveIdentity`, `pollInbox`.
  Keep `selectTeammates` as a compat alias of `selectReviewers` (spec line 278).
- `reviewer-turn.js` (new) ← `expert-turn.js` shim. Exports `runTurnWithDeps`, `assembleSpawnPrompt`,
  `runTurn`.
- `reviewer-output-parser.js` (new) ← `expert-output-parser.js` shim. Canonical
  `parseReviewerOutput` + keep `parseExpertOutput` alias; `buildRepairPrompt`.
- `reviewer-dm-scheduler.js` (new) ← `expert-dm-scheduler.js` shim. `drainPeerDMs`.
- `reviewer-archive.js` (new) ← `expert-archive.js` shim. `archive`, `ReviewerArchiveError`
  (+ `ExpertArchiveError` alias, same object), `HALT_REASONS_ARCHIVE`, `HALT_REASONS_PRESERVE`.
- `lib/codex-bridge/mailbox.js` (modify `RECIPIENT_RE`) + the peer-DM validator in
  `reviewer-turn.js`/`expert-turn.js` (`PEER_RECIPIENT_RE`): accept `reviewer-*` recipients alongside
  `expert-*` (round-3 finding). Reviewer member-ids become peer-DM recipients once Slice 8 renames
  member_id composites to `reviewer-*`; without this, reviewer peer DMs are recorded as invalid.
- New `reviewer-*.test.js` per module asserting the canonical export; modify existing
  `expert-*.test.js` to add a one-line "imported from expert-* shim equals reviewer-* canonical" check;
  add a mailbox test that a `reviewer-ui` recipient is accepted by `RECIPIENT_RE` and a reviewer
  peer-DM enqueue/read round-trips.

### Tasks

1. (RED) For each module, add a `reviewer-<x>.test.js` importing the canonical reviewer name and
   asserting it is a function/class with the documented signature (smoke). Add to each existing
   `expert-<x>.test.js` an assertion that the `expert-*` export `===` the `reviewer-*` export (same
   reference — proves shim). Run — fails (reviewer modules absent).
2. (GREEN) For each pair: move the implementation file content to `reviewer-<x>.js` (rename internal
   error-class declarations to `Reviewer*Error`, keeping an `Expert*Error` export alias bound to the
   SAME class object). Replace `expert-<x>.js` with `export * from './reviewer-<x>.js';` plus any
   aliased-name re-exports the old module guaranteed (e.g.
   `export { ReviewerArchiveError as ExpertArchiveError } from './reviewer-archive.js';`).
3. (GREEN) Update internal imports: modules that import a sibling `./expert-<x>.js` should import the
   `./reviewer-<x>.js` canonical (grep `from './expert-` across lib/). The expert shims remain for
   external/test callers and the one-window contract.
4. (RED→GREEN) Extend `RECIPIENT_RE` in `mailbox.js` and `PEER_RECIPIENT_RE` in the turn module to
   accept `reviewer-[a-z][a-z0-9-]{0,47}` alongside `expert-*` (and keep `orchestrator|slice-\d+|
   impl-*`). Add the reviewer-recipient + reviewer peer-DM round-trip tests. Do NOT remove `expert-*`
   acceptance (one-window contract).
5. Run `node --test` over all touched reviewer/expert module test files + the mailbox test +
   `tests/replay/…` + `tests/skills/skill-dispatch-integration.test.js`.

### Tests required

1. **Each reviewer module exports its canonical API.** Per-module smoke (function/class present).
2. **Each expert shim re-exports the identical reference.** `expertX === reviewerX` per module — proves
   single source of truth (decision 3).
3. **Aliased error classes are the same object.** `ExpertArchiveError === ReviewerArchiveError` etc.,
   so existing `instanceof` checks and `HALT_REASONS_PRESERVE` literals keep working.
4. **Mailbox accepts `reviewer-*` recipients (both regexes) + reviewer peer-DM round-trips.** Pins the
   round-3 mailbox-contract finding; `expert-*` recipients still accepted (regression guard).
5. **Replay + dispatch integration stay green.** Regression guard that the runtime family still drives
   real turns.

---

## Slice 6: Sidecar `reviewer_teammates` fields + dual-read + migrate-on-load

**Validation:** critical

Spec authority: §"Sidecar migration" lines 301-318. Old sidecars in the wild contain
`expert_teammates`; they must keep loading, and new writes must use reviewer field names.

### Files

- `lib/codex-bridge/sidecar.js` (modify: canonical `appendReviewerSelection`/`appendReviewerTurn`/
  `appendReviewerTurnLocked`/`appendFanOutRationale`(reviewer)/`readReviewerTurns`; `appendExpert*`
  delegate; `getTeammatesBlock` pure-read accessor; extend `migrateIfNeeded` with the
  `expert_teammates → reviewer_teammates` migration).
- `lib/codex-bridge/reviewer-archive.js`/`expert-archive.js` (modify if they read `expert_teammates`
  directly — route through `getTeammatesBlock`).
- `tests/codex-bridge/sidecar-expert-teammates.test.js` (modify) +
  `tests/codex-bridge/sidecar-reviewer-teammates.test.js` (new).
- `tests/replay/replay-from-sidecar.test.js` (modify: add an old-sidecar fixture with only
  `expert_teammates`).

### Tasks

1. (RED) In `sidecar-reviewer-teammates.test.js`:
   - `appendReviewerSelection`/`appendReviewerTurn` write under `reviewer_teammates.selected[]`/
     `.turns[]`; dispatch records use `reviewers_selected`/`reviewer_turn_ids`/`reviewer_blockers`.
   - `readReviewerTurns` returns turns written via the reviewer API.
   - **Migrate-on-load:** loading a sidecar containing only `expert_teammates` produces
     `reviewer_teammates` AND appends exactly one migration record. Assert each field value
     explicitly, not just presence/count: `from_schema === 'expert_teammates'`,
     `to_schema === 'reviewer_teammates'`, `action === 'expert_teammates → reviewer_teammates'`, and
     `typeof migrated_at === 'string'` (ISO). The copied `reviewer_teammates` deep-equals the original
     `expert_teammates`.
   - **Idempotency:** loading that already-migrated sidecar again appends NO second record (assert
     `migrations.filter(m => m.to_schema === 'reviewer_teammates').length === 1`).
   - **Dual-read precedence (both blocks present):** a sidecar that ALREADY has both
     `reviewer_teammates` (distinct contents) and `expert_teammates` loads WITHOUT migrating — the
     migrate guard `expert_teammates && !reviewer_teammates` is false, so NO migration record is
     appended; and `getTeammatesBlock` returns the `reviewer_teammates` block, not `expert_teammates`.
   - **Pure read:** `getTeammatesBlock` on an `expert_teammates`-only in-memory object returns the
     block WITHOUT appending a record (only `migrateIfNeeded`/load writes the record).
   - **Delegation:** `appendExpertTurn` writes into `reviewer_teammates` (canonical) so old callers
     converge.
   Run — fails (no reviewer functions; expert functions write `expert_teammates`).
2. (GREEN) Add canonical `appendReviewer*`/`readReviewerTurns` writing `reviewer_teammates`. Add
   `getTeammatesBlock(sidecar)` returning `sidecar.reviewer_teammates ?? sidecar.expert_teammates`
   (pure). Extend `migrateIfNeeded`: `if (sidecarData.expert_teammates && !sidecarData.reviewer_teammates)`
   copy the block to `reviewer_teammates`, push the migration record, `saveSidecar`. Make
   `appendExpert*` thin delegates to `appendReviewer*`.
3. (GREEN) Update `expert-archive`/`reviewer-archive` reads to use `getTeammatesBlock`.
4. (GREEN) Add an old-sidecar fixture (only `expert_teammates`) to the replay test; assert replay
   still reconstructs reviewer turns and emits exactly one migration record.
5. Run the two sidecar test files + replay test + `npm run test:affected`.

### Tests required

1. **New writes use `reviewer_teammates` + reviewer dispatch fields.** Canonical write path.
2. **Old `expert_teammates` sidecars migrate on load + append exactly one record (idempotent).** Pins
   Goal 2 + the round-1 migration-record-shape/idempotency finding. Asserts each migration-record
   field value explicitly (`from_schema`/`to_schema`/`action`/`migrated_at`), not only the count.
3. **Dual-read precedence when both blocks exist.** A sidecar with both `reviewer_teammates` and
   `expert_teammates` does NOT migrate (no record appended) and `getTeammatesBlock` returns the
   reviewer block. Pins the TDD-review precedence finding.
4. **`getTeammatesBlock` is a pure read.** No record append on read; only load/migrate writes.
5. **`appendExpert*` delegates to the reviewer block.** Old callers converge on canonical storage.
6. **Replay over an old sidecar succeeds.** Replay test with an `expert_teammates`-only fixture stays
   green (spec line 315 explicit requirement).

---

## Slice 7: `**Reviewers:**` plan directive + `**Experts:**` deprecated alias

**Validation:** standard

Spec authority: §"New canonical plan directive" lines 255-263. `**Reviewers:**` is canonical;
`**Experts:**` is a deprecated alias; if both are present, Reviewers wins and a warning is recorded.
This slice is **composer code only**; the skill prose that builds the signals + records the warning is
Slice 8.

### Files

- `lib/codex-bridge/reviewer-composer.js` (modify: accept `signals.reviewersDirective` +
  `signals.expertsDirective`; precedence + `directiveWarning`; keep `explicitDirective` as a
  back-compat alias for `expertsDirective`).
- `tests/codex-bridge/reviewer-composer.test.js` (modify).

### Tasks

1. (RED) In `reviewer-composer.test.js`:
   - `signals.reviewersDirective: 'ui, test'` → those roles merged with reason
     `from **Reviewers:** directive`; `directiveWarning === null`.
   - `signals.expertsDirective: 'ui'` only → merged with reason `from **Experts:** directive`;
     `directiveWarning` mentions deprecation.
   - **Both present** → reviewers win (experts-only roles NOT added unless also in reviewers);
     `directiveWarning` states `**Reviewers:** takes precedence over deprecated **Experts:**`.
   - `signals.explicitDirective: 'ui'` (legacy alias) behaves exactly like `expertsDirective: 'ui'`.
   Run — fails (composer ignores reviewers/expertsDirective distinction).
2. (GREEN) In `reviewer-composer.js`, replace the single `explicitDirective` handling: read
   `reviewersDirective` (canonical) and `expertsDirective` (alias). If both present, use reviewers and
   set `directiveWarning`. Keep `explicitDirective` as a back-compat alias for `expertsDirective`.
   Reason strings name the source directive.
3. Run `node --test tests/codex-bridge/reviewer-composer.test.js` + `npm run test:affected`.

### Tests required

1. **`**Reviewers:**` directive selects reviewers with the canonical reason.** Pins the new directive.
2. **`**Experts:**` alone still works + emits a deprecation `directiveWarning`.** Pins Goal 2.
3. **Both present → Reviewers wins + precedence warning.** Pins spec line 263 exactly.
4. **`explicitDirective` back-compat retained.** Existing callers passing `explicitDirective` behave as
   before (regression guard).

---

## Slice 8: Reviewer-named skill prose (all six skills: directive + write paths + dispatch ids)

**Validation:** standard

Spec authority: §"New canonical plan directive" line 255 + §"Module and API migration" line 298
("new sidecar writes use reviewer-*") + Goal 3. The runtime keeps working via shims, but the
operational **skill prose** still instructs new work through expert-named APIs/fields and role-id
literals. New prose must name the reviewer APIs/fields/ids; old names stay valid only as
accepted-on-read. Round-2 audit confirmed reviewer-sense `expert-*` prose in SIX skills, not two:
`autopilot`, `subagent-driven-development`, `brainstorming`, `writing-plans`, `systematic-debugging`,
`test-driven-development`. All six are in scope. Because Slice 3 makes `resolveAdapter` accept
`reviewer-*` ids, the role-id LITERALS in dispatch prose (`dispatchPanel('expert-test', …)`,
`resolveAdapter(identity.id)`, member_id composites `expert-test@<cli>`) can be renamed to
`reviewer-*` and still resolve — no compatibility carve-out is needed.

### Rename surface (apply consistently per skill)

- API names: `composeExperts`→`composeReviewers`; import paths `expert-turn.js`→`reviewer-turn.js`,
  `expert-runtime.js`→`reviewer-runtime.js`, `role-composer.js`→`reviewer-composer.js` where the file
  is imported for `composeExperts`; `appendExpert*`→`appendReviewer*`.
- Role-id literals + dispatch keys: `expert-{test,security,architecture,ui,ux,backend,ai-harness}`→
  `reviewer-*` in `dispatchPanel(<role>, …)`, `resolveAdapter(<id>)`, member_id composites
  `<role>@<cli>`, and selection/domain comments (`'ui' → expert-ui` → `'ui' → reviewer-ui`).
- Sidecar field names in write prose: `expert_teammates`/`experts_selected`/`expert_turn_ids`/
  `expert_blockers`→ reviewer equivalents.
- Directive: build signals from `sliceFrontmatter.reviewers` (canonical) falling back to
  `sliceFrontmatter.experts`; write `directiveWarning` to the sidecar audit when non-null.

### Files

- `skills/subagent-driven-development/SKILL.md`, `skills/autopilot/SKILL.md` (driver write paths +
  directive signals + sidecar field names).
- `skills/brainstorming/SKILL.md`, `skills/writing-plans/SKILL.md` (review-dispatch prose; panel-mode
  `reviewer-test`/`reviewer-security`/`reviewer-architecture`; advisory `reviewer-ui`; `writing-plans`
  emits `**Reviewers:**` in new plans, notes `**Experts:**` deprecated).
- `skills/systematic-debugging/SKILL.md`, `skills/test-driven-development/SKILL.md` (composer call,
  `expert-turn` import, `resolveAdapter`/`dispatchPanel` role-id literals, member_id composites).
- `tests/skills/skill-structure.test.js` (modify: scoped prose assertions).

### Tasks

1. (RED) In `skill-structure.test.js`. All prose assertions are **section-scoped** — extract the
   operational write/dispatch block (by heading or fenced-region boundary) and assert against that
   slice of text, NOT a whole-file substring (a whole-file `includes` is vacuous because compat notes
   legitimately mention the legacy names). Add:
   - Assert `writing-plans` documents `**Reviewers:**` as canonical and `**Experts:**` as deprecated.
   - Assert `subagent-driven-development` + `autopilot` build composer signals from `reviewers` with
     an `experts` fallback **within their directive-signal section**, and that the **sidecar-write
     section** references `composeReviewers` + `reviewer_teammates`/`reviewers_selected`.
   - Assert each of the six skills references `composeReviewers` (not `composeExperts`) **within its
     reviewer-dispatch section**, and that `test-driven-development` + `writing-plans` panel prose uses
     `reviewer-test` (not `expert-test`).
   - **Member-id composite:** assert the panel-dispatch sections write the member_id composite as
     `reviewer-test@${cli}` (and the other roles' `reviewer-<role>@${cli}`) and contain no
     `expert-test@${cli}` / `expert-<role>@${cli}` composite in a new-dispatch instruction.
   - **Negative guard (expanded):** no skill's NEW-write/dispatch instruction names any of
     `expert_teammates`, `experts_selected`, `expert_turn_ids`, `expert_blockers`, `appendExpert`,
     `composeExperts`, `expert-runtime`, or `expert-turn`. Accepted-on-read mentions inside an
     explicitly-scoped compatibility note are allowed; the guard targets the operational write/dispatch
     instruction regions only.
   Run — fails (skills still use expert names/ids).
2. (GREEN) Apply the rename surface to `autopilot` + `subagent-driven-development` (driver write
   paths + directive signals).
3. (GREEN) Apply the rename surface to `brainstorming` + `writing-plans` (review dispatch + panel ids
   + `**Reviewers:**` emission).
4. (GREEN) Apply the rename surface to `systematic-debugging` + `test-driven-development` (composer
   call + `reviewer-turn` import + `resolveAdapter`/`dispatchPanel` role-id literals + member_ids).
5. Run `node --test tests/skills/skill-structure.test.js tests/skills/skill-dispatch-integration.test.js`
   + `npm run test:affected`.

### Tests required

1. **`writing-plans` emits `**Reviewers:**` (canonical) + notes `**Experts:**` deprecated.** Pins the
   new-prose half of Goal 3.
2. **Driver skills read `reviewers` with `experts` fallback + name reviewer write APIs/fields
   (section-scoped).** Scoped assertions on autopilot + subagent-driven-development against their
   directive-signal and sidecar-write sections — not whole-file substrings (the round-1 "new writes
   still use expert prose" finding, made non-vacuous per the TDD-review).
3. **All six skills dispatch via `composeReviewers`; panel prose uses `reviewer-test` AND the member_id
   composite is `reviewer-test@${cli}`.** Covers the round-2 finding (six skills) plus the TDD-review
   finding that "panel prose uses reviewer-test" alone could miss a legacy-named dispatch key — the
   composite must be reviewer-named too.
4. **Negative guard (expanded): no new-write/dispatch instruction names `expert_teammates`,
   `experts_selected`, `expert_turn_ids`, `expert_blockers`, `appendExpert*`, `composeExperts`,
   `expert-runtime`, or `expert-turn`.** Section-scoped to operational regions (compat notes exempt).
   Pins Goal 3's "new writes use reviewer naming."

---

## Verification (whole plan)

```bash
node --test tests/codex-bridge/role-prompts-loader.test.js tests/codex-bridge/role-prompts-lock-check.test.js
node --test tests/codex-bridge/reviewer-resolver.test.js tests/codex-bridge/expert-resolver.test.js
node --test tests/codex-bridge/role-routing/resolver.test.js
node --test tests/codex-bridge/reviewer-composer.test.js tests/codex-bridge/role-composer.test.js
node --test tests/codex-bridge/sidecar-reviewer-teammates.test.js tests/codex-bridge/sidecar-expert-teammates.test.js
node --test tests/replay/replay-from-sidecar.test.js
node --test tests/skills/skill-structure.test.js tests/skills/skill-dispatch-integration.test.js
node scripts/generate-role-prompts-lock.mjs --check   # lock is up to date (exits non-zero on drift)
npm run test:affected
```

All green before the plan is considered shipped. The compatibility floor (old ids, old directive, old
sidecar shape) is pinned by the alias/dual-read/migration tests in every relevant slice — that is the
load-bearing evidence for Goal 2.

## Out of scope (Plan 4)

- `docs/execution-model.md` canonical three-choice doc + README cross-links + duplicate-matrix grep
  guard.
- Brainstorming/writing-plans handoff prose offering `execution` with driver choices.
- Renaming the `experts` JSON key in `agents/dispatchers.json` to `reviewers` (consumer-coupled —
  future cleanup release).
- Removing any `expert-*` compatibility shim (that is a future cleanup release, not this migration).
