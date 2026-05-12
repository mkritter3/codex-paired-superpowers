// v0.9.0 slice 7a — structural smoke tests for skill prose.
//
// Codex plan round-2 critique flagged critical-tier prose changes as needing
// verification: every SKILL.md update for v0.9.0 must consistently reference
// the new dispatcher APIs (composeExperts, runTurnWithDeps, dispatchPanel,
// resolveAdapter, detectAvailableCLIs) and the new section headings.
//
// These tests are PURE STRUCTURAL — they assert substring presence in each
// SKILL.md (the user-visible prose), no behavior. They prevent silent prose
// regressions during the v0.9.x maintenance horizon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

function readSkill(name) {
  return readFileSync(join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf8');
}

// ── Per-skill structural requirements (single source of truth) ─────────────

const SKILL_STRUCTURE_REQUIREMENTS = {
  brainstorming: {
    required_headings: [
      '## Honest-reporting activation',
      '## Phase 0',
      '## Phase 2',
      '## Phase 3',
      '## Composer-selected expert spec-review',
    ],
    required_commands: [
      'mcp__plugin_codex-paired-superpowers_codex__codex-reply',
    ],
    required_api_refs: [
      'composeExperts',
      'runTurnWithDeps',
      'dispatchPanel',
      'resolveAdapter',
      'detectAvailableCLIs',
    ],
    forbidden_legacy: [
      // No legacy v0.8.x literals removed in 7a. Reserved for future migrations.
    ],
  },
  'writing-plans': {
    required_headings: [
      '## TDD test-list review (mandatory)',
      '## high_stakes frontmatter',
    ],
    required_commands: [
      'expert-test',
      // tdd-review is the v0.9.0 phase string passed to dispatchPanel and
      // matches the phase recorded in the sidecar.
      'tdd-review',
    ],
    required_api_refs: [
      'dispatchPanel',
      'composeExperts',
      'runTurnWithDeps',
      'resolveAdapter',
      'detectAvailableCLIs',
    ],
    forbidden_legacy: [],
  },
  'test-driven-development': {
    required_headings: [
      '## tdd-review (panel mode)',
    ],
    required_commands: [
      '--single',
      'expert-test',
    ],
    required_api_refs: [
      'dispatchPanel',
      'runTurnWithDeps',
    ],
    forbidden_legacy: [],
  },
  'subagent-driven-development': {
    required_headings: [
      '## Per-slice expert review',
    ],
    required_api_refs: [
      'composeExperts',
      'runTurnWithDeps',
      'resolveAdapter',
      'detectAvailableCLIs',
    ],
    required_commands: [
      'post-implementation-review',
    ],
    forbidden_legacy: [],
  },
  'systematic-debugging': {
    required_headings: [
      '## Composer-picked hypothesis review',
    ],
    required_api_refs: [
      'composeExperts',
      'runTurnWithDeps',
      'dispatchPanel',
    ],
    required_commands: [
      'hypothesis-review',
    ],
    forbidden_legacy: [],
  },
  autopilot: {
    required_headings: [
      '#### Phase B.0.5',
      '#### Phase B.1.5',
      '#### Phase B.5.5',
    ],
    required_api_refs: [
      'dispatchPanel',
      'resolveAdapter',
      'drainPeerDMs',
      'composeExperts',
      'runTurnWithDeps',
      'detectAvailableCLIs',
    ],
    required_commands: [
      'panel-quorum-unavailable',
      'panel-disagreement',
      'panel-quorum-lost',
      'panel-config-invalid',
      'cli-dispatch-failed',
    ],
    forbidden_legacy: [],
  },
};

// ── Frontmatter sanity (every SKILL.md must have YAML frontmatter) ─────────

function parseFrontmatterBoundary(content) {
  // Returns { hasFrontmatter, body } — we don't need full YAML parsing;
  // we only assert that the file STARTS with `---\n` and has a closing
  // `---\n` line within the first 50 lines.
  if (!content.startsWith('---\n')) return { hasFrontmatter: false, body: content };
  const closeIdx = content.indexOf('\n---\n', 4);
  if (closeIdx === -1) return { hasFrontmatter: false, body: content };
  return {
    hasFrontmatter: true,
    body: content.slice(closeIdx + 5),
    frontmatter: content.slice(4, closeIdx),
  };
}

// ── Generate one test suite per skill ──────────────────────────────────────

for (const [skillName, requirements] of Object.entries(SKILL_STRUCTURE_REQUIREMENTS)) {
  test(`${skillName}: SKILL.md exists and parses (frontmatter + body)`, () => {
    const content = readSkill(skillName);
    assert.ok(content.length > 0, `${skillName}/SKILL.md is empty`);
    const fm = parseFrontmatterBoundary(content);
    assert.equal(fm.hasFrontmatter, true,
      `${skillName}/SKILL.md must start with YAML frontmatter (\`---\\n...\\n---\\n\`)`);
    assert.ok(fm.frontmatter.includes(`name: ${skillName}`),
      `${skillName}/SKILL.md frontmatter must declare \`name: ${skillName}\``);
    assert.ok(fm.body.length > 100,
      `${skillName}/SKILL.md body must be non-trivial (got ${fm.body.length} chars)`);
  });

  test(`${skillName}: all required headings present`, () => {
    const content = readSkill(skillName);
    for (const heading of requirements.required_headings) {
      assert.ok(
        content.includes(heading),
        `${skillName}/SKILL.md missing required heading: ${JSON.stringify(heading)}`,
      );
    }
  });

  test(`${skillName}: all required API references present`, () => {
    const content = readSkill(skillName);
    for (const apiRef of requirements.required_api_refs) {
      assert.ok(
        content.includes(apiRef),
        `${skillName}/SKILL.md missing required API reference: ${JSON.stringify(apiRef)}`,
      );
    }
  });

  test(`${skillName}: all required command/syntax literals present`, () => {
    const content = readSkill(skillName);
    const required = requirements.required_commands || [];
    for (const cmd of required) {
      assert.ok(
        content.includes(cmd),
        `${skillName}/SKILL.md missing required command/literal: ${JSON.stringify(cmd)}`,
      );
    }
  });

  test(`${skillName}: no forbidden legacy literals`, () => {
    const content = readSkill(skillName);
    const forbidden = requirements.forbidden_legacy || [];
    for (const legacy of forbidden) {
      assert.equal(
        content.includes(legacy),
        false,
        `${skillName}/SKILL.md contains forbidden legacy literal: ${JSON.stringify(legacy)}`,
      );
    }
  });
}

// ── Cross-skill consistency (v0.9.0 invariants) ────────────────────────────

test('all 6 skills reference runTurnWithDeps (v0.9.0 replay-field contract)', () => {
  const skills = Object.keys(SKILL_STRUCTURE_REQUIREMENTS);
  for (const skill of skills) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('runTurnWithDeps'),
      `${skill}/SKILL.md must reference runTurnWithDeps (v0.9.0 dispatch contract)`,
    );
  }
});

test('writing-plans + test-driven-development + systematic-debugging + autopilot reference dispatchPanel', () => {
  for (const skill of ['writing-plans', 'test-driven-development', 'systematic-debugging', 'autopilot', 'brainstorming']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('dispatchPanel'),
      `${skill}/SKILL.md must reference dispatchPanel (v0.9.0 slice 6 panel contract)`,
    );
  }
});

test('autopilot declares all 5 v0.9.0 halt reasons', () => {
  const content = readSkill('autopilot');
  const required = [
    'panel-quorum-unavailable',
    'panel-disagreement',
    'panel-quorum-lost',
    'panel-config-invalid',
    'cli-dispatch-failed',
  ];
  for (const halt of required) {
    assert.ok(
      content.includes(halt),
      `autopilot/SKILL.md missing v0.9.0 halt reason: ${halt}`,
    );
  }
});

test('writing-plans declares TDD-mandatory enforcement (mandatory keyword present)', () => {
  const content = readSkill('writing-plans');
  // Per spec § 3: "TDD is mandatory in writing-plans. Every plan slice must
  // have a test list. expert-test must SHIP the list before the plan can ship."
  assert.ok(
    content.includes('TDD test-list review (mandatory)'),
    'writing-plans/SKILL.md must mark TDD test-list review as mandatory',
  );
  assert.ok(
    content.includes('MUST'),
    'writing-plans/SKILL.md TDD-mandatory phase must use MUST (not SHOULD/MAY)',
  );
});

test('writing-plans documents high_stakes frontmatter syntax', () => {
  const content = readSkill('writing-plans');
  // The exact frontmatter literal users must type in their plan slices.
  assert.ok(
    content.includes('**high_stakes: true**'),
    'writing-plans/SKILL.md must show the **high_stakes: true** frontmatter literal',
  );
});

test('test-driven-development documents --single override flag', () => {
  const content = readSkill('test-driven-development');
  assert.ok(
    content.includes('--single'),
    'test-driven-development/SKILL.md must document the --single override flag',
  );
  assert.ok(
    content.includes('panel mode'),
    'test-driven-development/SKILL.md must mention panel mode as the default',
  );
});

test('subagent-driven-development matches autopilot post-implementation-review phase name', () => {
  const sub = readSkill('subagent-driven-development');
  const auto = readSkill('autopilot');
  // Both must use the same phase string so sidecar audit can be uniform.
  assert.ok(
    sub.includes('post-implementation-review'),
    'subagent-driven-development/SKILL.md must use phase: post-implementation-review',
  );
  assert.ok(
    auto.includes('post-implementation-review'),
    'autopilot/SKILL.md must use phase: post-implementation-review (sidecar uniformity)',
  );
});

test('brainstorming preserves Codex double-SHIP gate prose (regression guard)', () => {
  const content = readSkill('brainstorming');
  // The composer-selected expert phase is ADDITIVE — it must not have removed
  // the double-SHIP gate or the 7-round loop.
  assert.ok(
    content.includes('double-SHIP'),
    'brainstorming/SKILL.md must still describe the double-SHIP gate',
  );
  assert.ok(
    content.includes('max 7 rounds'),
    'brainstorming/SKILL.md must still describe the 7-round loop',
  );
});

test('all 6 skills still reference codex MCP tool name (no accidental rename)', () => {
  // The codex MCP tool name is load-bearing per CLAUDE.md / spec; ensure
  // no v0.9.0 prose update accidentally renamed or removed it from the
  // skills that historically dispatch Codex directly.
  const skillsThatCallCodex = ['brainstorming', 'writing-plans', 'subagent-driven-development', 'systematic-debugging'];
  for (const skill of skillsThatCallCodex) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('mcp__plugin_codex-paired-superpowers_codex'),
      `${skill}/SKILL.md must reference the codex MCP tool by canonical name`,
    );
  }
});

test('every skill preserves honest-reporting activation block', () => {
  // v0.8.1 honest-reporting marker activation. Must survive every prose
  // refresh (Stop/PreToolUse hook depends on the marker file).
  const skills = Object.keys(SKILL_STRUCTURE_REQUIREMENTS);
  for (const skill of skills) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('honest-reporting-mark-active'),
      `${skill}/SKILL.md must preserve honest-reporting-mark-active invocation`,
    );
  }
});
