/**
 * live-validation-coverage.js — Phase E coverage parser
 *
 * Parses the array of bullet strings from a Codex live-validation-coverage verdict block.
 * Returns { ok: true, tier, coverage } or { ok: false, defect, detail }.
 *
 * Phase E rubric: 13 live.* keys required for all tiers (no critical-only key).
 * This is a separate module from validation-coverage.js (Phase A) so that the
 * existing Phase A parser remains strict for its own key set.
 */

// ─── Allowed-keys constants ───────────────────────────────────────────────────

const LIVE_KEYS = [
  'live.scenarios-covered',
  'live.preconditions-enforced',
  'live.user-takeover-safe',
  'live.evidence-quality',
  'live.assertions-visible',
  'live.logs-reviewed',
  'live.flake-triaged',
  'live.failures-fixed',
  'live.regressions-rerun',
  'live.cleanup-recorded',
  'live.deferred-justified',
  'live.environment-reproducible',
  'live.residual-risk',
];

const TIER_VALUES = new Set(['light', 'standard', 'critical']);

const ALLOWED_KEYS = new Set([
  'tier',
  ...LIVE_KEYS,
]);

// Bullet shape: optional leading whitespace, key (alphanumeric + dots + hyphens),
// optional whitespace, colon, optional whitespace, optional value, optional trailing whitespace.
// The value capture (.*?) allows empty matches so the empty-value defect path is reachable.
const BULLET_RE = /^\s*([a-z][a-z0-9.\-]*)\s*:\s*(.*?)\s*$/;

/**
 * Parse a live-validation-coverage critique (Phase E).
 *
 * @param {unknown} critique - Should be an array of strings from a verdict block.
 * @param {{ tier?: string }} [opts] - Optional. If opts.tier is provided, it must
 *   match the tier bullet's value or tier-mismatch is emitted.
 * @returns {{ ok: true, tier: string, coverage: Record<string, string> }
 *          | { ok: false, defect: string, detail?: string }}
 */
export function parseLiveValidationCoverage(critique, opts = {}) {
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
    // whitespace so for "live.scenarios-covered:    " the lazy (.*?) leaves match[2] as ''
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

  // Check 7: tier bullet must be present
  if (!seen.has('tier')) {
    return { ok: false, defect: 'tier-missing', detail: 'No "tier:" bullet found in critique' };
  }

  const tierValue = seen.get('tier');

  // Check 8: tier value must be valid
  if (!TIER_VALUES.has(tierValue)) {
    return {
      ok: false,
      defect: `tier-invalid:${tierValue}`,
      detail: `Tier value "${tierValue}" is not one of: light, standard, critical`,
    };
  }

  // Check 9: tier-mismatch against opts.tier
  if (opts.tier && opts.tier !== tierValue) {
    return {
      ok: false,
      defect: 'tier-mismatch',
      detail: `opts.tier is "${opts.tier}" but critique declares tier: "${tierValue}"`,
    };
  }

  // Check 10: all 13 live.* keys are required (for any tier)
  for (const key of LIVE_KEYS) {
    if (!seen.has(key)) {
      return {
        ok: false,
        defect: `missing-key:${key}`,
        detail: `Required Phase E key "${key}" is absent from critique`,
      };
    }
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
