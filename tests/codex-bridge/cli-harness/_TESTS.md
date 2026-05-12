# cli-harness slice-1 test list

Test inventory for `lib/codex-bridge/cli-harness/`. Each entry is the
boundary-level assertion that justifies the production code in slice 1.
Result-oriented: assert observable DispatchResult fields, not internal calls.

## harness.test.js (top-level dispatcher)

1. **harness.dispatch returns normalized DispatchResult on happy path** —
   given an adapter that resolves with the canonical fields, the harness
   returns the same `{responseText, exit: 0, warnings: [], adapterMeta,
   duration_ms}` shape.
2. **harness.dispatch routes via the adapter registry by name** — given
   `{cli: 'codex'}`, the harness looks up `codex` in the registry and
   delegates to that adapter's `dispatch(systemPrompt, userPrompt, options)`.
3. **harness.dispatch rejects unknown CLI names** — `{cli: 'nonexistent'}`
   throws a `RegistryError` (or rejects the promise with one).
4. **harness.dispatch forwards `variant` in options to the adapter** —
   when called with `{cli: 'ollama', variant: 'kimi-k2.6'}`, the adapter
   receives `options.variant === 'kimi-k2.6'`.
5. **harness.dispatch records `duration_ms`** — the normalized result has
   a numeric `duration_ms >= 0`.

## adapters/codex.test.js (codex adapter via fake CLI)

6. **codex adapter happy path** — fake CLI emits a valid `--json` event
   stream with assistant-text events; adapter returns
   `{responseText: <concatenated text>, exit: 0, warnings: [], adapterMeta:
   {...}, duration_ms: <num>}`.
7. **codex adapter nonzero exit** — `FAKE_CLI_EXIT=1`: returns
   `{exit: 1, responseText: '', warnings: includes('cli-exit-nonzero')}`.
8. **codex adapter stderr warning passthrough** — `FAKE_CLI_STDERR='rate-limited'`:
   `warnings` contains a normalized form (`'stderr:rate-limited'` or
   similar) when exit is 0.
9. **codex adapter malformed stdout** — `FAKE_CLI_OUTPUT='not json'`:
   `{exit: 1, warnings: ['malformed-output']}`.
10. **codex adapter timeout via AbortController** — `FAKE_CLI_HANG=1`
    with timeout 100ms: process killed within ~500ms, result
    `{exit: 137, warnings: ['timeout']}`.

## normalizer.test.js (DispatchResult shape enforcement)

11. **normalizeDispatchResult enforces all required fields** — given a
    minimal `{responseText: 'hi'}`, returns object with
    `responseText, exit, warnings, sessionId, adapterMeta, duration_ms`
    all present with sane defaults (exit 0, warnings [], sessionId null,
    adapterMeta {}, duration_ms 0).
12. **normalizeDispatchResult preserves extras under adapterMeta** —
    unknown fields are merged into `adapterMeta`, not dropped.
13. **normalizeDispatchResult passes through explicit nulls** — if
    `sessionId: null` is given, the output keeps `sessionId: null`.

## concurrency.test.js (max-concurrent dispatch queue)

14. **enforceMaxConcurrent caps active dispatches at N** — wrap a slow
    fake dispatch with cap=2; fire 5 in parallel; shared counter never
    observes more than 2 concurrent active calls.
15. **enforceMaxConcurrent with cap=0 serializes** — single-file
    execution; max concurrent observed === 1.
16. **enforceMaxConcurrent default cap is 4** — when called with no
    `maxN`, allows up to 4 concurrent.

## adapters/registry.test.js (adapter lookup by cli-clients/*.json)

17. **registry resolves a known adapter** — `getAdapter('codex')`
    returns an object exposing `dispatch(...)`.
18. **registry rejects unknown names** — `getAdapter('nonexistent')`
    throws `RegistryError`.
19. **registry loads config metadata** — `getAdapterConfig('codex')`
    returns the parsed `cli-clients/codex.json` content (name, command,
    permissions).
