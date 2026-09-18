// @ts-check

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { readMarkers } from './checkout-markers.js';
import { findProcessesUnder } from '../../scripts/lib/process-ownership.mjs';

const REVIEW_MIN_AGE_MS = 60 * 60 * 1000;
const IMPLEMENTATION_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** @typedef {'not-ours' | 'preserved' | 'candidate'} CheckoutClass */
/** @typedef {'implementation' | 'fanout' | 'review'} CheckoutKind */
/** @typedef {{path: string, registered: boolean, class: CheckoutClass, kind: CheckoutKind | null, age_ms: number | null, keep: string[]}} Entry */
/** @typedef {Entry & {removed: boolean}} ReapEntry */
/** @typedef {{pids: number[], complete: boolean, gaps: any[]}} ProcessDiscovery */
/** @typedef {{status: number | null, stdout: string, stderr: string, error?: Error}} GitResult */
/** @typedef {{path: string, head: string | null, branch: string | null, adminDir: string | null, registered: boolean}} RawCheckout */

/** @param {string} path */
function normalized(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** @param {string} path @param {string} root */
function isUnder(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** @param {string} cwd @param {string[]} args @returns {GitResult} */
function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ...(result.error ? { error: result.error } : {}),
  };
}

/** @param {string} text */
function nulPaths(text) {
  return text.split('\0').filter(Boolean);
}

/** @param {string} output */
function parseWorktreeList(output) {
  return output.split(/\n\n+/).map((block) => {
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0) fields[line.slice(0, space)] = line.slice(space + 1);
    }
    return fields.worktree
      ? { path: normalized(fields.worktree), head: fields.HEAD || null, branch: fields.branch || null }
      : null;
  }).filter(Boolean);
}

/** @param {string} repoRoot */
function linkedAdminDirs(repoRoot) {
  const common = runGit(repoRoot, ['rev-parse', '--git-common-dir']);
  if (common.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const commonDirText = common.stdout.trim();
  const commonDir = normalized(isAbsolute(commonDirText) ? commonDirText : join(repoRoot, commonDirText));
  const registry = join(commonDir, 'worktrees');
  /** @type {Map<string, string>} */
  const byPath = new Map();
  let names;
  try {
    names = readdirSync(registry, { withFileTypes: true });
  } catch (/** @type {any} */ error) {
    if (error?.code === 'ENOENT') return byPath;
    throw error;
  }
  for (const name of names) {
    if (!name.isDirectory()) continue;
    const adminDir = join(registry, name.name);
    try {
      const dotGit = readFileSync(join(adminDir, 'gitdir'), 'utf8').trim();
      const dotGitPath = isAbsolute(dotGit) ? dotGit : resolve(adminDir, dotGit);
      byPath.set(normalized(dirname(dotGitPath)), adminDir);
    } catch {
      // A registry entry can disappear while Git or another reaper removes it.
      // The porcelain entry is retained below and classified without ownership
      // evidence, which is the fail-closed outcome.
    }
  }
  return byPath;
}

/** @param {string} repoRoot */
function registeredCheckouts(repoRoot) {
  const listed = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (listed.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const parsed = /** @type {{path: string, head: string | null, branch: string | null}[]} */ (parseWorktreeList(listed.stdout));
  const admins = linkedAdminDirs(repoRoot);
  // The first porcelain entry is the main worktree. It is never a plugin
  // orphan and omitting it lets doctor pass when no linked checkout exists.
  return parsed.slice(1).map((entry) => ({
    ...entry,
    adminDir: admins.get(entry.path) || null,
    registered: true,
  }));
}

/** @param {string} tmpDir @param {Set<string>} registered */
function strayReviewCheckouts(tmpDir, registered) {
  /** @type {RawCheckout[]} */
  const entries = [];
  let children;
  try {
    children = readdirSync(tmpDir, { withFileTypes: true });
  } catch (/** @type {any} */ error) {
    if (error?.code === 'ENOENT') return entries;
    return entries;
  }
  for (const child of children) {
    if (!child.name.startsWith('cps-review-') || !child.isDirectory()) continue;
    const path = normalized(join(tmpDir, child.name));
    if (!registered.has(path)) entries.push({ path, head: null, branch: null, adminDir: null, registered: false });
  }
  return entries;
}

/** @param {string} path @param {string} repoRoot */
function probablePluginLeftover(path, repoRoot) {
  return isUnder(path, join(repoRoot, '.git-worktrees'))
    || isUnder(path, join(repoRoot, '.codex-paired', 'worktrees'))
    || basename(path).startsWith('cps-review-');
}

/** @param {string} repoRoot @param {RawCheckout} checkout */
function headReachability(repoRoot, checkout) {
  if (!checkout.head) return 'unknown';
  // One call: every branch/tag containing HEAD. The checkout's own branch does not count.
  const refs = runGit(repoRoot, ['for-each-ref', '--format=%(refname)', `--contains=${checkout.head}`, 'refs/heads', 'refs/tags']);
  if (refs.status !== 0) return 'unknown';
  const containing = refs.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((ref) => ref !== checkout.branch);
  return containing.length > 0 ? 'reachable' : 'unreachable';
}

/** @param {string} path */
function ignoredFiles(path) {
  const ignored = runGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
  return ignored.status === 0 ? nulPaths(ignored.stdout) : null;
}

/** @param {string} path */
function implementationChanges(path) {
  const unstaged = runGit(path, ['diff', '--quiet', '--']);
  const staged = runGit(path, ['diff', '--cached', '--quiet', '--']);
  const untracked = runGit(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = ignoredFiles(path);
  if (![unstaged.status, staged.status].every((status) => status === 0 || status === 1)
    || untracked.status !== 0 || ignored === null) return ['worktree-state-unknown'];
  const keep = [];
  if (unstaged.status === 1) keep.push('modified-files');
  if (staged.status === 1) keep.push('staged-files');
  if (nulPaths(untracked.stdout).length > 0) keep.push('untracked-files');
  if (ignored.some((path) => !(path === 'node_modules' || path.startsWith('node_modules/')
    || path === '.tia-cache' || path.startsWith('.tia-cache/')))) keep.push('ignored-non-regenerable');
  return keep;
}

/** @param {string} path */
function safeOverlayPath(path) {
  if (path.length === 0 || isAbsolute(path)) return false;
  const parts = path.split(/[\\/]+/);
  return !parts.includes('..') && parts[0] !== '.git';
}

/** @param {string} left @param {string} right */
function sameBytes(left, right) {
  try {
    return statSync(left).isFile() && statSync(right).isFile() && readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/** @param {string} path @param {string} repoRoot @param {any} marker */
function reviewChanges(path, repoRoot, marker) {
  const overlays = /** @type {string[]} */ (Array.isArray(marker.overlays) ? marker.overlays : []);
  if (overlays.some((item) => !safeOverlayPath(item))) return ['overlay-path-invalid'];
  const tracked = runGit(path, ['diff', '--name-only', '-z', marker.base, '--']);
  const untracked = runGit(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = ignoredFiles(path);
  if (tracked.status !== 0 || untracked.status !== 0 || ignored === null) return ['worktree-state-unknown'];
  const changed = new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout), ...ignored]);
  const overlaySet = new Set(overlays);
  if ([...changed].some((item) => !overlaySet.has(item))) return ['review-changes-outside-overlays'];
  if (overlays.some((item) => !sameBytes(join(path, item), join(repoRoot, item)))) return ['overlay-mismatch'];
  return [];
}

/**
 * Construct a reaper around a deterministic process-discovery seam. Tests use
 * scripted results; production exports below use current-user OS discovery.
 *
 * @param {{findProcesses?: (rootReal: string) => ProcessDiscovery}} [dependencies]
 */
export function createCheckoutReaper({ findProcesses = findProcessesUnder } = {}) {
  /** @param {RawCheckout} checkout @param {{repoRoot: string, now: number}} context @returns {Entry} */
  function evaluate(checkout, { repoRoot, now }) {
    const probable = probablePluginLeftover(checkout.path, repoRoot);
    if (!checkout.adminDir) {
      return {
        path: checkout.path, registered: checkout.registered, class: 'not-ours', kind: null, age_ms: null,
        keep: ['not-created-by-plugin', ...(probable ? ['probable-plugin-leftover'] : [])],
      };
    }
    const markers = readMarkers({ repoRoot, adminDir: checkout.adminDir });
    if (markers.ownership.state !== 'valid') {
      return {
        path: checkout.path, registered: checkout.registered, class: 'not-ours', kind: null, age_ms: null,
        keep: [markers.ownership.state === 'invalid' ? 'ownership-marker-invalid' : 'not-created-by-plugin',
          ...(probable ? ['probable-plugin-leftover'] : [])],
      };
    }

    const marker = markers.ownership.value;
    const kind = /** @type {CheckoutKind} */ (marker.kind);
    const age = Math.max(0, now - Date.parse(marker.created_at));
    if (markers.preservation.state !== 'absent') {
      return {
        path: checkout.path, registered: checkout.registered, class: 'preserved', kind, age_ms: age,
        keep: markers.preservation.state === 'valid'
          ? [`preserved:${markers.preservation.value.reason}`]
          : ['preservation-marker-invalid'],
      };
    }

    const keep = [];
    const reachability = headReachability(repoRoot, checkout);
    if (reachability === 'unreachable') keep.push('head-unreachable');
    else if (reachability === 'unknown') keep.push('head-reachability-unknown');

    let checkoutExists = existsSync(checkout.path);
    if (checkoutExists) {
      let realPath;
      try {
        realPath = realpathSync(checkout.path);
      } catch (/** @type {any} */ error) {
        if (error?.code === 'ENOENT') checkoutExists = false;
        else keep.push('process-discovery-incomplete');
      }
      if (realPath) {
        try {
          const discovery = findProcesses(realPath);
          if (!discovery.complete) keep.push('process-discovery-incomplete');
          if (discovery.pids.length > 0) keep.push(`in-use:${discovery.pids.join(',')}`);
        } catch {
          keep.push('process-discovery-incomplete');
        }
      }
    }

    if (checkoutExists) {
      keep.push(...(kind === 'review'
        ? reviewChanges(checkout.path, repoRoot, marker)
        : implementationChanges(checkout.path)));
    }

    const minimumAge = kind === 'review' ? REVIEW_MIN_AGE_MS : IMPLEMENTATION_MIN_AGE_MS;
    if (age <= minimumAge) keep.push('too-young');
    return { path: checkout.path, registered: checkout.registered, class: 'candidate', kind, age_ms: age, keep };
  }

  /**
   * @param {{repoRoot: string, tmpDir: string, now: number | string | Date}} options
   * @returns {Entry[]}
   */
  function inventoryCheckouts({ repoRoot, tmpDir, now }) {
    const root = normalized(repoRoot);
    const timestamp = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
    if (!Number.isFinite(timestamp)) throw new TypeError('now must identify a valid instant');
    const registered = registeredCheckouts(root);
    const paths = new Set(registered.map((entry) => entry.path));
    const raw = [...registered, ...strayReviewCheckouts(tmpDir, paths)];
    return raw.map((entry) => evaluate(entry, { repoRoot: root, now: timestamp }));
  }

  /**
   * @param {{repoRoot: string, tmpDir: string, now: number | string | Date, apply: boolean}} options
   * @returns {{apply: boolean, entries: ReapEntry[]}}
   */
  function reap({ repoRoot, tmpDir, now, apply }) {
    const initial = inventoryCheckouts({ repoRoot, tmpDir, now });
    /** @type {ReapEntry[]} */
    const entries = initial.map((entry) => ({ ...entry, removed: false }));
    if (!apply) return { apply: false, entries };

    for (let index = 0; index < entries.length; index += 1) {
      const listed = entries[index];
      if (listed.class !== 'candidate' || listed.keep.length > 0 || !listed.registered) continue;
      // Full re-inventory is intentional: marker state, process ownership,
      // reachability, worktree bytes, and age are all sampled again directly
      // before this one removal. No decision from the dry-run view is trusted.
      const refreshed = inventoryCheckouts({ repoRoot, tmpDir, now }).find((entry) => entry.path === listed.path);
      if (!refreshed) {
        entries[index] = { ...listed, keep: ['no-longer-registered'], removed: false };
        continue;
      }
      entries[index] = { ...refreshed, removed: false };
      if (refreshed.class !== 'candidate' || refreshed.keep.length > 0 || !refreshed.registered) continue;
      const removed = runGit(normalized(repoRoot), ['worktree', 'remove', '--force', refreshed.path]);
      if (removed.status === 0) entries[index].removed = true;
      else entries[index].keep = ['removal-failed'];
    }
    return { apply: true, entries };
  }

  return { inventoryCheckouts, reap };
}

const productionReaper = createCheckoutReaper();

/** @param {{repoRoot: string, tmpDir: string, now: number | string | Date}} options */
export function inventoryCheckouts(options) {
  return productionReaper.inventoryCheckouts(options);
}

/** @param {{repoRoot: string, tmpDir: string, now: number | string | Date, apply: boolean}} options */
export function reap(options) {
  return productionReaper.reap(options);
}
