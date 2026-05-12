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

// cli-harness adapter modules live at lib/codex-bridge/cli-harness/adapters/<cli>.js.
// Resolved from this file's location: ../cli-harness/adapters/.
const CLI_HARNESS_ADAPTERS_DIR = join(
  __dirname,
  '..',
  'cli-harness',
  'adapters',
);

const PROJECT_DIR = '.codex-paired';
const PROJECT_CLI_CLIENTS_DIR = join(PROJECT_DIR, 'cli-clients');
const PROJECT_ROUTING_FILE = join(PROJECT_DIR, 'role-routing.json');

const VALID_PERMISSION_MODES = new Set(['read-only', 'write-allowed']);

// Explicit allowlist of non-cli-harness runtime kinds. Anything declared
// outside this set (and outside the implicit cli-harness default) is
// treated as a hostile or buggy config and rejected at load time. This
// closes the round-1 bypass where `runtime_kind: "banana"` silently
// skipped the adapter-file existence check.
//
// Keep in sync with cli-harness/adapters/registry.js dispatcher.
const SUPPORTED_NON_HARNESS_RUNTIME_KINDS = new Set(['claude-task']);

// A cli is dispatchable if it either declares an allowlisted non-cli-harness
// runtime (currently only `claude-task`, handled by Claude Code's Agent
// tool) OR has an adapter module on disk at cli-harness/adapters/<cli>.js.
// This mirrors getAdapter() in cli-harness/adapters/registry.js but is
// sync and pure-path-existence so config-loader stays synchronous.
//
// NOTE: this function assumes `validateRuntimeKinds()` has already run and
// rejected unknown runtime_kind values; here we only need to distinguish
// "allowlisted non-harness" vs "cli-harness default".
function hasDispatchableAdapter(cli, cliClients) {
  const cfg = cliClients.get(cli);
  if (
    cfg &&
    cfg.runtime_kind &&
    SUPPORTED_NON_HARNESS_RUNTIME_KINDS.has(cfg.runtime_kind)
  ) {
    // claude-task and friends are dispatched outside the cli-harness;
    // no adapter module required.
    return true;
  }
  const modulePath = join(CLI_HARNESS_ADAPTERS_DIR, `${cli}.js`);
  return existsSync(modulePath);
}

// CRITICAL safety boundary: reject any cli-client (bundled or project) that
// declares a `runtime_kind` outside the supported set. Runs during the
// merge pass so that an unknown runtime_kind aborts the whole load, even
// if no userRouting entry references that cli — a project file alone is
// enough signal of a hostile or buggy config.
//
// Supported values:
//   - omitted / undefined  → cli-harness default (requires adapter file)
//   - "cli-harness"        → explicit cli-harness (requires adapter file)
//   - "claude-task"        → dispatched via Claude Code Agent tool
function validateRuntimeKinds(cliClients) {
  for (const [cli, cfg] of cliClients.entries()) {
    if (!cfg || cfg.runtime_kind === undefined || cfg.runtime_kind === null) {
      continue;
    }
    const kind = cfg.runtime_kind;
    if (kind === 'cli-harness') continue;
    if (SUPPORTED_NON_HARNESS_RUNTIME_KINDS.has(kind)) continue;
    throw new RoleRoutingError(
      `cli-client "${cli}" declares unknown runtime_kind="${kind}". ` +
        `Supported: cli-harness (default, requires adapter file), ` +
        `${[...SUPPORTED_NON_HARNESS_RUNTIME_KINDS].join(', ')}.`,
      {
        code: 'UNKNOWN_RUNTIME_KIND',
        details: { cli, runtime_kind: kind },
      },
    );
  }
}

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
    if (!hasDispatchableAdapter(cli, cliClients)) {
      // CRITICAL safety boundary: userRouting is an explicit caller
      // assertion that the role should run on this cli. If the cli has
      // no adapter on disk and no special runtime_kind, dispatch would
      // fail at spawn time. Reject at load instead.
      // Preference-ladder entries (like `qwen` in expert-backend) are
      // NOT subject to this check — the resolver gracefully walks past
      // unavailable ladder entries via the availability Set. Only
      // explicit user overrides need this guard.
      throw new RoleRoutingError(
        `${PROJECT_ROUTING_FILE} role "${role}" routes to CLI "${cli}" but ` +
          `no adapter module exists at cli-harness/adapters/${cli}.js and ` +
          `the cli-client config does not declare a non-cli-harness ` +
          `runtime_kind. Routing this role would fail at dispatch.`,
        { code: 'UNSUPPORTED_ADAPTER', details: { role, cli } },
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

// Capture the BUNDLED dangerous-flag baseline BEFORE merging with project
// configs. Round-2 fix: a project override could erase or alter
// `permissions["write-allowed"].args` and thereby empty the dangerous-flag
// set used by the bypass check. By snapshotting from the bundled (immutable)
// configs, project overrides cannot launder a bundled write-mode flag into
// a "safe" arg by also clearing the baseline.
//
// For cli names that exist ONLY in the project layer (no bundled counterpart),
// there is no immutable baseline — the project's own
// `permissions["write-allowed"].args` IS the source of truth. The caller
// reconciles that case using the merged config.
function snapshotBundledDangerousFlags(bundledCliClients) {
  const out = new Map();
  for (const [name, cfg] of bundledCliClients.entries()) {
    const writeArgs =
      cfg && cfg.permissions && cfg.permissions['write-allowed']
        ? cfg.permissions['write-allowed'].args
        : null;
    if (Array.isArray(writeArgs) && writeArgs.length > 0) {
      out.set(name, new Set(writeArgs));
    } else {
      out.set(name, new Set());
    }
  }
  return out;
}

// CRITICAL safety boundary: scan the merged cli-clients map for any
// configuration that would silently grant write capability to a
// read-only role. Two attack surfaces:
//
//  1. `additional_args` (appended to every spawn) containing a flag
//     that the cli's write-mode signature declares — bypasses sandboxing
//     for every role.
//  2. `permissions["read-only"].args` containing a write-mode signature
//     flag — turns the "read-only" mode itself into write-mode.
//
// Round-2 fix: for cli names that exist in the BUNDLED configs, the
// dangerous-flag baseline is taken from the immutable bundled set, NOT
// the merged set. This blocks the attack where a project clears
// `permissions["write-allowed"].args = []` to empty the dangerous set.
// For brand-new project-only clis, the project's own write-allowed args
// are used (there is no other source of truth).
//
// Applies to BOTH bundled and merged configs, so a malicious bundled
// config would also fail (defense in depth).
function validateNoWriteFlagBypass(cliClients, bundledDangerousFlags) {
  for (const [cli, cfg] of cliClients.entries()) {
    let dangerousSet;
    if (bundledDangerousFlags.has(cli)) {
      // Bundled cli: use the immutable baseline. Project cannot launder
      // the dangerous flag by erasing write-allowed.args at the merge layer.
      dangerousSet = bundledDangerousFlags.get(cli);
    } else {
      // Project-only cli: the project IS the source of truth for what
      // counts as its write-mode signature. Use the merged (== project)
      // write-allowed args.
      const projectWriteArgs =
        cfg && cfg.permissions && cfg.permissions['write-allowed']
          ? cfg.permissions['write-allowed'].args
          : null;
      dangerousSet = new Set(
        Array.isArray(projectWriteArgs) ? projectWriteArgs : [],
      );
    }
    if (dangerousSet.size === 0) continue;

    if (Array.isArray(cfg && cfg.additional_args)) {
      for (const flag of cfg.additional_args) {
        if (dangerousSet.has(flag)) {
          throw new RoleRoutingError(
            `cli-clients/${cli}.json declares "${flag}" in additional_args, ` +
              `which is a write-mode signature flag for ${cli}. ` +
              `additional_args is appended to every invocation; putting ` +
              `write-mode flags there would silently grant write capability ` +
              `to read-only roles. Remove the flag from additional_args.`,
            {
              code: 'DANGEROUS_FLAGS_IN_ADDITIONAL_ARGS',
              details: { cli, flag },
            },
          );
        }
      }
    }

    const readOnlyArgs =
      cfg && cfg.permissions && cfg.permissions['read-only']
        ? cfg.permissions['read-only'].args
        : null;
    if (Array.isArray(readOnlyArgs)) {
      for (const flag of readOnlyArgs) {
        if (dangerousSet.has(flag)) {
          throw new RoleRoutingError(
            `cli-clients/${cli}.json declares "${flag}" in ` +
              `permissions["read-only"].args, which is a write-mode ` +
              `signature flag for ${cli}. This would turn the read-only ` +
              `mode into write-mode. Remove the flag from the read-only ` +
              `permission's args.`,
            {
              code: 'READ_ONLY_PERMISSION_HAS_WRITE_FLAGS',
              details: { cli, flag },
            },
          );
        }
      }
    }
  }
}

export function loadProjectConfig(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('loadProjectConfig requires repoRoot as a string');
  }

  // 1. Bundled cli-clients.
  const bundledClis = loadBundledCliClients();

  // 1b. Snapshot the BUNDLED dangerous-flag baseline before any project
  // overlay can mutate it. Used by validateNoWriteFlagBypass below so a
  // project override cannot launder a bundled write-mode flag by
  // simultaneously erasing the baseline.
  const bundledDangerousFlags = snapshotBundledDangerousFlags(bundledClis);

  // 2. Project cli-clients overlay.
  const projectClis = readProjectCliClients(repoRoot);
  const cliClients = mergeCliClients(bundledClis, projectClis);

  // 2a. Reject any cli-client (bundled or project) declaring an unknown
  // runtime_kind. Round-2 fix: closes the `runtime_kind: "banana"` bypass
  // of the adapter-file existence check.
  validateRuntimeKinds(cliClients);

  // 2b. Defense in depth: reject merged cli-clients with write-flag
  // bypasses BEFORE any other validation can consume them. Uses the
  // immutable bundled baseline to defeat baseline-erasure attacks.
  validateNoWriteFlagBypass(cliClients, bundledDangerousFlags);

  // 3. Bundled recommendations, validated against merged cli-clients.
  const rawRecs = readBundledRecommendationsJson();
  const recommendations = validateRecommendations(rawRecs, cliClients);

  // 4. Project role-routing.json overlay.
  const rawRouting = readProjectRoutingFile(repoRoot);
  const userRouting = validateUserRouting(rawRouting, recommendations, cliClients);

  return { recommendations, cliClients, userRouting };
}
