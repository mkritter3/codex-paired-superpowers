// v0.9.0 slice 3 — bundled role-recommendations loader + parser.
//
// `loadRecommendations()` returns a Map<role, {preference, rationale,
// permissions}> where `preference` is an array of `{cli, variant}` tuples.
// All validation happens at load time:
//   - each role has `preference` (non-empty array) + `rationale` + `permissions`
//   - `permissions` is one of "read-only" or "write-allowed"
//   - each preference entry parses cleanly (plain `"codex"` or
//     `"ollama{variant}"`)
//   - each cli referenced in any preference matches a bundled
//     `cli-clients/<name>.json`
//   - each variant referenced in any preference matches a declared
//     variant in that cli's config
//
// Throws `RoleRoutingError` with a stable `.code` on validation failure.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoleRoutingError } from './errors.js';
import { loadBundledCliClients } from './cli-clients.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RECOMMENDATIONS_PATH = join(
  __dirname,
  '..',
  'role-recommendations.json',
);

const PERMISSION_MODES = new Set(['read-only', 'write-allowed']);
// Plain entry: a single token of [A-Za-z0-9._-].
const PLAIN_RE = /^[A-Za-z0-9_-]+$/;
// Variant entry: `<cli>{<variant>}` where variant may contain dots, colons,
// hyphens, etc. to match real model-name shapes like `kimi-k2.6`.
const VARIANT_RE = /^([A-Za-z0-9_-]+)\{([A-Za-z0-9._:-]+)\}$/;

let cache = null;

export function _resetRecommendationsCache() {
  cache = null;
}

export function parsePreferenceEntry(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new RoleRoutingError(
      `Preference entry must be a non-empty string; got ${JSON.stringify(str)}`,
      { code: 'MALFORMED_PREFERENCE_ENTRY' },
    );
  }
  if (PLAIN_RE.test(str)) {
    return { cli: str, variant: null };
  }
  const match = VARIANT_RE.exec(str);
  if (!match) {
    throw new RoleRoutingError(
      `Malformed preference entry: ${JSON.stringify(str)}. ` +
        `Expected "<cli>" or "<cli>{<variant>}".`,
      { code: 'MALFORMED_PREFERENCE_ENTRY' },
    );
  }
  const [, cli, variant] = match;
  return { cli, variant };
}

function validateRoleEntry(role, raw, cliClients) {
  if (!raw || typeof raw !== 'object') {
    throw new RoleRoutingError(
      `Role "${role}" recommendation must be an object`,
      { code: 'RECOMMENDATIONS_INVALID', details: { role } },
    );
  }
  const { preference, rationale, permissions } = raw;
  if (!Array.isArray(preference) || preference.length === 0) {
    throw new RoleRoutingError(
      `Role "${role}" must have a non-empty preference array`,
      { code: 'RECOMMENDATIONS_INVALID', details: { role } },
    );
  }
  if (typeof rationale !== 'string' || rationale.length === 0) {
    throw new RoleRoutingError(
      `Role "${role}" must have a non-empty rationale string`,
      { code: 'RECOMMENDATIONS_INVALID', details: { role } },
    );
  }
  if (!PERMISSION_MODES.has(permissions)) {
    throw new RoleRoutingError(
      `Role "${role}" has invalid permissions "${permissions}". ` +
        `Must be one of: ${[...PERMISSION_MODES].join(', ')}`,
      { code: 'RECOMMENDATIONS_INVALID', details: { role, permissions } },
    );
  }

  const parsedPreference = preference.map((entry, idx) => {
    let parsed;
    try {
      parsed = parsePreferenceEntry(entry);
    } catch (err) {
      // Re-throw with role context attached.
      throw new RoleRoutingError(
        `Role "${role}" preference[${idx}]: ${err.message}`,
        {
          code: err.code || 'MALFORMED_PREFERENCE_ENTRY',
          details: { role, index: idx, entry },
        },
      );
    }
    if (!cliClients.has(parsed.cli)) {
      throw new RoleRoutingError(
        `Role "${role}" preference[${idx}] references unknown CLI ` +
          `"${parsed.cli}". No matching cli-clients/${parsed.cli}.json.`,
        {
          code: 'RECOMMENDATIONS_INVALID',
          details: { role, index: idx, cli: parsed.cli },
        },
      );
    }
    if (parsed.variant !== null) {
      const cfg = cliClients.get(parsed.cli);
      const variants = (cfg && cfg.variants) || {};
      if (!Object.prototype.hasOwnProperty.call(variants, parsed.variant)) {
        throw new RoleRoutingError(
          `Role "${role}" preference[${idx}] references unknown variant ` +
            `"${parsed.variant}" on CLI "${parsed.cli}". ` +
            `Declared variants: ${Object.keys(variants).join(', ') || '(none)'}.`,
          {
            code: 'RECOMMENDATIONS_INVALID',
            details: {
              role,
              index: idx,
              cli: parsed.cli,
              variant: parsed.variant,
            },
          },
        );
      }
    }
    return parsed;
  });

  return {
    preference: parsedPreference,
    rationale,
    permissions,
  };
}

export function loadRecommendations({ cliClients } = {}) {
  // The cache is only valid when reading the bundled defaults; if a caller
  // passes a custom cliClients map we re-validate (used by config-loader).
  if (cache && !cliClients) return cache;

  let raw;
  try {
    raw = JSON.parse(readFileSync(RECOMMENDATIONS_PATH, 'utf8'));
  } catch (err) {
    throw new RoleRoutingError(
      `Failed to read role-recommendations.json: ${err.message}`,
      { code: 'RECOMMENDATIONS_INVALID' },
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RoleRoutingError(
      'role-recommendations.json must be an object keyed by role',
      { code: 'RECOMMENDATIONS_INVALID' },
    );
  }

  const clis = cliClients || loadBundledCliClients();
  const out = new Map();
  for (const [role, entry] of Object.entries(raw)) {
    out.set(role, validateRoleEntry(role, entry, clis));
  }

  if (!cliClients) cache = out;
  return out;
}

// Lower-level helper for config-loader: validate an externally-supplied
// recommendations object against an externally-supplied cliClients map.
// Returns the same parsed Map<role, ...> shape.
export function validateRecommendations(rawRecs, cliClients) {
  if (!rawRecs || typeof rawRecs !== 'object' || Array.isArray(rawRecs)) {
    throw new RoleRoutingError(
      'recommendations must be an object keyed by role',
      { code: 'RECOMMENDATIONS_INVALID' },
    );
  }
  const out = new Map();
  for (const [role, entry] of Object.entries(rawRecs)) {
    out.set(role, validateRoleEntry(role, entry, cliClients));
  }
  return out;
}
