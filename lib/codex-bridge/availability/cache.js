// v0.9.0 slice 4 — availability cache (1h TTL + smart invalidation).
//
// Stores per-CLI prober results at `<repoRoot>/.codex-paired/cli-availability.json`.
// Format:
// {
//   "plugin_version": "0.9.0",
//   "cached_at":      "2026-05-11T22:00:00.000Z",
//   "fingerprint":    "<sha256-of-merged-cli-clients>",
//   "entries": {
//     "codex":  { ...proberResult },
//     "ollama": { ...proberResult }
//   }
// }
//
// Freshness rules (spec § 4 + plan slice 4 + round-1 review fix):
//   - `cached_at` newer than TTL (default 1h)
//   - cache `plugin_version` matches current (defaulted from package.json
//     if caller omits options.currentPluginVersion — so a missing option
//     never lets a stale cache survive a plugin upgrade)
//   - cache `fingerprint` matches the current merged cli-clients fingerprint
//     when supplied (caller passes options.currentFingerprint). If neither
//     side has one, fingerprint check is skipped (legacy caches stay
//     readable for TTL/version invalidation paths).
//   - every entry's `resolved_path` (when non-null) still exists on disk
//
// Atomic writes: temp file + rename, mirroring sidecar.js.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
export const PROJECT_DIR = '.codex-paired';
export const CACHE_FILE = 'cli-availability.json';

function cachePath(repoRoot) {
  return join(repoRoot, PROJECT_DIR, CACHE_FILE);
}

// Compute a stable fingerprint of a merged cli-clients Map. Two inputs
// that differ in the set of names OR in any fingerprint-significant
// config field (command, runtime_kind, variants keys, additional_args)
// must produce different hashes; reordered inputs must produce the same
// hash. Result is a sha256 hex digest.
export function fingerprintCliClients(cliClients) {
  if (!(cliClients instanceof Map)) {
    throw new TypeError('fingerprintCliClients requires a Map<name, configEntry>');
  }
  const sorted = [...cliClients.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cfg]) => [
      name,
      {
        command: cfg && typeof cfg.command === 'string' ? cfg.command : null,
        runtime_kind: cfg && typeof cfg.runtime_kind === 'string' ? cfg.runtime_kind : null,
        variants:
          cfg && cfg.variants && typeof cfg.variants === 'object'
            ? Object.keys(cfg.variants).sort()
            : [],
        additional_args:
          cfg && Array.isArray(cfg.additional_args) ? cfg.additional_args.slice() : [],
      },
    ]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// Lazy-cached package.json version read (the version cannot change mid-
// process, so we memoize after first successful read).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_PACKAGE_JSON = join(__dirname, '..', '..', '..', 'package.json');
let __cachedPackageJsonVersion = null;
export function _readPackageJsonVersion() {
  if (__cachedPackageJsonVersion !== null) return __cachedPackageJsonVersion;
  try {
    const raw = readFileSync(PLUGIN_PACKAGE_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === 'string') {
      __cachedPackageJsonVersion = parsed.version;
      return __cachedPackageJsonVersion;
    }
  } catch {
    // fall through
  }
  __cachedPackageJsonVersion = 'unknown';
  return __cachedPackageJsonVersion;
}

export function readCache(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('readCache requires repoRoot as a string');
  }
  const abs = cachePath(repoRoot);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (
    typeof parsed.plugin_version !== 'string' ||
    typeof parsed.cached_at !== 'string' ||
    !parsed.entries ||
    typeof parsed.entries !== 'object' ||
    Array.isArray(parsed.entries)
  ) {
    return null;
  }
  return parsed;
}

export function writeCache(repoRoot, entries, options = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('writeCache requires repoRoot as a string');
  }
  let entriesObj;
  if (entries instanceof Map) {
    entriesObj = Object.fromEntries(entries);
  } else if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    entriesObj = { ...entries };
  } else {
    throw new TypeError('writeCache requires entries to be a Map or plain object');
  }
  const pluginVersion =
    typeof options.pluginVersion === 'string' && options.pluginVersion.length > 0
      ? options.pluginVersion
      : pickPluginVersionFromEntries(entriesObj);
  const cachedAt =
    typeof options.cachedAt === 'string' && options.cachedAt.length > 0
      ? options.cachedAt
      : new Date().toISOString();

  const payload = {
    plugin_version: pluginVersion,
    cached_at: cachedAt,
    entries: entriesObj,
  };
  if (typeof options.fingerprint === 'string' && options.fingerprint.length > 0) {
    payload.fingerprint = options.fingerprint;
  }

  const target = cachePath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, target);
  return payload;
}

function pickPluginVersionFromEntries(entriesObj) {
  for (const entry of Object.values(entriesObj)) {
    if (entry && typeof entry.plugin_version === 'string') return entry.plugin_version;
  }
  return 'unknown';
}

export function isCacheFresh(cachePayload, nowMs, ttlMs = DEFAULT_TTL_MS, options = {}) {
  if (!cachePayload || typeof cachePayload !== 'object') return false;
  if (typeof cachePayload.plugin_version !== 'string') return false;
  if (typeof cachePayload.cached_at !== 'string') return false;

  // Plugin-version invalidation. Default the comparison side to the live
  // package.json version — NEVER echo the cached value. Doing so would
  // mean callers that forget to inject currentPluginVersion silently
  // accept stale caches across plugin upgrades. (Codex round-1 critical.)
  const currentVersion =
    typeof options.currentPluginVersion === 'string'
      ? options.currentPluginVersion
      : _readPackageJsonVersion();
  if (cachePayload.plugin_version !== currentVersion) return false;

  // cli-clients config-set fingerprint invalidation. When the caller
  // supplies a fingerprint, the cache must carry one and they must
  // match. (Codex round-1 critical: cache previously reused entries
  // across changed cli-client sets, letting the resolver miss new
  // clis.) Callers may pass `currentFingerprint: null/undefined` to
  // skip the check — used by legacy/lower-level callers that don't
  // know the cli-clients set.
  if (typeof options.currentFingerprint === 'string') {
    if (typeof cachePayload.fingerprint !== 'string') return false;
    if (cachePayload.fingerprint !== options.currentFingerprint) return false;
  }

  const cachedAtMs = Date.parse(cachePayload.cached_at);
  if (Number.isNaN(cachedAtMs)) return false;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (now - cachedAtMs > ttlMs) return false;

  const pathExistsFn = typeof options.pathExistsFn === 'function' ? options.pathExistsFn : existsSync;
  const entries = cachePayload.entries || {};
  for (const entry of Object.values(entries)) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.status === 'available' && entry.resolved_path) {
      try {
        if (!pathExistsFn(entry.resolved_path)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

export function clearCache(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('clearCache requires repoRoot as a string');
  }
  const abs = cachePath(repoRoot);
  try {
    unlinkSync(abs);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

// Test/debug helper — returns the absolute cache path that read/write use.
export function _cachePathFor(repoRoot) {
  return cachePath(repoRoot);
}

// Internal helper exported for tests that want to assert file metadata.
export function _cacheFileStat(repoRoot) {
  try {
    return statSync(cachePath(repoRoot));
  } catch {
    return null;
  }
}
