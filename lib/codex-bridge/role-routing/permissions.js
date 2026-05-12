// v0.9.0 slice 3 — permissions mapper.
//
// `mapPermissions(cli, mode)` returns the CLI args array declared in
// `cli-clients/<cli>.json`'s `permissions.<mode>.args`. This is the
// single source of truth for "what flags does CLI X need to run in
// mode Y" — adapters consume this, callers do not hand-craft flags.
//
// `refusesDangerousFlagsForReadOnly(cli, mode, providedArgs)` is a
// sanity check used by the resolver/dispatcher boundary before spawn:
// if a caller claims a role is `read-only` but is trying to inject the
// CLI's write-mode flags, the check returns `true` (refuse).

import { RoleRoutingError } from './errors.js';
import { loadBundledCliClients } from './cli-clients.js';

const VALID_MODES = new Set(['read-only', 'write-allowed']);

export function mapPermissions(cli, mode, { cliClients } = {}) {
  if (!VALID_MODES.has(mode)) {
    throw new RoleRoutingError(
      `Unknown permission mode "${mode}". Must be one of: ${[...VALID_MODES].join(', ')}`,
      { code: 'UNKNOWN_PERMISSION_MODE', details: { cli, mode } },
    );
  }
  const clis = cliClients || loadBundledCliClients();
  if (!clis.has(cli)) {
    throw new RoleRoutingError(
      `Unknown CLI "${cli}". No matching cli-clients/${cli}.json.`,
      { code: 'UNKNOWN_CLI', details: { cli } },
    );
  }
  const cfg = clis.get(cli);
  const perms = (cfg && cfg.permissions) || {};
  const entry = perms[mode];
  if (!entry || !Array.isArray(entry.args)) {
    // CLIs that don't declare a permissions block (e.g. claude.json which
    // is config-only / claude-task) return an empty args array. They can
    // not be sandboxed via flag here.
    return [];
  }
  // Defensive copy so callers can mutate without affecting cached config.
  return [...entry.args];
}

// Single source of truth for "which flags mean write-mode for this CLI."
// Read directly from cli-clients/<cli>.json's permissions["write-allowed"].args.
// Returns [] for CLIs without a write-allowed permissions block (e.g. claude
// which is runtime_kind=claude-task, or any cli that doesn't sandbox).
// Used by both refusesDangerousFlagsForReadOnly (dispatch-time) and
// config-loader's load-time bypass-prevention checks.
export function getDangerousFlagsForCli(cli, deps = {}) {
  try {
    return mapPermissions(cli, 'write-allowed', deps);
  } catch {
    return [];
  }
}

export function refusesDangerousFlagsForReadOnly(cli, mode, providedArgs, deps = {}) {
  if (mode !== 'read-only') return false;
  if (!Array.isArray(providedArgs)) return false;
  const writeArgs = getDangerousFlagsForCli(cli, deps);
  if (writeArgs.length === 0) return false;
  // If ANY of the write-allowed signature tokens appear in providedArgs,
  // refuse. Compare token-by-token; we don't care about ordering.
  const provided = new Set(providedArgs);
  for (const flag of writeArgs) {
    if (provided.has(flag)) return true;
  }
  return false;
}
