// v0.8.1 — tests for the honest-reporting Stop/PreToolUse hook scanner.
//
// Pure function tests: scanForUnsourcedClaims, decideStop, decidePreToolUse.
// Marker tests: writeMarker / readMarker / isActive with mocked filesystem
// (via tmpdir). Hook entry-point tests use mainWithStdin with deps overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
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
  clearMarker,
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

test('scanner v0.15.0: evidence anywhere in the message clears all claims', () => {
  // The old "same paragraph ±200 chars" window blocked the most common
  // honest shape — a citation paragraph followed by a summary paragraph.
  // Transcript replay (47 blocks, 8 sessions) showed the majority of fires
  // were on already-cited messages. Message-wide evidence is the contract.
  const text = [
    'Two paragraphs, two claims.',
    '',
    'VERIFIED with `node --test`.',
    '',
    'Also TAGGED.', // no evidence in THIS paragraph — but the message is cited
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  assert.equal(ok, true, `expected ok, got matches=${JSON.stringify(matches)}`);
});

test('scanner v0.15.0: evidence in an earlier paragraph counts for a later claim', () => {
  const text = [
    'Backticks here: `npm test`.',
    '',
    'And separately VERIFIED.',
  ].join('\n');
  const { ok } = scanForUnsourcedClaims(text);
  assert.equal(ok, true);
});

test('scanner v0.15.0: message with claims and NO evidence anywhere still blocks', () => {
  const text = [
    'Everything is wrapped up.',
    '',
    'The feature is VERIFIED and the release SHIPPED.',
  ].join('\n');
  const { ok, matches } = scanForUnsourcedClaims(text);
  assert.equal(ok, false);
  assert.ok(matches.some((m) => m.word === 'VERIFIED' && !m.hasEvidence));
  assert.ok(matches.some((m) => m.word === 'SHIPPED' && !m.hasEvidence));
});

test('scanner: empty input → ok', () => {
  assert.deepEqual(scanForUnsourcedClaims(''), { ok: true, matches: [] });
  assert.deepEqual(scanForUnsourcedClaims(null), { ok: true, matches: [] });
});

// ── v0.15.0 false-positive surgery ────────────────────────────────────────

test('scanner v0.15.0: quoted single-word mention "shipped" is a meta-mention, not a claim', () => {
  // The observed re-block loop: the hook flags "shipped", Claude's rewrite
  // says it is removing the word "shipped", and the quoted mention
  // re-triggers the hook — up to 3 consecutive blocks in the transcripts.
  const { ok, matches } = scanForUnsourcedClaims(
    'Rewriting the summary without the word "shipped" since I did not source it.',
  );
  assert.equal(ok, true, `expected ok, got matches=${JSON.stringify(matches)}`);
});

test('scanner v0.15.0: smart-quoted mention “shipped” is also stripped', () => {
  const { ok } = scanForUnsourcedClaims('Dropping the term “shipped” from the wrap-up.');
  assert.equal(ok, true);
});

test('scanner v0.15.0: quoted short phrase "tests pass" is stripped (hook-feedback echo)', () => {
  const { ok } = scanForUnsourcedClaims(
    'The hook flagged "tests pass" so I am restating the result with its source.',
  );
  assert.equal(ok, true);
});

test('scanner v0.15.0: long quoted sentence containing a claim still fires', () => {
  // Quotes only shield SHORT mentions (≤3 words, ≤40 chars). A full quoted
  // sentence is substantive text and must still be scanned.
  const { ok } = scanForUnsourcedClaims(
    'As I said before, "the whole epic is built and SHIPPED to production today" and that is final.',
  );
  assert.equal(ok, false);
});

test('scanner v0.15.0: lowercase confirmed/installed/released no longer fire', () => {
  const { ok, matches } = scanForUnsourcedClaims(
    'The user confirmed the choice. Node is installed by default. React 18 was released in 2022.',
  );
  assert.equal(ok, true, `expected ok, got matches=${JSON.stringify(matches)}`);
});

test('scanner v0.15.0: caps CONFIRMED still fires without evidence', () => {
  const { ok, matches } = scanForUnsourcedClaims('Status: CONFIRMED.');
  assert.equal(ok, false);
  assert.ok(matches.some((m) => m.word === 'CONFIRMED' && !m.hasEvidence));
});

test('scanner v0.15.0: lowercase shipped/deployed still fire without evidence', () => {
  const { ok } = scanForUnsourcedClaims('The epic is now built, reviewed, and shipped.');
  assert.equal(ok, false);
  const { ok: ok2 } = scanForUnsourcedClaims('Everything was deployed this morning.');
  assert.equal(ok2, false);
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

// ── v0.15.0 marker lifecycle ──────────────────────────────────────────────

test('clearMarker removes an existing marker and is idempotent', () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  assert.equal(isActive(dir).active, true);
  const first = clearMarker(dir);
  assert.equal(first.cleared, true);
  assert.equal(isActive(dir).active, false);
  const second = clearMarker(dir);
  assert.equal(second.cleared, false); // no-op, no throw
  rmSync(dir, { recursive: true, force: true });
});

test('markerPath: non-repo path under .git-worktrees walks up to the main root', () => {
  // Implementer subagents run from <repo>/.git-worktrees/slice-N. The hook
  // must police them against the main repo's marker — previously the
  // worktree root resolved to a marker-less path and silently deactivated
  // enforcement exactly where it mattered most. This case exercises the
  // walk-up on the git-free fallback path (rev-parse fails → startDir).
  const dir = mkdtempSync(join(tmpdir(), 'cps-honest-wt-'));
  const worktree = join(dir, '.git-worktrees', 'slice-3');
  mkdirSync(worktree, { recursive: true });
  const p = markerPath(worktree);
  assert.equal(p, join(dir, '.codex-paired', 'honest-reporting-active.json'));
  rmSync(dir, { recursive: true, force: true });
});

test('markerPath: a real git slice worktree resolves to the MAIN repo marker', () => {
  // End-to-end: a genuine `git worktree add` under .git-worktrees/slice-N.
  // rev-parse from inside returns the WORKTREE toplevel; the walk-up must
  // land on the main repo root.
  const dir = makeTmpRepo();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test',
  };
  const commit = spawnSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, env, timeout: 10000 });
  const worktree = join(dir, '.git-worktrees', 'slice-7');
  const add = spawnSync('git', ['worktree', 'add', '--detach', worktree], { cwd: dir, env, timeout: 10000 });
  if (commit.status !== 0 || add.status !== 0) {
    // git unavailable or worktree unsupported in this environment — the
    // fallback-path test above still pins the walk-up contract.
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const p = markerPath(worktree);
  const realDir = realpathSync(dir);
  assert.equal(p, join(realDir, '.codex-paired', 'honest-reporting-active.json'));
  rmSync(dir, { recursive: true, force: true });
});

test('cli honest-reporting-clear: clears the marker and reports the path', () => {
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'writing-plans' });
  const CLI = join(__dirname__, '..', '..', 'lib', 'codex-bridge', 'cli.js');
  const r = spawnSync('node', [CLI, 'honest-reporting-clear', '--cwd', dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.cleared, true);
  assert.equal(isActive(dir).active, false);
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

test('mainWithStdin v0.15.0: stop_hook_active=true → exit 0 even with unsourced claims (loop guard)', async () => {
  // Claude Code sets stop_hook_active when the turn is already a Stop-hook
  // continuation. Blocking again risks an un-exitable loop while the user
  // is away (autopilot). One block per stop, then pass.
  const dir = makeTmpRepo();
  writeMarker(dir, { skillName: 'autopilot' });
  const transcriptPath = join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'All VERIFIED.' }] },
  }));
  const result = await mainWithStdin('stop', JSON.stringify({
    cwd: dir,
    transcript_path: transcriptPath,
    stop_hook_active: true,
  }));
  assert.equal(result.exit, 0);
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
