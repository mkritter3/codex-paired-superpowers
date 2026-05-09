/**
 * Tests for lib/codex-bridge/scenario-validator.js — parseScenarioList()
 *
 * Covers all 11 cases specified in Slice 6.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenarioList } from '../../lib/codex-bridge/scenario-validator.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const VALID_SCENARIO = {
  id: 'lv-001',
  title: 'Save settings change',
  risk: 'happy-path',
  why: 'Catches user-visible save regressions',
  preconditions: [
    { type: 'route', value: '/settings', enforcement: 'navigate' },
    { type: 'auth', value: 'seeded_test_user', enforcement: 'login_profile' },
  ],
  steps: [
    { action: 'click', target: 'Settings nav item' },
    { action: 'type', target: 'Display name input', value: 'Avery' },
  ],
  assertions: [
    'Saved display name is visible without page reload',
    'No error toast appears',
  ],
  diagnostic_expectations: [
    'No uncaught exception in app logs',
    'No 5xx response in server logs',
  ],
  timeout_ms: 60000,
};

const VALID_SCENARIO_2 = {
  id: 'lv-002',
  title: 'Navigate to settings page',
  risk: 'happy-path',
  why: 'Ensures route loads correctly',
  preconditions: [],
  steps: [
    { action: 'navigate', target: '/settings' },
    { action: 'wait_for', target: 'Settings heading' },
    { action: 'assert', target: 'Settings heading is shown' },
  ],
  assertions: ['Settings page is displayed'],
  diagnostic_expectations: [],
  timeout_ms: 30000,
};

// ─── Test 1: Valid full scenario JSON parses ok ───────────────────────────────

test('valid full scenario JSON parses ok', () => {
  const raw = JSON.stringify({ scenarios: [VALID_SCENARIO], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
  assert.equal(result.scenarios.length, 1);
  assert.equal(result.scenarios[0].id, 'lv-001');
  assert.deepEqual(result.deferred, []);
});

// ─── Test 2: Missing `scenarios` field → error ────────────────────────────────

test('missing scenarios field → {ok: false, defect: scenarios-missing}', () => {
  const raw = JSON.stringify({});
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'scenarios-missing');
});

// ─── Test 3: `scenarios` not an array → error ────────────────────────────────

test('scenarios not an array → {ok: false, defect: scenarios-not-array}', () => {
  const raw = JSON.stringify({ scenarios: 'foo' });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'scenarios-not-array');
});

// ─── Test 4: Missing scenario `id` → error ───────────────────────────────────

test('missing scenario id → {ok: false, defect: scenario-missing-id:0}', () => {
  const scenario = { ...VALID_SCENARIO };
  delete scenario.id;
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'scenario-missing-id:0');
});

// ─── Test 5: Duplicate scenario ids → error ──────────────────────────────────

test('duplicate scenario ids → {ok: false, defect: duplicate-scenario-id:<id>}', () => {
  const s2 = { ...VALID_SCENARIO_2, id: 'lv-001' }; // same id as VALID_SCENARIO
  const raw = JSON.stringify({ scenarios: [VALID_SCENARIO, s2], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'duplicate-scenario-id:lv-001');
});

// ─── Test 6: Unsupported action → error ──────────────────────────────────────

test('unsupported step action → {ok: false, defect: unsupported-action:<action>}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    steps: [{ action: 'hover', target: 'Menu button' }],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'unsupported-action:hover');
});

// Verify all supported actions are allowed
test('all supported actions (click, type, navigate, wait_for, assert) are valid', () => {
  const scenario = {
    ...VALID_SCENARIO,
    steps: [
      { action: 'click', target: 'Button' },
      { action: 'type', target: 'Input', value: 'text' },
      { action: 'navigate', target: '/page' },
      { action: 'wait_for', target: 'Element' },
      { action: 'assert', target: 'Something visible' },
    ],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
});

// ─── Test 7: Precondition without enforceable enforcement → error ─────────────

test('precondition without enforcement field → {ok: false, defect: precondition-unenforceable:0}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    preconditions: [{ type: 'route', value: '/settings' }], // missing enforcement
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'precondition-unenforceable:0');
});

test('precondition with invalid enforcement value → {ok: false, defect: precondition-unenforceable:0}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    preconditions: [{ type: 'route', value: '/settings', enforcement: 'magic_teleport' }],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'precondition-unenforceable:0');
});

// Verify all valid enforcement types are accepted
test('all valid enforcement types are accepted', () => {
  const validEnforcements = [
    'navigate', 'reset_command', 'seed_command', 'login_profile', 'setup_steps', 'manual_blocked',
  ];
  for (const enforcement of validEnforcements) {
    const scenario = {
      ...VALID_SCENARIO,
      id: `lv-check-${enforcement}`,
      preconditions: [{ type: 'route', value: '/page', enforcement }],
    };
    const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
    const result = parseScenarioList(raw);
    assert.equal(result.ok, true, `enforcement "${enforcement}" should be valid`);
  }
});

// ─── Test 8: Zero scenarios for behavior-changing slice → error ───────────────

test('zero scenarios with requireScenarios: true → {ok: false, defect: zero-scenarios}', () => {
  const raw = JSON.stringify({ scenarios: [], deferred: [] });
  const result = parseScenarioList(raw, { requireScenarios: true });
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'zero-scenarios');
});

// ─── Test 9: Zero scenarios with requireScenarios: false → ok ────────────────

test('zero scenarios with requireScenarios: false → ok (pure-library context)', () => {
  const raw = JSON.stringify({ scenarios: [], deferred: [] });
  const result = parseScenarioList(raw, { requireScenarios: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.scenarios, []);
});

test('zero scenarios without opts (default) → ok (default: not required)', () => {
  const raw = JSON.stringify({ scenarios: [], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
});

// ─── Test 10: Assertion not in screenshot/log domain → REVISE ────────────────

test('assertion mentioning internal state → {ok: false, defect: assertion-not-visible:<id>}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: ['internal state is set to true'],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, `assertion-not-visible:${VALID_SCENARIO.id}`);
});

test('assertion mentioning private field → {ok: false, defect: assertion-not-visible:<id>}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: ['private field _data is populated'],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, `assertion-not-visible:${VALID_SCENARIO.id}`);
});

test('assertion mentioning memory → {ok: false, defect: assertion-not-visible:<id>}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: ['the component memory holds the value'],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, `assertion-not-visible:${VALID_SCENARIO.id}`);
});

test('assertion mentioning in-process variable → {ok: false, defect: assertion-not-visible:<id>}', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: ['in-process variable pendingCount is zero'],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, false);
  assert.equal(result.defect, `assertion-not-visible:${VALID_SCENARIO.id}`);
});

test('clear-pass assertion: visible/shown/displayed → ok', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: [
      'Success message is visible on screen',
      'Error badge is shown in the header',
      'The dashboard is displayed',
    ],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
});

test('clear-pass assertion: logged/logs/console/error → ok', () => {
  const scenario = {
    ...VALID_SCENARIO,
    assertions: [
      'No error logged in console',
      'server logs contain success entry',
      'No console error thrown',
    ],
  };
  const raw = JSON.stringify({ scenarios: [scenario], deferred: [] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
});

// ─── Test 11: Happy — complete schema with multiple scenarios, all valid ──────

test('happy: multiple valid scenarios all parse ok', () => {
  const raw = JSON.stringify({
    scenarios: [VALID_SCENARIO, VALID_SCENARIO_2],
    deferred: ['lv-skip-001'],
  });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
  assert.equal(result.scenarios.length, 2);
  assert.equal(result.scenarios[0].id, 'lv-001');
  assert.equal(result.scenarios[1].id, 'lv-002');
  assert.deepEqual(result.deferred, ['lv-skip-001']);
});

// ─── Additional edge cases ────────────────────────────────────────────────────

test('invalid JSON input → {ok: false, defect: invalid-json}', () => {
  const result = parseScenarioList('not json at all {{{');
  assert.equal(result.ok, false);
  assert.equal(result.defect, 'invalid-json');
});

test('deferred field defaults to empty array if absent', () => {
  const raw = JSON.stringify({ scenarios: [VALID_SCENARIO] });
  const result = parseScenarioList(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.deferred, []);
});
