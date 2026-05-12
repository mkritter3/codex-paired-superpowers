# ollama adapter slice-2 test list

Test inventory for `lib/codex-bridge/cli-harness/adapters/ollama.js`. Each
entry is a boundary-level assertion that justifies the production code in
slice 2 of v0.9.0. Result-oriented: assert observable DispatchResult fields
(responseText, exit, warnings, adapterMeta.model), not internal calls.

## Verified Ollama CLI form (from `ollama run --help` on macOS, v0.16.1)

```
Usage: ollama run MODEL [PROMPT] [flags]
```

- Stateless one-shot: invoke as `ollama run <model>`. With no PROMPT
  argument the binary reads from stdin and writes the response to stdout
  as plain text (no `--format` requested ⇒ no JSON event stream, unlike
  `codex --json`).
- Cloud variants use the `<name>:cloud` suffix (e.g. `kimi-k2.6:cloud`).
- Stderr surfaces warnings (cloud auth, rate-limit, deprecation).

This is what the adapter implements. The TODO marker in `ollama.json`'s
`_invocation_verified` field notes that slice-8 installed-smoke will
confirm against a live cloud session.

## adapters/ollama.test.js

1. **happy path with `kimi-k2.6` variant** — fake CLI emits plain text
   `Hello from Kimi`; adapter returns
   `{exit: 0, responseText: 'Hello from Kimi', warnings: [],
     adapterMeta.model: 'kimi-k2.6:cloud'}`.

2. **`glm-5.1` variant resolution** — `variant: 'glm-5.1'` resolves to
   `glm-5.1:cloud`; the fake CLI's invocation captures that model name
   in the args-echo side file and the adapter records
   `adapterMeta.model === 'glm-5.1:cloud'`.

3. **missing variant** — calling `dispatch(sys, usr, {})` without
   `options.variant` rejects with an `OllamaAdapterError` mentioning
   "variant".

4. **invalid variant** — `variant: 'gpt-99'` (not in
   cli-clients/ollama.json's variants map) rejects with an
   `OllamaAdapterError` mentioning the variant name.

5. **nonzero exit** — `FAKE_CLI_EXIT=1`: returns
   `{exit: 1, responseText: '', warnings: includes('cli-exit-nonzero')}`.

6. **stderr `unauthorized` → `ollama-cloud-unauthenticated` warning** —
   `FAKE_CLI_STDERR='Error: unauthorized — Ollama Cloud token expired'`
   with exit 1: `warnings` includes `'ollama-cloud-unauthenticated'`
   AND a passthrough `stderr:` line; exit is preserved.

7. **stderr rate-limited → `ollama-rate-limited` warning** —
   `FAKE_CLI_STDERR='rate limit exceeded'` with exit 0:
   `warnings` includes `'ollama-rate-limited'`; responseText still
   delivered.

8. **spawn-failed for missing binary** — `command: '/no/such/binary'`,
   `variant: 'kimi-k2.6'`: returns
   `{exit: 1, warnings: includes('spawn-failed'), adapterMeta.errorCode:
     'ENOENT'}` (matches slice-1 contract exactly).

9. **timeout via AbortController** — `FAKE_CLI_HANG=1` with
   `timeout_ms: 100`: process killed within ~500ms;
   `{exit: 137, warnings: includes('timeout')}`.

10. **empty stdout on success** — the adapter accepts plain-text empty
    output as benign-but-flagged (`warnings: includes('empty-output')`);
    `responseText: ''`, `exit: 0`.

## What this slice does NOT test

- HTTP `/api/generate` fallback — hard-banned by slice scope.
- Local-Ollama via `ANTHROPIC_BASE_URL` — explicitly NOT this slice.
- Real `ollama run` invocation against a live cloud model — that is
  slice-8 installed-smoke.
- Concurrency, registry-level wiring, role routing — slices 1, 3.
