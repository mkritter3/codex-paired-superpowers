// v0.7.3 plan markdown parsers — for the dependency graph DAG.
//
// Per spec rev5 §5.2, DependsOn validity is mechanical state (DAG correctness),
// not a subjective orchestration decision. Node owns this parsing.
//
// We also re-add a Files block parser here because dep-graph batching
// (slice 7) needs Node-level access to each slice's Files set to compute
// non-overlap. This restores parser code that was removed in v0.7.0's pivot,
// scoped to "data the orchestrator needs as machine state" rather than
// "decisions the orchestrator should make".
//
// Both parsers throw PlanParseError with halt codes matching the spec:
//   - dep-block-malformed (DependsOn structure invalid)
//   - dep-self-reference (slice depends on itself)
//   - parallel-files-malformed (Files block structure invalid)
//   - parallel-files-missing (DependsOn: only when caller explicitly requires)
//
// Cross-slice validation (unknown-slice, cycle) is handled at DAG construction
// (lib/codex-bridge/dependency-graph.js, slice 7).

import { readFileSync } from 'node:fs';

const SLICE_ID_RE = /^slice-\d+$/;

export class PlanParseError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'PlanParseError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Extract a slice's section text from a plan markdown.
 * The slice section runs from `## Slice N:` to the next `## Slice M:` header
 * (or end-of-file).
 *
 * @param {string} planMarkdown
 * @param {string|number} sliceId — "slice-3" or 3
 * @returns {string|null} the section text, or null if no such slice
 */
export function extractSliceSection(planMarkdown, sliceId) {
  const num = typeof sliceId === 'number'
    ? String(sliceId)
    : String(sliceId).replace(/^slice-/, '');
  if (!/^\d+$/.test(num)) return null;

  const lines = planMarkdown.split('\n');
  const startRe = new RegExp(`^##\\s+Slice\\s+${num}\\b`);
  const anySliceRe = /^##\s+Slice\s+\d+\b/;

  let inSection = false;
  const buf = [];
  for (const line of lines) {
    if (!inSection) {
      if (startRe.test(line)) {
        inSection = true;
        buf.push(line);
      }
    } else {
      if (anySliceRe.test(line) && !startRe.test(line)) {
        break;
      }
      buf.push(line);
    }
  }
  return inSection ? buf.join('\n') : null;
}

/**
 * Enumerate all slice ids in a plan in declaration order.
 * Returns ["slice-1", "slice-3", ...].
 */
export function enumerateSliceIds(planMarkdown) {
  const lines = planMarkdown.split('\n');
  const re = /^##\s+Slice\s+(\d+)\b/;
  const ids = [];
  for (const line of lines) {
    const m = line.match(re);
    if (m) ids.push(`slice-${m[1]}`);
  }
  return ids;
}

// Internal helper: parse a `**X:**` block of `- value` bullets.
// Returns array of bullet values (whitespace-trimmed). Throws PlanParseError
// with the supplied code on malformed shape.
function parseBlock(sliceSection, headerLiteral, errorCode) {
  if (typeof sliceSection !== 'string') {
    throw new PlanParseError(errorCode, `slice section must be a string; got ${typeof sliceSection}`);
  }
  const lines = sliceSection.split('\n');
  let inBlock = false;
  let blockOpened = false;
  const bullets = [];

  for (const raw of lines) {
    const t = raw.trim();
    if (!inBlock) {
      if (t === headerLiteral) {
        inBlock = true;
        blockOpened = true;
        continue;
      }
      // Detect inline form: `**X:** value` (anything past the header on the same line)
      if (raw.startsWith(headerLiteral) && raw.length > headerLiteral.length) {
        // Allow trailing whitespace only; reject inline content.
        const rest = raw.slice(headerLiteral.length).trim();
        if (rest.length > 0) {
          throw new PlanParseError(
            errorCode,
            `inline form not allowed for ${headerLiteral}; use bullet block instead`
          );
        }
      }
    } else {
      // In block: consume `- value` bullets; stop on blank/heading/other-bold.
      if (t === '') break;
      if (t.startsWith('## ') || t.startsWith('### ')) break;
      if (/^\*\*[A-Za-z][^*]*:\*\*/.test(t) && t !== headerLiteral) break;
      if (!t.startsWith('- ')) {
        throw new PlanParseError(
          errorCode,
          `${headerLiteral} block contains non-bullet line: "${t}"`
        );
      }
      const value = t.slice(2).trim();
      if (value.length === 0) {
        throw new PlanParseError(errorCode, `${headerLiteral} bullet has empty value`);
      }
      bullets.push(value);
    }
  }

  if (blockOpened && bullets.length === 0) {
    throw new PlanParseError(errorCode, `${headerLiteral} block is empty (at least one bullet required)`);
  }
  return { found: blockOpened, bullets };
}

/**
 * Parse a slice's `**Files:**` block.
 *
 * Returns array of repo-relative file paths.
 * Returns [] if the block is absent (caller decides if it's required for
 * parallel candidates per spec §5).
 *
 * Throws PlanParseError(code='parallel-files-malformed') on structural defects.
 */
export function parseFilesBlock(sliceSection) {
  const { found, bullets } = parseBlock(sliceSection, '**Files:**', 'parallel-files-malformed');
  if (!found) return [];

  // Path-shape validation per spec §13:
  // - reject globs (*, ?, [)
  // - reject traversal (./ or ../ segments)
  // - reject absolute paths (leading /)
  // - reject backslash separators
  // - reject directory-only paths (trailing /)
  // - reject duplicates within the slice
  const seen = new Set();
  for (const path of bullets) {
    if (/[\*\?\[\]]/.test(path)) {
      throw new PlanParseError('parallel-files-malformed', `Files path contains a glob character: ${path}`);
    }
    if (path.startsWith('/')) {
      throw new PlanParseError('parallel-files-malformed', `Files path is absolute: ${path}`);
    }
    if (path.includes('\\')) {
      throw new PlanParseError('parallel-files-malformed', `Files path uses backslash separator: ${path}`);
    }
    if (path.endsWith('/')) {
      throw new PlanParseError('parallel-files-malformed', `Files path is directory-only (trailing slash): ${path}`);
    }
    const parts = path.split('/');
    if (parts.some(p => p === '.' || p === '..')) {
      throw new PlanParseError('parallel-files-malformed', `Files path contains traversal segment: ${path}`);
    }
    if (seen.has(path)) {
      throw new PlanParseError('parallel-files-malformed', `Files block has duplicate entry: ${path}`);
    }
    seen.add(path);
  }
  return bullets;
}

/**
 * Parse a slice's `**DependsOn:**` block (v0.7.3+).
 *
 * Returns array of slice ids the slice depends on (e.g. ["slice-3", "slice-5"]).
 * Returns [] if the block is absent (no deps).
 *
 * Throws PlanParseError(code='dep-block-malformed') on structural defects;
 * code='dep-self-reference' if the block lists the slice's own id.
 *
 * Cross-slice validation (unknown id, cycle detection) is performed at DAG
 * construction in dependency-graph.js, not here.
 */
export function parseDependsOnBlock(sliceSection, ownSliceId = null) {
  const { found, bullets } = parseBlock(sliceSection, '**DependsOn:**', 'dep-block-malformed');
  if (!found) return [];

  const seen = new Set();
  for (const value of bullets) {
    if (!SLICE_ID_RE.test(value)) {
      throw new PlanParseError(
        'dep-block-malformed',
        `DependsOn entry must match /^slice-\\d+$/; got "${value}"`
      );
    }
    if (seen.has(value)) {
      throw new PlanParseError(
        'dep-block-malformed',
        `DependsOn block has duplicate entry: ${value}`
      );
    }
    seen.add(value);
    if (ownSliceId !== null && value === ownSliceId) {
      throw new PlanParseError(
        'dep-self-reference',
        `slice ${ownSliceId} cannot depend on itself`
      );
    }
  }
  return bullets;
}

/**
 * Parse the `**high_stakes: true**` bold-line frontmatter from a slice section.
 *
 * Returns true ONLY when the slice section contains the exact literal line
 * `**high_stakes: true**` (with a space after the colon). All other variants
 * are rejected and return false, keeping the prose↔parser contract tight:
 *
 *   **high_stakes: true**   → true   ✓ canonical form (SKILL.md §high_stakes)
 *   **high_stakes: false**  → false  (explicit opt-out)
 *   high_stakes: true       → false  (no bold markers)
 *   **high_stakes:true**    → false  (missing space after colon)
 *   **high_stakes: yes**    → false  (wrong value token)
 *   **high_stakes: TRUE**   → false  (case-sensitive; spec uses lowercase)
 *
 * The strict parser is intentional: the writing-plans skill-structure test
 * already pins `**high_stakes: true**` as the required literal in SKILL.md,
 * so the parser must accept exactly the same form.
 *
 * @param {string} sliceSection — raw slice markdown text
 * @returns {boolean}
 */
export function parseSliceHighStakes(sliceSection) {
  if (typeof sliceSection !== 'string') return false;
  const lines = sliceSection.split('\n');
  // v0.9.1 hardening: fenced code blocks must be skipped so that a docs
  // example like:
  //   ```markdown
  //   **high_stakes: true**
  //   ```
  // does not silently flip the parser. Track fence state on ``` or ~~~
  // markers (CommonMark fenced-code-block syntax).
  let inFence = false;
  let fenceMarker = null;
  for (const raw of lines) {
    const t = raw.trim();
    // Fence-state machine. We only consider a line a fence boundary when
    // it BEGINS with the marker (after trimming) — that matches markdown
    // renderers. Close the fence only on the same marker style (``` won't
    // close ~~~).
    if (!inFence) {
      if (t.startsWith('```')) { inFence = true; fenceMarker = '```'; continue; }
      if (t.startsWith('~~~')) { inFence = true; fenceMarker = '~~~'; continue; }
    } else {
      if (t.startsWith(fenceMarker)) { inFence = false; fenceMarker = null; }
      continue; // every line inside the fence is non-executable plan content
    }
    // Exact literal match: **high_stakes: true**
    if (t === '**high_stakes: true**') return true;
    // Explicit false — stop scanning; the flag is present but false.
    if (t === '**high_stakes: false**') return false;
  }
  return false;
}

/**
 * Convenience: read a plan file from disk, extract a slice's Files + DependsOn
 * blocks. Returns { files: string[], dependsOn: string[] }.
 *
 * Throws PlanParseError if the slice section is absent OR either block is
 * malformed.
 */
export function parseSliceMetadata(planPath, sliceId) {
  const planText = readFileSync(planPath, 'utf8');
  const section = extractSliceSection(planText, sliceId);
  if (section === null) {
    throw new PlanParseError(
      'dep-unknown-slice',
      `slice "${sliceId}" not found in plan ${planPath}`
    );
  }
  const files = parseFilesBlock(section);
  const dependsOn = parseDependsOnBlock(section, sliceId.startsWith('slice-') ? sliceId : `slice-${sliceId}`);
  return { files, dependsOn };
}
