// @ts-check

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const OWNER = 'codex-paired-superpowers';
const OWNERSHIP_FILE = 'codex-paired.json';
const PRESERVATION_FILE = 'codex-paired-keep.json';
const OWNERSHIP_KINDS = new Set(['implementation', 'fanout', 'review']);

/** @typedef {'implementation' | 'fanout' | 'review'} OwnershipKind */
/** @typedef {{kind: OwnershipKind, run_id: string, base: string, overlays?: string[], created_at?: string}} OwnershipInput */
/** @typedef {{reason: string, run_id: string}} PreservationInput */
/** @typedef {{state: 'absent' | 'valid' | 'invalid', value: any}} MarkerRead */

/** @param {unknown} value */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Resolve the linked worktree's private git administration directory.
 * Git permits the `gitdir:` pointer in `<worktree>/.git` to be absolute or
 * relative to the directory containing that pointer.
 *
 * @param {string} worktreePath
 */
function adminDirForWorktree(worktreePath) {
  const dotGit = join(worktreePath, '.git');
  if (existsSync(dotGit) && statSync(dotGit).isDirectory()) return dotGit;

  const pointerFile = readFileSync(dotGit, 'utf8');
  const match = pointerFile.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match || match[1].length === 0) {
    throw new Error(`invalid gitdir pointer: ${dotGit}`);
  }
  return isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(dotGit), match[1]);
}

/** @param {string} target @param {unknown} value */
function writeJsonAtomic(target, value) {
  const temp = join(dirname(target), `.${target.split('/').pop()}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** @param {unknown} value */
function validOwnership(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = /** @type {Record<string, unknown>} */ (value);
  if (marker.owner !== OWNER || !OWNERSHIP_KINDS.has(/** @type {string} */ (marker.kind))) return false;
  if (!isNonEmptyString(marker.created_at) || Number.isNaN(Date.parse(/** @type {string} */ (marker.created_at)))) return false;
  if (!isNonEmptyString(marker.run_id) || !isNonEmptyString(marker.base)) return false;
  if ('overlays' in marker && (!Array.isArray(marker.overlays) || marker.overlays.some((item) => typeof item !== 'string'))) return false;
  const allowed = new Set(['owner', 'kind', 'created_at', 'run_id', 'base', 'overlays']);
  return Object.keys(marker).every((key) => allowed.has(key));
}

/** @param {unknown} value */
function validPreservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = /** @type {Record<string, unknown>} */ (value);
  if (marker.owner !== OWNER || !isNonEmptyString(marker.reason) || !isNonEmptyString(marker.run_id)) return false;
  const allowed = new Set(['owner', 'reason', 'run_id']);
  return Object.keys(marker).every((key) => allowed.has(key));
}

/** @param {string} path @param {(value: unknown) => boolean} validate @returns {MarkerRead} */
function readMarker(path, validate) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (/** @type {any} */ error) {
    if (error?.code === 'ENOENT') return { state: 'absent', value: null };
    return { state: 'invalid', value: null };
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: 'invalid', value: null };
  }
  return validate(value)
    ? { state: 'valid', value }
    : { state: 'invalid', value };
}

/**
 * Write plugin ownership into the worktree's private administration directory.
 *
 * @param {string} worktreePath
 * @param {OwnershipInput} input
 */
export function writeOwnershipMarker(worktreePath, input) {
  if (!input || !OWNERSHIP_KINDS.has(input.kind)) throw new TypeError('ownership marker kind is invalid');
  if (!isNonEmptyString(input.run_id)) throw new TypeError('ownership marker run_id must be a non-empty string');
  if (!isNonEmptyString(input.base)) throw new TypeError('ownership marker base must be a non-empty string');
  if (input.overlays !== undefined && (!Array.isArray(input.overlays) || input.overlays.some((item) => typeof item !== 'string'))) {
    throw new TypeError('ownership marker overlays must be an array of strings');
  }
  const createdAt = input.created_at ?? new Date().toISOString();
  if (!isNonEmptyString(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError('ownership marker created_at must be an ISO timestamp');
  }
  const value = {
    owner: OWNER,
    kind: input.kind,
    created_at: createdAt,
    run_id: input.run_id,
    base: input.base,
    ...(input.overlays === undefined ? {} : { overlays: [...input.overlays] }),
  };
  writeJsonAtomic(join(adminDirForWorktree(worktreePath), OWNERSHIP_FILE), value);
  return value;
}

/**
 * Write positive preservation evidence into the worktree's private admin dir.
 *
 * @param {string} worktreePath
 * @param {PreservationInput} input
 */
export function writePreservationMarker(worktreePath, input) {
  if (!input || !isNonEmptyString(input.reason)) throw new TypeError('preservation marker reason must be a non-empty string');
  if (!isNonEmptyString(input.run_id)) throw new TypeError('preservation marker run_id must be a non-empty string');
  const value = { owner: OWNER, reason: input.reason, run_id: input.run_id };
  writeJsonAtomic(join(adminDirForWorktree(worktreePath), PRESERVATION_FILE), value);
  return value;
}

/**
 * Read markers through a registry-provided admin directory. This deliberately
 * does not inspect the checkout path, which may already have disappeared.
 *
 * @param {{repoRoot: string, adminDir: string}} input
 */
export function readMarkers({ repoRoot, adminDir }) {
  const resolvedAdminDir = isAbsolute(adminDir) ? resolve(adminDir) : resolve(repoRoot, adminDir);
  return {
    ownership: readMarker(join(resolvedAdminDir, OWNERSHIP_FILE), validOwnership),
    preservation: readMarker(join(resolvedAdminDir, PRESERVATION_FILE), validPreservation),
  };
}
