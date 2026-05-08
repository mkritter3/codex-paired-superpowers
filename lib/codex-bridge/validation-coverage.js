/**
 * validation-coverage.js — Phase A coverage parser
 *
 * Parses the array of bullet strings from a Codex validation-coverage verdict block.
 * Returns { ok: true, tier, coverage } or { ok: false, defect, detail }.
 *
 * This is the deterministic source of truth for rubric enforcement.
 * Phase C keys (rubric.diff-vs-plan, etc.) are out of scope for v0.4.1.
 */

// ─── Allowed-keys constants ───────────────────────────────────────────────────

const TIER1_KEYS = [
  'happy',
  'edge.zero-null-empty',
  'edge.boundary',
  'edge.large-input',
  'edge.concurrent',
  'edge.adversarial',
  'fail.dependency',
  'fail.malformed-input',
  'fail.exception-path',
  'integration.cross-module',
];

const TIER2_KEYS = [
  'stress.scale',
  'perf.slo',
  'compat.breaking',
];

const TIER_VALUES = new Set(['light', 'standard', 'critical']);

const ALLOWED_KEYS = new Set([
  'tier',
  ...TIER1_KEYS,
  ...TIER2_KEYS,
  'critical.residual-risk',
]);

// Bullet shape: optional leading whitespace, key (alphanumeric + dots + hyphens),
// optional whitespace, colon, optional whitespace, optional value, optional trailing whitespace.
// The value capture (.*?) allows empty matches so the empty-value defect path is reachable.
const BULLET_RE = /^\s*([a-z][a-z0-9.\-]*)\s*:\s*(.*?)\s*$/;

/**
 * Parse a validation-coverage critique.
 *
 * @param {unknown} critique - Should be an array of strings from a verdict block.
 * @param {{ tier?: string }} [opts] - Optional. If opts.tier is provided, it must
 *   match the tier bullet's value or tier-mismatch is emitted.
 * @returns {{ ok: true, tier: string, coverage: Record<string, string> }
 *          | { ok: false, defect: string, detail?: string }}
 */
export function parseValidationCoverage(critique, opts = {}) {
  // Check 1: must be an array
  if (!Array.isArray(critique)) {
    return { ok: false, defect: 'not-array', detail: `Expected array, got ${typeof critique}` };
  }

  // Check 2: all elements must be strings
  for (let i = 0; i < critique.length; i++) {
    if (typeof critique[i] !== 'string') {
      return {
        ok: false,
        defect: `non-string-element:${i}`,
        detail: `Element at index ${i} is ${typeof critique[i]}, expected string`,
      };
    }
  }

  // Checks 3-6: parse each bullet
  const seen = new Map(); // key -> value

  for (let i = 0; i < critique.length; i++) {
    const bullet = critique[i];
    const match = BULLET_RE.exec(bullet);

    // Check 3: bullet must match key:value shape
    if (!match) {
      return {
        ok: false,
        defect: `malformed-bullet:${i}`,
        detail: `Bullet at index ${i} has no valid key:value separator: ${JSON.stringify(bullet)}`,
      };
    }

    const key = match[1];
    // match[2] is the inner captured value; the regex outer \s*$ trims trailing
    // whitespace so for "happy:    " the lazy (.*?) leaves match[2] as ''
    const rawValue = match[2];

    // Check 4: key must be in the allowed set
    if (!ALLOWED_KEYS.has(key)) {
      return {
        ok: false,
        defect: `unknown-key:${key}`,
        detail: `Key "${key}" at index ${i} is not in the allowed rubric key set`,
      };
    }

    // Check 5: no duplicates
    if (seen.has(key)) {
      return {
        ok: false,
        defect: `duplicate-key:${key}`,
        detail: `Key "${key}" appears more than once (repeated at index ${i})`,
      };
    }

    // Check 6: value must not be empty/whitespace-only
    // The regex outer \s*$ has already consumed trailing whitespace from the match,
    // so rawValue is the trimmed post-colon content. Empty string means empty value.
    if (rawValue.length === 0) {
      return {
        ok: false,
        defect: `empty-value:${key}`,
        detail: `Key "${key}" at index ${i} has an empty or whitespace-only value`,
      };
    }

    seen.set(key, rawValue);
  }

  // Check 8: tier bullet must be present
  if (!seen.has('tier')) {
    return { ok: false, defect: 'tier-missing', detail: 'No "tier:" bullet found in critique' };
  }

  const tierValue = seen.get('tier');

  // Check 9: tier value must be valid
  if (!TIER_VALUES.has(tierValue)) {
    return {
      ok: false,
      defect: `tier-invalid:${tierValue}`,
      detail: `Tier value "${tierValue}" is not one of: light, standard, critical`,
    };
  }

  // Check 10: tier-mismatch against opts.tier
  if (opts.tier && opts.tier !== tierValue) {
    return {
      ok: false,
      defect: 'tier-mismatch',
      detail: `opts.tier is "${opts.tier}" but critique declares tier: "${tierValue}"`,
    };
  }

  // Check 11: Tier-1 required keys
  for (const key of TIER1_KEYS) {
    if (!seen.has(key)) {
      return {
        ok: false,
        defect: `missing-key:${key}`,
        detail: `Required Tier-1 key "${key}" is absent from critique`,
      };
    }
  }

  // Check 12: Tier-2 required keys
  for (const key of TIER2_KEYS) {
    if (!seen.has(key)) {
      return {
        ok: false,
        defect: `missing-key:${key}`,
        detail: `Required Tier-2 key "${key}" is absent from critique`,
      };
    }
  }

  // Check 13: critical.residual-risk required when tier is critical
  if (tierValue === 'critical' && !seen.has('critical.residual-risk')) {
    return {
      ok: false,
      defect: 'missing-key:critical.residual-risk',
      detail: 'tier is "critical" but "critical.residual-risk:" bullet is absent',
    };
  }

  // Build coverage map (all keys except 'tier')
  const coverage = {};
  for (const [key, value] of seen.entries()) {
    if (key !== 'tier') {
      coverage[key] = value;
    }
  }

  return { ok: true, tier: tierValue, coverage };
}
