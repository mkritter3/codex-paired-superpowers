// v0.10.1 — goals block + audit log tests.
//
// These functions are the load-bearing primitive for the writing-plans /
// brainstorming "audit before SHIP" contract added in v0.10.1. The honest-
// reporting Stop-gate consumes hasAuditFor(); the prompt-composition layer
// consumes getGoals().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  setGoals,
  getGoals,
  appendAuditLog,
  listAudits,
  hasAuditFor,
  hasExecutedVerificationFor,
  requiresExecutedVerification,
  loadSidecar,
  sidecarPathFor,
} from '../../lib/codex-bridge/sidecar.js';

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-goals-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'goals-demo', codexSession: 'tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const VALID_BLOCK = `<<<GOALS>>>
- Goal 1: After this ships, the user can do X.
- Goal 2: System guarantees Y.
<<<END_GOALS>>>`;

test('setGoals persists block + persisted_at', () => {
  const { dir, spec } = makeSpec();
  setGoals(spec, { block: VALID_BLOCK });
  const g = getGoals(spec);
  assert.equal(g.block, VALID_BLOCK);
  assert.match(g.persisted_at, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(dir, { recursive: true, force: true });
});

test('getGoals returns null before setGoals', () => {
  const { dir, spec } = makeSpec();
  assert.equal(getGoals(spec), null);
  rmSync(dir, { recursive: true, force: true });
});

test('setGoals rejects non-object', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => setGoals(spec, null), /must be an object/);
  assert.throws(() => setGoals(spec, 'foo'), /must be an object/);
  rmSync(dir, { recursive: true, force: true });
});

test('setGoals rejects empty / non-string block', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => setGoals(spec, { block: '' }), /non-empty string/);
  assert.throws(() => setGoals(spec, { block: 42 }), /non-empty string/);
  rmSync(dir, { recursive: true, force: true });
});

test('setGoals rejects block missing delimiters', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => setGoals(spec, { block: 'just some text' }), /<<<GOALS>>>/);
  assert.throws(() => setGoals(spec, { block: '<<<GOALS>>>\nno end' }), /<<<END_GOALS>>>/);
  rmSync(dir, { recursive: true, force: true });
});

test('setGoals overwrites prior value (goals may be user-revised)', () => {
  const { dir, spec } = makeSpec();
  setGoals(spec, { block: VALID_BLOCK });
  const next = VALID_BLOCK.replace('Goal 1', 'Goal 1 (revised)');
  setGoals(spec, { block: next });
  assert.equal(getGoals(spec).block, next);
  rmSync(dir, { recursive: true, force: true });
});

const VALID_AUDIT = {
  phase: 'plan',
  round: 1,
  side: 'codex',
  commands: [
    { cmd: 'grep -rn dependency-graph lib/', summary: 'exists at lib/codex-bridge/dependency-graph.js:1', kind: 'inspection' },
    { cmd: 'git log --grep=DAG --oneline', summary: '3 prior commits — capability shipped in v0.7.3', kind: 'inspection' },
  ],
  verdict_basis: 'Plan reinvents existing DAG → REVISE',
};

test('appendAuditLog persists structured entry', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, VALID_AUDIT);
  const audits = listAudits(spec);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].phase, 'plan');
  assert.equal(audits[0].round, 1);
  assert.equal(audits[0].side, 'codex');
  assert.equal(audits[0].commands.length, 2);
  assert.equal(audits[0].commands[0].cmd, 'grep -rn dependency-graph lib/');
  assert.equal(audits[0].verdict_basis, 'Plan reinvents existing DAG → REVISE');
  assert.match(audits[0].appended_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(audits[0].commands[0].ran_at, /^\d{4}-\d{2}-\d{2}T/);
  rmSync(dir, { recursive: true, force: true });
});

test('appendAuditLog accepts caller-supplied ran_at', () => {
  const { dir, spec } = makeSpec();
  const audit = {
    ...VALID_AUDIT,
    commands: [{ cmd: 'ls', summary: 'ok', kind: 'inspection', ran_at: '2026-05-13T12:00:00.000Z' }],
  };
  appendAuditLog(spec, audit);
  assert.equal(listAudits(spec)[0].commands[0].ran_at, '2026-05-13T12:00:00.000Z');
  rmSync(dir, { recursive: true, force: true });
});

test('appendAuditLog rejects each missing required field', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendAuditLog(spec, null), /plain object/);
  assert.throws(() => appendAuditLog(spec, []), /plain object/);
  assert.throws(() => appendAuditLog(spec, { ...VALID_AUDIT, phase: '' }), /phase/);
  assert.throws(() => appendAuditLog(spec, { ...VALID_AUDIT, round: 0 }), /positive integer/);
  assert.throws(() => appendAuditLog(spec, { ...VALID_AUDIT, round: 1.5 }), /positive integer/);
  assert.throws(() => appendAuditLog(spec, { ...VALID_AUDIT, side: 'human' }), /claude.*codex/);
  assert.throws(() => appendAuditLog(spec, { ...VALID_AUDIT, commands: [] }), /non-empty array/);
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: '', summary: 'ok' }] }),
    /cmd/
  );
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: 'x', summary: '' }] }),
    /summary/
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendAuditLog rejects empty verdict_basis when present', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, verdict_basis: '' }),
    /verdict_basis/
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendAuditLog stores verdict_basis: null when omitted', () => {
  const { dir, spec } = makeSpec();
  const audit = { ...VALID_AUDIT };
  delete audit.verdict_basis;
  appendAuditLog(spec, audit);
  assert.equal(listAudits(spec)[0].verdict_basis, null);
  rmSync(dir, { recursive: true, force: true });
});

test('listAudits filters by phase / round / side', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'spec', round: 1, side: 'claude' });
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'spec', round: 1, side: 'codex' });
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'plan', round: 1, side: 'codex' });
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'plan', round: 2, side: 'codex' });

  assert.equal(listAudits(spec).length, 4);
  assert.equal(listAudits(spec, { phase: 'spec' }).length, 2);
  assert.equal(listAudits(spec, { phase: 'plan' }).length, 2);
  assert.equal(listAudits(spec, { side: 'codex' }).length, 3);
  assert.equal(listAudits(spec, { phase: 'plan', round: 1 }).length, 1);
  assert.equal(listAudits(spec, { phase: 'plan', round: 1, side: 'codex' }).length, 1);
  assert.equal(listAudits(spec, { phase: 'plan', round: 1, side: 'claude' }).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('listAudits returns deep copy (mutations do not affect sidecar)', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, VALID_AUDIT);
  const audits = listAudits(spec);
  audits[0].commands[0].cmd = 'MUTATED';
  audits[0].phase = 'MUTATED';
  const fresh = listAudits(spec);
  assert.equal(fresh[0].commands[0].cmd, VALID_AUDIT.commands[0].cmd);
  assert.equal(fresh[0].phase, 'plan');
  rmSync(dir, { recursive: true, force: true });
});

test('listAudits returns empty array when no audits recorded', () => {
  const { dir, spec } = makeSpec();
  assert.deepEqual(listAudits(spec), []);
  rmSync(dir, { recursive: true, force: true });
});

test('hasAuditFor returns true only for matching (phase, round, side)', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'plan', round: 1, side: 'codex' });
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'plan', round: 2, side: 'codex' });

  assert.equal(hasAuditFor(spec, { phase: 'plan', round: 1, side: 'codex' }), true);
  assert.equal(hasAuditFor(spec, { phase: 'plan', round: 2, side: 'codex' }), true);
  assert.equal(hasAuditFor(spec, { phase: 'plan', round: 1, side: 'claude' }), false);
  assert.equal(hasAuditFor(spec, { phase: 'plan', round: 3, side: 'codex' }), false);
  assert.equal(hasAuditFor(spec, { phase: 'spec', round: 1, side: 'codex' }), false);
  rmSync(dir, { recursive: true, force: true });
});

test('hasAuditFor rejects malformed args', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => hasAuditFor(spec, { phase: '', round: 1, side: 'codex' }), /phase/);
  assert.throws(() => hasAuditFor(spec, { phase: 'plan', round: 0, side: 'codex' }), /round/);
  assert.throws(() => hasAuditFor(spec, { phase: 'plan', round: 1, side: 'gpt' }), /side/);
  rmSync(dir, { recursive: true, force: true });
});

test('goals + audits coexist with rounds and other top-level keys', () => {
  const { dir, spec } = makeSpec();
  setGoals(spec, { block: VALID_BLOCK });
  appendAuditLog(spec, VALID_AUDIT);
  const sc = loadSidecar(spec);
  assert.equal(sc.feature, 'goals-demo');
  assert.equal(sc.goals.block, VALID_BLOCK);
  assert.equal(sc.audits.length, 1);
  assert.deepEqual(sc.rounds, []);
  assert.deepEqual(sc.open_contentions, []);
  rmSync(dir, { recursive: true, force: true });
});

// ── v0.13.0 Slice 2 — kind/exit_code schema + verification floor ───────────

test('appendAuditLog requires command kind ∈ inspection|verification|other', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: 'ls', summary: 'ok' }] }),
    /kind/,
  );
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: 'ls', summary: 'ok', kind: 'bogus' }] }),
    /kind/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendAuditLog requires integer exit_code for kind verification', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: 'npm test', summary: 'ran', kind: 'verification' }] }),
    /exit_code/,
  );
  assert.throws(
    () => appendAuditLog(spec, { ...VALID_AUDIT, commands: [{ cmd: 'npm test', summary: 'ran', kind: 'verification', exit_code: 'zero' }] }),
    /exit_code/,
  );
  appendAuditLog(spec, {
    ...VALID_AUDIT, phase: 'implement:slice-1', round: 1, side: 'codex',
    commands: [{ cmd: 'npm test', summary: '42 passed', kind: 'verification', exit_code: 0 }],
  });
  const a = listAudits(spec, { phase: 'implement:slice-1', round: 1, side: 'codex' })[0];
  assert.equal(a.commands[0].kind, 'verification');
  assert.equal(a.commands[0].exit_code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('requiresExecutedVerification: false for design phases, true for code-bearing', () => {
  for (const p of ['spec', 'plan', 'plan-slice:slice-1']) {
    assert.equal(requiresExecutedVerification(p), false, `${p} should be design-only`);
  }
  for (const p of ['implement:slice-1', 'review-slice:slice-1', 'live-verification:slice-1', 'post-merge-review:slice-1']) {
    assert.equal(requiresExecutedVerification(p), true, `${p} should require verification`);
  }
  assert.equal(requiresExecutedVerification('unknown-phase'), false, 'unknown phases default to inspection-only');
});

test('hasExecutedVerificationFor: only verification + exit_code 0 counts', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, { ...VALID_AUDIT, phase: 'review-slice:s1', round: 1, side: 'codex' });
  assert.equal(hasExecutedVerificationFor(spec, { phase: 'review-slice:s1', round: 1, side: 'codex' }), false);
  appendAuditLog(spec, {
    ...VALID_AUDIT, phase: 'review-slice:s1', round: 2, side: 'codex',
    commands: [{ cmd: 'npm test', summary: '3 failed', kind: 'verification', exit_code: 1 }],
  });
  assert.equal(hasExecutedVerificationFor(spec, { phase: 'review-slice:s1', round: 2, side: 'codex' }), false);
  appendAuditLog(spec, {
    ...VALID_AUDIT, phase: 'review-slice:s1', round: 3, side: 'codex',
    commands: [{ cmd: 'npm test', summary: 'all pass', kind: 'verification', exit_code: 0 }],
  });
  assert.equal(hasExecutedVerificationFor(spec, { phase: 'review-slice:s1', round: 3, side: 'codex' }), true);
  rmSync(dir, { recursive: true, force: true });
});

test('legacy audit (no kind) lists + satisfies hasAuditFor but never hasExecutedVerificationFor', () => {
  const { dir, spec } = makeSpec();
  const sc = loadSidecar(spec);
  sc.audits = [{
    phase: 'review-slice:s1', round: 1, side: 'codex',
    commands: [{ cmd: 'npm test', summary: 'ran', ran_at: '2026-05-01T00:00:00.000Z' }],
    verdict_basis: null, appended_at: '2026-05-01T00:00:00.000Z',
  }];
  writeFileSync(sidecarPathFor(spec), JSON.stringify(sc, null, 2));
  assert.equal(listAudits(spec).length, 1);
  assert.equal(hasAuditFor(spec, { phase: 'review-slice:s1', round: 1, side: 'codex' }), true);
  assert.equal(hasExecutedVerificationFor(spec, { phase: 'review-slice:s1', round: 1, side: 'codex' }), false);
  rmSync(dir, { recursive: true, force: true });
});
