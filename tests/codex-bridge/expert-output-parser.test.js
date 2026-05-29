// Tests for v0.8.0 expert-output-parser — strict JSON-block parser for expert
// turn output. The expert response is free-form Markdown with one fenced JSON
// block inside a `## Machine Result` section.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseExpertOutput,
  buildRepairPrompt,
} from '../../lib/codex-bridge/expert-output-parser.js';
import {
  parseReviewerOutput,
  buildRepairPrompt as reviewerBuildRepairPrompt,
} from '../../lib/codex-bridge/reviewer-output-parser.js';

// Plan 3 one-window contract: the expert-* shim re-exports the identical
// reviewer-* references.
test('expert-output-parser shim === reviewer-output-parser canonical', () => {
  assert.equal(parseExpertOutput, parseReviewerOutput);
  assert.equal(buildRepairPrompt, reviewerBuildRepairPrompt);
});

function validPayload(overrides = {}) {
  return {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: [],
    questions_for_orchestrator: [],
    ...overrides,
  };
}

function wrapMachineResult(jsonText, prefix = '', suffix = '') {
  return [
    prefix,
    '## Machine Result',
    '',
    '```json',
    jsonText,
    '```',
    suffix,
  ].join('\n');
}

// Test 1: Valid path
test('parseExpertOutput: valid complete payload returns ok', () => {
  const payload = validPayload();
  const raw = wrapMachineResult(JSON.stringify(payload, null, 2));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, payload);
  assert.equal(result.warnings, undefined);
});

// Test 2: Extra Markdown sections are ignored
test('parseExpertOutput: ignores extra Markdown sections', () => {
  const payload = validPayload();
  const raw = [
    '## Findings',
    'Some free-form findings prose here.',
    '',
    '## Notes',
    '- bullet one',
    '- bullet two',
    '',
    '## Machine Result',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    '## Trailing section',
    'More prose.',
  ].join('\n');
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, payload);
});

// Test 3: Section order independence — Machine Result first
test('parseExpertOutput: Machine Result appearing before other sections still parses', () => {
  const payload = validPayload();
  const raw = [
    '## Machine Result',
    '',
    '```json',
    JSON.stringify(payload),
    '```',
    '',
    '## Findings',
    'Findings come after.',
  ].join('\n');
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, payload);
});

// Test 4: Missing machine block
test('parseExpertOutput: returns missing-machine-block when no heading', () => {
  const raw = [
    '## Findings',
    'Some findings.',
    '',
    '## Notes',
    'No machine block here.',
  ].join('\n');
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-machine-block');
});

// Test 5: Invalid JSON in block
test('parseExpertOutput: invalid JSON returns invalid-json with rawBlock', () => {
  const rawBlockText = '{ this is not: valid json, ';
  const raw = wrapMachineResult(rawBlockText);
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-json');
  assert.equal(result.rawBlock, rawBlockText);
});

// Test 6: Schema violation — required field missing
test('parseExpertOutput: missing required field returns schema-violation', () => {
  const payload = validPayload();
  delete payload.expert_id;
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(Array.isArray(result.missingFields));
  assert.ok(result.missingFields.includes('expert_id'));
});

test('parseExpertOutput: missing scope field returns schema-violation', () => {
  const payload = validPayload();
  delete payload.scope;
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('scope'));
});

// Test 7: Wrong expert_id
test('parseExpertOutput: expert_id mismatch returns expert-id-mismatch', () => {
  const payload = validPayload({ expert_id: 'expert-ux' });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expert-id-mismatch');
  assert.equal(result.got, 'expert-ux');
  assert.equal(result.expected, 'expert-ui');
});

// Test 8: Wrong phase
test('parseExpertOutput: phase mismatch returns phase-mismatch', () => {
  const payload = validPayload({ phase: 'post-implementation-review' });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'phase-mismatch');
  assert.equal(result.got, 'post-implementation-review');
  assert.equal(result.expected, 'spec-review');
});

// Test 9: Status enum
test('parseExpertOutput: SHIP and REVISE statuses both pass; arbitrary status fails', () => {
  for (const status of ['SHIP', 'REVISE']) {
    const payload = validPayload({ status });
    const raw = wrapMachineResult(JSON.stringify(payload));
    const result = parseExpertOutput(raw, {
      expectedExpertId: 'expert-ui',
      expectedPhase: 'spec-review',
    });
    assert.equal(result.ok, true, `status=${status} should pass`);
  }
  const bad = validPayload({ status: 'OOPS' });
  const raw = wrapMachineResult(JSON.stringify(bad));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-status');
  assert.equal(result.got, 'OOPS');
});

// Test 10a: Required arrays — empty arrays valid
test('parseExpertOutput: empty arrays for findings/messages are valid', () => {
  const payload = validPayload({
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true);
});

// Test 10b: Required arrays — non-array (null) triggers schema-violation
test('parseExpertOutput: non-array (null) for findings triggers schema-violation', () => {
  const payload = validPayload({ blocking_findings: null });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('blocking_findings'));
});

// Test 10c: Required arrays — non-array (object) triggers schema-violation
test('parseExpertOutput: non-array (object) for peer_messages_requested triggers schema-violation', () => {
  const payload = validPayload({ peer_messages_requested: { x: 1 } });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('peer_messages_requested'));
});

// Test 10d: Required arrays — non-array (string) triggers schema-violation
test('parseExpertOutput: non-array (string) for questions_for_orchestrator triggers schema-violation', () => {
  const payload = validPayload({ questions_for_orchestrator: 'nope' });
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('questions_for_orchestrator'));
});

// Test 11: Multiple machine blocks
test('parseExpertOutput: multiple machine blocks — first wins, warning included', () => {
  const first = validPayload({ scope: 'first-block' });
  const second = validPayload({ scope: 'second-block' });
  const raw = [
    '## Machine Result',
    '',
    '```json',
    JSON.stringify(first),
    '```',
    '',
    '## Other prose',
    'some text',
    '',
    '## Machine Result',
    '',
    '```json',
    JSON.stringify(second),
    '```',
  ].join('\n');
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.scope, 'first-block');
  assert.deepEqual(result.warnings, ['multiple-machine-blocks']);
});

// Test 12: buildRepairPrompt
test('buildRepairPrompt: contains raw output, reason, expected id/phase, and instructions', () => {
  const rawOutput = '## Findings\nSome broken output.\n## Machine Result\n```json\n{bad json}\n```';
  const prompt = buildRepairPrompt({
    rawOutput,
    reason: 'invalid-json',
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(typeof prompt, 'string');
  // Raw output verbatim
  assert.ok(prompt.includes(rawOutput), 'should include raw output verbatim');
  // Specific failure reason
  assert.ok(prompt.includes('invalid-json'), 'should include failure reason');
  // Expected expert_id and phase
  assert.ok(prompt.includes('expert-ui'), 'should include expected expert_id');
  assert.ok(prompt.includes('spec-review'), 'should include expected phase');
  // Instruction to re-emit Machine Result block with required schema
  assert.ok(
    /Machine Result/.test(prompt),
    'should mention Machine Result block',
  );
  // Reminder that surrounding Markdown can be free-form
  assert.ok(
    /free-form/i.test(prompt),
    'should remind that surrounding Markdown can be free-form',
  );
});

// ── Non-object JSON guard (round-1 codex critique) ────────────────────────
//
// JSON.parse accepts primitives and arrays. Without an explicit object
// guard, the schema loop's `f in parsed` would throw TypeError on null /
// primitives, escaping the parser instead of returning schema-violation.

test('parser handles JSON null without throwing (returns schema-violation)', () => {
  const result = parseExpertOutput(
    '## Machine Result\n\n```json\nnull\n```',
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(/null/i.test(result.detail), 'detail should mention got=null');
});

test('parser handles JSON primitives (42, "str", true) without throwing', () => {
  for (const payload of ['42', '"hello"', 'true', 'false']) {
    const result = parseExpertOutput(
      `## Machine Result\n\n\`\`\`json\n${payload}\n\`\`\``,
      {}
    );
    assert.equal(result.ok, false, `payload=${payload}: expected ok=false`);
    assert.equal(
      result.reason,
      'schema-violation',
      `payload=${payload}: expected schema-violation reason`
    );
  }
});

test('parser handles JSON array (not object) without throwing', () => {
  const result = parseExpertOutput(
    '## Machine Result\n\n```json\n[1, 2, 3]\n```',
    {}
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(/array/i.test(result.detail), 'detail should mention got=array');
});

// ── v0.8.1 legacy field back-compat ───────────────────────────────────────
//
// v0.8.0 emitted `peer_messages_sent`; v0.8.1 canonical is
// `peer_messages_requested`. Parser accepts the legacy alias for one release
// and normalizes onto the canonical field, with a warning.

test('parser normalizes legacy peer_messages_sent into peer_messages_requested with warning', () => {
  const payload = {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_sent: [{ to: 'expert-ux', summary: 's' }], // legacy shape
    questions_for_orchestrator: [],
  };
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {
    expectedExpertId: 'expert-ui',
    expectedPhase: 'spec-review',
  });
  assert.equal(result.ok, true, 'legacy field should parse');
  assert.deepEqual(
    result.result.peer_messages_requested,
    [{ to: 'expert-ux', summary: 's' }],
    'normalized onto canonical field'
  );
  assert.ok(
    Array.isArray(result.warnings) && result.warnings.includes('legacy-peer_messages_sent-normalized'),
    'should emit legacy-normalization warning'
  );
});

test('parser preferred-wins when both peer_messages_requested and peer_messages_sent present', () => {
  const payload = {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_requested: [{ to: 'expert-ux', body: 'preferred' }],
    peer_messages_sent: [{ to: 'expert-ux', summary: 'legacy' }],
    questions_for_orchestrator: [],
  };
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {});
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.result.peer_messages_requested,
    [{ to: 'expert-ux', body: 'preferred' }],
    'preferred field wins'
  );
  assert.ok(
    Array.isArray(result.warnings) && result.warnings.includes('both-peer-fields-present-preferred-wins'),
    'should warn that both are present'
  );
});

test('parser fails schema-violation when neither peer_messages_requested nor peer_messages_sent present', () => {
  const payload = {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    // both peer fields absent
    questions_for_orchestrator: [],
  };
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('peer_messages_requested'));
});

test('parser fails schema-violation when legacy peer_messages_sent is non-array', () => {
  const payload = {
    expert_id: 'expert-ui',
    phase: 'spec-review',
    status: 'SHIP',
    scope: 'ui',
    blocking_findings: [],
    nonblocking_findings: [],
    peer_messages_sent: { bogus: true }, // legacy field, wrong type
    questions_for_orchestrator: [],
  };
  const raw = wrapMachineResult(JSON.stringify(payload));
  const result = parseExpertOutput(raw, {});
  // Normalization happens regardless of type; downstream array-ness check
  // sees the non-array on the canonical field and reports schema-violation.
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema-violation');
  assert.ok(result.missingFields.includes('peer_messages_requested'));
});
