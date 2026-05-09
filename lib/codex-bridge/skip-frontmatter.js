/**
 * parseSkipFrontmatter — parse `live-verification: skip - <reason>` from slice markdown.
 *
 * Returns one of:
 *   { skip: false }
 *   { skip: true, reason: string }
 *   { error: { code: string, detail: string } }
 *
 * Error codes:
 *   skip-malformed             — directive present but wrong casing (e.g. Live-Verification:)
 *   skip-duplicate             — more than one live-verification: line
 *   skip-justification-missing — `live-verification: skip` with no ` - reason` at all
 *   skip-justification-empty   — `live-verification: skip -` with empty/whitespace reason
 *   skip-unknown-value         — value is not `skip` (e.g. `maybe`, `yes`)
 */

const CASE_SENSITIVE_RE = /^live-verification:\s*(.*)$/m;
const CASE_INSENSITIVE_RE = /^live-verification:\s*(.*)$/im;

/**
 * @param {string} sliceMarkdown
 * @returns {{ skip: false } | { skip: true, reason: string } | { error: { code: string, detail: string } }}
 */
export function parseSkipFrontmatter(sliceMarkdown) {
  // Step 1: wrong-casing check — matches case-insensitively but NOT case-sensitively.
  const insensitiveMatch = CASE_INSENSITIVE_RE.exec(sliceMarkdown);
  const sensitiveMatch = CASE_SENSITIVE_RE.exec(sliceMarkdown);

  if (insensitiveMatch && !sensitiveMatch) {
    return {
      error: {
        code: 'skip-malformed',
        detail:
          `live-verification directive found with wrong casing: "${insensitiveMatch[0].split('\n')[0]}". ` +
          'Use exact lowercase `live-verification:` key.',
      },
    };
  }

  // Step 2: count all case-sensitive matches.
  const allMatches = [...sliceMarkdown.matchAll(/^live-verification:\s*(.*)$/gm)];

  if (allMatches.length === 0) {
    return { skip: false };
  }

  if (allMatches.length > 1) {
    return {
      error: {
        code: 'skip-duplicate',
        detail:
          `Found ${allMatches.length} live-verification: directives in this slice. ` +
          'Only one is allowed per slice.',
      },
    };
  }

  // Exactly one match — parse its value.
  const rawValue = allMatches[0][1].trim();

  // Does it start with "skip"?
  if (rawValue === 'skip') {
    // `skip` with no ` - reason` separator at all.
    return {
      error: {
        code: 'skip-justification-missing',
        detail:
          'live-verification: skip requires a justification. ' +
          'Use `live-verification: skip - <reason>` where reason is non-empty.',
      },
    };
  }

  if (rawValue.startsWith('skip -')) {
    const reason = rawValue.slice('skip -'.length).trim();
    if (reason.length === 0) {
      return {
        error: {
          code: 'skip-justification-empty',
          detail:
            'live-verification: skip has an empty justification after the dash. ' +
            'Provide a non-empty reason explaining why live verification can be skipped.',
        },
      };
    }
    return { skip: true, reason };
  }

  // Value is something other than `skip` or `skip - ...`.
  return {
    error: {
      code: 'skip-unknown-value',
      detail:
        `live-verification: received unknown value "${rawValue}". ` +
        'The only supported value is `skip` (with a justification).',
    },
  };
}
