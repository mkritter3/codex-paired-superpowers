// v0.9.0 slice 7a — skill dispatch-path integration tests.
//
// Exercises the dispatch primitives each SKILL.md tells the orchestrator to
// invoke. We do NOT load skill prose at runtime (the orchestrator is Claude —
// not callable from Node). Instead these tests assert the API surface the
// prose targets actually works end-to-end with fake CLIs:
//
//   - brainstorming               → composeExperts + runTurnWithDeps (single)
//   - writing-plans (TDD-mandatory) → dispatchPanel('expert-test', ...) panel mode
//   - test-driven-development     → dispatchPanel('expert-test', ...) panel mode
//   - test-driven-development     → runTurnWithDeps single mode (--single override)
//   - subagent-driven-development → composeExperts + runTurnWithDeps (single)
//   - systematic-debugging        → composeExperts + runTurnWithDeps (single)
//   - systematic-debugging        → dispatchPanel for security-relevant bugs
//   - autopilot                   → dispatchPanel + drainPeerDMs seam contracts
//
// These are coverage tests for the SEAMS the prose names — if any of these
// fails, the skill prose is pointing at an API that doesn't behave as
// documented and Codex slice review should flag it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runTurnWithDeps,
} from '../../lib/codex-bridge/expert-turn.js';
import {
  dispatchPanel,
  PanelDispatchError,
} from '../../lib/codex-bridge/panel/dispatcher.js';
import {
  composeExperts,
} from '../../lib/codex-bridge/role-composer.js';
import {
  initSidecar,
  loadSidecar,
  appendExpertTurn,
} from '../../lib/codex-bridge/sidecar.js';

// ── shared helpers ─────────────────────────────────────────────────────────

function makeFixture(role) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-skill-disp-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'skill-disp-feature',
    codexSession: 's',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  const promptPath = join(dir, `${role}.md`);
  writeFileSync(
    promptPath,
    `---\nid: ${role}\nrole: ${role}\nversion: 1\n---\n# ${role} prompt body\n`,
  );
  return { dir, spec, promptPath };
}

function buildMachineResultText(role, phase, status, blocking = [], nonblocking = []) {
  const body = {
    expert_id: role,
    phase,
    status,
    scope: role,
    blocking_findings: blocking,
    nonblocking_findings: nonblocking,
    peer_messages_requested: [],
    questions_for_orchestrator: [],
  };
  return `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
}

function makeDispatchFn({ role, promptPath, adapter, phase, verdict }) {
  const identity = { id: role, role, promptPath, source: 'builtin' };
  return async (request) => {
    return runTurnWithDeps(
      { ...request, identity, adapter },
      {
        readUnreadMessages: async () => [],
        markManyAsRead: async () => ({ marked: [], skipped: [] }),
        writeToMailbox: async () => ({ id: 'msg-stub' }),
        agentDispatch: async () =>
          buildMachineResultText(role, phase, verdict),
      },
    );
  };
}

// ──────────────────────────────────────────────────────────────────────────
// brainstorming: composer-selected experts → single-mode runTurnWithDeps
// ──────────────────────────────────────────────────────────────────────────

test('brainstorming: composeExperts returns a list with phase=spec-review', () => {
  const result = composeExperts({
    phase: 'spec-review',
    signals: {
      specHas: ['ui', 'ux'],
      filePaths: ['src/ui/foo.tsx'],
      domains: ['ui'],
    },
    repoRoot: process.cwd(),
  });
  assert.ok(Array.isArray(result.selected), 'composeExperts.selected must be an array');
  // The composer's exact selection depends on the registry, but the contract
  // says it returns at least 1 expert when given UI signals.
  assert.ok(result.selected.length >= 1,
    'composeExperts must select at least one expert from UI signals');
  for (const identity of result.selected) {
    assert.ok(typeof identity.id === 'string' && identity.id.length > 0,
      'each selected expert must have a non-empty id');
    assert.ok(typeof identity.role === 'string' && identity.role.length > 0,
      'each selected expert must have a non-empty role');
  }
});

test('brainstorming: single-mode runTurnWithDeps records spec-review phase + adapter', async () => {
  const role = 'expert-architecture';
  const { dir, spec, promptPath } = makeFixture(role);
  const identity = { id: role, role, promptPath, source: 'builtin' };
  const result = await runTurnWithDeps(
    {
      identity,
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'draft spec text',
      phase: 'spec-review',
      sliceId: null,
      sidecarParticipantState: '',
      task: 'critique the spec draft',
      adapter: 'claude-task',
    },
    {
      readUnreadMessages: async () => [],
      markManyAsRead: async () => ({ marked: [], skipped: [] }),
      writeToMailbox: async () => ({ id: 'msg-stub' }),
      agentDispatch: async () =>
        buildMachineResultText(role, 'spec-review', 'SHIP'),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'SHIP');
  const sc = loadSidecar(spec);
  const turn = sc.expert_teammates.turns[0];
  assert.equal(turn.phase, 'spec-review');
  assert.equal(turn.expert_id, role);
  assert.equal(turn.adapter, 'claude-task');
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// writing-plans + test-driven-development: dispatchPanel('expert-test', ...)
// ──────────────────────────────────────────────────────────────────────────

test('writing-plans TDD-mandatory: dispatchPanel for expert-test with [codex, claude] ladder → panel-SHIP', async () => {
  const role = 'expert-test';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'tdd-review', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'tdd-review', verdict: 'SHIP' })],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'full plan text',
    phase: 'tdd-review',
    sliceId: null,
    sidecarParticipantState: '',
    task: 'review per-slice test lists',
  }, dispatchFns);

  assert.equal(result.outcome, 'panel-SHIP');
  assert.equal(result.member_results.length, 2);
  // Sidecar must have one turn per panelist with panel_id propagated.
  const sc = loadSidecar(spec);
  assert.equal(sc.expert_teammates.turns.length, 2);
  for (const turn of sc.expert_teammates.turns) {
    assert.equal(turn.expert_id, role);
    assert.equal(turn.panel_id, result.panel_id);
    assert.equal(turn.panel_size, 2);
    assert.equal(turn.phase, 'tdd-review');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('writing-plans TDD-mandatory: dispatchPanel mixed verdicts → consensus round runs', async () => {
  const role = 'expert-test';
  const { dir, spec, promptPath } = makeFixture(role);

  // For consensus round to fire we need size >= 3 with mixed verdicts.
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'tdd-review', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'tdd-review', verdict: 'REVISE' })],
    [`${role}@ollama`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:ollama',
                      phase: 'tdd-review', verdict: 'SHIP' })],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'plan text',
    phase: 'tdd-review',
    sliceId: null,
    sidecarParticipantState: '',
    task: 'review',
  }, dispatchFns);

  // Mixed SHIP/REVISE with size=3 → one consensus round runs.
  assert.equal(result.consensus_round_ran, true,
    'mixed SHIP/REVISE at size>=3 must trigger one consensus round');
  rmSync(dir, { recursive: true, force: true });
});

test('writing-plans high_stakes slice: dispatchPanel for expert-security works the same way as expert-test', async () => {
  const role = 'expert-security';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'plan-review', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'plan-review', verdict: 'SHIP' })],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'high-stakes slice text',
    phase: 'plan-review',
    sliceId: 'slice-3',
    sidecarParticipantState: '',
    task: 'security review of high-stakes slice',
  }, dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  // The dispatcher does not enforce role naming — it works for any role.
  // This proves the writing-plans prose can reuse the same dispatchPanel
  // call for expert-security/expert-architecture on high_stakes slices.
  rmSync(dir, { recursive: true, force: true });
});

test('test-driven-development: panel-quorum-unavailable halts BEFORE dispatch when only 1 CLI present', async () => {
  const role = 'expert-test';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'tdd-review', verdict: 'SHIP' })],
    // only one — quorum-unavailable
  ]);
  await assert.rejects(
    () => dispatchPanel(role, {
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'plan',
      phase: 'tdd-review',
      sliceId: null,
      sidecarParticipantState: '',
      task: 'review',
    }, dispatchFns),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-quorum-unavailable');
      return true;
    },
  );
  // No turns should have been persisted (fail before dispatch). When no
  // expert turns ever appended, `expert_teammates` may be absent on the
  // sidecar — that's also a valid "no turns" state.
  const sc = loadSidecar(spec);
  const turns = (sc.expert_teammates && sc.expert_teammates.turns) || [];
  assert.equal(turns.length, 0,
    'panel-quorum-unavailable must halt before any dispatch');
  rmSync(dir, { recursive: true, force: true });
});

test('test-driven-development --single override: runTurnWithDeps single dispatch works (no panel)', async () => {
  const role = 'expert-test';
  const { dir, spec, promptPath } = makeFixture(role);
  const identity = { id: role, role, promptPath, source: 'builtin' };
  const result = await runTurnWithDeps(
    {
      identity,
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'test list',
      phase: 'tdd-review',
      sliceId: 'slice-1',
      sidecarParticipantState: '',
      task: 'review test list (single mode override)',
      adapter: 'cli-harness:codex',
    },
    {
      readUnreadMessages: async () => [],
      markManyAsRead: async () => ({ marked: [], skipped: [] }),
      writeToMailbox: async () => ({ id: 'msg-stub' }),
      agentDispatch: async () =>
        buildMachineResultText(role, 'tdd-review', 'SHIP'),
    },
  );
  assert.equal(result.ok, true);
  const sc = loadSidecar(spec);
  const turn = sc.expert_teammates.turns[0];
  assert.equal(turn.phase, 'tdd-review');
  // No panel metadata when running single.
  assert.equal(turn.panel_id ?? null, null);
  assert.equal(turn.panel_size ?? null, null);
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// subagent-driven-development: composer + per-expert runTurnWithDeps
// ──────────────────────────────────────────────────────────────────────────

test('subagent-driven-development: composeExperts(phase=post-implementation-review) returns experts; each runs via runTurnWithDeps in single mode', async () => {
  const composed = composeExperts({
    phase: 'post-implementation-review',
    signals: {
      specHas: ['security'],
      filePaths: ['src/auth/token.ts'],
      domains: ['security'],
    },
    repoRoot: process.cwd(),
  });
  assert.ok(composed.selected.length >= 1);

  // Pick the first selected expert and run it through runTurnWithDeps.
  // Note: composer returns identity.id = "expert-<role>", identity.role = "<role>".
  // The parser expects `expert_id === identity.id`, so the agentDispatch stub
  // must emit identity.id (not identity.role) in the Machine Result body.
  const expert = composed.selected[0];
  const { dir, spec } = makeFixture(expert.id);
  // Use the composer-supplied promptPath (it points to the real builtin prompt).
  const identity = expert;
  const result = await runTurnWithDeps(
    {
      identity,
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'slice diff',
      phase: 'post-implementation-review',
      sliceId: 'slice-3',
      sidecarParticipantState: '',
      task: 'review the slice diff',
      adapter: 'claude-task',
    },
    {
      readUnreadMessages: async () => [],
      markManyAsRead: async () => ({ marked: [], skipped: [] }),
      writeToMailbox: async () => ({ id: 'msg-stub' }),
      agentDispatch: async () =>
        buildMachineResultText(expert.id, 'post-implementation-review', 'SHIP'),
    },
  );
  assert.equal(result.ok, true);
  const sc = loadSidecar(spec);
  const turn = sc.expert_teammates.turns[0];
  assert.equal(turn.phase, 'post-implementation-review');
  assert.equal(turn.slice_id, 'slice-3');
  assert.equal(turn.expert_id, expert.id);
  rmSync(dir, { recursive: true, force: true });
});

test('subagent-driven-development: blocking finding from expert is preserved in sidecar (HALT signal source)', async () => {
  const role = 'expert-architecture';
  const { dir, spec, promptPath } = makeFixture(role);
  const identity = { id: role, role, promptPath, source: 'builtin' };
  const blocking = [{
    id: 'arch-bf-1',
    severity: 'high',
    summary: 'Slice introduces a circular dep',
    citation: 'src/foo.ts:42',
  }];
  const result = await runTurnWithDeps(
    {
      identity,
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'slice diff',
      phase: 'post-implementation-review',
      sliceId: 'slice-3',
      sidecarParticipantState: '',
      task: 'review',
      adapter: 'claude-task',
    },
    {
      readUnreadMessages: async () => [],
      markManyAsRead: async () => ({ marked: [], skipped: [] }),
      writeToMailbox: async () => ({ id: 'msg-stub' }),
      agentDispatch: async () =>
        buildMachineResultText(role, 'post-implementation-review', 'REVISE', blocking),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.result.status, 'REVISE');
  assert.equal(result.result.blocking_findings.length, 1);
  assert.equal(result.result.blocking_findings[0].id, 'arch-bf-1');
  // Sidecar turn must record the verdict so autopilot/sub can halt on it.
  const sc = loadSidecar(spec);
  const turn = sc.expert_teammates.turns[0];
  assert.equal(turn.verdict, 'REVISE');
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// systematic-debugging: composer-picked hypothesis review (single + panel)
// ──────────────────────────────────────────────────────────────────────────

test('systematic-debugging: composeExperts(phase=hypothesis-review) works with bug-domain signals', () => {
  const result = composeExperts({
    phase: 'hypothesis-review',
    signals: {
      specHas: ['concurrent', 'race'],
      filePaths: ['src/backend/queue.ts'],
      domains: ['backend'],
    },
    repoRoot: process.cwd(),
  });
  assert.ok(Array.isArray(result.selected));
  // Bug review should pick at least one expert.
  assert.ok(result.selected.length >= 1);
});

test('systematic-debugging: panel-mode dispatchPanel for security-relevant bugs → panel-SHIP', async () => {
  const role = 'expert-security';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'hypothesis-review', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'hypothesis-review', verdict: 'SHIP' })],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'hypothesis text',
    phase: 'hypothesis-review',
    sliceId: 'debug-bug-42',
    sidecarParticipantState: '',
    task: 'critique the root-cause hypothesis',
  }, dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  rmSync(dir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// autopilot: dispatchPanel + halt-reason surface contracts (seam coverage)
// ──────────────────────────────────────────────────────────────────────────

test('autopilot: panel-config-invalid is raised when panel_max_size < panel_min_size', async () => {
  const role = 'paired-reviewer';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'release-gate', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'release-gate', verdict: 'SHIP' })],
  ]);
  await assert.rejects(
    () => dispatchPanel(role, {
      repoRoot: dir,
      specPath: spec,
      specSnippet: 'release-gate snippet',
      phase: 'release-gate',
      sliceId: null,
      sidecarParticipantState: '',
      task: 'final go/no-go',
    }, dispatchFns, { panel_min_size: 3, panel_max_size: 2 }),
    (err) => {
      assert.ok(err instanceof PanelDispatchError);
      assert.equal(err.code, 'panel-config-invalid');
      return true;
    },
  );
  rmSync(dir, { recursive: true, force: true });
});

test('autopilot: paired-reviewer release-gate panel records panel metadata per member', async () => {
  const role = 'paired-reviewer';
  const { dir, spec, promptPath } = makeFixture(role);
  const dispatchFns = new Map([
    [`${role}@codex`,
     makeDispatchFn({ role, promptPath, adapter: 'cli-harness:codex',
                      phase: 'release-gate', verdict: 'SHIP' })],
    [`${role}@claude-task`,
     makeDispatchFn({ role, promptPath, adapter: 'claude-task',
                      phase: 'release-gate', verdict: 'SHIP' })],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'release-gate snippet',
    phase: 'release-gate',
    sliceId: null,
    sidecarParticipantState: '',
    task: 'final go/no-go',
  }, dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  const sc = loadSidecar(spec);
  // Each panelist gets its own turn with panel_member_index distinct.
  const indices = sc.expert_teammates.turns
    .filter((t) => t.expert_id === role)
    .map((t) => t.panel_member_index);
  assert.equal(indices.length, 2);
  assert.notEqual(indices[0], indices[1],
    'panel members must have distinct panel_member_index in sidecar');
  rmSync(dir, { recursive: true, force: true });
});

test('autopilot: panel suppresses peer messages (peer-DM duplicate-delivery guard)', async () => {
  const role = 'expert-test';
  const { dir, spec, promptPath } = makeFixture(role);
  // Each panelist tries to peer-DM another expert. The dispatcher's
  // suppressPeerMessages: true contract prevents duplicate delivery.
  function buildWithPeerDM(verdict) {
    const body = {
      expert_id: role,
      phase: 'tdd-review',
      status: verdict,
      scope: role,
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: [{ to: 'expert-architecture', body: 'cross-check this' }],
      questions_for_orchestrator: [],
    };
    return `## Machine Result\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n`;
  }
  const identity = { id: role, role, promptPath, source: 'builtin' };
  const mailboxWrites = [];
  function makeFn(adapter, verdict) {
    return async (request) => runTurnWithDeps(
      { ...request, identity, adapter },
      {
        readUnreadMessages: async () => [],
        markManyAsRead: async () => ({ marked: [], skipped: [] }),
        writeToMailbox: async (...args) => {
          mailboxWrites.push(args);
          return { id: 'msg-stub' };
        },
        agentDispatch: async () => buildWithPeerDM(verdict),
      },
    );
  }
  const dispatchFns = new Map([
    [`${role}@codex`, makeFn('cli-harness:codex', 'SHIP')],
    [`${role}@claude-task`, makeFn('claude-task', 'SHIP')],
  ]);
  const result = await dispatchPanel(role, {
    repoRoot: dir,
    specPath: spec,
    specSnippet: 'plan',
    phase: 'tdd-review',
    sliceId: null,
    sidecarParticipantState: '',
    task: 'review',
  }, dispatchFns);
  assert.equal(result.outcome, 'panel-SHIP');
  // Critical: NO mailbox writes should have occurred — panelists' peer-DMs
  // are suppressed (spec § 4: "Panel peer DMs are suppressed").
  assert.equal(mailboxWrites.length, 0,
    'panel mode must suppress peer-DM mailbox writes (avoid duplicate delivery)');
  rmSync(dir, { recursive: true, force: true });
});

// ── Plan 2 Slice 4 — interactive driver wiring (incl. interactive hybrid) ──

// Local copy of the section-slicing helper (it is not importable from skill-structure.test.js).
const __SLICE4_DIR = dirname(fileURLToPath(import.meta.url));
const __SLICE4_PLUGIN_ROOT = join(__SLICE4_DIR, '..', '..');

function readSkillFile(name) {
  return readFileSync(join(__SLICE4_PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

function sectionByHeader(content, header) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === header);
  assert.ok(start !== -1, `expected to find section header ${JSON.stringify(header)}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('execution interactive driver documents per-work-item flow: normalize → split → reviewers → Codex review', () => {
  const section = sectionByHeader(readSkillFile('execution'), '## Driver: interactive');
  // Order matters (spec lines 212-218): normalize, run split path, reviewers, Codex paired review.
  const iNormalize = section.search(/normaliz/i);
  const iSplit = section.search(/runSplit/);
  const iReviewers = section.search(/reviewer/i);
  const iCodex = section.search(/Codex (paired )?review/i);
  assert.ok(iNormalize !== -1, 'interactive section must describe split normalization');
  assert.ok(iSplit !== -1, 'interactive section must name runSplit');
  assert.ok(iReviewers !== -1, 'interactive section must describe domain reviewers');
  assert.ok(iCodex !== -1, 'interactive section must describe Codex paired review');
  assert.ok(
    iNormalize < iReviewers && iReviewers < iCodex,
    'interactive flow must be ordered: normalize → reviewers → Codex review',
  );
  // The three split paths must all be named.
  assert.match(section, /dispatch-single/, 'single split → dispatch-single directive (Step A subagent)');
  assert.match(section, /subagent-driven-development/, 'single split names subagent-driven-development Step A');
  assert.match(section, /dispatchImplementers/, 'two-disjoint split → dispatchImplementers + merge');
});

test('execution interactive hybrid routes runHybridSlice with mode: interactive + claude-inline/codex-background-bash', () => {
  // The unit that runSplit actually threads mode:'interactive' is pinned by dispatcher slice-2 case 4
  // (Plan 1, tests/codex-bridge/execution/split-dispatcher.test.js). This test pins the SKILL prose
  // that triggers that path.
  const section = sectionByHeader(readSkillFile('execution'), '## Driver: interactive');
  assert.match(section, /runHybridSlice/, 'interactive hybrid must call runHybridSlice');
  assert.match(
    section,
    /mode:\s*'interactive'|mode:\s*interactive|mode: 'interactive'/,
    "interactive hybrid must pass mode: 'interactive'",
  );
  assert.match(section, /claude-inline/, 'interactive hybrid UI owner runtime is claude-inline');
  assert.match(section, /codex-background-bash/, 'interactive hybrid backend owner runtime is codex-background-bash');
});

test('execution interactive dirty-checkout halt is surfaced in plain English (no raw code to user)', () => {
  const section = sectionByHeader(readSkillFile('execution'), '## Driver: interactive');
  // Plain-English rendering present (uncommitted changes / commit or stash).
  assert.match(
    section,
    /uncommitted changes|commit or stash/i,
    'dirty-checkout halt must be rendered as a plain-English message',
  );
  // The raw halt code may be referenced as the internal trigger, but the user-visible message must
  // not BE the raw code. Assert the plain-English phrasing exists alongside any code mention.
  assert.match(
    section,
    /re-?run/i,
    'dirty-checkout message must tell the user to re-run after committing/stashing',
  );
});

// ── Plan 2 Slice 5 — autopilot split-normalization decision point ──

test('execution autopilot driver delegates to autopilot, only adds split normalization at Phase B', () => {
  const section = sectionByHeader(readSkillFile('execution'), '## Driver: autopilot');
  assert.match(section, /delegat/i, 'autopilot section must state it delegates to the autopilot flow');
  assert.match(section, /\bautopilot\b/, 'autopilot section must name the autopilot skill/flow');
  assert.match(section, /normaliz/i, 'autopilot section must state the only addition is split normalization');
  assert.match(section, /Phase B/, 'autopilot section must locate normalization at the Phase B decision point');
  // single → dispatch-single → autopilot's existing single-implementer phase must be explicit so a
  // maintainer cannot bypass the Plan 1 router (plan-review round-1 caution).
  assert.match(section, /dispatch-single/, 'autopilot section must make single → dispatch-single explicit');
  // Residual-risk guard: the delegating front door must not redefine resume discovery or add flags.
  assert.ok(
    !/Enumerate sidecars/i.test(section),
    'autopilot section must not redefine resume discovery (owned by the autopilot skill)',
  );
  const flags = section.match(/(?<![A-Za-z0-9])--[A-Za-z][\w-]*/g) || [];
  assert.deepEqual(flags, [], `autopilot section must not introduce CLI flags; found: ${flags.join(', ')}`);
});

test('autopilot Phase B reads **Split:** via normalizeSplit and preserves legacy inference', () => {
  const section = sectionByHeader(readSkillFile('autopilot'), '## Phase B implementer-experts branch');
  assert.match(section, /normalizeSplit/, 'Phase B must name normalizeSplit as the canonical split reader');
  assert.match(section, /\*\*Split:\*\*/, 'Phase B must name the canonical **Split:** directive');
  // The three legacy routings must be re-stated as still valid (Goal 5 compatibility).
  assert.match(section, /\bsingle\b/, 'Phase B must keep: no directive → single');
  assert.match(section, /dispatchImplementers/, 'Phase B must keep: **Implementers:** → dispatchImplementers');
  assert.match(
    section,
    /\*\*Orchestration:\*\* hybrid|runHybridSlice/,
    'Phase B must keep: **Orchestration:** hybrid → runHybridSlice',
  );
});
