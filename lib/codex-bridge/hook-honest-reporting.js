// v0.8.1 honest-reporting hook — deterministic scanner for claim language
// without nearby evidence.
//
// Scope: when the activation marker is present (see honest-reporting-marker.js),
// scan the last assistant turn for high-precision claim vocabulary
// ("VERIFIED", "PASS", "shipped", "tests pass", etc.). For each match, check
// for evidence anywhere in the same message. If any match lacks evidence,
// exit 2 with a message asking the orchestrator to cite the establishing
// tool call OR reclassify the claim as ASSUMED/UNTESTED.
//
// v0.15.0 false-positive surgery (driven by transcript replay of 47 Stop
// blocks across 8 sessions, majority false positives):
//   - evidence proximity widened from "same paragraph ±200 chars" to the
//     whole message — the common honest shape is a tool-output paragraph
//     followed by a summary paragraph, which the old window punished;
//   - quoted single-word/short mentions ("shipped") are stripped, killing
//     the re-block loop where the REWRITE discussing the flagged word
//     re-triggered the hook (observed up to 3 consecutive blocks);
//   - over-broad lowercase vocab (confirmed/installed/released) dropped;
//   - `stop_hook_active` guard: at most one block per stop, never a loop;
//   - the v0.10.1 SHIP-audit gate moved out of this hook into the sidecar
//     sink (sidecar.js assertShipAuditsForAppend) — the shell-string regex
//     parse was fail-open against $VAR / heredoc / $(...) forms.
//
// Pure functions are exported for tests; `main()` reads stdin + env and
// dispatches to `runStop` or `runPreToolUse`.
//
// Exit code semantics (Claude Code hook spec):
//   - exit 0: continue (no action).
//   - exit 2: block + emit message on stderr that gets shown back to Claude.

import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
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
  /\bdeployed\b/i,
  /\bshipped\b/i,
  // v0.15.0: bare /confirmed|installed|released/i removed — transcript
  // replay showed they fire overwhelmingly on ambient prose ("the user
  // confirmed the choice", "Node is installed by default", "React 18 was
  // released in 2022"). The deliberate caps forms (CONFIRMED / INSTALLED /
  // RELEASED) remain in CAPS_VOCAB above.
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

  // 1. Fenced code blocks ``` ... ``` (closed).
  out = out.replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length));

  // 1b. Unterminated fenced code block — opener with no matching closer
  // (Claude truncates mid-response, network hiccup). The lazy regex in 1
  // would leave claim words inside an unterminated block in the scanned
  // text. Strip from a remaining ``` to EOF. (v0.8.1.1 edge-case fix.)
  out = out.replace(/```[\s\S]*$/g, (m) => ' '.repeat(m.length));

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

  // 6. v0.15.0: short double-quoted spans (straight or smart quotes) are
  //    meta-mentions, not claims — `the flagged word "shipped"`, quoting the
  //    hook's own feedback, etc. Transcript replay showed rewrites that
  //    DISCUSS the flagged word re-trigger the hook for up to 3 consecutive
  //    blocks. Spans of ≤3 words and ≤40 chars are blanked; anything longer
  //    is treated as substantive text and still scanned.
  out = out.replace(/["“]([^"“”\n]{1,40})["”]/g, (m, inner) => {
    const words = inner.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3) {
      return '"' + ' '.repeat(inner.length) + '"';
    }
    return m;
  });

  return out;
}

// ── Evidence helpers ──────────────────────────────────────────────────────

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

  // v0.15.0: evidence anywhere in the message clears its claims. The old
  // "same paragraph ±200 chars" window blocked the most common honest
  // shape — a tool-output/citation paragraph followed by a summary
  // paragraph — and trained the model to sprinkle decorative backticks
  // next to claim words instead of verifying. The hook's remaining job is
  // catching wrap-ups with NO evidence at all. Evidence is checked on the
  // ORIGINAL turnText so file paths inside code blocks still count.
  const messageHasEvidence = hasEvidenceInRange(turnText, 0, turnText.length);
  const decorated = matches.map((m) => ({ ...m, hasEvidence: messageHasEvidence }));

  const ok = decorated.every((m) => m.hasEvidence);
  return { ok, matches: decorated };
}

// ── Transcript reader ─────────────────────────────────────────────────────
//
// Claude Code Stop hooks export $CLAUDE_TRANSCRIPT_PATH which points to a
// JSONL file with one message per line. We need the LAST assistant message,
// and within it the concatenation of text-type content blocks.

// v0.15.0: read only the tail of the transcript. Late in a long session the
// JSONL can be tens of MB; the hook runs on EVERY Stop and Bash PreToolUse
// and only ever needs the last 1-2 assistant turns. 256KB comfortably holds
// several maximal turns. The first (possibly partial) line in the window is
// dropped — JSON.parse would reject it anyway.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function readFileTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      return readFileSync(path, 'utf8');
    }
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString('utf8', 0, bytesRead);
    const firstNewline = text.indexOf('\n');
    return firstNewline < 0 ? '' : text.slice(firstNewline + 1);
  } catch {
    return '';
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

export function readLastAssistantTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  const raw = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!raw) return '';
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
  const raw = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!raw) return [];
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
    lines.push(`  - "${m.word}" at offset ${m.offset}: no tool reference or caveat anywhere in the message`);
  }
  lines.push('');
  lines.push('Required action: rewrite your previous response so each claim is one of:');
  lines.push('  (a) cited: name the tool command and quote the output that established it, OR');
  lines.push('  (b) marked ASSUMED, UNTESTED, or "based on prior session" if you did not verify this turn.');
  lines.push('');
  lines.push('Do NOT quote or discuss the flagged word in the rewrite — state the evidence or reclassify.');
  lines.push('This hook blocks at most once per stop; your next response goes through.');
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
 *
 * v0.15.0: the v0.10.1 SHIP-audit gate no longer lives here. It regex-parsed
 * the literal Bash string and was fail-open against `--round "$VAR"`,
 * heredocs, and $(...) — the most natural ways to write the command. The
 * gate is now enforced in the sink (sidecar.js assertShipAuditsForAppend,
 * invoked by the cli.js sidecar-append-round verb), where the JSON arrives
 * already parsed and no quoting form can slip past.
 *
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

  // v0.15.0 loop guard: Claude Code sets stop_hook_active=true when the
  // current turn is already a continuation forced by a Stop hook. Blocking
  // again risks an un-exitable block loop (a real failure mode while the
  // user is away during autopilot). One block per stop is the contract.
  if (mode === 'stop' && input.stop_hook_active === true) return { exit: 0 };

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
