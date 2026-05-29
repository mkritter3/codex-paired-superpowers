// v0.9.0 slice 5a — role-prompt loader with frontmatter parsing.
//
// Each role-prompt file in lib/codex-bridge/prompts/ carries YAML-style
// frontmatter at the top declaring its `version` and `role_id`:
//
//     ---
//     version: v0.9.0-r1
//     role_id: expert-architecture
//     ---
//     # Expert: Architecture
//     ...
//
// This module:
//   1. Resolves a role id (e.g. "expert-architecture", "paired-reviewer") to
//      its on-disk prompt file.
//   2. Reads the file, parses the frontmatter, and returns
//      { roleId, version, content, hash }.
//   3. Provides a hash-verification helper for the dispatcher to audit
//      `role_prompt_hash` against `role-prompts.lock.json` (soft warning on
//      mismatch — not a hard failure).
//
// Frontmatter parser is intentionally minimal — regex over `key: value` lines
// inside a `---` … `---` block. We do NOT pull in `gray-matter` or `js-yaml`;
// the spec mandates only two simple keys, and rejecting anything malformed is
// the safest bound (callers can bump the prompt format when richer schema is
// needed).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, 'prompts');

/**
 * Typed error thrown by role-prompt loading paths. Lets callers distinguish
 * "prompt file missing/malformed" from generic runtime errors.
 */
export class RolePromptError extends Error {
  constructor(message, { roleId, cause } = {}) {
    super(message);
    this.name = 'RolePromptError';
    this.roleId = roleId;
    if (cause) this.cause = cause;
  }
}

/**
 * Canonicalize a role id to its reviewer-* form.
 *
 * Plan 3 (reviewer naming migration): the reviewer sense of "expert" became
 * "reviewer". Legacy `expert-<x>` ids are accepted on input and canonicalized
 * to `reviewer-<x>` before the strict `role_id` check + lock-hash lookup.
 *
 * `expert-template` is NOT a reviewer role (it is authoring scaffolding, never
 * resolved through `resolveIdentity`), so it is exempt from canonicalization
 * and keeps loading from `expert-template.md`.
 *
 * @param {string} roleId
 * @returns {string} canonical role id
 */
export function canonicalizeRoleId(roleId) {
  if (typeof roleId === 'string' && roleId !== 'expert-template') {
    const m = roleId.match(/^expert-(.+)$/);
    if (m) return `reviewer-${m[1]}`;
  }
  return roleId;
}

/**
 * Map a role id to its on-disk prompt file basename.
 *
 * Both `reviewer-<x>` and legacy `expert-<x>` ids map to `reviewer-<x>.md` (the
 * 7 role prompts were renamed in Plan 3). `paired-reviewer` maps to
 * `system-rubric.md` because the rubric IS the paired-reviewer's base prompt.
 * `expert-template` is authoring scaffolding and keeps its own file.
 *
 * @param {string} roleId
 * @returns {string} file basename (e.g. "reviewer-architecture.md")
 */
export function roleIdToFilename(roleId) {
  if (roleId === 'paired-reviewer') return 'system-rubric.md';
  if (roleId === 'expert-template') return 'expert-template.md';
  if (typeof roleId === 'string') {
    const m = roleId.match(/^(?:reviewer|expert)-(.+)$/);
    if (m) return `reviewer-${m[1]}.md`;
  }
  throw new RolePromptError(
    `unknown role id "${roleId}" — expected "paired-reviewer", "reviewer-*", or "expert-*"`,
    { roleId }
  );
}

/**
 * Parse YAML-ish frontmatter from the top of a file.
 *
 * Accepts the strict form:
 *   ---
 *   key: value
 *   key: value
 *   ---
 *
 * Rules (kept narrow on purpose):
 *   - File MUST start with `---\n`.
 *   - Each body line MUST match `^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$`
 *     OR be blank/comment (`#…`). Blank/comment lines are skipped.
 *   - Block MUST be terminated by a line of exactly `---`.
 *   - Anything else → throw RolePromptError.
 *
 * @param {string} text — full file contents
 * @param {string} roleId — for error messages
 * @returns {{frontmatter: Record<string,string>, body: string}}
 */
function parseFrontmatter(text, roleId) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new RolePromptError(
      `role prompt "${roleId}" is missing frontmatter (file must start with "---")`,
      { roleId }
    );
  }
  // Split off the opening fence.
  const afterOpen = text.replace(/^---\r?\n/, '');
  // Find the closing `---` on its own line.
  const closeMatch = afterOpen.match(/^---\r?\n/m);
  if (!closeMatch) {
    throw new RolePromptError(
      `role prompt "${roleId}" frontmatter is not terminated (missing closing "---")`,
      { roleId }
    );
  }
  const fmRaw = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  const frontmatter = {};
  const kvRe = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/;
  const lines = fmRaw.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(kvRe);
    if (!m) {
      throw new RolePromptError(
        `role prompt "${roleId}" has malformed frontmatter line: ${JSON.stringify(line)}`,
        { roleId }
      );
    }
    frontmatter[m[1]] = m[2];
  }
  return { frontmatter, body };
}

/**
 * Compute SHA-256 of the FULL file contents (frontmatter included). The lock
 * file generator hashes the same span, so the two values are directly
 * comparable.
 *
 * @param {string} content
 * @returns {string} lowercase hex digest
 */
function sha256Hex(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Load a role-prompt file by role id and return its parsed contents.
 *
 * @param {string} roleId — e.g. "expert-architecture", "paired-reviewer"
 * @param {{promptsDir?: string}} [opts] — override prompts directory (tests)
 * @returns {{roleId: string, version: string, content: string, hash: string}}
 *
 * Throws RolePromptError if:
 *   - file missing
 *   - frontmatter missing or malformed
 *   - `version` field absent
 *   - `role_id` field absent or mismatched with the expected roleId
 */
export function loadRolePrompt(roleId, opts = {}) {
  const canonical = canonicalizeRoleId(roleId);
  const filename = roleIdToFilename(canonical);
  const dir = opts.promptsDir || PROMPTS_DIR;
  const filepath = join(dir, filename);
  if (!existsSync(filepath)) {
    throw new RolePromptError(
      `role prompt "${roleId}" not found at ${filepath}`,
      { roleId }
    );
  }
  let text;
  try {
    text = readFileSync(filepath, 'utf8');
  } catch (cause) {
    throw new RolePromptError(
      `role prompt "${roleId}" could not be read: ${cause.message}`,
      { roleId, cause }
    );
  }
  const { frontmatter, body } = parseFrontmatter(text, canonical);
  if (!frontmatter.version) {
    throw new RolePromptError(
      `role prompt "${roleId}" is missing required frontmatter field "version"`,
      { roleId }
    );
  }
  if (!frontmatter.role_id) {
    throw new RolePromptError(
      `role prompt "${roleId}" is missing required frontmatter field "role_id"`,
      { roleId }
    );
  }
  if (frontmatter.role_id !== canonical) {
    throw new RolePromptError(
      `role prompt at ${filename} declares role_id="${frontmatter.role_id}" ` +
        `but was loaded as "${canonical}" — fix the frontmatter or the caller`,
      { roleId }
    );
  }
  return {
    roleId: canonical,
    version: frontmatter.version,
    content: body,
    hash: sha256Hex(text),
  };
}

/**
 * Verify that a role-prompt's hash matches the lock-file entry.
 *
 * This is a SOFT check per spec §5: a mismatch means a user edited the prompt
 * file without bumping `version` and regenerating the lock file. The
 * dispatcher should record an audit signal (e.g. log it, surface in the
 * verdict block) but the run continues — we don't want to wedge the
 * autopilot on a stale lock file.
 *
 * @param {string} roleId
 * @param {string} fullFileContent — FULL file content (including frontmatter)
 * @param {object} lockFile — parsed role-prompts.lock.json
 * @returns {boolean} true on match, false on mismatch or absent entry
 */
export function verifyRolePromptHash(roleId, fullFileContent, lockFile) {
  if (!lockFile || typeof lockFile !== 'object' || !lockFile.prompts) {
    return false;
  }
  const entry = lockFile.prompts[roleId];
  if (!entry || typeof entry.sha256 !== 'string') return false;
  return sha256Hex(fullFileContent) === entry.sha256;
}
