// Slice 1 — hybrid per-slice owner parsing + validation.
//
// Spec: docs/specs/2026-05-28-hybrid-dev-mode-design.md §5 (plan syntax / owner
// rules) and §6 (preflight + halt-reason names).
//
// A hybrid slice declares exactly two REQUIRED owners in its `**Implementers:**`
// block: one `owner: claude-ui` and one `owner: codex-backend`. Each owner's
// claimed `files` must partition the slice `**Files:**` block, and file overlap
// between owners is rejected by the SAME validator implementer-experts uses
// (`validateClaimedFileOverlap`) — there is no second overlap checker (spec §5).
//
// Halt reasons emitted (spec §6):
//   hybrid-ownership-malformed   — invalid/ambiguous owner declarations.
//   hybrid-owner-files-unclaimed — slice **Files:** and owner files do not match.
//   hybrid-owner-files-overlap   — owner files overlap without rationale.
//
// NOTE on reuse: `parseImplementersBlock` cannot be reused directly here because
// its `validateImplementers` step rejects the hybrid logical adapters
// (`claude-ui` / `codex-background-bash`) — it only allows `claude-cli`/`codex-cli`.
// We therefore reuse the lower-level parsing primitives
// (`extractImplementersBlockLines` + `parseImplementerEntries`, both exported
// from frontmatter.js) and the shared `validateClaimedFileOverlap` validator.

import {
  extractImplementersBlockLines,
  parseImplementerEntries,
  validateClaimedFileOverlap,
} from '../implementer/frontmatter.js';

/** The two — and only two — valid hybrid owners. */
export const HYBRID_OWNERS = Object.freeze(['claude-ui', 'codex-backend']);

/**
 * @typedef {object} HybridOwnerEntry
 * @property {string}   member_id
 * @property {string}   [owner]
 * @property {string}   adapter
 * @property {string}   model
 * @property {boolean}  required
 * @property {string[]} files
 * @property {string}   [overlap_rationale]
 */

/**
 * Build a halt-shaped Error carrying `.code`.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function haltError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Parse the `**Implementers:**` owner block of a hybrid slice.
 *
 * Reuses the frontmatter parsing primitives so each entry carries its optional
 * `owner` field. This is a *parse* step only — ambiguity/partition rules are
 * enforced by `validateHybridOwnership`.
 *
 * @param {string} planMarkdown  — full plan file content (unused today, kept for
 *   parity with `parseImplementersBlock` and future top-frontmatter needs).
 * @param {string} sliceSection  — the hybrid slice section text.
 * @returns {HybridOwnerEntry[]}  — parsed owner entries (may be []).
 */
export function parseHybridOwners(planMarkdown, sliceSection) {
  const blockLines = extractImplementersBlockLines(sliceSection);
  if (blockLines === null) return [];
  const entries = parseImplementerEntries(blockLines);
  // Normalize: drop the internal `undefined` placeholders so consumers see a
  // shape matching parseImplementersBlock's cleaned output (owner present only
  // when declared, overlap_rationale present only when non-empty).
  return entries.map((e) => {
    /** @type {HybridOwnerEntry} */
    const clean = {
      member_id: e.member_id,
      adapter: e.adapter,
      model: e.model,
      required: e.required,
      files: e.files,
    };
    if (typeof e.owner === 'string' && e.owner.length > 0) {
      clean.owner = e.owner;
    }
    if (typeof e.overlap_rationale === 'string' && e.overlap_rationale.trim().length > 0) {
      clean.overlap_rationale = e.overlap_rationale.trim();
    }
    return clean;
  });
}

/**
 * Enforce the hybrid owner rules from spec §5/§6.
 *
 * @param {object} args
 * @param {string[]} args.sliceFiles  — the slice `**Files:**` entries.
 * @param {HybridOwnerEntry[]} args.implementers  — parsed owner entries.
 * @returns {HybridOwnerEntry[]}  — the validated implementers (rationale preserved).
 * @throws {Error} with `.code` set to the spec §6 halt reason on any violation.
 */
export function validateHybridOwnership({ sliceFiles, implementers }) {
  const entries = Array.isArray(implementers) ? implementers : [];
  const files = Array.isArray(sliceFiles) ? sliceFiles : [];

  // ── Ownership shape: exactly one required claude-ui + one required codex-backend.
  for (const e of entries) {
    if (typeof e.owner !== 'string' || e.owner.length === 0) {
      throw haltError(
        'hybrid-ownership-malformed',
        `member "${e.member_id}" is missing an owner field`
      );
    }
    if (!HYBRID_OWNERS.includes(e.owner)) {
      throw haltError(
        'hybrid-ownership-malformed',
        `member "${e.member_id}" has unknown owner "${e.owner}"; allowed: ${HYBRID_OWNERS.join(', ')}`
      );
    }
    if (e.required === false) {
      throw haltError(
        'hybrid-ownership-malformed',
        `owner "${e.owner}" (member "${e.member_id}") must be required; optional owners are not allowed`
      );
    }
  }

  // Exactly one of each owner.
  for (const owner of HYBRID_OWNERS) {
    const matches = entries.filter((e) => e.owner === owner);
    if (matches.length === 0) {
      throw haltError('hybrid-ownership-malformed', `missing required owner "${owner}"`);
    }
    if (matches.length > 1) {
      throw haltError(
        'hybrid-ownership-malformed',
        `duplicate owner "${owner}" (${matches.map((m) => m.member_id).join(', ')})`
      );
    }
  }

  // No owners outside the two known roles, and no extra entries.
  if (entries.length !== HYBRID_OWNERS.length) {
    throw haltError(
      'hybrid-ownership-malformed',
      `expected exactly ${HYBRID_OWNERS.length} owners (one per role); got ${entries.length}`
    );
  }

  // Each owner must claim at least one file.
  for (const e of entries) {
    if (!Array.isArray(e.files) || e.files.length === 0) {
      throw haltError(
        'hybrid-ownership-malformed',
        `owner "${e.owner}" (member "${e.member_id}") claims no files`
      );
    }
  }

  // ── File partition: slice **Files:** ⇔ union of owner claims.
  const sliceSet = new Set(files);
  const claimedSet = new Set();
  for (const e of entries) {
    for (const f of e.files) claimedSet.add(f);
  }

  for (const f of sliceSet) {
    if (!claimedSet.has(f)) {
      throw haltError(
        'hybrid-owner-files-unclaimed',
        `slice file "${f}" is not claimed by either owner`
      );
    }
  }
  for (const f of claimedSet) {
    if (!sliceSet.has(f)) {
      throw haltError(
        'hybrid-owner-files-unclaimed',
        `owner-claimed file "${f}" is absent from the slice **Files:** block`
      );
    }
  }

  // ── Overlap: delegate to the shared frontmatter validator (spec §5). A
  // rationalized overlap passes through; an unrationalized overlap throws
  // `implementer-claimed-files-missing`, which we translate to the hybrid reason.
  try {
    validateClaimedFileOverlap(entries);
  } catch (err) {
    if (err && err.code === 'implementer-claimed-files-missing') {
      throw Object.assign(
        new Error(`hybrid-owner-files-overlap: ${err.message}`),
        { code: 'hybrid-owner-files-overlap', cause: err }
      );
    }
    throw err;
  }

  return entries;
}
