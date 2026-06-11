// v0.15.0 — sink-side round validation + relocated SHIP-audit gate.
//
// Replaces tests/codex-bridge/hook-audit-gate.test.js: the v0.10.1 gate
// regex-parsed the literal Bash command string in the PreToolUse hook and
// was fail-open against `--round "$VAR"`, $(...), and heredoc forms. The
// gate now lives in sidecar.js where the round arrives parsed, so no
// quoting form can slip past. These tests pin:
//   - shape validation (the bare-integer rounds[] corruption observed in a
//     live sidecar),
//   - sequential round numbers (the r4 → r11 discontinuities),
//   - the 7-round budget (plans observed at 11/13/15 rounds under one key),
//   - SHIP-audit enforcement in the sink for design + code-bearing phases,
//   - cli.js flag plumbing (--force-round, --allow-over-budget) and the
//     requireJsonArg usage error that replaced JSON.parse(undefined) crashes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSidecar,
  loadSidecar,
  appendRound,
  appendAuditLog,
  ROUND_BUDGET,
} from '../../lib/codex-bridge/sidecar.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'codex-bridge', 'cli.js');

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-rndval-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'rndval', codexSession: 'tid', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

const insp = (s = 'ok') => ({ cmd: 'rg foo', summary: s, kind: 'inspection' });
const verif = () => ({ cmd: 'npm test', summary: 'ran', kind: 'verification', exit_code: 0 });

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ── Shape validation (always on) ──────────────────────────────────────────

test('appendRound: bare integer round entry is rejected (corruption guard)', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendRound(spec, 3), /plain object/);
  assert.equal(loadSidecar(spec).rounds.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound: round.round null/missing is rejected', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendRound(spec, { phase: 'plan', round: null, claude: 'REVISE', codex: 'REVISE' }),
    /positive integer/,
  );
  assert.throws(
    () => appendRound(spec, { phase: 'plan', claude: 'REVISE', codex: 'REVISE' }),
    /positive integer/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound: missing/empty phase is rejected', () => {
  const { dir, spec } = makeSpec();
  assert.throws(() => appendRound(spec, { round: 1, claude: 'REVISE', codex: 'REVISE' }), /phase/);
  rmSync(dir, { recursive: true, force: true });
});

// ── Sequential enforcement (opt-in via opts.sequential) ──────────────────

test('appendRound sequential: non-contiguous round number is refused with guidance', () => {
  const { dir, spec } = makeSpec();
  appendRound(spec, { phase: 'plan', round: 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true });
  assert.throws(
    () => appendRound(spec, { phase: 'plan', round: 11, claude: 'REVISE', codex: 'REVISE' }, { sequential: true }),
    /expects round 2 next.*fresh phase key/s,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound sequential: first round of a NEW phase key must be 1', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendRound(spec, { phase: 'plan-2', round: 4, claude: 'REVISE', codex: 'REVISE' }, { sequential: true }),
    /expects round 1 next/,
  );
  appendRound(spec, { phase: 'plan-2', round: 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound sequential: per-phase counters are independent', () => {
  const { dir, spec } = makeSpec();
  appendRound(spec, { phase: 'spec', round: 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true });
  appendRound(spec, { phase: 'spec', round: 2, claude: 'REVISE', codex: 'REVISE' }, { sequential: true });
  // A different phase starts back at 1 even though spec is at 2.
  appendRound(spec, { phase: 'plan', round: 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true });
  assert.equal(loadSidecar(spec).rounds.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

// ── Budget enforcement (opt-in via opts.budget) ───────────────────────────

test(`appendRound budget: round ${ROUND_BUDGET + 1} is refused with new-phase-key guidance`, () => {
  const { dir, spec } = makeSpec();
  for (let i = 1; i <= ROUND_BUDGET; i++) {
    appendRound(spec, { phase: 'plan', round: i, claude: 'REVISE', codex: 'REVISE' }, { sequential: true, budget: true });
  }
  assert.throws(
    () => appendRound(spec, { phase: 'plan', round: ROUND_BUDGET + 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true, budget: true }),
    /exceeds the 7-round budget.*plan-2.*allow-over-budget/s,
  );
  // Without the budget opt (user-approved override path) it appends.
  appendRound(spec, { phase: 'plan', round: ROUND_BUDGET + 1, claude: 'REVISE', codex: 'REVISE' }, { sequential: true, budget: false });
  assert.equal(loadSidecar(spec).rounds.length, ROUND_BUDGET + 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── SHIP-audit gate in the sink (opt-in via opts.enforceShipAudits) ───────

test('sink gate: design-phase SHIP without audits is refused', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendRound(spec, { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' }, { enforceShipAudits: true }),
    /no audit entry/,
  );
  assert.equal(loadSidecar(spec).rounds.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('sink gate: design-phase SHIP with both audits recorded passes', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, { phase: 'plan', round: 1, side: 'claude', commands: [insp()], verdict_basis: 'x' });
  appendAuditLog(spec, { phase: 'plan', round: 1, side: 'codex', commands: [insp()], verdict_basis: 'y' });
  appendRound(spec, { phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' }, { enforceShipAudits: true });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('sink gate: plan-2 (budget-driven fresh key) is still a gated design phase', () => {
  const { dir, spec } = makeSpec();
  assert.throws(
    () => appendRound(spec, { phase: 'plan-2', round: 1, claude: 'SHIP', codex: 'REVISE: x' }, { enforceShipAudits: true }),
    /claude SHIP in plan-2/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test('sink gate: code-bearing SHIP requires an executed verification, not just inspection', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, { phase: 'review-slice:slice-1', round: 1, side: 'claude', commands: [insp()], verdict_basis: 'x' });
  assert.throws(
    () => appendRound(spec, { phase: 'review-slice:slice-1', round: 1, claude: 'SHIP', codex: 'REVISE: y' }, { enforceShipAudits: true }),
    /verification/,
  );
  appendAuditLog(spec, { phase: 'review-slice:slice-1', round: 1, side: 'claude', commands: [verif()], verdict_basis: 'x' });
  appendRound(spec, { phase: 'review-slice:slice-1', round: 1, claude: 'SHIP', codex: 'REVISE: y' }, { enforceShipAudits: true });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('sink gate: REVISE verdicts never require audits', () => {
  const { dir, spec } = makeSpec();
  appendRound(spec, { phase: 'plan', round: 1, claude: 'REVISE: a', codex: 'REVISE: b' }, { enforceShipAudits: true });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('sink gate: out-of-scope phase (neither design nor code-bearing) passes SHIP unaudited', () => {
  const { dir, spec } = makeSpec();
  appendRound(spec, { phase: 'security-panel', round: 1, claude: 'SHIP', codex: 'SHIP' }, { enforceShipAudits: true });
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── cli.js plumbing ───────────────────────────────────────────────────────

test('cli sidecar-append-round: missing --round → exit 2 with usage message, no stack trace', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['sidecar-append-round', '--specPath', spec]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--round <json> is required/);
  assert.ok(!/SyntaxError/.test(r.stderr), 'no raw JSON.parse stack trace');
  rmSync(dir, { recursive: true, force: true });
});

test('cli sidecar-add-contention: missing --contention → exit 2 usage (the live-incident crash)', () => {
  const { dir, spec } = makeSpec();
  const r = runCli(['sidecar-add-contention', '--specPath', spec]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--contention <json> is required/);
  rmSync(dir, { recursive: true, force: true });
});

test('cli sidecar-append-round: enforces SHIP gate from a $VAR-shaped invocation (no quoting bypass)', () => {
  // The old hook gate could not see through `--round "$JSON"`. The sink gate
  // operates on the parsed value, so the quoting form is irrelevant.
  const { dir, spec } = makeSpec();
  const json = JSON.stringify({ phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' });
  const r = runCli(['sidecar-append-round', '--specPath', spec, '--round', json]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no audit entry/);
  assert.equal(loadSidecar(spec).rounds.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('cli sidecar-append-round: --force-round permits a non-sequential append', () => {
  const { dir, spec } = makeSpec();
  const json = JSON.stringify({ phase: 'plan', round: 5, claude: 'REVISE: a', codex: 'REVISE: b' });
  const blocked = runCli(['sidecar-append-round', '--specPath', spec, '--round', json]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /expects round 1 next/);
  const forced = runCli(['sidecar-append-round', '--specPath', spec, '--round', json, '--force-round']);
  assert.equal(forced.status, 0, `stderr: ${forced.stderr}`);
  assert.equal(loadSidecar(spec).rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('cli sidecar-append-round: --allow-over-budget permits round 8 (sequentially reached)', () => {
  const { dir, spec } = makeSpec();
  for (let i = 1; i <= ROUND_BUDGET; i++) {
    appendRound(spec, { phase: 'plan', round: i, claude: 'REVISE', codex: 'REVISE' });
  }
  const json = JSON.stringify({ phase: 'plan', round: 8, claude: 'REVISE: a', codex: 'REVISE: b' });
  const blocked = runCli(['sidecar-append-round', '--specPath', spec, '--round', json]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /7-round budget/);
  const allowed = runCli(['sidecar-append-round', '--specPath', spec, '--round', json, '--allow-over-budget']);
  assert.equal(allowed.status, 0, `stderr: ${allowed.stderr}`);
  assert.equal(loadSidecar(spec).rounds.length, 8);
  rmSync(dir, { recursive: true, force: true });
});
