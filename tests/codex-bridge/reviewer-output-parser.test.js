// Plan 3 (reviewer naming migration) — reviewer-output-parser canonical module.
//
// Smoke + one-window-compat:
//   - canonical `parseReviewerOutput` present;
//   - `parseExpertOutput` alias === `parseReviewerOutput`;
//   - the expert-output-parser.js shim re-exports identical references.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseReviewerOutput,
  parseExpertOutput,
  buildRepairPrompt,
} from '../../lib/codex-bridge/reviewer-output-parser.js';
import * as expertShim from '../../lib/codex-bridge/expert-output-parser.js';

function validPayload() {
  return [
    '## Machine Result',
    '```json',
    JSON.stringify({
      expert_id: 'reviewer-architecture',
      phase: 'spec-review',
      status: 'SHIP',
      scope: 'architecture',
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    }),
    '```',
  ].join('\n');
}

test('reviewer-output-parser exposes the canonical API', () => {
  assert.equal(typeof parseReviewerOutput, 'function');
  assert.equal(typeof buildRepairPrompt, 'function');
});

test('parseExpertOutput alias === parseReviewerOutput', () => {
  assert.equal(parseExpertOutput, parseReviewerOutput);
});

test('expert-output-parser shim re-exports the identical references', () => {
  assert.equal(expertShim.parseExpertOutput, parseReviewerOutput);
  assert.equal(expertShim.buildRepairPrompt, buildRepairPrompt);
});

test('parseReviewerOutput parses a valid reviewer Machine Result', () => {
  const res = parseReviewerOutput(validPayload(), {
    expectedExpertId: 'reviewer-architecture',
    expectedPhase: 'spec-review',
  });
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.result.status, 'SHIP');
});
