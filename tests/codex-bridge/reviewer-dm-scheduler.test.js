// Plan 3 (reviewer naming migration) — reviewer-dm-scheduler canonical module.
//
// Smoke + one-window-compat: canonical `drainPeerDMs` present and the
// expert-dm-scheduler.js shim re-exports the identical reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drainPeerDMs } from '../../lib/codex-bridge/reviewer-dm-scheduler.js';
import * as expertShim from '../../lib/codex-bridge/expert-dm-scheduler.js';

test('reviewer-dm-scheduler exposes drainPeerDMs', () => {
  assert.equal(typeof drainPeerDMs, 'function');
});

test('expert-dm-scheduler shim re-exports the identical drainPeerDMs reference', () => {
  assert.equal(expertShim.drainPeerDMs, drainPeerDMs);
});

test('drainPeerDMs converges cleanly when no reviewer has unread', async () => {
  const { turns, halt } = await drainPeerDMs(
    [{ id: 'reviewer-ui' }, { id: 'reviewer-architecture' }],
    { hasUnread: async () => 0, runTurn: async () => ({ ok: true }) },
    {}
  );
  assert.deepEqual(turns, []);
  assert.equal(halt, null);
});
