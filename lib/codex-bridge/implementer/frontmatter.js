// v0.10.0 frontmatter — parse the **Implementers:** block from a plan slice.
//
// The Implementers block lives INSIDE the slice section of the plan markdown,
// formatted as a bold label followed by a YAML-indented list:
//
//   **Implementers:**
//   - member_id: expert-implementer@claude:kimi-k2.6:cloud#0
//     adapter: claude-cli
//     model: kimi-k2.6:cloud
//     required: true
//     files:
//       - lib/foo.js
//     overlap_rationale: shared types file
//   - member_id: expert-implementer@codex:gpt-5.5#0
//     ...
//
// `high_cost` and `high_cost_rationale` are parsed from the plan-level YAML
// frontmatter block (the `---` fenced block at the very start of planMarkdown).
// If no `---` block is present, both default to false / "".
//
// Cap rules:
//   ≤ 3          — always allowed
//   4 or 5       — require high_cost: true + non-empty high_cost_rationale
//   > 5          — always throws 'role-composer-fan-out-unjustified'
//
// Error codes thrown match the halt-envelope known set:
//   role-composer-fan-out-unjustified
//   implementer-cap-exceeded
//   implementer-high-cost-rationale-missing
//   implementer-member-id-invalid
//   implementer-claimed-files-missing

import { parseMemberId } from './member-id.js';

/**
 * @typedef {object} ImplementerEntry
 * @property {string}   member_id
 * @property {string}   adapter
 * @property {string}   model
 * @property {boolean}  required
 * @property {string[]} files
 * @property {string}   [overlap_rationale]
 */

/**
 * @typedef {object} ImplementersConfig
 * @property {ImplementerEntry[]} implementers
 * @property {boolean}            high_cost
 * @property {string}             high_cost_rationale
 */

// ── Top-level frontmatter parsing ──────────────────────────────────────────────

/**
 * Normalize a simple YAML scalar value.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeYamlScalar(value) {
  let normalized = value.trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.trim();
}

/**
 * Extract the YAML `---` frontmatter block at the start of planMarkdown.
 * Returns the key→value map (scalar only; simple fields only).
 *
 * @param {string} planMarkdown
 * @returns {Record<string, string>}
 */
function parseTopFrontmatter(planMarkdown) {
  const result = {};
  const lines = planMarkdown.split('\n');
  if (lines[0].trim() !== '---') return result;

  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const value = normalizeYamlScalar(line.slice(colonIdx + 1));
      result[key] = value;
    }
    i++;
  }
  return result;
}

/**
 * Parse a YAML bool-ish string to boolean.
 * 'true' → true, anything else → false.
 *
 * @param {string|undefined} s
 * @returns {boolean}
 */
function parseBool(s) {
  return typeof s === 'string' && s.trim().toLowerCase() === 'true';
}

// ── Implementers block parsing ──────────────────────────────────────────────────

/**
 * Locate the **Implementers:** block within a slice section.
 * Returns the lines of the block body (after the label), [] if present but
 * empty, or null if absent.
 *
 * @param {string} sliceSection
 * @returns {string[] | null}
 */
function extractImplementersBlockLines(sliceSection) {
  const lines = sliceSection.split('\n');
  // Look for a line matching `**Implementers:**` (possibly with trailing space)
  const labelRe = /^\*\*Implementers:\*\*\s*$/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (labelRe.test(lines[i].trim())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Collect lines until we hit a blank line or a new section header (##, **...**)
  // that is not indented. The implementers block is indented (starts with `- `).
  const blockLines = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Stop at blank lines only if we've already collected some content.
    if (line.trim() === '') {
      if (blockLines.length > 0) break;
      continue;
    }
    // Stop at a new section marker.
    if (/^#{1,6}\s/.test(line) || /^\*\*[A-Z]/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines;
}

/**
 * Parse the raw lines of the implementers block into ImplementerEntry[].
 *
 * The block is structured as a YAML-style list of entries, where each entry
 * starts with `- member_id:` (possibly with leading whitespace) and subsequent
 * fields are indented under it.
 *
 * @param {string[]} lines
 * @returns {ImplementerEntry[]}
 */
function parseImplementerEntries(lines) {
  const entries = [];
  let current = null;
  let inFiles = false;

  /**
   * Flush the pending entry.
   */
  function flush() {
    if (current) {
      entries.push(current);
      current = null;
      inFiles = false;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    // Strip leading whitespace to detect intent.
    const trimmed = line.trimStart();

    // New top-level list item — starts with '- member_id:' or '- member_id :'
    if (/^-\s+member_id\s*:/.test(trimmed)) {
      flush();
      const value = normalizeYamlScalar(trimmed.replace(/^-\s+member_id\s*:\s*/, ''));
      current = {
        member_id: value,
        adapter: '',
        model: '',
        required: true,
        files: [],
        overlap_rationale: undefined,
      };
      inFiles = false;
      continue;
    }

    if (!current) continue;

    // File sub-list item under `files:`.
    if (inFiles) {
      if (/^-\s+/.test(trimmed)) {
        const filePath = normalizeYamlScalar(trimmed.replace(/^-\s+/, ''));
        if (filePath.length > 0) {
          current.files.push(filePath);
        }
        continue;
      }
      // A line that is not a list item ends the files block.
      inFiles = false;
    }

    // Key-value pairs within the current entry.
    const kvMatch = trimmed.match(/^([a-z_]+)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    const [, key, value] = kvMatch;
    switch (key) {
      case 'adapter':
        current.adapter = normalizeYamlScalar(value);
        break;
      case 'model':
        current.model = normalizeYamlScalar(value);
        break;
      case 'required':
        current.required = normalizeYamlScalar(value).toLowerCase() !== 'false';
        break;
      case 'files':
        inFiles = true;
        // If files: has an inline value (uncommon), treat it as a file.
        if (normalizeYamlScalar(value).length > 0) {
          current.files.push(normalizeYamlScalar(value));
        }
        break;
      case 'overlap_rationale':
        current.overlap_rationale = normalizeYamlScalar(value);
        break;
      default:
        break;
    }
  }

  flush();
  return entries;
}

// ── Validation ─────────────────────────────────────────────────────────────────

/**
 * Validate all parsed ImplementerEntry items and enforce cap + overlap rules.
 *
 * @param {ImplementerEntry[]}  entries
 * @param {boolean}             highCost
 * @param {string}              highCostRationale
 */
function validateImplementers(entries, highCost, highCostRationale) {
  const count = entries.length;

  if (count === 0) {
    throw Object.assign(
      new Error('implementer-directive-malformed: Implementers block has no valid entries'),
      { code: 'implementer-directive-malformed' }
    );
  }

  // Cap check: > 5 always throws fan-out error.
  if (count > 5) {
    throw Object.assign(
      new Error(
        `role-composer-fan-out-unjustified: ${count} implementers exceeds the hard cap of 5`
      ),
      { code: 'role-composer-fan-out-unjustified' }
    );
  }

  // Cap check: 4 or 5 require high_cost: true + non-empty rationale.
  if (count >= 4) {
    if (!highCost) {
      throw Object.assign(
        new Error(
          `implementer-cap-exceeded: ${count} implementers require high_cost: true in plan frontmatter`
        ),
        { code: 'implementer-cap-exceeded' }
      );
    }
    const rationale =
      typeof highCostRationale === 'string' ? highCostRationale.trim() : '';
    if (rationale.length === 0) {
      throw Object.assign(
        new Error(
          'implementer-high-cost-rationale-missing: high_cost: true requires a non-empty high_cost_rationale'
        ),
        { code: 'implementer-high-cost-rationale-missing' }
      );
    }
  }

  const allowedAdapters = new Set(['claude-cli', 'codex-cli']);
  for (const entry of entries) {
    if (entry.adapter === '' || entry.model === '' || !allowedAdapters.has(entry.adapter)) {
      throw Object.assign(
        new Error(
          `implementer-directive-malformed: member "${entry.member_id}" has invalid adapter/model fields`
        ),
        { code: 'implementer-directive-malformed' }
      );
    }
  }

  // Validate each member_id parses correctly.
  for (const entry of entries) {
    try {
      parseMemberId(entry.member_id);
    } catch (err) {
      throw Object.assign(
        new Error(`implementer-member-id-invalid: ${err.message}`),
        { code: 'implementer-member-id-invalid', cause: err }
      );
    }
  }

  // Reject duplicate full member_id (case-sensitive).
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.member_id)) {
      throw Object.assign(
        new Error(`implementer-member-id-invalid: duplicate member_id "${entry.member_id}"`),
        { code: 'implementer-member-id-invalid' }
      );
    }
    seen.add(entry.member_id);
  }

  // Reject missing files.
  for (const entry of entries) {
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw Object.assign(
        new Error(
          `implementer-claimed-files-missing: member "${entry.member_id}" has no claimed files`
        ),
        { code: 'implementer-claimed-files-missing' }
      );
    }
  }

  // Reject overlapping files when both overlapping members lack overlap_rationale.
  // Build file → [member_ids] map.
  /** @type {Map<string, string[]>} */
  const fileOwners = new Map();
  for (const entry of entries) {
    for (const f of entry.files) {
      if (!fileOwners.has(f)) fileOwners.set(f, []);
      fileOwners.get(f).push(entry.member_id);
    }
  }

  // Build a quick lookup: member_id → has overlap_rationale
  const hasRationale = new Map(
    entries.map((e) => [
      e.member_id,
      typeof e.overlap_rationale === 'string' && e.overlap_rationale.trim().length > 0,
    ])
  );

  for (const [file, owners] of fileOwners) {
    if (owners.length < 2) continue;
    // All overlapping members must have overlap_rationale.
    const missing = owners.filter((id) => !hasRationale.get(id));
    if (missing.length > 0) {
      throw Object.assign(
        new Error(
          `implementer-claimed-files-missing: file "${file}" claimed by multiple members ` +
            `(${owners.join(', ')}) but ${missing.join(', ')} lack overlap_rationale`
        ),
        { code: 'implementer-claimed-files-missing' }
      );
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Parse the **Implementers:** block from a plan slice section.
 *
 * Returns null if no **Implementers:** block is found (legacy mode — slice
 * uses the v0.9.x single-implementer path unchanged).
 *
 * `high_cost` / `high_cost_rationale` are read from the top-level `---`
 * YAML frontmatter at the start of `planMarkdown`. If the plan has no `---`
 * block, both default to `false` / `""`.
 *
 * @param {string} planMarkdown  — full plan file content
 * @param {string} sliceSection  — slice section text (e.g. from extractSliceSection)
 * @returns {ImplementersConfig | null}
 * @throws {Error} with `.code` matching a halt-envelope key on validation failure
 */
export function parseImplementersBlock(planMarkdown, sliceSection) {
  // 1. Parse high_cost from top-level plan frontmatter.
  const topFm = parseTopFrontmatter(planMarkdown);
  const highCost = parseBool(topFm.high_cost);
  const highCostRationale =
    typeof topFm.high_cost_rationale === 'string' ? topFm.high_cost_rationale.trim() : '';

  // 2. Locate the **Implementers:** block within the slice section.
  const blockLines = extractImplementersBlockLines(sliceSection);
  if (blockLines === null) return null;

  // 3. Parse entries from the block lines.
  const entries = parseImplementerEntries(blockLines);

  // 4. Validate entries + cap + overlap.
  validateImplementers(entries, highCost, highCostRationale);

  return {
    implementers: entries.map((e) => {
      const clean = {
        member_id: e.member_id,
        adapter: e.adapter,
        model: e.model,
        required: e.required,
        files: e.files,
      };
      if (typeof e.overlap_rationale === 'string' && e.overlap_rationale.trim().length > 0) {
        clean.overlap_rationale = e.overlap_rationale.trim();
      }
      return clean;
    }),
    high_cost: highCost,
    high_cost_rationale: highCostRationale,
  };
}
