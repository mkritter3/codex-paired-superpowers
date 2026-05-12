#!/usr/bin/env node
// v0.9.0 slice 4 — doctor's availability sub-report.
//
// Invoked from bin/codex-paired-doctor as:
//   node lib/codex-bridge/availability/doctor-report.js [--force]
//
// Reads cache (or re-probes if stale / --force), then prints to stdout:
//   - one line per CLI: "<name>: <STATUS> (<detail>)"
//   - a blank line
//   - one line per role: "<role>: ladder ladder ladder → <chosen|UNROUTABLE>"
//
// Exit codes:
//   0 — at least one CLI is available
//   1 — every CLI in cli-clients is missing/broken (hard halt for dispatch)
//
// Designed to be parsed by humans first, but the format is stable enough
// for tests + downstream scripts. The bash wrapper just streams stdout
// through to the user.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  availableCLISet,
  detectAvailableCLIs,
  firstAvailableInLadder,
} from './detector.js';
import { loadRecommendations } from '../role-routing/recommendations.js';
import { loadProjectConfig } from '../role-routing/config-loader.js';
import { _readPluginVersion } from './prober.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv) {
  const opts = { force: false, json: false, repoRoot: process.cwd() };
  for (const a of argv.slice(2)) {
    if (a === '--force') opts.force = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--repo-root=')) opts.repoRoot = a.slice('--repo-root='.length);
  }
  return opts;
}

function formatLadderEntry({ cli, variant }) {
  return variant ? `${cli}{${variant}}` : cli;
}

function statusLabel(status) {
  switch (status) {
    case 'available': return 'PASS';
    case 'missing':   return 'NOT INSTALLED';
    case 'broken':    return 'BROKEN';
    default:          return 'UNKNOWN';
  }
}

function formatCliLine(payload) {
  const name = payload.name;
  const status = statusLabel(payload.status);
  if (payload.status === 'available') {
    const parts = [];
    if (payload.version === 'session') {
      parts.push('running this session');
    } else if (payload.version) {
      parts.push(`v${payload.version.replace(/^v/, '')}`);
    }
    if (payload.resolved_path) parts.push(payload.resolved_path);
    return `- ${name}: ${status} (${parts.join(', ') || 'no detail'})`;
  }
  const detail = payload.error || 'no detail';
  return `- ${name}: ${status} — ${detail}`;
}

function formatRoleLine(role, recEntry, availableSet) {
  const ladder = recEntry.preference.map(formatLadderEntry).join(' → ');
  const first = firstAvailableInLadder(recEntry, availableSet);
  if (!first) {
    return `- ${role}: ${ladder} → UNROUTABLE (no available CLI in ladder)`;
  }
  const chosen = formatLadderEntry(first);
  if (first.index === 0) {
    return `- ${role}: ${ladder} → ${chosen} (preferred)`;
  }
  // Walk preceding ladder entries to report which were skipped.
  const skipped = recEntry.preference
    .slice(0, first.index)
    .map(formatLadderEntry)
    .join(', ');
  return `- ${role}: ${ladder} → ${chosen} (fallback; preferred ${skipped} unavailable)`;
}

async function main() {
  const opts = parseArgs(process.argv);
  let cliClients;
  let recommendations;
  try {
    const cfg = loadProjectConfig(opts.repoRoot);
    cliClients = cfg.cliClients;
    // recommendations validated against the merged cliClients map.
    recommendations = cfg.recommendations;
  } catch (err) {
    process.stderr.write(`doctor-report: failed to load config: ${err.message}\n`);
    cliClients = null;
    try {
      recommendations = loadRecommendations();
    } catch {
      recommendations = new Map();
    }
  }

  if (!cliClients) {
    process.stderr.write('doctor-report: no cli-clients loaded; aborting.\n');
    process.exit(1);
  }

  const pluginVersion = _readPluginVersion();
  const detection = await detectAvailableCLIs(opts.repoRoot, {
    force: opts.force,
    cliClientsLoader: () => cliClients,
    currentPluginVersion: pluginVersion,
  });
  const availableSet = availableCLISet(detection);

  // --- JSON output mode (--json) -------------------------------------
  // Embedded in doctor's --json envelope so programmatic consumers see
  // CLI availability + per-role fallback hints alongside the standard
  // doctor checks. (Codex round-1 deferred: --json --force previously
  // dropped this section silently.)
  if (opts.json) {
    const clisOut = [];
    const sortedNamesJson = [...detection.keys()].sort();
    for (const name of sortedNamesJson) {
      const p = detection.get(name);
      clisOut.push({
        name: p.name,
        status: p.status,
        version: p.version || null,
        resolved_path: p.resolved_path || null,
        error: p.error || null,
      });
    }
    const rolesOut = [];
    const sortedRolesJson = [...recommendations.keys()].sort();
    for (const role of sortedRolesJson) {
      const rec = recommendations.get(role);
      const first = firstAvailableInLadder(rec, availableSet);
      rolesOut.push({
        role,
        ladder: rec.preference.map((p) => ({ cli: p.cli, variant: p.variant || null })),
        chosen: first
          ? { cli: first.cli, variant: first.variant || null, index: first.index }
          : null,
        routable: !!first,
      });
    }
    const payload = {
      plugin_version: pluginVersion,
      clis: clisOut,
      roles: rolesOut,
      summary: {
        total: detection.size,
        available: availableSet.size,
      },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(availableSet.size > 0 ? 0 : 1);
  }

  // --- CLI section ----------------------------------------------------
  process.stdout.write('Availability:\n');
  const sortedNames = [...detection.keys()].sort();
  for (const name of sortedNames) {
    process.stdout.write(formatCliLine(detection.get(name)) + '\n');
  }

  // --- Role section ---------------------------------------------------
  process.stdout.write('\nRole routing (fallback hints):\n');
  const sortedRoles = [...recommendations.keys()].sort();
  for (const role of sortedRoles) {
    process.stdout.write(formatRoleLine(role, recommendations.get(role), availableSet) + '\n');
  }

  // Summary line.
  const totalClis = detection.size;
  const availableCount = availableSet.size;
  process.stdout.write(
    `\nSummary: ${availableCount}/${totalClis} CLIs available (plugin ${pluginVersion}).\n`,
  );

  process.exit(availableCount > 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`doctor-report: unexpected failure: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
