// v0.9.0 slice 3 — tests for lib/codex-bridge/role-routing/permissions.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapPermissions,
  refusesDangerousFlagsForReadOnly,
} from '../../../lib/codex-bridge/role-routing/permissions.js';
import { RoleRoutingError } from '../../../lib/codex-bridge/role-routing/errors.js';

test('codex + read-only → sandbox args', () => {
  const args = mapPermissions('codex', 'read-only');
  assert.deepEqual(args, ['--sandbox', 'read-only']);
});

test('codex + write-allowed → dangerous bypass', () => {
  const args = mapPermissions('codex', 'write-allowed');
  assert.deepEqual(args, ['--dangerously-bypass-approvals-and-sandbox']);
});

test('ollama + read-only → empty args', () => {
  const args = mapPermissions('ollama', 'read-only');
  assert.deepEqual(args, []);
});

test('unknown CLI throws RoleRoutingError UNKNOWN_CLI', () => {
  assert.throws(
    () => mapPermissions('nonexistent', 'read-only'),
    (err) =>
      err instanceof RoleRoutingError && err.code === 'UNKNOWN_CLI',
  );
});

test('unknown mode throws RoleRoutingError UNKNOWN_PERMISSION_MODE', () => {
  assert.throws(
    () => mapPermissions('codex', 'whatever'),
    (err) =>
      err instanceof RoleRoutingError &&
      err.code === 'UNKNOWN_PERMISSION_MODE',
  );
});

test('refusesDangerousFlagsForReadOnly catches reviewer-with-write-args', () => {
  // codex.json write-allowed = ['--dangerously-bypass-approvals-and-sandbox'].
  assert.equal(
    refusesDangerousFlagsForReadOnly('codex', 'read-only', [
      '--dangerously-bypass-approvals-and-sandbox',
    ]),
    true,
  );
  // Clean read-only args do not trip the check.
  assert.equal(
    refusesDangerousFlagsForReadOnly('codex', 'read-only', [
      '--sandbox',
      'read-only',
    ]),
    false,
  );
  // write-allowed mode is irrelevant to this guard.
  assert.equal(
    refusesDangerousFlagsForReadOnly('codex', 'write-allowed', [
      '--dangerously-bypass-approvals-and-sandbox',
    ]),
    false,
  );
});
