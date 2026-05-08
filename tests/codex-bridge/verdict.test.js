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
