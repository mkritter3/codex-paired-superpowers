# Installed-Smoke Tests (Tier 4)

## What these tests are

Installed-smoke tests verify that the cli-harness adapters work correctly against
**real CLI binaries** on a developer machine or CI runner. They are the only tier
that exercises actual network calls and real model inference.

These tests live in `tests/installed-smoke/` and follow the `node --test` format.
Each test file wraps its tests in guards that `skip` automatically when the required
environment is unavailable.

## Opt-in: `CPS_INSTALLED_SMOKE=1`

All tests in this directory are **no-ops** when run without the opt-in env var.
They use `test.skip()` with a clear human-readable reason so CI output shows the
skip rather than silently passing.

```bash
# Default (CI): skips all installed-smoke tests
npm test

# Opt in (developer machine or CI runner with real CLIs):
CPS_INSTALLED_SMOKE=1 npm run test:installed-smoke
```

When `CPS_INSTALLED_SMOKE` is unset or not exactly `'1'`, every test in this
directory skips. This is intentional: a CI runner that lacks the `codex` or `ollama`
binaries must NOT fail, but it also must NOT silently pass these tests — skips are
visible in the test report.

## What each file requires

### `codex-real.test.js`

- `CPS_INSTALLED_SMOKE=1`
- `codex` binary on `PATH` (the real OpenAI Codex CLI, authenticated)
- No `OPENAI_API_KEY` override needed if the binary is already auth'd via `codex login`

Sends a 2-turn prompt, asserts:
- Response is non-empty text
- `DispatchResult` shape is correct (`{ok, responseText, exit, warnings, adapterMeta, duration_ms}`)
- `adapterMeta.adapter === 'cli-harness:codex'`
- No orphaned processes left behind (60-second timeout enforced by `AbortController`)

### `ollama-real.test.js`

- `CPS_INSTALLED_SMOKE=1`
- `ollama` binary on `PATH`
- At least one variant configured in `cli-clients/ollama.json` (`kimi-k2.6` or `glm-5.1`)
- Active Ollama Cloud session (or Ollama Cloud token in the environment)

Sends a short prompt that asks the model to identify itself, asserts:
- Response is non-empty text
- Response does NOT contain "Anthropic" or "Claude" (cross-model verification)
- `DispatchResult` shape is correct
- Correct variant was resolved (inferred from `adapterMeta.model`)
- No orphaned processes left behind (60-second timeout)

## What these tests are NOT

- **Not a substitute for unit tests.** Unit tests in `tests/codex-bridge/cli-harness/`
  use fake-CLI fixtures and run in ~30s with no external dependencies. Installed-smoke
  tests complement them — they don't replace them.
- **Not run by `npm test`.** The default CI command skips this directory entirely.
  Use `npm run test:installed-smoke` or `CPS_INSTALLED_SMOKE=1 node --test tests/installed-smoke/**/*.test.js`.
- **Not a correctness gate for model quality.** We don't assert "the model said X."
  We assert response shape, non-emptiness, and cross-model identity (Ollama is not
  Anthropic).

## Required for the v0.9.0 release gate

Both `codex-real.test.js` and `ollama-real.test.js` must PASS (not skip) before
`v0.9.0` is tagged. See `docs/verification/v0.9.0-release-gate.md` for the full
gate criteria and how the gate-runner script (`scripts/v0.9.0-release-gate.sh`)
invokes these tests.

## Timeout and cleanup discipline

Every installed-smoke test:
- Uses a 60-second per-test timeout via the `node:test` `timeout` option
- Spawns subprocesses via the cli-harness (which manages `AbortController` internally)
- Never leaves a `codex` or `ollama` process running after the test exits — the
  harness kills the child on timeout; the test confirms by checking that the result
  includes a timeout warning when applicable
