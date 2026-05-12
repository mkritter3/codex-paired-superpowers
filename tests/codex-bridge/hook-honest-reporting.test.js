// v0.8.1 — tests for the honest-reporting Stop/PreToolUse hook scanner.
//
// Pure function tests: scanForUnsourcedClaims, decideStop, decidePreToolUse.
// Marker tests: writeMarker / readMarker / isActive with mocked filesystem
// (via tmpdir). Hook entry-point tests use mainWithStdin with deps overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scanForUnsourcedClaims,
  decideStop,
  decidePreToolUse,
  readLastAssistantTurn,
  readLastNAssistantTurns,
  mainWithStdin,
} from '../../lib/codex-bridge/hook-honest-reporting.js';
import {
  writeMarker,
  readMarker,
  isActive,
  markerPath,
} from '../../lib/codex-bridge/honest-reporting-marker.js';

function makeTmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-honest-'));
  // v0.8.1.1: real `git init` instead of a bare `.git/` directory.
  // Codex slice-review caught that some git versions can stall trying
  // to traverse an uninitialized `.git/`, which timed out the bash
  // wrapper test. A real init is the cheapest robust fixture.
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir, timeout: 5000 });
  } catch {
    // Fallback to bare `.git/` if git isn't available; the markerPath
    // timeout will catch any resulting slow paths.
    mkdirSync(join(dir, '.git'), { recursive: true });
  }
  return dir;
}

// ── scanForUnsourcedClaims ────────────────────────────────────────────────

test('scanner: no claim vocabulary → ok', () => {
  const { ok, matches } = scanForUnsourcedClaims('Just some prose about design.');
  assert.equal(ok, true);
  assert.equal(matches.length, 0);
});

test('scanner: caps-sensitive — uppercase VERIFIED alone fires', () => {
  const { ok, matches } = scanForUnsourcedClaims('We are VERIFIED.');
  assert.equal(ok, false);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].word, 'VERIFIED');
  assert.equal(matches[0].hasEvidence, false);
});

test('scanner: caps-sensitive — lowercase pass mid-sentence does NOT fire', () => {
  // "PASS" is a strong claim; "pass" alone is too ambient.
  // Note: the phrase regex matches "tests? pass" so we craft a sentence
  // where "pass" appears alone without the "tests" preamble.
  const { ok, matches } = scanForUnsourcedClaims('My first pass at the design.');
  // The phrase regex /\btests?\s+pass(?:es|ed)?\b/i requires "test" or
  // "tests" preamble, so plain "pass" should not match.
  assert.equal(ok, true, `expected ok, got matches=${JSON.stringify(matches)}`);
});

test('scanner: caps-sensitive PASS without evidence fires', () => {
  const { ok, matches } = scanForUnsourcedClaims('Final answer: PASS.');
  assert.equal(ok, false);
  assert.ok(matches.some((m) => m.word === 'PASS' && !m.hasEvidence));
});

test('scanner: phrase "tests passed" without evidence fires', () => {
  const { ok } = scanForUnsourcedClaims('I think tests passed.');
  assert.equal(ok, false);
});

test('scanner: claim + adjacent inline backtick (evidence) → ok', () => {
  const { ok } = scanForUnsourcedClaims('VERIFIED by running `npm test`.');
  assert.equal(ok, true);
});

test('scanner: claim + adjacent file path (evidence) → ok', () => {
  const { ok } = scanForUnsourcedClaims('VERIFIED: see tests/codex-bridge/expert-turn.test.js for the assertion.');
  assert.equal(ok, true);
});

test('scanner: claim + adjacent caveat marker (ASSUMED) → ok', () => {
  const { ok } = scanForUnsourcedClaims('shipped (ASSUMED based on prior session, not re-checked).');
  assert.equal(ok, true);
});

test('scanner: claim inside fenced code block → ignored', () => {
  const { ok } = scanForUnsourcedClaims([
    'Here is a code block:',
    '```',
    'echo VERIFIED',
    '```',
    'No claims outside.',
  ].join('\n'));
  assert.equal(ok, true);
});

test('scanner: claim inside Codex verdict block → ignored', () => {
  const { ok } = scanForUnsourcedClaims([
    'Codex verdict follows:',
    '<<<VERDICT>>>',
    'status: PASS',
    'rationale: looks good',
    '<<<END>>>',
    'Carry on.',
  ].join('\n'));
  assert.equal(ok, true);
});

test('scanner: claim inside ## Machine Result section → ignored', () => {
  const { ok } = scanForUnsourcedClaims([
    'Reviewing.',
    '',
    '## Machine Result',
    '```json',
    '{"status": "SHIPPED"}',
    '```',
    '',
    '## Findings',
    'All clear.',
  ].join('\n'));
  assert.equal(ok, true);
});

test('scanner: claim inside blockquote → ignored', () => {
  const { ok } = scanForUnsourcedClaims([
    'The user said:',
    '> we already VERIFIED this last week',
    'I will check now.',
  ].join('\n'));
  assert.equal(ok, true);
});

test('scanner: multiple claims, some with evidence and some without → fails on the unsourced ones', () => {
  const text = [
    'Two paragraphs, two claims.',
    '',
    'VERIFIED with `node --test`.',
    '',
    'Also TAGGED.', // no evidence here
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  assert.equal(ok, false);
  // VERIFIED in para 2 has evidence; TAGGED in para 3 does not.
  const ver = matches.find((m) => m.word === 'VERIFIED');
  const tag = matches.find((m) => m.word === 'TAGGED');
  assert.ok(ver && ver.hasEvidence === true, 'VERIFIED should be sourced');
  assert.ok(tag && tag.hasEvidence === false, 'TAGGED should be unsourced');
});

test('scanner: evidence proximity is paragraph-bounded', () => {
  // Evidence in paragraph 1, claim in paragraph 2 — should NOT count.
  const text = [
    'Backticks here: `npm test`.',
    '',
    'And separately VERIFIED.',
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  assert.equal(ok, false);
  assert.ok(matches.some((m) => m.word === 'VERIFIED' && !m.hasEvidence));
});

test('scanner: empty input → ok', () => {
  assert.deepEqual(scanForUnsourcedClaims(''), { ok: true, matches: [] });
  assert.deepEqual(scanForUnsourcedClaims(null), { ok: true, matches: [] });
});

// ── v0.8.1 round-1 review fixes ───────────────────────────────────────────

test('scanner: PASS-THROUGH and similar hyphenated compounds do NOT trigger PASS match', () => {
  // Codex round-1 review caught: `\bPASS\b` matches before `-` because `\b`
  // is a word boundary. The fix uses `(?![-\w])` to reject hyphenated/word-
  // continued compounds. Pin the contract here.
  const { ok, matches } = scanForUnsourcedClaims(
    'We implemented PASS-THROUGH semantics in the new SHIPPED_BY field.',
  );
  assert.equal(ok, true, `expected ok, got matches=${JSON.stringify(matches)}`);
});

test('scanner: standalone PASS still fires when unsourced', () => {
  const { ok } = scanForUnsourcedClaims('Final answer: PASS.');
  assert.equal(ok, false);
});

test('scanner: bare "ran into a problem" does NOT count as evidence for an unsourced claim', () => {
  // Codex round-1 review caught: `\bran\b` is too weak — it lets "I ran into
  // a problem" salvage a "VERIFIED" claim. Tighten to require command-shaped
  // context after "ran".
  const { ok, matches } = scanForUnsourcedClaims(
    'I ran into a problem, but the result is VERIFIED.',
  );
  assert.equal(ok, false, 'unsourced VERIFIED should still fire despite bare "ran"');
  assert.ok(matches.some((m) => m.word === 'VERIFIED' && !m.hasEvidence));
});

test('scanner: "ran `npm test`" still counts as evidence', () => {
  // The narrowed "ran" marker still accepts genuinely command-shaped uses.
  const { ok } = scanForUnsourcedClaims('VERIFIED: I ran `npm test` and it exited 0.');
  assert.equal(ok, true);
});

test('scanner: "ran node script.js" counts as evidence (tool-name adjacent)', () => {
  const { ok } = scanForUnsourcedClaims('VERIFIED — I ran node bin/check.js.');
  assert.equal(ok, true);
});

test('scanner (codex round-2): vague "ran the full suite" does NOT count as evidence', () => {
  // Codex round-2 critique: prior commit allowed `ran\s+the\s+` and
  // `ran\s+all\s+` as evidence, which let "VERIFIED: I ran the full suite"
  // through without a command, output, or caveat. Pin the contract.
  const { ok, matches } = scanForUnsourcedClaims(
    'VERIFIED: I ran the full suite.',
  );
  assert.equal(ok, false, 'vague "ran the full suite" must not source the VERIFIED claim');
  assert.ok(matches.some((m) => m.word === 'VERIFIED' && !m.hasEvidence));
});

test('scanner (codex round-2): vague "ran all the tests" does NOT count as evidence', () => {
  const { ok } = scanForUnsourcedClaims('VERIFIED — I ran all the tests.');
  assert.equal(ok, false);
});

test('scanner (codex round-2): backtick-cited "ran" form still passes', () => {
  // Regression guard: tightening must not break the legit form.
  const { ok } = scanForUnsourcedClaims(
    'VERIFIED: ran `node --test tests/codex-bridge/*.test.js` and it exited 0.',
  );
  assert.equal(ok, true);
});

// ── v0.8.1.1 unterminated code block (edge-case #1) ──────────────────────

test('scanner v0.8.1.1: unterminated fenced code block — content inside is stripped', () => {
  // Codex truncates mid-response; the lazy `[\s\S]*?` regex from v0.8.1
  // would NOT strip an opener-without-closer, leaving claim words inside
  // the block exposed to the scanner. The two-step strip closes this hole.
  const text = [
    'before VERIFIED with `node --test`',
    '',
    '```bash',
    'echo SHIPPED_FROM_INSIDE',
    'echo TAGGED_FROM_INSIDE',
    // intentionally no closing ```
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  // The VERIFIED outside the block IS sourced (adjacent backticks + tool ref).
  assert.equal(ok, true, `expected ok (only sourced VERIFIED present); got matches=${JSON.stringify(matches)}`);
  // Confirm claim words inside the unterminated block were stripped (no matches at all).
  assert.ok(
    !matches.some((m) => m.word === 'SHIPPED'),
    'SHIPPED inside unterminated code block must be stripped',
  );
  assert.ok(
    !matches.some((m) => m.word === 'TAGGED'),
    'TAGGED inside unterminated code block must be stripped',
  );
});

test('scanner v0.8.1.1: unterminated block followed by would-fire claim — still strips block', () => {
  // Even more adversarial: unterminated block contains a claim, then NO
  // other content. The regex `[\s\S]*$` swallows to EOF. Test asserts
  // nothing matches.
  const text = '```\nVERIFIED inside only\n';
  const { ok } = scanForUnsourcedClaims(text);
  assert.equal(ok, true, 'no claims outside unterminated block → ok');
});

test('scanner v0.8.1.1: closed block + unterminated block in same text', () => {
  const text = [
    '```',
    'echo INSIDE_CLOSED', // closed block — already stripped by step 1
    '```',
    '',
    'middle prose with VERIFIED, sourced by `node --test`.',
    '',
    '```',
    'echo INSIDE_UNTERMINATED PASSED', // unterminated — stripped by step 1b
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  assert.equal(ok, true);
  assert.ok(!matches.some((m) => m.word === 'PASSED'), 'PASSED in unterminated block must be stripped');
});

// ── decideStop ────────────────────────────────────────────────────────────

test('decideStop: marker inactive → exit 0 regardless of content', () => {
  const res = decideStop('We are VERIFIED.', { active: false });
  assert.equal(res.exit, 0);
});

test('decideStop: active marker + clean content → exit 0', () => {
  const res = decideStop('Just some prose.', { active: true, marker: { skillName: 'autopilot', expiresAt: 'future' } });
  assert.equal(res.exit, 0);
});

test('decideStop: active marker + unsourced claim → exit 2 with message', () => {
  const res = decideStop('VERIFIED.', { active: true, marker: { skillName: 'autopilot', expiresAt: 'future' } });
  assert.equal(res.exit, 2);
  assert.match(res.message, /unsourced claims/i);
  assert.match(res.message, /VERIFIED/);
  assert.match(res.message, /honest-reporting-active/);
});

// ── decidePreToolUse ──────────────────────────────────────────────────────

test('decidePreToolUse: marker inactive → exit 0', () => {
  const res = decidePreToolUse('Bash', { command: 'git push' }, ['VERIFIED.'], { active: false });
  assert.equal(res.exit, 0);
});

test('decidePreToolUse: non-Bash tool → exit 0', () => {
  const res = decidePreToolUse('Edit', { command: 'whatever' }, ['VERIFIED.'], { active: true, marker: {} });
  assert.equal(res.exit, 0);
});

test('decidePreToolUse: Bash with non-blocklisted command → exit 0 even with unsourced claims', () => {
  const res = decidePreToolUse('Bash', { command: 'ls' }, ['VERIFIED.'], { active: true, marker: {} });
  assert.equal(res.exit, 0);
});

test('decidePreToolUse: Bash git tag with unsourced claim → exit 2', () => {
  const res = decidePreToolUse(
    'Bash',
    { command: 'git tag v1.0.0' },
    ['VERIFIED.'],
    { active: true, marker: { skillName: 'autopilot' } },
  );
  assert.equal(res.exit, 2);
  assert.match(res.message, /git tag v1\.0\.0/);
  assert.match(res.message, /VERIFIED/);
});

test('decidePreToolUse: Bash git push with sourced claim → exit 0', () => {
  const res = decidePreToolUse(
    'Bash',
    { command: 'git push origin main' },
    ['VERIFIED by `node --test` exit 0.'],
    { active: true, marker: {} },
  );
  assert.equal(res.exit, 0);
});

test('decidePreToolUse: gh release create blocked when claims unsourced', () => {
  const res = decidePreToolUse(
    'Bash',
    { command: 'gh release create v1.0.0' },
    ['SHIPPED.'],
    { active: true, marker: {} },
  );
  assert.equal(res.exit, 2);
});

test('decidePreToolUse: npm publish blocked when claims unsourced', () => {
  const res = decidePreToolUse(
    'Bash',
    { command: 'npm publish' },
    ['Tests passed.'],
    { active: true, marker: {} },
  );
  assert.equal(res.exit, 2);
});

// ── Marker helpers ────────────────────────────────────────────────────────

test('writeMarker + readMarker round-trip with expiresAt', () => {
  const dir = makeTmpRepo();
  const now = '2026-05-11T14:00:00.000Z';
  const { path, marker } = writeMarker(dir, { skillName: 'autopilot', now, ttlHours: 8, specPath: '/x/spec.md' });
  assert.ok(path.endsWith('honest-reporting-active.json'));
  assert.equal(marker.skillName, 'autopilot');
  assert.equal(marker.sessionStartedAt, now);
  assert.equal(marker.expiresAt, '2026-05-11T22:00:00.000Z');
  assert.equal(marker.specPath, '/x/spec.md');
  const read = readMarker(dir);
  assert.deepEqual(read, marker);
  rmSync(dir, { recursive: true, force: true });
});

test('readMarker: returns null when file absent', () => {
  const dir = makeTmpRepo();
  assert.equal(readMarker(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('readMarker: returns null when file malformed', () => {
  const dir = makeTmpRepo();
  const p = markerPath(dir);
  mkdirSync(join(dir, '.codex-paired'), { recursive: true });
  writeFileSync(p, '{ this is not json');
  assert.equal(readMarker(dir), null);
  rmSync(dir, { recursive: true, force: true });
});

test('isActive: returns active=true within TTL', () => {
  const dir = makeTmpRepo();
  const now = new Date('2026-05-11T14:00:00.000Z');
  writeMarker(dir, { skillName: 'autopilot', now: now.toISOString(), ttlHours: 8 });
  // Check 1 hour later — still within TTL.
  const check = new Date('2026-05-11T15:00:00.000Z');
  const result = isActive(dir, check);
  assert.equal(result.active, true);
  assert.equal(result.reason, 'active');
  rmSync(dir, { recursive: true, force: true });
});

test('isActive: returns active=false after expiresAt', () => {
  const dir = makeTmpRepo();
  const now = new Date('2026-05-11T14:00:00.000Z');
  writeMarker(dir, { skillName: 'autopilot', now: now.toISOString(), ttlHours: 1 });
  // Check 2 hours later — past TTL.
  const check = new Date('2026-05-11T16:00:00.000Z');
  const result = isActive(dir, check);
  assert.equal(result.active, false);
  assert.equal(result.reason, 'expired');
  rmSync(dir, { recursive: true, force: true });
});

test('isActive: returns active=false when marker absent', () => {
  const dir = makeTmpRepo();
  const result = isActive(dir, new Date());
  assert.equal(result.active, false);
  assert.equal(result.reason, 'marker-absent-or-malformed');
  rmSync(dir, { recursive: true, force: true });
});

test('isActive: returns active=false when expiresAt missing/unparseable', () => {
  const dir = makeTmpRepo();
  mkdirSync(join(dir, '.codex-paired'), { recursive: true });
  writeFileSync(markerPath(dir), JSON.stringify({ skillName: 'autopilot' }));
  let result = isActive(dir, new Date());
  assert.equal(result.active, false);
  assert.equal(result.reason, 'expiresAt-missing-or-invalid');
  // Now an unparseable date.
  writeFileSync(markerPath(dir), JSON.stringify({ skillName: 'autopilot', expiresAt: 'not-a-date' }));
  result = isActive(dir, new Date());
  assert.equal(result.active, false);
  assert.equal(result.reason, 'expiresAt-unparseable');
  rmSync(dir, { recursive: true, force: true });
});

// ── readLastAssistantTurn ────────────────────────────────────────────────

test('readLastAssistantTurn: extracts text from last assistant message', () => {
  const dir = makeTmpRepo();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'First reply.' },
          { type: 'tool_use', name: 'Bash' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: 'another' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Last reply, has VERIFIED.' },
        ],
      },
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n'));
  const text = readLastAssistantTurn(transcriptPath);
  assert.match(text, /Last reply/);
  assert.match(text, /VERIFIED/);
  rmSync(dir, { recursive: true, force: true });
});

test('readLastAssistantTurn: missing transcript → empty string', () => {
  assert.equal(readLastAssistantTurn('/nonexistent/path'), '');
  assert.equal(readLastAssistantTurn(''), '');
});

test('readLastNAssistantTurns: returns N most recent in chronological order', () => {
  const dir = makeTmpRepo();
  const transcriptPath = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'three' }] } }),
  ];
  writeFileSync(transcriptPath, lines.join('\n'));
  const got = readLastNAssistantTurns(transcriptPath, 2);
  assert.deepEqual(got, ['two', 'three']);
  rmSync(dir, { recursive: true, force: true });
});

// ── mainWithStdin ─────────────────────────────────────────────────────────

test('mainWithStdin: marker absent → exit 0 (fail-open)', async () => {
  const dir = makeTmpRepo();
  // No marker written.
  const result = await mainWithStdin('stop', JSON.stringify({ cwd: dir, transcript_path: '' }));
  assert.equal(result.exit, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('mainWithStdin: malformed JSON stdin → exit 0', async () => {
  const result = await mainWithStdin('stop', 'not json');
  assert.equal(result.exit, 0);
});

test('mainWithStdin: marker active, clean turn → exit 0', async () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Just normal prose.' }] },
  }));
  const result = await mainWithStdin('stop', JSON.stringify({ cwd: dir, transcript_path: transcriptPath }));
  assert.equal(result.exit, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('mainWithStdin: marker active, unsourced claim → exit 2 with message', async () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'All VERIFIED.' }] },
  }));
  const result = await mainWithStdin('stop', JSON.stringify({ cwd: dir, transcript_path: transcriptPath }));
  assert.equal(result.exit, 2);
  assert.match(result.message, /VERIFIED/);
  rmSync(dir, { recursive: true, force: true });
});

test('mainWithStdin pretooluse: git push + active + unsourced → exit 2', async () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Tests passed.' }] },
  }));
  const result = await mainWithStdin('pretooluse', JSON.stringify({
    cwd: dir,
    transcript_path: transcriptPath,
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  }));
  assert.equal(result.exit, 2);
  rmSync(dir, { recursive: true, force: true });
});

test('mainWithStdin pretooluse: ls command never blocked', async () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'All VERIFIED.' }] },
  }));
  const result = await mainWithStdin('pretooluse', JSON.stringify({
    cwd: dir,
    transcript_path: transcriptPath,
    tool_name: 'Bash',
    tool_input: { command: 'ls -la' },
  }));
  assert.equal(result.exit, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── Bash wrapper fail-open contract (v0.8.1 round-1 fix) ─────────────────
//
// Codex round-1 review caught: the wrapper's `exec node` propagated all
// node failure modes (missing module, syntax error, runtime exception) as
// nonzero exits with raw stderr. The fail-open contract requires exit 0
// for any infrastructure error — only exit 2 with a captured block-message
// reaches Claude.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename__ = fileURLToPath(import.meta.url);
const __dirname__ = dirname(__filename__);
const WRAPPER_PATH = join(__dirname__, '..', '..', 'hooks', 'honest-reporting.sh');

test('bash wrapper: exits 0 when NODE_MODULE missing (fail-open)', () => {
  // Point the wrapper at a non-existent CLAUDE_PLUGIN_ROOT so NODE_MODULE
  // resolves to a missing path. Wrapper must exit 0 with empty stderr.
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: '/nonexistent/plugin/root' };
  delete env.CPS_HONEST_REPORTING_DEBUG;
  const result = spawnSync('bash', [WRAPPER_PATH, 'stop'], {
    input: '{}', // empty hook stdin
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `expected exit 0 (fail-open), got ${result.status}`);
  assert.equal(result.stderr, '', `expected empty stderr (no leak), got: ${result.stderr}`);
});

test('bash wrapper: exits 0 with empty stderr when marker absent (no block)', () => {
  const dir = makeTmpRepo();
  // No marker written; wrapper should fail-open silently.
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: join(__dirname__, '..', '..') };
  delete env.CPS_HONEST_REPORTING_DEBUG;
  const stdin = JSON.stringify({ cwd: dir, transcript_path: '/nonexistent' });
  const result = spawnSync('bash', [WRAPPER_PATH, 'stop'], {
    input: stdin,
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: stderr=${result.stderr}`);
  assert.equal(result.stderr, '');
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.8.1.1 mktemp failure → fail-open (edge-case #2) ──────────────────

test('bash wrapper v0.8.1.1: exits 0 when mktemp fails (TMPDIR unwritable)', () => {
  // Force mktemp to fail by pointing TMPDIR at a non-existent directory.
  // The wrapper's `mktemp ... 2>/dev/null || exit 0` must catch this and
  // fail-open silently rather than crashing on `2>""`.
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: join(__dirname__, '..', '..'),
    TMPDIR: '/nonexistent-dir-for-mktemp-failure-test-cps081-' + Date.now(),
  };
  delete env.CPS_HONEST_REPORTING_DEBUG;
  const result = spawnSync('bash', [WRAPPER_PATH, 'stop'], {
    input: '{}',
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `expected exit 0 (fail-open on mktemp failure), got ${result.status}; stderr=${result.stderr}`);
  assert.equal(result.stderr, '', 'no stderr leak on mktemp failure');
});
