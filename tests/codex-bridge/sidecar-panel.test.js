import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendAuditLog,
  appendRound,
  appendRoundWithAudits,
  getCodexThreadId,
  initSidecar,
  loadSidecar,
  panelPhaseForRound,
  setCodexThreadId,
  setPanelRoster,
} from '../../lib/codex-bridge/sidecar.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'codex-bridge', 'cli.js');
const VERSION = 'sha256:' + 'a'.repeat(64);
const ROSTER = [
  { member_id: 'codex:gpt-review', cli: 'codex', model: 'gpt-review', effort: 'high' },
  { member_id: 'agy:gemini-review-high', cli: 'agy', model: 'gemini-review-high', effort: 'high' },
];

function makeSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-panel-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'panel', codexSession: 'legacy-thread', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

function panel(statuses = ['REVISE', 'REVISE']) {
  return ROSTER.map((member, index) => ({
    member_id: member.member_id,
    cli: member.cli,
    model: member.model,
    version: VERSION,
    status: statuses[index],
    session: `session-${index + 1}`,
  }));
}

function round(overrides = {}) {
  return {
    phase: 'plan-2',
    round: 1,
    claude: 'REVISE',
    claude_version: VERSION,
    panel: panel(),
    ...overrides,
  };
}

const inspection = () => ({ cmd: 'rg invariant', summary: 'checked', kind: 'inspection' });
function audit(side) {
  return { phase: 'plan-2', round: 1, side, commands: [inspection()], verdict_basis: 'checked' };
}

async function appendByPath(path, spec, value, audits = []) {
  if (path === 'appendRound') {
    for (const entry of audits) appendAuditLog(spec, entry);
    return appendRound(spec, value, { enforceShipAudits: true });
  }
  return appendRoundWithAudits(spec, { audits, round: value });
}

for (const path of ['appendRound', 'appendRoundWithAudits']) {
  test(`${path}: missing panel in a rostered plan-2 phase is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const value = round();
    delete value.panel;
    await assert.rejects(async () => appendByPath(path, spec, value), (error) => error.code === 'panel-round-invalid' && /panel.*required/.test(error.message));
    assert.equal(loadSidecar(spec).rounds.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: a complete unanimous panel in a rostered plan-2 phase is accepted`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const value = round({ claude: 'SHIP', panel: panel(['SHIP', 'SHIP']) });
    await appendByPath(path, spec, value, [audit('claude'), ...ROSTER.map((member) => audit(member.member_id))]);
    assert.equal(loadSidecar(spec).rounds[0].codex, 'SHIP');
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: a missing panel member is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await assert.rejects(async () => appendByPath(path, spec, round({ panel: panel().slice(0, 1) })), (error) => error.code === 'panel-round-invalid' && /missing member/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: an extra panel member is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const extra = { member_id: 'codex:extra', cli: 'codex', model: 'extra', version: VERSION, status: 'REVISE', session: 'extra-session' };
    await assert.rejects(async () => appendByPath(path, spec, round({ panel: [...panel(), extra] })), (error) => error.code === 'panel-round-invalid' && /extra member/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: a duplicate panel member is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await assert.rejects(async () => appendByPath(path, spec, round({ panel: [panel()[0], panel()[0]] })), (error) => error.code === 'panel-round-invalid' && /duplicate member/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: mismatched member versions are rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const entries = panel();
    entries[1].version = 'sha256:' + 'b'.repeat(64);
    await assert.rejects(async () => appendByPath(path, spec, round({ panel: entries })), (error) => error.code === 'panel-round-invalid' && /version/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: a claude_version mismatch is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await assert.rejects(async () => appendByPath(path, spec, round({ claude_version: 'sha256:' + 'b'.repeat(64) })), (error) => error.code === 'panel-round-invalid' && /claude_version/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: matching quotes and whitespace are normalized before version comparison`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const entries = panel();
    entries[0].version = `  "${VERSION}"  `;
    entries[1].version = ` '${VERSION}' `;
    await appendByPath(path, spec, round({ claude_version: `  ${VERSION}  `, panel: entries }));
    assert.equal(loadSidecar(spec).rounds[0].codex, 'REVISE');
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: caller codex SHIP with a member REVISE is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await assert.rejects(async () => appendByPath(path, spec, round({ codex: 'SHIP', panel: panel(['SHIP', 'REVISE']) })), (error) => error.code === 'panel-round-invalid' && /codex.*disagrees/.test(error.message));
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: aggregate SHIP with a member REVISE is rejected even with every audit`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const audits = [audit('claude'), ...ROSTER.map((member) => audit(member.member_id))];
    await assert.rejects(async () => appendByPath(path, spec, round({ claude: 'SHIP', codex: 'SHIP', panel: panel(['SHIP', 'REVISE']) }), audits), (error) => error.code === 'panel-round-invalid');
    assert.equal(loadSidecar(spec).rounds.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: all members SHIP with all audits is accepted and codex is derived as SHIP`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const audits = [audit('claude'), ...ROSTER.map((member) => audit(member.member_id))];
    await appendByPath(path, spec, round({ claude: 'SHIP', panel: panel(['SHIP', 'SHIP']) }), audits);
    assert.equal(loadSidecar(spec).rounds[0].codex, 'SHIP');
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: panel SHIP missing one member audit is rejected`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await assert.rejects(
      async () => appendByPath(path, spec, round({ claude: 'SHIP', panel: panel(['SHIP', 'SHIP']) }), [audit('claude'), audit(ROSTER[0].member_id)]),
      new RegExp(ROSTER[1].member_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(loadSidecar(spec).rounds.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('member-id audit side is accepted and an unknown side is rejected', () => {
  const { dir, spec } = makeSpec();
  appendAuditLog(spec, audit('codex:gpt-review'));
  assert.equal(loadSidecar(spec).audits[0].side, 'codex:gpt-review');
  assert.throws(() => appendAuditLog(spec, audit('other:gpt-review')), /side.*claude.*codex.*member_id/);
  rmSync(dir, { recursive: true, force: true });
});

test('every skill-written round phase maps to its panel phase', () => {
  const cases = new Map([
    ['spec', 'planning'],
    ['plan', 'planning'],
    ['plan-2', 'planning'],
    ['plan-37', 'planning'],
    ['plan-slice:slice-2', 'planning'],
    ['review-slice:slice-2', 'review'],
    ['docs-update', 'review'],
    ['implement:slice-2', null],
    ['live-verification:slice-2', null],
    ['post-implementation-review', null],
  ]);
  for (const [phase, expected] of cases) assert.equal(panelPhaseForRound(phase), expected, phase);
});

test('without a roster a legacy round with no version is accepted byte-identically', () => {
  const { dir, spec } = makeSpec();
  const legacyRound = { phase: 'plan-2', round: 1, claude: 'REVISE: edit', codex: 'REVISE: edit' };
  const before = JSON.stringify(legacyRound);
  appendRound(spec, legacyRound);
  assert.equal(JSON.stringify(loadSidecar(spec).rounds[0]), before);
  assert.equal(JSON.stringify(legacyRound), before);
  rmSync(dir, { recursive: true, force: true });
});

test('two Codex panel members get distinct member-scoped session keys', async () => {
  const { dir, spec } = makeSpec();
  await setCodexThreadId(spec, { role: 'paired-reviewer:codex:gpt-a', newThreadId: 'thread-a' });
  await setCodexThreadId(spec, { role: 'paired-reviewer:codex:gpt-b', newThreadId: 'thread-b' });
  const sc = loadSidecar(spec);
  assert.equal(getCodexThreadId(sc, 'paired-reviewer:codex:gpt-a'), 'thread-a');
  assert.equal(getCodexThreadId(sc, 'paired-reviewer:codex:gpt-b'), 'thread-b');
  assert.equal(sc.role_sessions['paired-reviewer:codex:gpt-a'], 'thread-a');
  assert.equal(sc.role_sessions['paired-reviewer:codex:gpt-b'], 'thread-b');
  rmSync(dir, { recursive: true, force: true });
});

test('setPanelRoster is idempotent but a changed roster throws panel-roster-changed', () => {
  const { dir, spec } = makeSpec();
  setPanelRoster(spec, 'planning', ROSTER);
  setPanelRoster(spec, 'planning', ROSTER.map((member) => ({ ...member })));
  assert.throws(
    () => setPanelRoster(spec, 'planning', ROSTER.slice(0, 1)),
    (error) => error.code === 'panel-roster-changed' && /planning/.test(error.message),
  );
  assert.deepEqual(loadSidecar(spec).panel_roster.planning, ROSTER);
  rmSync(dir, { recursive: true, force: true });
});

test('sidecar-set-panel-roster persists the roster and validates usage', () => {
  const { dir, spec } = makeSpec();
  const stdout = execFileSync('node', [CLI, 'sidecar-set-panel-roster', '--specPath', spec, '--phase', 'review', '--roster', JSON.stringify(ROSTER)], { encoding: 'utf8' });
  assert.equal(stdout, '');
  assert.deepEqual(loadSidecar(spec).panel_roster.review, ROSTER);
  assert.throws(
    () => execFileSync('node', [CLI, 'sidecar-set-panel-roster', '--specPath', spec, '--roster', JSON.stringify(ROSTER)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => error.status === 2 && /--phase/.test(error.stderr),
  );
  rmSync(dir, { recursive: true, force: true });
});

for (const path of ['appendRound', 'appendRoundWithAudits']) {
  test(`${path}: panel fields on a phase with no roster are rejected, never used to pick SHIP sides`, async () => {
    const { dir, spec } = makeSpec();
    // Without the guard, `panel: []` made the SHIP-side list just ['claude'], so a caller-claimed
    // codex SHIP in a legacy phase skipped its required codex audit.
    for (const extra of [{ panel: [] }, { panel: panel(['SHIP', 'SHIP']) }, { claude_version: VERSION }]) {
      const legacy = { phase: 'plan-2', round: 1, claude: 'SHIP', codex: 'SHIP', summary: 's', ...extra };
      await assert.rejects(async () => appendByPath(path, spec, legacy, [audit('claude')]), (error) => error.code === 'panel-round-invalid');
    }
    assert.equal(loadSidecar(spec).rounds.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test(`${path}: a unanimous member SHIP with Claude REVISE needs no Claude audit`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    await appendByPath(path, spec, round({ claude: 'REVISE', panel: panel(['SHIP', 'SHIP']) }), ROSTER.map((member) => audit(member.member_id)));
    assert.equal(loadSidecar(spec).rounds[0].codex, 'SHIP');
    rmSync(dir, { recursive: true, force: true });
  });
}

for (const path of ['appendRound', 'appendRoundWithAudits']) {
  test(`${path}: a malformed Claude verdict in a panel round is rejected, a padded one canonicalized`, async () => {
    const { dir, spec } = makeSpec();
    setPanelRoster(spec, 'planning', ROSTER);
    const memberAudits = ROSTER.map((member) => audit(member.member_id));
    // "SHIPPED" is not SHIP for audit selection but is for prefix readers; it must never persist.
    for (const bad of ['SHIPPED', 'ship', '', undefined]) {
      await assert.rejects(async () => appendByPath(path, spec, round({ claude: bad, panel: panel(['SHIP', 'SHIP']) }), memberAudits), (error) => error.code === 'panel-round-invalid' && /claude verdict/.test(error.message));
    }
    assert.equal(loadSidecar(spec).rounds.length, 0);
    await appendByPath(path, spec, round({ claude: ' REVISE ', panel: panel(['SHIP', 'SHIP']) }), memberAudits);
    assert.equal(loadSidecar(spec).rounds[0].claude, 'REVISE');
    rmSync(dir, { recursive: true, force: true });
  });
}
