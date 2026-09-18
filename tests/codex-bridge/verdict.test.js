import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../../lib/codex-bridge/verdict.js';

test('parses SHIP verdict', () => {
  const text = `prose...
<<<VERDICT>>>
status: SHIP
critique: []
rationale: looks good
<<<END>>>`;
  const v = parseVerdict(text);
  assert.equal(v.status, 'SHIP');
  assert.deepEqual(v.critique, []);
  assert.equal(v.rationale, 'looks good');
});

test('parses REVISE verdict with bullet critique', () => {
  const text = `<<<VERDICT>>>
status: REVISE
critique:
  - missing error handling on line 42
  - test for empty input is wrong
rationale: fix above before ship
<<<END>>>`;
  const v = parseVerdict(text);
  assert.equal(v.status, 'REVISE');
  assert.equal(v.critique.length, 2);
  assert.match(v.critique[0], /missing error handling/);
});

test('returns synthetic REVISE on missing block', () => {
  const v = parseVerdict('no verdict here');
  assert.equal(v.status, 'REVISE');
  assert.match(v.critique[0], /verdict block missing/i);
});

test('returns synthetic REVISE on malformed block', () => {
  const v = parseVerdict('<<<VERDICT>>>\nstatus: WAT\n<<<END>>>');
  assert.equal(v.status, 'REVISE');
  assert.match(v.critique[0], /malformed/i);
});

// ── v0.18.1: deferred parsing, and no truncation after a wrapped line ─────────
// parseCritique was generalised into parseListField so `deferred:` could survive parsing. The first
// attempt terminated on any non-bullet line, which silently dropped every finding after a wrapped
// one — the way most real findings are written. These pin the behaviour in both directions.

test('a wrapped continuation line does not truncate the list that follows it', () => {
  const v = parseVerdict([
    '<<<VERDICT>>>', 'status: REVISE', 'critique:',
    '  - First finding', '    wrapped explanation of the first finding', '  - Second blocking finding',
    'rationale: r', '<<<END>>>',
  ].join('\n'));
  assert.deepEqual(v.critique, ['First finding', 'Second blocking finding']);
});

test('deferred findings parse, stop at the next field, and tolerate wrapping', () => {
  const v = parseVerdict([
    '<<<VERDICT>>>', 'status: SHIP', 'critique:',
    '  - rubric.test-results: tier: critical - 12 pass',
    'deferred:', '  - narrower type', '    would be nicer but nothing depends on it', '  - one more case',
    'rationale: fine', '<<<END>>>',
  ].join('\n'));
  assert.deepEqual(v.critique, ['rubric.test-results: tier: critical - 12 pass']);
  assert.deepEqual(v.deferred, ['narrower type', 'one more case']);
  assert.equal(v.rationale, 'fine');
});

test('deferred is [] when absent or inline-empty, and never swallows rationale', () => {
  const absent = parseVerdict('<<<VERDICT>>>\nstatus: SHIP\ncritique:\n  - a\nrationale: r\n<<<END>>>');
  assert.deepEqual(absent.deferred, []);
  assert.equal(absent.rationale, 'r');
  const inline = parseVerdict('<<<VERDICT>>>\nstatus: SHIP\ncritique:\n  - a\ndeferred: []\nrationale: r\n<<<END>>>');
  assert.deepEqual(inline.deferred, []);
});

test('a long deferred list is preserved in full', () => {
  const items = Array.from({ length: 25 }, (_, i) => `  - deferred item ${i + 1}`);
  const v = parseVerdict(['<<<VERDICT>>>', 'status: SHIP', 'critique:', '  - rubric.x: tier: standard - ok',
    'deferred:', ...items, 'rationale: r', '<<<END>>>'].join('\n'));
  assert.equal(v.deferred.length, 25);
  assert.equal(v.deferred[24], 'deferred item 25');
});
