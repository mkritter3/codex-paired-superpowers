// v0.9.1 hardening — sidecar append serialization (in-process).
//
// IMPORTANT SCOPE (round-1 critique): sidecar.js does NOT currently use
// proper-lockfile or any cross-process lock. Its appendExpertTurn is
// synchronous; concurrent callers serialize naturally through Node's
// single-threaded event loop. This test pins THAT contract — that the
// in-process serialization invariant holds (no lost writes when many
// sync calls are scheduled together in one event loop).
//
// What this test does NOT prove (deferred to v0.9.2):
//   - cross-process safety (e.g., ralph re-firing /autopilot while a
//     previous run still has the sidecar open). The temp-rename in
//     saveSidecar() is atomic for the WRITE, but two processes can race
//     between LOAD and SAVE → lost update. The companion
//     `sidecar-concurrent-crossproc.test.js` documents that race.
//   - genuine async concurrency. If appendExpertTurn ever becomes async
//     (e.g., to add proper-lockfile), this test must be revisited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  appendExpertTurn,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-concurrent-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'concurrent-test',
    codexSession: 's',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  return { dir, spec };
}

function turnRecord(i) {
  return {
    expert_id: `expert-architecture`,        // same expert across all turns; tests append serialization
    phase: 'spec-review',
    mailbox_message_ids_injected: [`msg-${i}`],
    started_at: `2026-05-12T12:00:${String(i).padStart(2, '0')}.000Z`,
    completed_at: `2026-05-12T12:00:${String(i + 1).padStart(2, '0')}.000Z`,
    result_summary: `turn-${i}`,
    verdict: 'SHIP',
    failure_reason: null,
  };
}

test('appendExpertTurn: 20 parallel appends all land exactly once, JSON stays valid', async () => {
  const { dir, spec } = makeSpec();
  const N = 20;
  // Fire all N appends in parallel via Promise.all. Each appendExpertTurn
  // takes the lock, reads, mutates, writes, releases — concurrent callers
  // serialize through proper-lockfile.
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() => appendExpertTurn(spec, turnRecord(i)))
    )
  );

  // Reload + verify: every turn must be present exactly once, JSON valid.
  const sc = loadSidecar(spec);
  assert.ok(sc.reviewer_teammates, 'sidecar missing expert_teammates block');
  assert.equal(
    sc.reviewer_teammates.turns.length,
    N,
    `expected ${N} turns; got ${sc.reviewer_teammates.turns.length} (lost writes indicate lock failure)`
  );

  // Each turn's mailbox_message_ids_injected[0] is a unique sentinel; the
  // set must match {msg-0, msg-1, ..., msg-(N-1)} exactly.
  const sentinels = new Set(
    sc.reviewer_teammates.turns.map((t) => t.mailbox_message_ids_injected[0])
  );
  assert.equal(sentinels.size, N, 'duplicate or missing turn sentinels');
  for (let i = 0; i < N; i++) {
    assert.ok(sentinels.has(`msg-${i}`), `missing sentinel msg-${i}`);
  }

  // The on-disk JSON must be parseable from scratch (no partial writes).
  const { sidecarPathFor } = await import('../../lib/codex-bridge/sidecar.js');
  const onDisk = sidecarPathFor(spec);
  const raw = readFileSync(onDisk, 'utf8');
  const reparsed = JSON.parse(raw); // would throw if corrupt
  assert.equal(reparsed.reviewer_teammates.turns.length, N);

  rmSync(dir, { recursive: true, force: true });
});

test('appendExpertTurn: parallel appends from different experts all serialize', async () => {
  const { dir, spec } = makeSpec();
  const experts = ['expert-architecture', 'expert-test', 'expert-ui', 'expert-security'];
  const turnsPerExpert = 5;
  const total = experts.length * turnsPerExpert;

  const calls = [];
  for (const ex of experts) {
    for (let i = 0; i < turnsPerExpert; i++) {
      calls.push(
        Promise.resolve().then(() =>
          appendExpertTurn(spec, {
            ...turnRecord(i),
            expert_id: ex,
            mailbox_message_ids_injected: [`${ex}-${i}`],
            result_summary: `${ex}-${i}`,
          })
        )
      );
    }
  }
  await Promise.all(calls);

  const sc = loadSidecar(spec);
  assert.equal(sc.reviewer_teammates.turns.length, total, 'lost writes during multi-expert race');
  for (const ex of experts) {
    const fromExpert = sc.reviewer_teammates.turns.filter((t) => t.expert_id === ex);
    assert.equal(fromExpert.length, turnsPerExpert, `wrong count for ${ex}`);
  }
  rmSync(dir, { recursive: true, force: true });
});
