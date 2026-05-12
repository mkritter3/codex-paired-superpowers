// v0.9.0 slice 3 — preference-ladder walker.
//
// `resolveAdapter(role, availableCLIs, userRouting, deps)` maps a role
// to a concrete `(cli, variant)` at dispatch time. It walks the
// preference ladder from `role-recommendations.json` and picks the
// first available CLI; an explicit user-routing override short-circuits
// the walk.
//
// Hard-halt codes (spec § 2 + Codex round-3 SHIP):
//   - `override-cli-unavailable`     — user opted into CLI X, X not installed.
//   - `override-variant-unknown`     — user opted into variant V on CLI Y, V not declared.
//   - `no-supported-cli-for-role`    — full ladder walk found nothing available.
//
// Returned shape:
// {
//   cli, variant,
//   resolution_source: 'override' | 'recommendation',
//   preference_index,
//   preference_ladder: string[],          // pretty-printed ladder for audit
//   unavailable_candidates: string[],     // ladder entries skipped because of availability
//   fallback_reason: string | null,
//   permissions: 'read-only' | 'write-allowed',
//   audit_warnings: string[],             // e.g. reviewer + write-allowed
// }
//
// `availableCLIs` is a Set<string> of cli names that doctor's cache
// reports as installed. Variants are availability-checked against the
// `cli-clients/<cli>.json`'s `variants` map. Slice 3 trusts the caller
// for cli availability; slice 4 builds the cache that feeds this.

import { RoleRoutingError } from './errors.js';
import { loadRecommendations } from './recommendations.js';
import { loadBundledCliClients } from './cli-clients.js';

// Roles whose default permissions are read-only; routing a write-allowed
// override to one of these triggers an audit warning.
const REVIEWER_ROLE_PREFIX = /^(paired-reviewer|expert-)/;

function isReviewerRole(role) {
  return REVIEWER_ROLE_PREFIX.test(role);
}

function formatLadderEntry({ cli, variant }) {
  return variant ? `${cli}{${variant}}` : cli;
}

function pickRecommendations(role, deps) {
  const recs = deps.recommendations || loadRecommendations();
  if (!recs.has(role)) {
    throw new RoleRoutingError(
      `Unknown role "${role}". No entry in role-recommendations.json.`,
      { code: 'UNKNOWN_ROLE', details: { role } },
    );
  }
  return recs.get(role);
}

function pickCliClients(deps) {
  return deps.cliClients || loadBundledCliClients();
}

function variantDeclared(cliClients, cli, variant) {
  if (!cliClients.has(cli)) return false;
  const cfg = cliClients.get(cli);
  const variants = (cfg && cfg.variants) || {};
  return Object.prototype.hasOwnProperty.call(variants, variant);
}

function applyAuditWarnings(role, permissions) {
  const warnings = [];
  if (isReviewerRole(role) && permissions === 'write-allowed') {
    warnings.push(
      `reviewer-role-write-allowed: role "${role}" is reviewer-class but ` +
        `was routed with write-allowed permissions. Every dispatch will ` +
        `emit this audit warning.`,
    );
  }
  return warnings;
}

export function resolveAdapter(role, availableCLIs, userRouting, deps = {}) {
  if (typeof role !== 'string' || role.length === 0) {
    throw new TypeError('resolveAdapter requires a non-empty role string');
  }
  if (!(availableCLIs instanceof Set)) {
    throw new TypeError('resolveAdapter requires availableCLIs to be a Set<string>');
  }
  const routing = userRouting instanceof Map
    ? userRouting
    : new Map(Object.entries(userRouting || {}));

  const rec = pickRecommendations(role, deps);
  const cliClients = pickCliClients(deps);
  const ladderPretty = rec.preference.map(formatLadderEntry);

  // --- Override path ----------------------------------------------------
  if (routing.has(role)) {
    const override = routing.get(role);
    if (!override || typeof override !== 'object' || typeof override.cli !== 'string') {
      throw new RoleRoutingError(
        `User routing for role "${role}" must be an object with a "cli" string`,
        { code: 'USER_ROUTING_MALFORMED', details: { role } },
      );
    }
    const overrideVariant = override.variant ?? null;
    if (!availableCLIs.has(override.cli)) {
      throw new RoleRoutingError(
        `Role "${role}" is explicitly routed to "${override.cli}", but ` +
          `"${override.cli}" is not installed. Install it or remove the override.`,
        {
          code: 'override-cli-unavailable',
          details: { role, cli: override.cli, variant: overrideVariant },
        },
      );
    }
    if (overrideVariant !== null) {
      if (!variantDeclared(cliClients, override.cli, overrideVariant)) {
        throw new RoleRoutingError(
          `Role "${role}" override specifies variant "${overrideVariant}" on ` +
            `CLI "${override.cli}", but no such variant is declared in ` +
            `cli-clients/${override.cli}.json.`,
          {
            code: 'override-variant-unknown',
            details: { role, cli: override.cli, variant: overrideVariant },
          },
        );
      }
    }
    const permissions = override.permissions || rec.permissions;
    return {
      cli: override.cli,
      variant: overrideVariant,
      resolution_source: 'override',
      preference_index: -1,
      preference_ladder: ladderPretty,
      unavailable_candidates: [],
      fallback_reason: null,
      permissions,
      audit_warnings: applyAuditWarnings(role, permissions),
    };
  }

  // --- Ladder walk ------------------------------------------------------
  const unavailable = [];
  for (let i = 0; i < rec.preference.length; i += 1) {
    const entry = rec.preference[i];
    const pretty = formatLadderEntry(entry);
    const cliInstalled = availableCLIs.has(entry.cli);
    const variantOk = entry.variant === null
      || variantDeclared(cliClients, entry.cli, entry.variant);
    if (cliInstalled && variantOk) {
      const permissions = rec.permissions;
      return {
        cli: entry.cli,
        variant: entry.variant,
        resolution_source: 'recommendation',
        preference_index: i,
        preference_ladder: ladderPretty,
        unavailable_candidates: unavailable,
        fallback_reason: unavailable.length > 0
          ? `Preferred ${unavailable.join(', ')} unavailable; fell back to ${pretty}.`
          : null,
        permissions,
        audit_warnings: applyAuditWarnings(role, permissions),
      };
    }
    unavailable.push(pretty);
  }

  throw new RoleRoutingError(
    `no-supported-cli-for-role: role "${role}" has no available CLI in its ` +
      `preference ladder (${ladderPretty.join(' -> ')}); no fallback possible.`,
    {
      code: 'no-supported-cli-for-role',
      details: { role, ladder: ladderPretty, unavailable },
    },
  );
}

export { RoleRoutingError };
