// v0.9.0 slice 3 — tests for lib/codex-bridge/role-routing/recommendations.js.
//
// Result-oriented: assert the parsed-Map shape returned by
// loadRecommendations() and the thrown RoleRoutingError codes when
// validation fails. Never assert mock-invocation counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadRecommendations,
  parsePreferenceEntry,
  validateRecommendations,
  _resetRecommendationsCache,
} from '../../../lib/codex-bridge/role-routing/recommendations.js';
import { RoleRoutingError } from '../../../lib/codex-bridge/role-routing/errors.js';

const EXPECTED_ROLES = [
  'paired-reviewer',
  'expert-architecture',
  'expert-ai-harness',
  'expert-test',
  'expert-security',
  'expert-backend',
  'expert-ui',
  'expert-ux',
  'implementer',
];

test('loadRecommendations returns all 9 roles with required fields', () => {
  _resetRecommendationsCache();
  const recs = loadRecommendations();
  assert.ok(recs instanceof Map, 'returns a Map');
  for (const role of EXPECTED_ROLES) {
    assert.ok(recs.has(role), `role "${role}" missing`);
    const entry = recs.get(role);
    assert.ok(Array.isArray(entry.preference), `${role}.preference not array`);
    assert.ok(entry.preference.length > 0, `${role}.preference empty`);
    assert.equal(typeof entry.rationale, 'string');
    assert.ok(entry.rationale.length > 0, `${role}.rationale empty`);
    assert.ok(
      entry.permissions === 'read-only' || entry.permissions === 'write-allowed',
      `${role}.permissions not enumerated`,
    );
  }
});

test('every preference array is non-empty', () => {
  const recs = loadRecommendations();
  for (const [role, entry] of recs) {
    assert.ok(entry.preference.length > 0, `${role} preference empty`);
  }
});

test('permissions value is one of the enumerated modes', () => {
  const recs = loadRecommendations();
  const modes = new Set(['read-only', 'write-allowed']);
  for (const [, entry] of recs) {
    assert.ok(modes.has(entry.permissions));
  }
  // Implementer is the only write-allowed role by default.
  const writeAllowed = [...recs.entries()]
    .filter(([, v]) => v.permissions === 'write-allowed')
    .map(([k]) => k);
  assert.deepEqual(writeAllowed, ['implementer']);
});

test('parsePreferenceEntry: variant entry → {cli, variant}', () => {
  assert.deepEqual(parsePreferenceEntry('ollama{kimi-k2.6}'), {
    cli: 'ollama',
    variant: 'kimi-k2.6',
  });
  assert.deepEqual(parsePreferenceEntry('ollama{glm-5.1}'), {
    cli: 'ollama',
    variant: 'glm-5.1',
  });
});

test('parsePreferenceEntry: plain entry → {cli, variant: null}', () => {
  assert.deepEqual(parsePreferenceEntry('codex'), { cli: 'codex', variant: null });
  assert.deepEqual(parsePreferenceEntry('claude'), { cli: 'claude', variant: null });
});

test('parsePreferenceEntry: malformed input throws MALFORMED_PREFERENCE_ENTRY', () => {
  const bad = ['ollama{}', 'ollama{x}}', '{kimi}', '', 'ollama{', '}'];
  for (const s of bad) {
    assert.throws(
      () => parsePreferenceEntry(s),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'MALFORMED_PREFERENCE_ENTRY',
      `expected throw for ${JSON.stringify(s)}`,
    );
  }
});

test('validateRecommendations: unknown CLI reference fails load', () => {
  // Build a synthetic cliClients map that intentionally omits "ghost".
  const cliClients = new Map([
    ['codex', { name: 'codex' }],
    ['claude', { name: 'claude' }],
  ]);
  const bad = {
    'paired-reviewer': {
      preference: ['ghost', 'codex'],
      rationale: 'broken',
      permissions: 'read-only',
    },
  };
  assert.throws(
    () => validateRecommendations(bad, cliClients),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'RECOMMENDATIONS_INVALID' &&
      /unknown CLI "ghost"/.test(err.message),
  );
});

test('validateRecommendations: unknown variant reference fails load', () => {
  const cliClients = new Map([
    ['codex', { name: 'codex' }],
    [
      'ollama',
      {
        name: 'ollama',
        variants: { 'kimi-k2.6': { model_name: 'kimi-k2.6:cloud' } },
      },
    ],
  ]);
  const bad = {
    'expert-ui': {
      preference: ['ollama{nonexistent}'],
      rationale: 'broken',
      permissions: 'read-only',
    },
  };
  assert.throws(
    () => validateRecommendations(bad, cliClients),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'RECOMMENDATIONS_INVALID' &&
      /unknown variant "nonexistent"/.test(err.message),
  );
});
