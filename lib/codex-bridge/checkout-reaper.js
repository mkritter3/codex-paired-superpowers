// @ts-check

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
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
/** @typedef {{path: string, head: string | null, branch: string | null, adminDir: string | null, registered: boolean, identityKeep: string[]}} RawCheckout */

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
  /** @type {{path: string, head: string | null, branch: string | null}[]} */
  const entries = [];
  /** @type {Record<string, string>} */
  let fields = {};
  const finish = () => {
    if (fields.worktree !== undefined) {
      entries.push({ path: fields.worktree, head: fields.HEAD || null, branch: fields.branch || null });
    }
    fields = {};
  };
  for (const field of output.split('\0')) {
    if (field === '') {
      if (Object.keys(fields).length > 0) finish();
      continue;
    }
    const space = field.indexOf(' ');
    if (space > 0) fields[field.slice(0, space)] = field.slice(space + 1);
  }
  if (Object.keys(fields).length > 0) finish();
  return entries;
}

/** Remove only Git's record terminator, preserving newlines that are part of a path. @param {string} text */
function stripRecordTerminator(text) {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/** @param {string} dotGit @returns {string | null} */
function adminFromDotGit(dotGit) {
  try {
    const text = readFileSync(dotGit, 'utf8');
    const prefix = text.match(/^gitdir:[ \t]*/);
    if (!prefix) return null;
    const value = stripRecordTerminator(text.slice(prefix[0].length));
    if (value.length === 0) return null;
    return normalized(isAbsolute(value) ? value : resolve(dirname(dotGit), value));
  } catch {
    return null;
  }
}

/** @param {string} repoRoot */
function linkedAdminDirs(repoRoot) {
  const common = runGit(repoRoot, ['rev-parse', '--git-common-dir']);
  if (common.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const commonDirText = common.stdout.trim();
  const commonDir = normalized(isAbsolute(commonDirText) ? commonDirText : join(repoRoot, commonDirText));
  const registry = join(commonDir, 'worktrees');
  /** @type {Map<string, string[]>} */
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
      const dotGit = stripRecordTerminator(readFileSync(join(adminDir, 'gitdir'), 'utf8'));
      const dotGitPath = isAbsolute(dotGit) ? dotGit : resolve(adminDir, dotGit);
      const path = normalized(dirname(dotGitPath));
      const linked = byPath.get(path) ?? [];
      linked.push(adminDir);
      byPath.set(path, linked);
    } catch {
      // A registry entry can disappear while Git or another reaper removes it.
      // The porcelain entry is retained below and classified without ownership
      // evidence, which is the fail-closed outcome.
    }
  }
  return byPath;
}

/** @param {string} path @param {string} adminDir */
function checkoutIdentityKeep(path, adminDir) {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) return ['checkout-path-symlink'];
    if (!status.isDirectory()) return ['admin-dir-mismatch'];
  } catch (/** @type {any} */ error) {
    if (error?.code === 'ENOENT') return [];
    return ['admin-dir-mismatch'];
  }
  const ownAdmin = adminFromDotGit(join(path, '.git'));
  return ownAdmin === normalized(adminDir) ? [] : ['admin-dir-mismatch'];
}

/** @param {string} repoRoot */
function registeredCheckouts(repoRoot) {
  const listed = runGit(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (listed.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const parsed = /** @type {{path: string, head: string | null, branch: string | null}[]} */ (parseWorktreeList(listed.stdout));
  const admins = linkedAdminDirs(repoRoot);
  // The first porcelain entry is the main worktree. It is never a plugin
  // orphan and omitting it lets doctor pass when no linked checkout exists.
  return parsed.slice(1).map((entry) => ({
    ...entry,
    ...(() => {
      const linked = admins.get(normalized(entry.path)) ?? [];
      if (linked.length > 1) return { adminDir: null, identityKeep: ['registry-ambiguous'] };
      const adminDir = linked[0] ?? null;
      return {
        adminDir,
        identityKeep: adminDir ? checkoutIdentityKeep(entry.path, adminDir) : [],
      };
    })(),
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
    if (!registered.has(path)) {
      entries.push({ path, head: null, branch: null, adminDir: null, registered: false, identityKeep: [] });
    }
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

/** @param {string} path @returns {boolean | null} */
function indexFlagsHideChanges(path) {
  const flagged = runGit(path, ['ls-files', '-v', '-z']);
  if (flagged.status !== 0) return null;
  return nulPaths(flagged.stdout).some((entry) => {
    const tag = entry[0];
    return tag === 'S' || tag === 's' || (tag >= 'a' && tag <= 'z');
  });
}

/** @param {string} path */
function implementationChanges(path) {
  const unstaged = runGit(path, ['diff', '--quiet', '--']);
  const staged = runGit(path, ['diff', '--cached', '--quiet', '--']);
  const untracked = runGit(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = ignoredFiles(path);
  const hiddenByIndexFlags = indexFlagsHideChanges(path);
  if (![unstaged.status, staged.status].every((status) => status === 0 || status === 1)
    || untracked.status !== 0 || ignored === null || hiddenByIndexFlags === null) return ['worktree-state-unknown'];
  const keep = [];
  if (hiddenByIndexFlags) keep.push('index-flags-hide-changes');
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

/** @param {string} checkoutPath @param {string} sourcePath @param {string} item */
function indexMatchesFile(checkoutPath, sourcePath, item) {
  const indexed = runGit(checkoutPath, ['rev-parse', '--verify', `:${item}`]);
  const source = runGit(checkoutPath, ['hash-object', '--no-filters', join(sourcePath, item)]);
  return indexed.status === 0 && source.status === 0 && indexed.stdout.trim() === source.stdout.trim();
}

/** @param {string} path @param {string} repoRoot @param {any} marker */
function reviewChanges(path, repoRoot, marker) {
  const overlays = /** @type {string[]} */ (Array.isArray(marker.overlays) ? marker.overlays : []);
  if (overlays.some((item) => !safeOverlayPath(item))) return ['overlay-path-invalid'];
  const tracked = runGit(path, ['diff', '--name-only', '-z', marker.base, '--']);
  const staged = runGit(path, ['diff', '--cached', '--name-only', '-z', marker.base, '--']);
  const untracked = runGit(path, ['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = ignoredFiles(path);
  const hiddenByIndexFlags = indexFlagsHideChanges(path);
  if (tracked.status !== 0 || staged.status !== 0 || untracked.status !== 0 || ignored === null
    || hiddenByIndexFlags === null) return ['worktree-state-unknown'];
  const stagedPaths = nulPaths(staged.stdout);
  const changed = new Set([...nulPaths(tracked.stdout), ...stagedPaths, ...nulPaths(untracked.stdout), ...ignored]);
  const overlaySet = new Set(overlays);
  if ([...changed].some((item) => !overlaySet.has(item))) return ['review-changes-outside-overlays'];
  if (hiddenByIndexFlags) return ['index-flags-hide-changes'];
  if (stagedPaths.some((item) => !indexMatchesFile(path, repoRoot, item))) return ['review-changes-outside-overlays'];
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
        keep: checkout.identityKeep.length > 0
          ? [...checkout.identityKeep]
          : ['not-created-by-plugin', ...(probable ? ['probable-plugin-leftover'] : [])],
      };
    }
    const markers = readMarkers({ repoRoot, adminDir: checkout.adminDir });
    if (markers.ownership.state !== 'valid') {
      return {
        path: checkout.path, registered: checkout.registered, class: 'not-ours', kind: null, age_ms: null,
        keep: [markers.ownership.state === 'invalid' ? 'ownership-marker-invalid' : 'not-created-by-plugin',
          ...(probable ? ['probable-plugin-leftover'] : []), ...checkout.identityKeep],
      };
    }

    const marker = markers.ownership.value;
    const kind = /** @type {CheckoutKind} */ (marker.kind);
    const age = Math.max(0, now - Date.parse(marker.created_at));
    if (markers.preservation.state !== 'absent') {
      return {
        path: checkout.path, registered: checkout.registered, class: 'preserved', kind, age_ms: age,
        keep: markers.preservation.state === 'valid'
          ? [`preserved:${markers.preservation.value.reason}`, ...checkout.identityKeep]
          : ['preservation-marker-invalid', ...checkout.identityKeep],
      };
    }

    const keep = [...checkout.identityKeep];
    const reachability = headReachability(repoRoot, checkout);
    if (reachability === 'unreachable') keep.push('head-unreachable');
    else if (reachability === 'unknown') keep.push('head-reachability-unknown');

    let checkoutExists = existsSync(checkout.path);
    if (checkoutExists && checkout.identityKeep.length === 0) {
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

    if (checkoutExists && checkout.identityKeep.length === 0) {
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
      // Refresh registry identity and every candidate condition for only this
      // target. Evaluating an unrelated checkout here would open a race window
      // between this final sample and this target's removal.
      const root = normalized(repoRoot);
      const timestamp = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
      const matches = registeredCheckouts(root).filter((entry) => entry.path === listed.path);
      if (matches.length === 0) {
        entries[index] = { ...listed, keep: ['no-longer-registered'], removed: false };
        continue;
      }
      const refreshedRaw = matches.length === 1
        ? matches[0]
        : { ...matches[0], adminDir: null, identityKeep: ['registry-ambiguous'] };
      const refreshed = evaluate(refreshedRaw, { repoRoot: root, now: timestamp });
      entries[index] = { ...refreshed, removed: false };
      if (refreshed.class !== 'candidate' || refreshed.keep.length > 0 || !refreshed.registered) continue;
      const removed = runGit(root, ['worktree', 'remove', '--force', refreshed.path]);
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
