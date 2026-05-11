// v0.8.1 honest-reporting hook — deterministic scanner for claim language
// without nearby evidence.
//
// Scope: when the activation marker is present (see honest-reporting-marker.js),
// scan the last assistant turn for high-precision claim vocabulary
// ("VERIFIED", "PASS", "shipped", "tests pass", etc.). For each match, check
// for evidence proximity within ±200 chars AND the same paragraph. If any
// match lacks evidence, exit 2 with a message asking the orchestrator to
// cite the establishing tool call OR reclassify the claim as ASSUMED/UNTESTED.
//
// Pure functions are exported for tests; `main()` reads stdin + env and
// dispatches to `runStop` or `runPreToolUse`.
//
// Exit code semantics (Claude Code hook spec):
//   - exit 0: continue (no action).
//   - exit 2: block + emit message on stderr that gets shown back to Claude.

import { readFileSync, existsSync } from 'node:fs';
import { isActive } from './honest-reporting-marker.js';

// ── Claim vocabulary ──────────────────────────────────────────────────────
//
// Two buckets:
//   1. Caps-sensitive: words like "PASS" / "VERIFIED" — these signal a
//      definitive claim and shouldn't appear without evidence. Lowercase
//      "pass" appears in benign prose ("first pass at the design"); we
//      don't want false positives.
//   2. Case-insensitive phrases: multi-word claims that are reliably
//      stronger than ambient mention.
//
// We compile two regexes per turn; the union of matches is the set we
// require evidence for.

const CAPS_VOCAB = [
  'VERIFIED',
  'PASS',
  'PASSED',
  'SHIPPED',
  'TAGGED',
  'PUSHED',
  'DEPLOYED',
  'RELEASED',
  'INSTALLED',
  'CONFIRMED',
];

const PHRASE_VOCAB_LOWER = [
  // Multi-word phrases where the verb form carries the claim.
  /\btests?\s+pass(?:es|ed)?\b/i,
  /\bsmoke\s+pass(?:es|ed)?\b/i,
  /\b(?:i\s+|just\s+|already\s+)?verified\b/i,
  /\bconfirmed\b/i,
  /\bdeployed\b/i,
  /\breleased\b/i,
  /\binstalled\b/i,
  /\bshipped\b/i,
];

// Word-boundary alone is insufficient because `\b` matches before a hyphen,
// so `PASS-THROUGH`, `SHIPPED-BY`, etc. would falsely fire. The negative
// lookahead `(?![-\w])` rejects when the next char is `-`, a digit, or a
// word character — leaving normal punctuation, whitespace, and EOL as
// valid terminators for the claim word. (Codex round-1 critique.)
const CAPS_RE = new RegExp(`\\b(?:${CAPS_VOCAB.join('|')})(?![-\\w])`, 'g'); // case-sensitive by default

// ── Evidence markers ──────────────────────────────────────────────────────

const EVIDENCE_MARKERS = [
  /`[^`\n]+`/,                                          // inline backticks (any code)
  /\b(?:Bash|Edit|Read|Write|gh|git|node|npm|pnpm|yarn|cargo|pytest|jest)\b/, // tool/CLI refs
  /(?:[\w.-]+\/){1,}[\w.-]+/,                            // file path (a/b/c.ext)
  /:\d+\b/,                                              // :linenum
  /\b(?:ASSUMED|UNTESTED|not verified|haven't checked|based on prior session|recall from memory)\b/i,
  /\bexit code\b/i,
  // "ran" only counts when adjacent to something command-shaped: a backtick
  // or a known CLI name. Bare "ran into a problem" and vague "ran the full
  // suite" / "ran all the tests" do NOT count as evidence — those phrases
  // describe an action without citing the command, so they let unsupported
  // verification claims through. (Codex round-2 critique pinned this case.)
  /\bran\s+(?:`|node\b|npm\b|pnpm\b|git\b|gh\b|bash\b|sh\b|pytest\b|jest\b|cargo\b|yarn\b)/i,
];

// ── Region stripping ──────────────────────────────────────────────────────
//
// We DON'T want to fire on text that's inside quoted regions (the user's
// own words echoed back, code blocks, Codex verdict blocks). We replace
// those regions with same-length whitespace so character offsets remain
// stable for proximity checks while regex matches don't fire inside.

function stripExcludedRegions(text) {
  let out = text;

  // 1. Fenced code blocks ``` ... ```
  out = out.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));

  // 2. Codex verdict blocks <<<VERDICT>>> ... <<<END>>>
  out = out.replace(/<<<VERDICT>>>[\s\S]*?<<<END>>>/g, (m) => ' '.repeat(m.length));

  // 3. `## Machine Result` sections — heading through next H2 or EOF.
  //    We accept "## Machine Result" followed by anything up to "\n## " or EOF.
  out = out.replace(/^##\s+Machine\s+Result[\s\S]*?(?=\n##\s|$)/gm, (m) => ' '.repeat(m.length));

  // 4. Inline backticks — kept for matching (they're EVIDENCE) but we still
  //    strip code-content INSIDE them so claim words inside backticks don't
  //    fire. The leading/trailing backticks themselves remain as evidence
  //    markers (regex above checks inline-backtick presence).
  out = out.replace(/`([^`\n]+)`/g, (m, inner) => '`' + ' '.repeat(inner.length) + '`');

  // 5. Blockquote-prefixed lines (`> ...`): erase the content.
  out = out.replace(/^>.*$/gm, (m) => ' '.repeat(m.length));

  return out;
}

// ── Paragraph + proximity helpers ─────────────────────────────────────────

function paragraphBoundaries(text, offset) {
  // A "paragraph" is delimited by blank lines (\n\n+). Find the start/end
  // boundaries of the paragraph containing `offset`.
  let start = text.lastIndexOf('\n\n', offset);
  start = start < 0 ? 0 : start + 2;
  let end = text.indexOf('\n\n', offset);
  if (end < 0) end = text.length;
  return [start, end];
}

function hasEvidenceInRange(originalText, start, end) {
  const slice = originalText.slice(start, end);
  return EVIDENCE_MARKERS.some((re) => re.test(slice));
}

// ── Public scanner ────────────────────────────────────────────────────────

/**
 * Scan an assistant turn text for claim language without proximity evidence.
 *
 * @param {string} turnText — raw assistant turn text (full).
 * @returns {{
 *   ok: boolean,                    // true = no unsourced claims
 *   matches: Array<{
 *     word: string,
 *     offset: number,
 *     hasEvidence: boolean,
 *   }>,
 * }}
 */
export function scanForUnsourcedClaims(turnText) {
  if (typeof turnText !== 'string' || turnText.length === 0) {
    return { ok: true, matches: [] };
  }
  const stripped = stripExcludedRegions(turnText);
  const matches = [];

  // Caps-sensitive pass.
  for (const m of stripped.matchAll(CAPS_RE)) {
    matches.push({ word: m[0], offset: m.index });
  }

  // Phrase pass (case-insensitive).
  for (const re of PHRASE_VOCAB_LOWER) {
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of stripped.matchAll(globalRe)) {
      // Avoid duplicating a match already captured by CAPS_RE.
      const dup = matches.find((x) => x.offset === m.index);
      if (!dup) matches.push({ word: m[0], offset: m.index });
    }
  }

  // For each match, look for evidence in the SAME PARAGRAPH and within
  // ±200 chars of the match. Use the ORIGINAL turnText for evidence
  // proximity so file paths inside code blocks still count (the offsets
  // are preserved by the strip step).
  const decorated = matches.map((m) => {
    const [pStart, pEnd] = paragraphBoundaries(turnText, m.offset);
    const rangeStart = Math.max(pStart, m.offset - 200);
    const rangeEnd = Math.min(pEnd, m.offset + m.word.length + 200);
    const hasEvidence = hasEvidenceInRange(turnText, rangeStart, rangeEnd);
    return { ...m, hasEvidence };
  });

  const ok = decorated.every((m) => m.hasEvidence);
  return { ok, matches: decorated };
}

// ── Transcript reader ─────────────────────────────────────────────────────
//
// Claude Code Stop hooks export $CLAUDE_TRANSCRIPT_PATH which points to a
// JSONL file with one message per line. We need the LAST assistant message,
// and within it the concatenation of text-type content blocks.

export function readLastAssistantTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const lines = raw.split('\n');
  // Walk backward.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    // Concatenate text-type content blocks; ignore tool_use / tool_result.
    return msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n');
  }
  return '';
}

// ── Last N assistant turns (PreToolUse) ───────────────────────────────────

export function readLastNAssistantTurns(transcriptPath, n) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    const text = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n');
    if (text.length > 0) out.unshift(text);
  }
  return out;
}

// ── Decision messages ─────────────────────────────────────────────────────

function formatStopMessage(matches, markerInfo) {
  const lines = ['Honest-reporting hook: found unsourced claims:'];
  for (const m of matches.filter((x) => !x.hasEvidence)) {
    lines.push(`  - "${m.word}" at offset ${m.offset}: no tool reference or caveat within same paragraph + ±200 chars`);
  }
  lines.push('');
  lines.push('Required action: rewrite your previous response so each claim is one of:');
  lines.push('  (a) cited: name the tool command and quote the output that established it, OR');
  lines.push('  (b) marked ASSUMED, UNTESTED, or "based on prior session" if you did not verify this turn.');
  lines.push('');
  if (markerInfo && markerInfo.marker) {
    lines.push(`Hook is active because <.codex-paired/honest-reporting-active.json> is present (skill: ${markerInfo.marker.skillName}, expires: ${markerInfo.marker.expiresAt}).`);
  }
  return lines.join('\n');
}

function formatPreToolUseMessage(command, matches) {
  const lines = [`Honest-reporting hook: about to run \`${command}\`, but recent turns contain unsourced claims:`];
  for (const m of matches.filter((x) => !x.hasEvidence)) {
    lines.push(`  - "${m.word}" at offset ${m.offset}`);
  }
  lines.push('');
  lines.push('Required action before proceeding:');
  lines.push('  (a) Cite the verification tool calls (tests run, install verified, etc.) in this or the prior turn, OR');
  lines.push('  (b) Reclassify each claim as ASSUMED / UNTESTED / "based on prior session" before running the command.');
  return lines.join('\n');
}

// ── Hook entry points ─────────────────────────────────────────────────────

const PRETOOLUSE_BLOCKED_COMMAND_RES = [
  /^git\s+tag\b/,
  /^git\s+push\b/,
  /^gh\s+release\s+create\b/,
  /^npm\s+publish\b/,
];

function commandMatchesBlocklist(cmd) {
  if (typeof cmd !== 'string') return false;
  for (const re of PRETOOLUSE_BLOCKED_COMMAND_RES) {
    if (re.test(cmd.trim())) return true;
  }
  return false;
}

/**
 * Pure decision function for the Stop hook.
 * @returns {{exit: 0|2, message?: string}}
 */
export function decideStop(turnText, markerInfo) {
  if (!markerInfo || !markerInfo.active) return { exit: 0 };
  const { ok, matches } = scanForUnsourcedClaims(turnText);
  if (ok) return { exit: 0 };
  return { exit: 2, message: formatStopMessage(matches, markerInfo) };
}

/**
 * Pure decision function for the PreToolUse hook (Bash commands only).
 * @returns {{exit: 0|2, message?: string}}
 */
export function decidePreToolUse(toolName, toolInput, recentTurns, markerInfo) {
  if (!markerInfo || !markerInfo.active) return { exit: 0 };
  if (toolName !== 'Bash') return { exit: 0 };
  const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!commandMatchesBlocklist(command)) return { exit: 0 };
  // Scan the concatenated recent turns for unsourced claims.
  const combined = (recentTurns || []).join('\n\n');
  const { ok, matches } = scanForUnsourcedClaims(combined);
  if (ok) return { exit: 0 };
  return { exit: 2, message: formatPreToolUseMessage(command, matches) };
}

// ── Main dispatch (CLI) ──────────────────────────────────────────────────

export async function mainWithStdin(mode, stdinJson, deps = {}) {
  const isActiveFn = deps.isActive || isActive;
  const readLast = deps.readLastAssistantTurn || readLastAssistantTurn;
  const readLastN = deps.readLastNAssistantTurns || readLastNAssistantTurns;

  let input = {};
  try {
    input = JSON.parse(stdinJson);
  } catch {
    return { exit: 0 };
  }
  const cwd = input.cwd || process.cwd();
  const transcriptPath = input.transcript_path || input.transcriptPath || process.env.CLAUDE_TRANSCRIPT_PATH;

  const markerInfo = isActiveFn(cwd);
  if (!markerInfo.active) return { exit: 0 };

  if (mode === 'stop') {
    const turn = readLast(transcriptPath);
    return decideStop(turn, markerInfo);
  }
  if (mode === 'pretooluse') {
    const recent = readLastN(transcriptPath, 2);
    return decidePreToolUse(input.tool_name, input.tool_input, recent, markerInfo);
  }
  return { exit: 0 };
}

// ── Process bootstrap (only when invoked as CLI) ─────────────────────────

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const mode = process.argv[2] || 'stop';
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', async () => {
    try {
      const { exit, message } = await mainWithStdin(mode, stdin);
      if (exit === 2 && message) {
        process.stderr.write(message + '\n');
      }
      process.exit(exit);
    } catch {
      // Fail-open: never block the user because the hook itself errored.
      process.exit(0);
    }
  });
}
