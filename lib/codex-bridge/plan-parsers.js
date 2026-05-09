/**
 * plan-parsers — pure parsers for v0.7.0 plan frontmatter extensions.
 *
 * Spec: docs/specs/2026-05-08-v0.7.0-implementer-routing.md section 9
 *
 * Two exports:
 *   parseImplementerDirective(planText) — reads `**Implementer:** <value>`
 *   parseFilesBlock(planSliceSection)   — reads `**Files:**` bullet block
 *
 * Both are pure (no I/O). Callers (e.g. CLI) handle file reading and slice
 * extraction.
 *
 * Result shapes:
 *   parseImplementerDirective:
 *     { implementer: "codex" | "sonnet" }
 *     { defect: "implementer-directive-malformed", detail: string }
 *
 *   parseFilesBlock:
 *     { files: null }                 — block absent (informational)
 *     { files: string[] }             — block present, valid bullets
 *     { defect: "parallel-files-malformed", detail: string }
 */

const IMPLEMENTER_LINE_RE = /^\*\*Implementer:\*\*(.*)$/m;

/**
 * Parse the **Implementer:** directive from plan text.
 * Missing directive defaults to codex. Case-sensitive on value.
 *
 * @param {string} planText
 * @returns {{implementer: 'codex' | 'sonnet'} | {defect: string, detail: string}}
 */
export function parseImplementerDirective(planText) {
  const match = planText.match(IMPLEMENTER_LINE_RE);
  if (!match) {
    return { implementer: 'codex' };
  }

  const value = match[1].trim();

  if (value === 'codex' || value === 'sonnet') {
    return { implementer: value };
  }

  if (value === '') {
    return {
      defect: 'implementer-directive-malformed',
      detail:
        '**Implementer:** directive has empty value. ' +
        'Allowed values are `codex` or `sonnet` (lower-case).',
    };
  }

  return {
    defect: 'implementer-directive-malformed',
    detail:
      `**Implementer:** received unsupported value "${value}". ` +
      'Allowed values are `codex` or `sonnet` (lower-case, exact match). ' +
      'Note: literal `auto` is not supported.',
  };
}

const FILES_HEADER_LINE = '**Files:**';
const HEADING_LINE_RE = /^#{1,6}\s/;
const BOLD_DIRECTIVE_LINE_RE = /^\*\*[^*]+:\*\*/;
const BULLET_LINE_RE = /^-\s+(.*)$/;

/**
 * Parse the **Files:** bullet block from a plan slice section.
 *
 * The block:
 *   - starts at a line equal to `**Files:**` after trimming;
 *   - continues through consecutive `- <path>` bullet lines (whitespace-tolerant);
 *   - ends at a blank line, a heading, or a next bold directive.
 *
 * Inline form (`**Files:** path`) is malformed.
 * Each path must be a repo-relative file path with no globs, traversal,
 * absolute prefix, trailing slash, or backslash. Duplicates within the block
 * are malformed.
 *
 * @param {string} planSliceSection
 * @returns {{files: null} | {files: string[]} | {defect: string, detail: string}}
 */
export function parseFilesBlock(planSliceSection) {
  const lines = planSliceSection.split('\n');

  // Find the **Files:** header line.
  let headerIdx = -1;
  let inlineHeaderRaw = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === FILES_HEADER_LINE) {
      headerIdx = i;
      break;
    }
    // Inline form check: starts with **Files:** followed by non-empty content.
    if (trimmed.startsWith('**Files:**') && trimmed !== FILES_HEADER_LINE) {
      inlineHeaderRaw = trimmed;
      break;
    }
  }

  if (inlineHeaderRaw !== null) {
    return {
      defect: 'parallel-files-malformed',
      detail:
        `inline **Files:** form is not supported: "${inlineHeaderRaw}". ` +
        'Use a bullet list on subsequent lines: `**Files:**\\n- <path>`.',
    };
  }

  if (headerIdx === -1) {
    return { files: null };
  }

  // Collect bullets from lines after the header until terminator.
  const collected = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Terminators: blank line, heading, or another bold directive.
    if (trimmed === '') break;
    if (HEADING_LINE_RE.test(trimmed)) break;
    if (BOLD_DIRECTIVE_LINE_RE.test(trimmed)) break;

    const bulletMatch = trimmed.match(BULLET_LINE_RE);
    if (!bulletMatch) {
      // Non-bullet line inside the block before any terminator — malformed.
      return {
        defect: 'parallel-files-malformed',
        detail:
          `unexpected non-bullet line inside Files block: "${trimmed}". ` +
          'Each entry must be a `- <path>` bullet.',
      };
    }
    collected.push(bulletMatch[1].trim());
  }

  if (collected.length === 0) {
    return {
      defect: 'parallel-files-malformed',
      detail: 'empty Files block; at least one file required',
    };
  }

  // Validate each path.
  const seen = new Set();
  for (const path of collected) {
    const v = validateFilePath(path);
    if (v) {
      return { defect: 'parallel-files-malformed', detail: v };
    }
    if (seen.has(path)) {
      return {
        defect: 'parallel-files-malformed',
        detail: `duplicate path within Files block: "${path}"`,
      };
    }
    seen.add(path);
  }

  return { files: collected };
}

/**
 * Validate a single repo-relative file path. Returns null if OK, or a string
 * detail describing the violation.
 *
 * @param {string} path
 * @returns {string | null}
 */
function validateFilePath(path) {
  if (path === '') {
    return 'empty path entry in Files block';
  }
  if (path.startsWith('/')) {
    return `absolute paths are not allowed: "${path}"`;
  }
  if (path.includes('\\')) {
    return `backslash separators are not allowed: "${path}" (use forward slashes)`;
  }
  // Traversal / current-dir prefix.
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    return `path traversal/relative segments not allowed: "${path}"`;
  }
  // Globs.
  if (path.includes('*') || path.includes('?')) {
    return `glob patterns not allowed: "${path}"`;
  }
  // Directories (trailing slash).
  if (path.endsWith('/')) {
    return `directory paths not allowed (trailing slash): "${path}"`;
  }
  return null;
}
