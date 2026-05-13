import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchPanel } from '../../../lib/codex-bridge/panel/dispatcher.js';

const ROLE = 'expert-test';
const DOCUMENTED_OUTCOMES = new Set([
  'panel-SHIP',
  'panel-REVISE',
  'panel-disagreement',
  'panel-quorum-lost',
]);

function shipResult() {
  return {
    ok: true,
    result: {
      expert_id: ROLE,
      phase: 'spec-review',
      status: 'SHIP',
      scope: ROLE,
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: [],
      questions_for_orchestrator: [],
    },
  };
}

const baseRequest = {
  repoRoot: '/tmp/cps-panel-timeout',
  specPath: '/tmp/cps-panel-timeout/spec.md',
  specSnippet: 'snip',
  phase: 'spec-review',
  sliceId: 'slice-timeout',
  sidecarParticipantState: '',
  task: 'review',
};

function makeTimeoutPanel() {
  return new Map([
    [`${ROLE}@fast`, async () => shipResult()],
    [`${ROLE}@hung`, async () => new Promise(() => {})],
  ]);
}

test('dispatchPanel: per-member timeout abandons hung member and returns within budget', async () => {
  const startedAt = Date.now();
  const result = await dispatchPanel(ROLE, baseRequest, makeTimeoutPanel(), {
    panel_min_size: 1,
    panel_max_size: 2,
    member_timeout_ms: 200,
  });
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 500, `dispatchPanel should return within ~500ms; took ${elapsed}ms`);
  assert.ok(DOCUMENTED_OUTCOMES.has(result.outcome), `unexpected outcome ${result.outcome}`);
  assert.equal(result.outcome, 'panel-SHIP');

  const timedOut = result.member_results.find((r) => r.member_id === `${ROLE}@hung`);
  assert.ok(timedOut, 'timed-out member must be present in member_results');
  assert.equal(timedOut.parse_failure_reason, 'dispatch_fn-timeout');
  assert.equal(timedOut.parsed_result, null);
});

test('dispatchPanel: timed-out member counts failed for panel_min_size quorum', async () => {
  const result = await dispatchPanel(ROLE, baseRequest, makeTimeoutPanel(), {
    panel_min_size: 2,
    panel_max_size: 2,
    member_timeout_ms: 200,
  });

  assert.ok(DOCUMENTED_OUTCOMES.has(result.outcome), `unexpected outcome ${result.outcome}`);
  assert.equal(result.outcome, 'panel-quorum-lost');
  const timedOut = result.member_results.find((r) => r.member_id === `${ROLE}@hung`);
  assert.equal(timedOut.parse_failure_reason, 'dispatch_fn-timeout');
});
