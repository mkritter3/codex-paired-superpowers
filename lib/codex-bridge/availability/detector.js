// v0.9.0 slice 4 — availability orchestrator.
//
// `detectAvailableCLIs(repoRoot, options)` combines prober + cache:
//   1. If options.force is falsy and the on-disk cache is fresh,
//      return the cached Map<name, payload>.
//   2. Else probe every cli-client (bundled + project overlays) and write
//      the result back to cache.
//
// DI seams keep tests off the real filesystem and off real CLI binaries:
//   - cliClientsLoader(repoRoot): returns Map<name, configEntry>
//   - proberFn(name, configEntry): returns prober payload Promise
//   - nowMs: current epoch ms for cache freshness check
//   - ttlMs: cache TTL override
//   - pathExistsFn: alternative existsSync (used for cache invalidation)
//   - cacheReader / cacheWriter / cacheClearer: full I/O overrides for tests
//
// The default cliClientsLoader uses `loadProjectConfig().cliClients` so
// project overlays are probed alongside bundled configs (which is what we
// want — a project that adds a custom cli-client variant should also have
// its CLI probed for availability).

import { loadProjectConfig } from '../role-routing/config-loader.js';
import { probeCLI } from './prober.js';
import {
  DEFAULT_TTL_MS,
  isCacheFresh,
  readCache,
  writeCache,
  clearCache,
} from './cache.js';

function defaultCliClientsLoader(repoRoot) {
  return loadProjectConfig(repoRoot).cliClients;
}

export async function detectAvailableCLIs(repoRoot, options = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('detectAvailableCLIs requires repoRoot as a string');
  }
  const force = Boolean(options.force);
  const proberFn = typeof options.proberFn === 'function' ? options.proberFn : probeCLI;
  const cliClientsLoader =
    typeof options.cliClientsLoader === 'function'
      ? options.cliClientsLoader
      : defaultCliClientsLoader;
  const cacheReader = typeof options.cacheReader === 'function' ? options.cacheReader : readCache;
  const cacheWriter = typeof options.cacheWriter === 'function' ? options.cacheWriter : writeCache;
  const cacheClearer =
    typeof options.cacheClearer === 'function' ? options.cacheClearer : clearCache;
  const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : DEFAULT_TTL_MS;
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const pathExistsFn = options.pathExistsFn;
  const currentPluginVersion = options.currentPluginVersion;

  // 1. Try cache first (unless forced).
  if (!force) {
    const payload = cacheReader(repoRoot);
    if (
      payload &&
      isCacheFresh(payload, nowMs, ttlMs, {
        pathExistsFn,
        currentPluginVersion,
      })
    ) {
      return toMap(payload.entries);
    }
  } else {
    // Force re-probe: clear cache file so doctor's "what's stored" matches reality.
    try {
      cacheClearer(repoRoot);
    } catch {
      // ignore; cacheClearer also no-ops on ENOENT
    }
  }

  // 2. Probe every cli-client.
  const cliClients = cliClientsLoader(repoRoot);
  const probed = new Map();
  for (const [name, cfg] of cliClients.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const result = await proberFn(name, cfg);
    probed.set(name, result);
  }

  // 3. Write cache. Use the current plugin version (if known) so an
  // upcoming check with mismatched plugin_version still invalidates.
  const writeOptions = {};
  if (typeof currentPluginVersion === 'string') {
    writeOptions.pluginVersion = currentPluginVersion;
  }
  cacheWriter(repoRoot, probed, writeOptions);

  return probed;
}

function toMap(entriesObj) {
  const m = new Map();
  for (const [name, entry] of Object.entries(entriesObj || {})) {
    m.set(name, entry);
  }
  return m;
}

export function availableCLISet(detectorResult) {
  if (!(detectorResult instanceof Map)) {
    throw new TypeError('availableCLISet requires a Map');
  }
  const out = new Set();
  for (const [name, entry] of detectorResult.entries()) {
    if (entry && entry.status === 'available') out.add(name);
  }
  return out;
}

// Convenience for doctor: walk a role's preference ladder and report the
// first CLI that is currently available. Returns `null` if none match.
// `recEntry` is the slice-3 recommendation Map value: `{preference, ...}`.
export function firstAvailableInLadder(recEntry, availableSet) {
  if (!recEntry || !Array.isArray(recEntry.preference)) return null;
  if (!(availableSet instanceof Set)) return null;
  for (let i = 0; i < recEntry.preference.length; i += 1) {
    const entry = recEntry.preference[i];
    if (entry && typeof entry.cli === 'string' && availableSet.has(entry.cli)) {
      return { ...entry, index: i };
    }
  }
  return null;
}
