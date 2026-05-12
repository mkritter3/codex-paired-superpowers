# role-routing slice-3 test list

Test inventory for `lib/codex-bridge/role-routing/`. CRITICAL-tier slice:
routing + permissions decide which model runs AND whether reviewer roles
are write-capable. Higher test density. Each entry is the boundary-level
assertion that justifies the production code in slice 3.

Result-oriented: assert observable returned objects + thrown error
codes, never internal mock-invocation counts.

## recommendations.test.js — bundled defaults load + validate (~8 tests)

1. **All 9 roles present with required fields** — `loadRecommendations()`
   returns a Map with `paired-reviewer`, the 7 experts, and `implementer`;
   each value has `preference`, `rationale`, `permissions`.
2. **Preference array non-empty** — every role has at least one entry.
3. **Permissions value enumerated** — every role's `permissions` is one
   of `read-only` or `write-allowed`.
4. **Variant entry parses to {cli, variant}** — `parsePreferenceEntry('ollama{kimi-k2.6}')`
   returns `{cli: 'ollama', variant: 'kimi-k2.6'}`.
5. **Plain entry parses to {cli, variant: null}** —
   `parsePreferenceEntry('codex')` returns `{cli: 'codex', variant: null}`.
6. **Malformed preference entry throws** — `'ollama{}'` and `'ollama{x}}'`
   and `'{kimi}'` all throw RoleRoutingError code
   `MALFORMED_PREFERENCE_ENTRY`.
7. **Unknown CLI reference fails load** — if a role's preference contains
   a cli name with no matching `cli-clients/<name>.json`, load throws
   RoleRoutingError code `RECOMMENDATIONS_INVALID`.
8. **Unknown variant reference fails load** — if a role's preference
   references `ollama{nonexistent}` but `cli-clients/ollama.json` has no
   `nonexistent` variant, load throws `RECOMMENDATIONS_INVALID`.

## permissions.test.js — per-CLI flag mapping (~6 tests)

9. **codex + read-only** — `mapPermissions('codex', 'read-only')` returns
   `["--sandbox", "read-only"]`.
10. **codex + write-allowed** — `mapPermissions('codex', 'write-allowed')`
    returns `["--dangerously-bypass-approvals-and-sandbox"]`.
11. **ollama + read-only** — `mapPermissions('ollama', 'read-only')`
    returns `[]` (no sandbox flag exists on ollama).
12. **Unknown cli throws** — `mapPermissions('nonexistent', 'read-only')`
    throws RoleRoutingError code `UNKNOWN_CLI`.
13. **Unknown mode throws** — `mapPermissions('codex', 'whatever')`
    throws RoleRoutingError code `UNKNOWN_PERMISSION_MODE`.
14. **refusesDangerousFlagsForReadOnly** — given codex + read-only + an
    args array containing `--dangerously-bypass-approvals-and-sandbox`,
    returns `true` (i.e. it refuses); otherwise `false`.

## resolver.test.js — preference-ladder walker (~12 tests)

15. **Override path: cli available → resolution_source: 'override'** —
    `resolveAdapter('expert-architecture', new Set(['claude']), new Map([['expert-architecture', {cli: 'claude'}]]))`
    returns `{cli: 'claude', variant: null, resolution_source: 'override', ...}`.
16. **Override path: cli unavailable → HARD HALT** —
    same userRouting but `availableCLIs = new Set([])` → throws
    RoleRoutingError code `override-cli-unavailable`.
17. **Ladder walk: first preference available** —
    `resolveAdapter('expert-architecture', new Set(['codex', 'claude']), new Map())`
    returns `{cli: 'codex', preference_index: 0, resolution_source: 'recommendation', unavailable_candidates: []}`.
18. **Ladder walk: skip unavailable to second** — codex missing,
    claude available → `{cli: 'claude', preference_index: 1, unavailable_candidates: ['codex']}`.
19. **Ladder walk: full ladder unavailable → HARD HALT** — no available
    CLIs for `expert-architecture` → throws code `no-supported-cli-for-role`.
20. **Variant in preference resolves** —
    `resolveAdapter('expert-ux', new Set(['ollama']), new Map())` walks
    `claude → gemini → ollama{kimi-k2.6}` and lands at preference_index: 2
    with `{cli: 'ollama', variant: 'kimi-k2.6'}`.
21. **Variant in userRouting override resolves** — userRouting
    `expert-ux → {cli: 'ollama', variant: 'kimi-k2.6'}` + ollama available
    + kimi-k2.6 is a declared variant → resolves to that.
22. **Variant in userRouting unknown → HARD HALT** — same but variant
    name not in `cli-clients/ollama.json` → throws code
    `override-variant-unknown`.
23. **Reviewer + write-allowed override → audit warning present** —
    userRouting `{paired-reviewer: {cli: 'codex', permissions: 'write-allowed'}}` →
    resolved object has a non-empty `audit_warnings` array containing the
    "reviewer-role + write permissions" warning. Permissions on the result
    reflect the requested write-allowed mode.
24. **Implementer + write-allowed → no audit warning** — implementer is
    write-capable by default; no warning emitted.
25. **`resolution_source: implicit-fallback` is never returned in v0.9.0** —
    not used by the resolver until a future release; sanity check across
    all happy paths.
26. **All hard-halt errors are RoleRoutingError with `.code` set** —
    instance check + each thrown error has the expected `.code`.

## config-loader.test.js — project-config merge order (~10 tests)

27. **No project overrides → bundled defaults returned** — empty repo
    (no `.codex-paired/`) → returns `{recommendations, cliClients,
    userRouting}` with empty userRouting and bundled cliClients.
28. **`.codex-paired/cli-clients/<name>.json` merges with bundled** —
    project ships a `cli-clients/codex.json` override; result's
    cliClients map has the project version merged in.
29. **`.codex-paired/role-routing.json` populates userRouting** —
    repo `.codex-paired/role-routing.json` of
    `{"expert-architecture": {"cli": "claude"}}` → userRouting Map has
    that key.
30. **userRouting references unknown role → throws at LOAD time** —
    not later when dispatch happens. Error code `USER_ROUTING_UNKNOWN_ROLE`.
31. **userRouting references unknown cli → throws at LOAD time** —
    error code `USER_ROUTING_UNKNOWN_CLI`.
32. **userRouting references unknown variant on known cli → throws at LOAD time** —
    error code `USER_ROUTING_UNKNOWN_VARIANT`.
33. **userRouting specifies unknown permission mode → throws at LOAD time** —
    error code `USER_ROUTING_INVALID_PERMISSIONS`.
34. **Malformed JSON in `.codex-paired/role-routing.json` → throws at LOAD time** —
    parse error path; error code `USER_ROUTING_INVALID_JSON`.
35. **Project cli-client extending bundled adds variant for resolver** —
    project `cli-clients/ollama.json` declares an additional variant; the
    merged cliClients map has that variant available to validation.
36. **Project cli-client replacing bundled overrides command path** —
    project `cli-clients/codex.json` sets `"command": "/opt/local/bin/codex"`;
    merged cliClients map exposes the override.

## Notes

- All file-system tests use `mkdtempSync()` for an isolated temp dir;
  no test touches the real repo's `.codex-paired/`.
- `availableCLIs` is an input parameter to `resolveAdapter`. Slice 4
  (doctor + cache) builds availability detection. Slice 3 trusts whatever
  Set<string> the caller provides.
- Slice is READ-ONLY: nothing in the rest of the codebase calls into
  role-routing yet. Slice 7a wires this up to skill prose / sidecar.
