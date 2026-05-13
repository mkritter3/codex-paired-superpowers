import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendExpertTurnLocked,
  initSidecar,
  loadSidecar,
  sidecarPathFor,
  SidecarLockError,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-sidecar-lock-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec\n', 'utf8');
  initSidecar(spec, {
    feature: 'sidecar-lock-test',
    codexSession: 'session',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  return { dir, spec };
}

function makeTurn(id = 'expert-test') {
  const now = new Date().toISOString();
  return {
    expert_id: id,
    phase: 'spec-review',
    mailbox_message_ids_injected: [],
    started_at: now,
    completed_at: now,
    result_summary: 'ok',
    verdict: 'SHIP',
    failure_reason: null,
  };
}

test('appendExpertTurnLocked: reclaims stale sidecar lock and appends turn', async () => {
  const { dir, spec } = makeSpec();
  try {
    const lockPath = `${sidecarPathFor(spec)}.lock`;
    mkdirSync(lockPath);
    const staleDate = new Date(Date.now() - 150);
    utimesSync(lockPath, staleDate, staleDate);

    await appendExpertTurnLocked(spec, makeTurn(), {
      lockOptions: { retries: 3, minTimeout: 30, maxTimeout: 50, stale: 100 },
    });

    const sidecar = loadSidecar(spec);
    assert.equal(sidecar.expert_teammates.turns.length, 1);
    assert.equal(sidecar.expert_teammates.turns[0].expert_id, 'expert-test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendExpertTurnLocked: fresh ELOCKED surfaces as SidecarLockError', async () => {
  const { dir, spec } = makeSpec();
  try {
    const lockPath = `${sidecarPathFor(spec)}.lock`;
    mkdirSync(lockPath);
    const freshDate = new Date();
    utimesSync(lockPath, freshDate, freshDate);

    await assert.rejects(
      () =>
        appendExpertTurnLocked(spec, makeTurn(), {
          lockOptions: { retries: 2, minTimeout: 10, maxTimeout: 20, stale: 60_000 },
        }),
      (err) => {
        assert.ok(err instanceof SidecarLockError);
        assert.equal(err.code, 'sidecar-lock-failed');
        assert.ok(err.cause, 'SidecarLockError must preserve original cause');
        assert.equal(err.cause.code, 'ELOCKED');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
