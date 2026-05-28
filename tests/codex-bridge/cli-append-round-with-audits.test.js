// v0.13.0 Slice 4 — atomic round+audit logging (Goal 4).
//
// The happy path must record audits and the round in ONE locked mutation so the round can never be
// logged before its audits at runtime (the 21 observed "hook error" backtracks). If any audit is
// invalid, NOTHING is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSidecar, loadSidecar, appendRoundWithAudits } from '../../lib/codex-bridge/sidecar.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'codex-bridge', 'cli.js');

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-arwa-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'arwa', codexSession: 'tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const insp = (s = 'ok') => ({ cmd: 'rg foo', summary: s, kind: 'inspection' });
const verif = (code = 0) => ({ cmd: 'npm test', summary: 'ran', kind: 'verification', exit_code: code });

test('appendRoundWithAudits persists audits THEN the round in one save (design SHIP)', async () => {
  const { dir, spec } = makeSpec();
  await appendRoundWithAudits(spec, {
    audits: [
      { phase: 'plan', round: 1, side: 'claude', commands: [insp()], verdict_basis: 'x' },
      { phase: 'plan', round: 1, side: 'codex', commands: [insp()], verdict_basis: 'y' },
    ],
    round: { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' },
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.audits.length, 2);
  assert.equal(sc.rounds.length, 1);
  assert.equal(sc.rounds[0].claude, 'SHIP');
  rmSync(dir, { recursive: true, force: true });
});

test('appendRoundWithAudits is atomic: invalid second audit → nothing written', async () => {
  const { dir, spec } = makeSpec();
  await assert.rejects(
    () => appendRoundWithAudits(spec, {
      audits: [
        { phase: 'plan', round: 1, side: 'claude', commands: [insp()] },
        { phase: 'plan', round: 1, side: 'codex', commands: [{ cmd: 'x', summary: 'y' }] }, // missing kind
      ],
      round: { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' },
    }),
    /kind/,
  );
  const sc = loadSidecar(spec);
  assert.equal((sc.audits ?? []).length, 0); // neither audit (sidecar never saved)
  assert.equal((sc.rounds ?? []).length, 0); // nor the round
  rmSync(dir, { recursive: true, force: true });
});

test('appendRoundWithAudits rejects a design-phase SHIP with no audit for that side', async () => {
  const { dir, spec } = makeSpec();
  await assert.rejects(
    () => appendRoundWithAudits(spec, {
      audits: [{ phase: 'plan', round: 1, side: 'claude', commands: [insp()] }],
      round: { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' }, // codex SHIP has no audit
    }),
    /codex/,
  );
  assert.deepEqual(loadSidecar(spec).rounds, []);
  rmSync(dir, { recursive: true, force: true });
});

test('appendRoundWithAudits requires executed verification for a code-bearing SHIP', async () => {
  const { dir, spec } = makeSpec();
  // inspection-only audit is insufficient for review-slice SHIP
  await assert.rejects(
    () => appendRoundWithAudits(spec, {
      audits: [{ phase: 'review-slice:s1', round: 1, side: 'claude', commands: [insp()] }],
      round: { phase: 'review-slice:s1', round: 1, claude: 'SHIP', codex: 'REVISE: x' },
    }),
    /verification/i,
  );
  // with a passing verification command it succeeds
  await appendRoundWithAudits(spec, {
    audits: [{ phase: 'review-slice:s1', round: 2, side: 'claude', commands: [verif(0)] }],
    round: { phase: 'review-slice:s1', round: 2, claude: 'SHIP', codex: 'REVISE: x' },
  });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('appendRoundWithAudits rejects a code-bearing SHIP backed only by a zero-test TIA run', async () => {
  const { dir, spec } = makeSpec();
  await assert.rejects(
    () => appendRoundWithAudits(spec, {
      audits: [{
        phase: 'review-slice:s1', round: 1, side: 'claude',
        commands: [{ cmd: 'tia run', summary: 'ran 0', kind: 'verification', exit_code: 0, selection: { mode: 'none', ran: 0 } }],
      }],
      round: { phase: 'review-slice:s1', round: 1, claude: 'SHIP', codex: 'REVISE: x' },
    }),
    /verification/i,
  );
  assert.deepEqual((loadSidecar(spec).rounds ?? []), []);
  rmSync(dir, { recursive: true, force: true });
});

test('appendRoundWithAudits allows REVISE rounds with no audits', async () => {
  const { dir, spec } = makeSpec();
  await appendRoundWithAudits(spec, {
    audits: [],
    round: { phase: 'plan', round: 1, claude: 'REVISE: a', codex: 'REVISE: b' },
  });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('CLI sidecar-append-round-with-audits wires through --payload', () => {
  const { dir, spec } = makeSpec();
  const payload = JSON.stringify({
    audits: [
      { phase: 'plan', round: 1, side: 'claude', commands: [insp()] },
      { phase: 'plan', round: 1, side: 'codex', commands: [insp()] },
    ],
    round: { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' },
  });
  execFileSync(process.execPath, [CLI, 'sidecar-append-round-with-audits', '--specPath', spec, '--payload', payload]);
  const sc = loadSidecar(spec);
  assert.equal(sc.audits.length, 2);
  assert.equal(sc.rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
