// v0.9.0 slice 1 — cli-harness top-level dispatcher.
//
// `dispatch({cli, variant}, systemPrompt, userPrompt, options, deps)`
// resolves the named CLI adapter (via cli-clients/<cli>.json + the matching
// adapter module under cli-harness/adapters/) and delegates to it. The
// returned DispatchResult is normalized to the canonical shape declared
// by lib/codex-bridge/cli-harness/normalizer.js.
//
// `deps.adapters` is an optional `Map<string, adapter>` for tests — when
// provided, it bypasses the on-disk registry. Production callers pass no
// deps and the harness uses the real registry.

import { getAdapter, RegistryError } from './adapters/registry.js';
import { normalizeDispatchResult } from './normalizer.js';

export async function dispatch(
  target,
  systemPrompt,
  userPrompt,
  options = {},
  deps = {},
) {
  if (!target || typeof target !== 'object' || typeof target.cli !== 'string') {
    throw new TypeError(
      "harness.dispatch requires {cli: string} as the first argument",
    );
  }

  const adapter = await resolveAdapter(target.cli, deps);
  const mergedOptions = { ...options };
  if (target.variant !== undefined) {
    mergedOptions.variant = target.variant;
  }

  const startedAt = Date.now();
  const raw = await adapter.dispatch(systemPrompt, userPrompt, mergedOptions);
  const elapsed = Date.now() - startedAt;

  const normalized = normalizeDispatchResult(raw);
  // If the adapter didn't supply duration_ms, the harness records it.
  if (!Number.isFinite(raw && raw.duration_ms)) {
    normalized.duration_ms = elapsed;
  }
  return normalized;
}

async function resolveAdapter(name, deps) {
  if (deps && deps.adapters instanceof Map) {
    if (!deps.adapters.has(name)) {
      throw new RegistryError(`Unknown CLI adapter: ${name}`, {
        code: 'UNKNOWN_ADAPTER',
      });
    }
    return deps.adapters.get(name);
  }
  return getAdapter(name);
}

export { RegistryError };
