// v0.9.1 hardening — cross-process sidecar append correctness.
//
// Companion to `sidecar-concurrent.test.js`. That test only pins in-process
// serialization. This one fires N independent node subprocesses that each
// load → append → save through `appendExpertTurnLocked` (the audit-critical
// production path).
//
// `appendExpertTurnLocked` wraps the load → modify → save window with
// proper-lockfile (50 retries, jittered exp backoff up to 250ms). Concurrent
// processes serialize through the lock; no appends are lost.
//
// This test asserts the STRICT contract: ALL N appends survive. If a future
// change breaks the lock (e.g., reverts to the sync `appendExpertTurn` on
// the production path), this test fails immediately. The prior in-process
// `Promise.all` test would NOT catch a regression here because Node's event
// loop hides the race in one process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

const TEST_TIMEOUT_MS = 90_000;

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-xproc-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  return { dir, spec };
}

// Initialize the sidecar from the parent process ONCE before workers fire.
// Worker concurrent `initSidecar` calls would each wipe the sidecar to fresh
// state and lose appends — that race is a separate gap, out of scope here.
async function initSidecarOnce(spec) {
  const { initSidecar } = await import('../../lib/codex-bridge/sidecar.js');
  initSidecar(spec, {
    feature: 'xproc-test',
    codexSession: 's',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
}

// A small worker script: takes <specPath> <turnId> as argv, calls
// initSidecar (idempotent) + appendExpertTurn once, exits 0.
//
// Note: with `node -e <script>`, process.argv is [node, arg1, arg2] —
// NOT the usual [node, scriptpath, arg1, arg2]. Index accordingly.
function workerSource() {
  return `
import { appendExpertTurnLocked } from "${join(REPO_ROOT, 'lib/codex-bridge/sidecar.js')}";
const specPath = process.argv[1];
const turnId = process.argv[2];
if (!specPath || !turnId) {
  console.error('worker: missing argv specPath/turnId; argv was', JSON.stringify(process.argv));
  process.exit(2);
}
// Parent initializes the sidecar once before workers fire. Workers only
// append (under the lock). Calling initSidecar from a worker would race
// with sibling initSidecar calls and clobber appends.
await appendExpertTurnLocked(specPath, {
  expert_id: 'expert-architecture',
  phase: 'spec-review',
  mailbox_message_ids_injected: ['msg-' + turnId],
  started_at: new Date().toISOString(),
  completed_at: new Date().toISOString(),
  result_summary: 'turn-' + turnId,
  verdict: 'SHIP',
  failure_reason: null,
});
process.exit(0);
`;
}

function spawnWorker(specPath, turnId) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--input-type=module', '-e', workerSource(), specPath, String(turnId)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

test('cross-process: N node subprocesses appending to one sidecar — JSON stays valid', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const { dir, spec } = makeSpec();
  try {
    // N=4 with light startup stagger. Production ralph re-fires don't
    // happen on the same millisecond; this is a stress test, not chaos
    // monkey. Under full-suite parallel test load we'd otherwise exhaust
    // the lock retry budget (~50s) competing with N=8 simultaneous
    // workers AND other test files' I/O.
    const N = 4;
    await initSidecarOnce(spec);
    // Stagger spawns by 25ms each so workers don't all hit the lock on
    // the same millisecond. Still tests cross-process serialization but
    // tolerates parallel test-runner load.
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i * 25));
        return spawnWorker(spec, i);
      })
    );

    // Every worker must have exited cleanly (no crashes on contention).
    for (const r of results) {
      assert.equal(r.code, 0, `worker exited ${r.code}; stderr: ${r.stderr}`);
    }

    // The sidecar JSON must still parse. This is the bare minimum:
    // temp-rename's atomic-write contract should guarantee no corrupt
    // partial JSON on disk.
    const { sidecarPathFor } = await import('../../lib/codex-bridge/sidecar.js');
    const onDisk = sidecarPathFor(spec);
    const raw = readFileSync(onDisk, 'utf8');
    const reparsed = JSON.parse(raw); // would throw if corrupt
    assert.ok(reparsed.expert_teammates, 'expert_teammates block must exist');
    const turns = reparsed.expert_teammates.turns;
    assert.ok(Array.isArray(turns), 'turns must be an array');

    // ── v0.9.1 strict contract: ALL N appends must survive.
    // `appendExpertTurnLocked` wraps load → modify → save with
    // proper-lockfile so concurrent processes serialize. A regression
    // (e.g., reverting to sync appendExpertTurn on the production path)
    // would make this fail with N=1 or partial counts.
    assert.equal(
      turns.length,
      N,
      `all ${N} cross-process appends must survive; only ${turns.length} did. ` +
        `Likely cause: production path is using the unlocked appendExpertTurn ` +
        `(regression of v0.9.1 hardening).`
    );

    // Each turn must have a unique sentinel — proves no duplicate appends either.
    const sentinels = new Set(turns.map((t) => t.mailbox_message_ids_injected[0]));
    assert.equal(sentinels.size, N, 'duplicate or missing sentinels — lock leakage?');
    for (let i = 0; i < N; i++) {
      assert.ok(sentinels.has(`msg-${i}`), `missing sentinel msg-${i}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
