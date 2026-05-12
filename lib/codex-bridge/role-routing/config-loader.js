// v0.9.0 slice 3 — project-config loader.
//
// Merge order (Codex round-3 SHIP):
//   1. bundled `lib/codex-bridge/role-recommendations.json`
//   2. bundled `lib/codex-bridge/cli-clients/<name>.json`
//   3. `<repoRoot>/.codex-paired/cli-clients/<name>.json`   (extends/replaces #2)
//   4. `<repoRoot>/.codex-paired/role-routing.json`         (user routing map)
//
// Project cli-clients EXTEND when adding new variants and REPLACE when
// overriding existing top-level fields. Validation happens at LOAD time,
// not dispatch time — malformed configs throw immediately on
// `loadProjectConfig()`.
//
// Returns:
// {
//   recommendations: Map<role, {preference, rationale, permissions}>,
//   cliClients:      Map<cli, configObject>,
//   userRouting:     Map<role, {cli, variant?, permissions?}>,
// }

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoleRoutingError } from './errors.js';
import {
  loadBundledCliClients,
  readCliClientsDir,
} from './cli-clients.js';
import { validateRecommendations } from './recommendations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUNDLED_RECOMMENDATIONS_PATH = join(
  __dirname,
  '..',
  'role-recommendations.json',
);

const PROJECT_DIR = '.codex-paired';
const PROJECT_CLI_CLIENTS_DIR = join(PROJECT_DIR, 'cli-clients');
const PROJECT_ROUTING_FILE = join(PROJECT_DIR, 'role-routing.json');

const VALID_PERMISSION_MODES = new Set(['read-only', 'write-allowed']);

function readBundledRecommendationsJson() {
  try {
    return JSON.parse(readFileSync(BUNDLED_RECOMMENDATIONS_PATH, 'utf8'));
  } catch (err) {
    throw new RoleRoutingError(
      `Failed to read bundled role-recommendations.json: ${err.message}`,
      { code: 'RECOMMENDATIONS_INVALID' },
    );
  }
}

function mergeCliClients(bundled, project) {
  // Deep-merge per CLI: project entries override + extend bundled entries.
  // - top-level scalar/array fields: project value replaces bundled value.
  // - `variants`: shallow-merged so project can add a new variant without
  //   wiping bundled variants.
  // - `permissions`: shallow-merged so project can override one mode
  //   without wiping the other.
  const out = new Map(bundled);
  for (const [name, projectCfg] of project.entries()) {
    if (!out.has(name)) {
      out.set(name, { ...projectCfg });
      continue;
    }
    const base = out.get(name);
    const merged = { ...base, ...projectCfg };
    if (base.variants || projectCfg.variants) {
      merged.variants = {
        ...(base.variants || {}),
        ...(projectCfg.variants || {}),
      };
    }
    if (base.permissions || projectCfg.permissions) {
      merged.permissions = {
        ...(base.permissions || {}),
        ...(projectCfg.permissions || {}),
      };
    }
    out.set(name, merged);
  }
  return out;
}

function readProjectRoutingFile(repoRoot) {
  const abs = join(repoRoot, PROJECT_ROUTING_FILE);
  if (!existsSync(abs)) return null;
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    throw new RoleRoutingError(
      `Failed to read ${PROJECT_ROUTING_FILE}: ${err.message}`,
      { code: 'USER_ROUTING_INVALID_JSON' },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RoleRoutingError(
      `${PROJECT_ROUTING_FILE} is not valid JSON: ${err.message}`,
      { code: 'USER_ROUTING_INVALID_JSON' },
    );
  }
}

function readProjectCliClients(repoRoot) {
  const abs = join(repoRoot, PROJECT_CLI_CLIENTS_DIR);
  if (!existsSync(abs)) return new Map();
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return new Map();
  }
  if (!stat.isDirectory()) return new Map();
  try {
    return readCliClientsDir(abs);
  } catch (err) {
    if (err instanceof RoleRoutingError) throw err;
    throw new RoleRoutingError(
      `Failed to read ${PROJECT_CLI_CLIENTS_DIR}: ${err.message}`,
      { code: 'CLI_CLIENT_INVALID_JSON' },
    );
  }
}

function validateUserRouting(rawRouting, recommendations, cliClients) {
  const out = new Map();
  if (rawRouting === null || rawRouting === undefined) return out;
  if (typeof rawRouting !== 'object' || Array.isArray(rawRouting)) {
    throw new RoleRoutingError(
      `${PROJECT_ROUTING_FILE} must be a JSON object keyed by role`,
      { code: 'USER_ROUTING_INVALID_JSON' },
    );
  }
  for (const [role, entry] of Object.entries(rawRouting)) {
    if (!recommendations.has(role)) {
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} references unknown role "${role}". ` +
          `Known roles: ${[...recommendations.keys()].join(', ')}.`,
        { code: 'USER_ROUTING_UNKNOWN_ROLE', details: { role } },
      );
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} entry for role "${role}" must be an object`,
        { code: 'USER_ROUTING_MALFORMED', details: { role } },
      );
    }
    const { cli, variant, permissions } = entry;
    if (typeof cli !== 'string' || cli.length === 0) {
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} entry for role "${role}" must specify a "cli" string`,
        { code: 'USER_ROUTING_MALFORMED', details: { role } },
      );
    }
    if (!cliClients.has(cli)) {
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} role "${role}" references unknown CLI "${cli}". ` +
          `Available: ${[...cliClients.keys()].join(', ')}.`,
        { code: 'USER_ROUTING_UNKNOWN_CLI', details: { role, cli } },
      );
    }
    if (variant !== undefined && variant !== null) {
      if (typeof variant !== 'string' || variant.length === 0) {
        throw new RoleRoutingError(
          `${PROJECT_ROUTING_FILE} role "${role}" has invalid variant ${JSON.stringify(variant)}`,
          { code: 'USER_ROUTING_MALFORMED', details: { role, variant } },
        );
      }
      const cfg = cliClients.get(cli);
      const variants = (cfg && cfg.variants) || {};
      if (!Object.prototype.hasOwnProperty.call(variants, variant)) {
        throw new RoleRoutingError(
          `${PROJECT_ROUTING_FILE} role "${role}" references unknown variant ` +
            `"${variant}" on CLI "${cli}". Declared variants: ` +
            `${Object.keys(variants).join(', ') || '(none)'}.`,
          {
            code: 'USER_ROUTING_UNKNOWN_VARIANT',
            details: { role, cli, variant },
          },
        );
      }
    }
    if (permissions !== undefined && !VALID_PERMISSION_MODES.has(permissions)) {
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} role "${role}" specifies invalid permissions ` +
          `"${permissions}". Must be one of: ${[...VALID_PERMISSION_MODES].join(', ')}.`,
        {
          code: 'USER_ROUTING_INVALID_PERMISSIONS',
          details: { role, permissions },
        },
      );
    }
    const cleaned = { cli };
    if (variant !== undefined && variant !== null) cleaned.variant = variant;
    if (permissions !== undefined) cleaned.permissions = permissions;
    out.set(role, cleaned);
  }
  return out;
}

export function loadProjectConfig(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('loadProjectConfig requires repoRoot as a string');
  }

  // 1. Bundled cli-clients.
  const bundledClis = loadBundledCliClients();

  // 2. Project cli-clients overlay.
  const projectClis = readProjectCliClients(repoRoot);
  const cliClients = mergeCliClients(bundledClis, projectClis);

  // 3. Bundled recommendations, validated against merged cli-clients.
  const rawRecs = readBundledRecommendationsJson();
  const recommendations = validateRecommendations(rawRecs, cliClients);

  // 4. Project role-routing.json overlay.
  const rawRouting = readProjectRoutingFile(repoRoot);
  const userRouting = validateUserRouting(rawRouting, recommendations, cliClients);

  return { recommendations, cliClients, userRouting };
}
