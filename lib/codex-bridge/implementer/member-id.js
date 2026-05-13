// v0.10.0 member-id — parse, format, and slug implementer member IDs.
//
// Member ID format:
//   <role_id>@<cli_kind>:<model_id>#<ordinal>
//
// Examples:
//   expert-implementer@claude:kimi-k2.6:cloud#0
//   expert-implementer@codex:gpt-5.5#0
//   expert-implementer@claude:glm-4.7:cloud#1
//
// Parsing rules (per spec § Member-ID Disambiguation):
//   1. Split at the LAST '#' for ordinal.
//   2. Split the pre-ordinal portion at the FIRST '@'.
//   3. Split the runtime portion (right side of @) at the FIRST ':'.
//   4. The remaining model string is opaque — model IDs may contain ':'.

import { createHash } from 'node:crypto';

/** @typedef {'codex' | 'claude'} CliKind */

/**
 * @typedef {object} ParsedMemberId
 * @property {string}  roleId  — e.g. 'expert-implementer'
 * @property {CliKind} cliKind — 'codex' or 'claude'
 * @property {string}  modelId — opaque model string, e.g. 'kimi-k2.6:cloud'
 * @property {number}  ordinal — non-negative integer
 */

const ALLOWED_CLI_KINDS = new Set(['codex', 'claude']);

/**
 * Parse a member ID string into its components.
 *
 * @param {string} s
 * @returns {ParsedMemberId}
 * @throws {Error} if the member ID is malformed or contains invalid values
 */
export function parseMemberId(s) {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('parseMemberId: input must be a non-empty string');
  }

  // Step 1: Split at the LAST '#' for ordinal.
  const lastHash = s.lastIndexOf('#');
  if (lastHash === -1) {
    throw new Error(`parseMemberId: missing '#' ordinal separator in "${s}"`);
  }
  const preOrdinal = s.slice(0, lastHash);
  const ordinalStr = s.slice(lastHash + 1);

  if (ordinalStr.length === 0) {
    throw new Error(`parseMemberId: empty ordinal after '#' in "${s}"`);
  }
  if (!/^\d+$/.test(ordinalStr)) {
    throw new Error(
      `parseMemberId: ordinal must be a non-negative integer; got "${ordinalStr}" in "${s}"`
    );
  }
  const ordinal = Number(ordinalStr);
  if (!Number.isInteger(ordinal)) {
    // Guard against extreme values, though regex above catches most cases.
    throw new Error(`parseMemberId: non-integer ordinal "${ordinalStr}" in "${s}"`);
  }

  // Step 2: Split pre-ordinal at the FIRST '@'.
  const firstAt = preOrdinal.indexOf('@');
  if (firstAt === -1) {
    throw new Error(`parseMemberId: missing '@' in "${s}"`);
  }
  const roleId = preOrdinal.slice(0, firstAt);
  const runtimePlusModel = preOrdinal.slice(firstAt + 1);

  if (roleId.length === 0) {
    throw new Error(`parseMemberId: empty roleId in "${s}"`);
  }

  // Step 3: Split runtimePlusModel at the FIRST ':'.
  const firstColon = runtimePlusModel.indexOf(':');
  if (firstColon === -1) {
    throw new Error(`parseMemberId: missing ':' between cliKind and modelId in "${s}"`);
  }
  const cliKind = runtimePlusModel.slice(0, firstColon);
  const modelId = runtimePlusModel.slice(firstColon + 1);

  if (cliKind.length === 0) {
    throw new Error(`parseMemberId: empty cliKind in "${s}"`);
  }
  if (!ALLOWED_CLI_KINDS.has(cliKind)) {
    throw new Error(
      `parseMemberId: unknown cliKind "${cliKind}" in "${s}"; allowed: ${[...ALLOWED_CLI_KINDS].join(', ')}`
    );
  }
  if (modelId.length === 0) {
    throw new Error(`parseMemberId: empty modelId in "${s}"`);
  }

  return { roleId, cliKind, modelId, ordinal };
}

/**
 * Format a parsed member ID back into the canonical string form.
 * Round-trips with parseMemberId.
 *
 * @param {ParsedMemberId} parsed
 * @returns {string}
 * @throws {Error} if any field is invalid
 */
export function formatMemberId({ roleId, cliKind, modelId, ordinal }) {
  if (typeof roleId !== 'string' || roleId.length === 0) {
    throw new Error('formatMemberId: roleId must be a non-empty string');
  }
  if (typeof cliKind !== 'string' || !ALLOWED_CLI_KINDS.has(cliKind)) {
    throw new Error(
      `formatMemberId: cliKind must be one of ${[...ALLOWED_CLI_KINDS].join(', ')}; got "${cliKind}"`
    );
  }
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new Error('formatMemberId: modelId must be a non-empty string');
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error(`formatMemberId: ordinal must be a non-negative integer; got ${ordinal}`);
  }

  return `${roleId}@${cliKind}:${modelId}#${ordinal}`;
}

/**
 * Convert a member ID string into a filesystem-safe slug.
 *
 * The slug is lowercase, uses only `[a-z0-9-]`, and ends with an 8-character
 * SHA-256 hash of the original member ID. This ensures uniqueness even if two
 * member IDs differ only in casing or punctuation detail.
 *
 * The result is deterministic: same input always → same output.
 *
 * @param {string} memberId  — the raw member ID string (not pre-parsed)
 * @returns {string}
 */
export function memberIdSlug(memberId) {
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new Error('memberIdSlug: input must be a non-empty string');
  }

  // Produce the human-readable prefix by lowercasing and replacing all
  // non-alphanumeric characters with hyphens, then collapsing consecutive
  // hyphens and trimming leading/trailing hyphens.
  const prefix = memberId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // 8-character hex sha256 suffix for uniqueness / collision resistance.
  const hash = createHash('sha256').update(memberId).digest('hex').slice(0, 8);

  return `${prefix}-${hash}`;
}
