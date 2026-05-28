// v0.10.1 — audit gate tests.
//
// The gate fires when a Bash command attempts to log a SHIP verdict via
// sidecar-append-round without a corresponding audit-log entry. This is
// the machine-enforced version of "Codex always verifies against the
// existing codebase before claiming SHIP."

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAuditGate,
  decidePreToolUse,
  parseSidecarAppendRoundCommand,
} from '../../lib/codex-bridge/hook-honest-reporting.js';

const ACTIVE = { active: true, marker: { skillName: 'writing-plans' } };
const INACTIVE = { active: false };

function bashCmd(command) {
  return { command };
}

function roundJson({ phase = 'plan', round = 1, claude = 'SHIP', codex = 'SHIP' } = {}) {
  return JSON.stringify({ phase, round, claude, codex });
}

function appendRoundCmd({ phase, round, claude, codex, specPath = '/x/y/spec.md' } = {}) {
  const json = roundJson({ phase, round, claude, codex });
  return `node \${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round --specPath "${specPath}" --round '${json}'`;
}

// ── parseSidecarAppendRoundCommand ────────────────────────────────────────

test('parser: extracts spec / phase / round / verdicts from canonical form', () => {
  const cmd = appendRoundCmd({ phase: 'plan', round: 2, claude: 'SHIP', codex: 'REVISE: x' });
  const r = parseSidecarAppendRoundCommand(cmd);
  assert.equal(r.specPath, '/x/y/spec.md');
  assert.equal(r.phase, 'plan');
  assert.equal(r.round, 2);
  assert.equal(r.claudeVerdict, 'SHIP');
  assert.equal(r.codexVerdict, 'REVISE: x');
});

test('parser: single-quoted specPath also works', () => {
  const cmd = `node cli.js sidecar-append-round --specPath '/a/b/c.md' --round '${roundJson()}'`;
  const r = parseSidecarAppendRoundCommand(cmd);
  assert.equal(r.specPath, '/a/b/c.md');
});

test('parser: unquoted specPath also works', () => {
  const cmd = `node cli.js sidecar-append-round --specPath /a/b/c.md --round '${roundJson()}'`;
  const r = parseSidecarAppendRoundCommand(cmd);
  assert.equal(r.specPath, '/a/b/c.md');
});

test('parser: returns null when not a sidecar-append-round command', () => {
  assert.equal(parseSidecarAppendRoundCommand('echo hello'), null);
  assert.equal(parseSidecarAppendRoundCommand('node cli.js sidecar-show --specPath foo'), null);
});

test('parser: returns null when --specPath missing', () => {
  assert.equal(
    parseSidecarAppendRoundCommand(`node cli.js sidecar-append-round --round '${roundJson()}'`),
    null
  );
});

test('parser: returns null when --round missing', () => {
  assert.equal(
    parseSidecarAppendRoundCommand('node cli.js sidecar-append-round --specPath "/a/b.md"'),
    null
  );
});

test('parser: returns null when --round JSON is malformed', () => {
  const cmd = `node cli.js sidecar-append-round --specPath "/a.md" --round 'not-json'`;
  assert.equal(parseSidecarAppendRoundCommand(cmd), null);
});

// ── decideAuditGate ───────────────────────────────────────────────────────

test('gate: inactive marker → exit 0 (no gate)', () => {
  const r = decideAuditGate('Bash', bashCmd(appendRoundCmd()), INACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: non-Bash tool → exit 0', () => {
  const r = decideAuditGate('Edit', { file_path: '/x' }, ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: Bash command unrelated to append-round → exit 0', () => {
  const r = decideAuditGate('Bash', bashCmd('echo hello'), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: phase=slice:7 → exit 0 (slice review out of scope for this gate)', () => {
  const cmd = appendRoundCmd({ phase: 'slice:7', round: 1, claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: both REVISE → exit 0 (no SHIP claimed, no audit required)', () => {
  const cmd = appendRoundCmd({ claude: 'REVISE: x', codex: 'REVISE: y' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: claude SHIP only, audit present → exit 0', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'REVISE: x' });
  const calls = [];
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: (sp, { side }) => { calls.push(side); return side === 'claude'; },
  });
  assert.equal(r.exit, 0);
  assert.deepEqual(calls, ['claude']);
});

test('gate: claude SHIP, audit missing → exit 2 with claude in missing list', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'REVISE: x' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 2);
  assert.match(r.message, /Missing audit evidence for side\(s\): claude\b/);
  assert.match(r.message, /sidecar-append-audit/);
});

test('gate: both SHIP, both audits missing → exit 2 with both listed', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 2);
  assert.match(r.message, /claude, codex/);
});

test('gate: both SHIP, both audits present → exit 0', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => true });
  assert.equal(r.exit, 0);
});

test('gate: SHIP-with-rationale ("SHIP: looks good") triggers gate', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP: looks good', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 2);
});

test('gate: "SHIPYARD" or "SHIPPED" alone in verdict does NOT trigger (must start with bare SHIP)', () => {
  const cmd = appendRoundCmd({ claude: 'SHIPYARD-related', codex: 'REVISE: x' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: hasAuditFor throws → fail open (exit 0)', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: () => { throw new Error('sidecar missing'); },
  });
  assert.equal(r.exit, 0);
});

test('gate: malformed --round JSON → exit 0 (fail open)', () => {
  const cmd = 'node cli.js sidecar-append-round --specPath "/x.md" --round \'not-json\'';
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});

test('gate: queries hasAuditFor with exact (specPath, phase, round, side) tuple', () => {
  const cmd = appendRoundCmd({ phase: 'spec', round: 4, claude: 'SHIP', codex: 'SHIP', specPath: '/p/q.md' });
  const queries = [];
  decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: (sp, args) => { queries.push({ sp, ...args }); return true; },
  });
  assert.deepEqual(queries, [
    { sp: '/p/q.md', phase: 'spec', round: 4, side: 'claude' },
    { sp: '/p/q.md', phase: 'spec', round: 4, side: 'codex' },
  ]);
});

// ── v0.13.0 code-bearing verification gate ─────────────────────────────────

test('gate: code-bearing SHIP with inspection audit but no verification → exit 2', () => {
  const cmd = appendRoundCmd({ phase: 'review-slice:slice-1', round: 1, claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: () => true,                 // inspection audit exists
    hasExecutedVerificationFor: () => false, // but no executed verification
    requiresExecutedVerification: () => true,
  });
  assert.equal(r.exit, 2);
  assert.match(r.message, /claude, codex/);
});

test('gate: code-bearing SHIP with executed verification → exit 0', () => {
  const cmd = appendRoundCmd({ phase: 'implement:slice-1', round: 2, claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: () => false,
    hasExecutedVerificationFor: () => true,
    requiresExecutedVerification: () => true,
  });
  assert.equal(r.exit, 0);
});

test('gate: design-phase SHIP backed by inspection audit only → exit 0 (no verification required)', () => {
  const cmd = appendRoundCmd({ phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: () => true,
    hasExecutedVerificationFor: () => false, // never consulted for design phases
    requiresExecutedVerification: () => false,
  });
  assert.equal(r.exit, 0);
});

test('gate: plan-slice phase is design-only (inspection audit suffices)', () => {
  const cmd = appendRoundCmd({ phase: 'plan-slice:slice-1', round: 1, claude: 'SHIP', codex: 'REVISE: x' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, {
    hasAuditFor: (sp, { side }) => side === 'claude',
    hasExecutedVerificationFor: () => false,
  });
  assert.equal(r.exit, 0);
});

test('gate message manual audit example includes a kind field (v0.13.0)', () => {
  const cmd = appendRoundCmd({ phase: 'plan', round: 1, claude: 'SHIP', codex: 'SHIP' });
  const r = decideAuditGate('Bash', bashCmd(cmd), ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 2);
  assert.match(r.message, /"kind"/);
});

// ── decidePreToolUse integration ──────────────────────────────────────────

test('integration: decidePreToolUse blocks unaudited SHIP-round-append', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decidePreToolUse('Bash', bashCmd(cmd), [], ACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 2);
  assert.match(r.message, /audit gate/i);
});

test('integration: decidePreToolUse allows audited SHIP-round-append', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decidePreToolUse('Bash', bashCmd(cmd), [], ACTIVE, { hasAuditFor: () => true });
  assert.equal(r.exit, 0);
});

test('integration: decidePreToolUse non-append-round Bash still passes through to claim-vocab scan', () => {
  // A `git push` with no claim vocab in recent turns is allowed.
  const r = decidePreToolUse('Bash', bashCmd('git push'), ['just pushing'], ACTIVE, { hasAuditFor: () => true });
  assert.equal(r.exit, 0);
});

test('integration: marker inactive disables both gates', () => {
  const cmd = appendRoundCmd({ claude: 'SHIP', codex: 'SHIP' });
  const r = decidePreToolUse('Bash', bashCmd(cmd), [], INACTIVE, { hasAuditFor: () => false });
  assert.equal(r.exit, 0);
});
