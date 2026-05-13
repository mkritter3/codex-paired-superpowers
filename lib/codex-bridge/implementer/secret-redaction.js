// v0.10.0 slice 5 — secret-redaction helpers.
//
// Three exports used by the claude-cli adapter to prevent token leakage:
//
//   resolveToken(provider, deps?)  — lookup API token for a route
//   sanitizeEnv(env)               — strip 6 protected env keys
//   redactSecretFields(obj)        — deep-walk + redact any token-containing values

// ── Denylist: the 6 env keys that MUST be stripped from inherited env
// and whose values MUST be replaced with '<REDACTED>' if they appear
// as object keys in a result structure.
const DENYLIST_KEYS = new Set([
  'OLLAMA_CLOUD_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
]);

// ── Canary tokens from spec L612-618 (used in tests to prove redaction fires)
const CANARY_TOKENS = [
  'ollama-tok-test-canary-abc123',
  'anthropic-auth-test-canary-def456',
  'sk-ant-canary-xyz789',
  'sk-openai-canary-uvw000',
];

// ── Regex patterns for unknown token shapes (spec L645)
const SECRET_REGEXES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-openai-[A-Za-z0-9_-]{20,}/,
  /ollama-tok-[A-Za-z0-9_-]{8,}/,
  /anthropic-auth-[A-Za-z0-9_-]{8,}/,
];

/**
 * Resolve an API token for a given provider.
 *
 * Token resolution order:
 *   1. deps.keychain.getToken(provider) if keychain is provided (DI for tests)
 *   2. process.env lookup (OLLAMA_CLOUD_API_KEY / ANTHROPIC_AUTH_TOKEN)
 *   3. throw Error('claude-cli-auth-missing') with .code set
 *
 * @param {string} provider — 'ollama-cloud' | 'anthropic-api'
 * @param {{keychain?: {getToken: (provider: string) => string | null | undefined}}} [deps]
 * @returns {string}
 */
export function resolveToken(provider, deps = {}) {
  if (provider !== 'ollama-cloud' && provider !== 'anthropic-api') {
    const err = new Error('claude-cli-auth-unknown-provider');
    err.code = 'claude-cli-auth-unknown-provider';
    throw err;
  }

  // 1. Try keychain (DI path).
  if (deps.keychain && typeof deps.keychain.getToken === 'function') {
    let token;
    try {
      token = deps.keychain.getToken(provider);
    } catch {
      // keychain threw — fall through to env
      token = null;
    }
    if (token != null && token !== '') {
      return String(token);
    }
  }

  // 2. Try env vars.
  const envKey =
    provider === 'ollama-cloud' ? 'OLLAMA_CLOUD_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  const envValue = process.env[envKey];
  if (envValue != null && envValue !== '') {
    return String(envValue);
  }

  // 3. Nothing found.
  const err = new Error('claude-cli-auth-missing');
  err.code = 'claude-cli-auth-missing';
  throw err;
}

/**
 * Strip the 6 protected denylist env keys from an env object.
 * Preserves all other keys (PATH, HOME, LANG, LC_*, user keys, etc.).
 *
 * @param {Record<string, string>} env
 * @returns {Record<string, string>}
 */
export function sanitizeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!DENYLIST_KEYS.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Check whether a string value needs redaction.
 * Returns true if the string contains any of the 4 canary tokens
 * OR matches any secret regex pattern.
 *
 * @param {string} s
 * @returns {boolean}
 */
function needsRedaction(s) {
  for (const canary of CANARY_TOKENS) {
    if (s.includes(canary)) return true;
  }
  for (const re of SECRET_REGEXES) {
    if (re.test(s)) return true;
  }
  return false;
}

/**
 * Deep-walk an object/array structure and replace any secret-containing
 * string values with '<REDACTED>'. Also redacts values whose object key
 * is in the denylist (regardless of value shape).
 *
 * - Cycle-safe via WeakSet of visited objects.
 * - Preserves numbers, booleans, null, undefined.
 * - Non-mutating: returns a new structure (structuredClone base, then
 *   in-place replacement is fine since we own the clone).
 *
 * @param {unknown} obj
 * @returns {unknown}
 */
export function redactSecretFields(obj) {
  return redactValue(obj, new WeakSet());
}

function redactValue(val, visited) {
  if (val === null || val === undefined) return val;

  if (typeof val === 'string') {
    return needsRedaction(val) ? '<REDACTED>' : val;
  }

  if (typeof val !== 'object' && !Array.isArray(val)) {
    // numbers, booleans, etc.
    return val;
  }

  if (Array.isArray(val)) {
    // Cycle-safe for arrays: use the array itself as key.
    if (visited.has(val)) return val;
    visited.add(val);
    return val.map((item) => redactValue(item, visited));
  }

  // Plain object.
  if (visited.has(val)) return val;
  visited.add(val);

  const out = {};
  for (const [key, value] of Object.entries(val)) {
    if (DENYLIST_KEYS.has(key)) {
      // Denylist key: redact the value regardless of its shape.
      out[key] = '<REDACTED>';
    } else {
      out[key] = redactValue(value, visited);
    }
  }
  return out;
}
