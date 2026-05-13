// v0.10.0 slice 3 — types-contract.test.js
//
// Verifies that __shapesForTests in types.js matches spec § Architecture L72-95.
// JSDoc typedefs are erased at runtime; this runtime witness lets us assert
// the exact property-name lists and runtime-kind union members without reflection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __shapesForTests } from '../../../lib/codex-bridge/implementer/types.js';

// ── ImplementerRuntimeKind ────────────────────────────────────────────────────

test('__shapesForTests: runtimeKindMembers equals ["claude-cli", "codex-cli"] (sorted)', () => {
  assert.deepEqual(
    __shapesForTests.runtimeKindMembers,
    ['claude-cli', 'codex-cli'],
    'runtimeKindMembers must be sorted and contain exactly the two spec values'
  );
});

// ── ImplementerDispatchInput ──────────────────────────────────────────────────

test('__shapesForTests: dispatchInputProps matches spec L74-85 required properties (sorted)', () => {
  const expected = [
    'abortSignal',
    'baseSha',
    'branchName',
    'claimedFiles',
    'env',
    'implementerRunId',
    'memberId',
    'prompt',
    'runtimeKind',
    'sliceId',
    'worktreePath',
  ].sort();

  assert.deepEqual(
    [...__shapesForTests.dispatchInputProps].sort(),
    expected,
    'dispatchInputProps must contain exactly the 11 required properties from spec L74-85'
  );
});

test('__shapesForTests: dispatchInputProps is already sorted', () => {
  const sorted = [...__shapesForTests.dispatchInputProps].sort();
  assert.deepEqual(
    __shapesForTests.dispatchInputProps,
    sorted,
    'dispatchInputProps should be sorted alphabetically'
  );
});

// ── ImplementerDispatchResult ─────────────────────────────────────────────────

test('__shapesForTests: dispatchResultProps matches spec L87-95 required properties (sorted)', () => {
  const expected = [
    'changedFiles',
    'diffHash',
    'exitCode',
    'haltEnvelope',
    'headSha',
    'memberId',
    'outcome',
  ].sort();

  assert.deepEqual(
    [...__shapesForTests.dispatchResultProps].sort(),
    expected,
    'dispatchResultProps must contain exactly the 7 required properties from spec L87-95'
  );
});

test('__shapesForTests: dispatchResultProps is already sorted', () => {
  const sorted = [...__shapesForTests.dispatchResultProps].sort();
  assert.deepEqual(
    __shapesForTests.dispatchResultProps,
    sorted,
    'dispatchResultProps should be sorted alphabetically'
  );
});

// ── shape integrity ───────────────────────────────────────────────────────────

test('__shapesForTests: object has exactly three expected keys', () => {
  const keys = Object.keys(__shapesForTests).sort();
  assert.deepEqual(keys, ['dispatchInputProps', 'dispatchResultProps', 'runtimeKindMembers']);
});

test('__shapesForTests: all arrays are non-empty arrays', () => {
  assert.ok(Array.isArray(__shapesForTests.runtimeKindMembers), 'runtimeKindMembers must be array');
  assert.ok(__shapesForTests.runtimeKindMembers.length > 0, 'runtimeKindMembers must be non-empty');
  assert.ok(Array.isArray(__shapesForTests.dispatchInputProps), 'dispatchInputProps must be array');
  assert.ok(__shapesForTests.dispatchInputProps.length > 0, 'dispatchInputProps must be non-empty');
  assert.ok(Array.isArray(__shapesForTests.dispatchResultProps), 'dispatchResultProps must be array');
  assert.ok(__shapesForTests.dispatchResultProps.length > 0, 'dispatchResultProps must be non-empty');
});
