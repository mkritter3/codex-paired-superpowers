// v0.9.0 slice 7a — structural smoke tests for skill prose.
//
// Codex plan round-2 critique flagged critical-tier prose changes as needing
// verification: every SKILL.md update for v0.9.0 must consistently reference
// the new dispatcher APIs (composeReviewers, runTurnWithDeps, dispatchPanel,
// resolveAdapter, detectAvailableCLIs) and the new section headings.
//
// These tests are PURE STRUCTURAL — they assert substring presence in each
// SKILL.md (the user-visible prose), no behavior. They prevent silent prose
// regressions during the v0.9.x maintenance horizon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
      '## Composer-selected reviewer spec-review',
    ],
    required_commands: [
      'mcp__plugin_codex-paired-superpowers_codex__codex-reply',
    ],
    required_api_refs: [
      'composeReviewers',
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
      'reviewer-test',
      // tdd-review is the v0.9.0 phase string passed to dispatchPanel and
      // matches the phase recorded in the sidecar.
      'tdd-review',
    ],
    required_api_refs: [
      'dispatchPanel',
      'composeReviewers',
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
      'reviewer-test',
    ],
    required_api_refs: [
      'dispatchPanel',
      'runTurnWithDeps',
    ],
    forbidden_legacy: [],
  },
  'subagent-driven-development': {
    required_headings: [
      '## Per-slice reviewer review',
    ],
    required_api_refs: [
      'composeReviewers',
      'runTurnWithDeps',
      'resolveAdapter',
      'detectAvailableCLIs',
    ],
    required_commands: [
      'post-implementation-review',
      // v0.13.0: slice review uses the code-bearing `review-slice:<id>` phase (was `slice:<id>`),
      // which the verification gate enforces. Pin the canonical phase name so it can't regress.
      'review-slice:<slice-id>',
    ],
    forbidden_legacy: [],
  },
  'systematic-debugging': {
    required_headings: [
      '## Composer-picked hypothesis review',
    ],
    required_api_refs: [
      'composeReviewers',
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
      'composeReviewers',
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

// ── Round-1 slice-review structural fixes (Codex critique) ─────────────────
//
// Codex flagged three prose errors in round-1 slice-7a review that would
// route or audit incorrectly under real orchestration:
//   1. resolveAdapter called with identity.role (short form) instead of
//      identity.id ("expert-XXX"); recommendation keys use the id form.
//   2. Resolver prose claimed null return + `resolved.adapter` field, but
//      the real resolver THROWS RoleRoutingError and returns `{cli, ...}`.
//   3. Panel `dispatch_fn` wrappers called `runTurnWithDeps(req, ...)` with
//      no adapter binding, so slice 5b defaulted to 'claude-task' and
//      codex panelists would be audited as claude.
// These tests pin the corrected prose so the same drift can't recur silently.

const SKILLS_THAT_CALL_RESOLVE_ADAPTER = [
  'brainstorming',
  'subagent-driven-development',
  'systematic-debugging',
  'autopilot',
];

for (const skill of SKILLS_THAT_CALL_RESOLVE_ADAPTER) {
  test(`${skill}: resolveAdapter is called with identity.id (not identity.role)`, () => {
    const content = readSkill(skill);
    assert.ok(
      content.includes('resolveAdapter(identity.id'),
      `${skill}/SKILL.md must call resolveAdapter with identity.id ` +
        `(recommendation keys are "expert-XXX", which is identity.id, not identity.role)`,
    );
    assert.equal(
      content.includes('resolveAdapter(identity.role'),
      false,
      `${skill}/SKILL.md must NOT call resolveAdapter(identity.role, ...) — ` +
        `that resolves the short role name and throws UNKNOWN_ROLE at dispatch time`,
    );
  });

  test(`${skill}: prose uses resolved.cli (not resolved.adapter)`, () => {
    const content = readSkill(skill);
    // The resolver returns { cli, variant, ... }. There is no .adapter field
    // — that's a derived value the orchestrator computes for the sidecar.
    assert.equal(
      content.includes('resolved.adapter'),
      false,
      `${skill}/SKILL.md must NOT reference resolved.adapter — ` +
        `the resolver returns { cli, variant, ... }; compute adapter from cli`,
    );
    assert.ok(
      content.includes('resolved.cli'),
      `${skill}/SKILL.md must use resolved.cli (the real resolver return shape)`,
    );
  });

  test(`${skill}: prose treats resolveAdapter as throwing (not null-returning)`, () => {
    const content = readSkill(skill);
    // The resolver throws RoleRoutingError; describing it as returning null
    // would lead orchestrators to drop the throw and emit silent failures.
    assert.equal(
      content.includes('returns `null`'),
      false,
      `${skill}/SKILL.md must NOT say resolveAdapter returns null — ` +
        `it throws RoleRoutingError; the prose must show try/catch`,
    );
    assert.equal(
      content.includes('resolved === null'),
      false,
      `${skill}/SKILL.md must NOT show resolved === null check — ` +
        `the resolver throws on failure, it never returns null`,
    );
    assert.ok(
      content.includes('RoleRoutingError'),
      `${skill}/SKILL.md must reference RoleRoutingError (the thrown failure type)`,
    );
  });
}

const SKILLS_WITH_PANEL_DISPATCH_WRAPPERS = [
  'brainstorming',
  'writing-plans',
  'test-driven-development',
];

for (const skill of SKILLS_WITH_PANEL_DISPATCH_WRAPPERS) {
  test(`${skill}: panel dispatch_fn wrappers inject adapter into runTurnWithDeps`, () => {
    const content = readSkill(skill);
    // Slice-5b defaults missing request.adapter to 'claude-task'. The wrapper
    // MUST spread `adapter` into the request before calling runTurnWithDeps,
    // otherwise codex panelists are audited as claude (round-1 critique fix).
    assert.ok(
      content.includes('runTurnWithDeps({ ...req, adapter }'),
      `${skill}/SKILL.md panel wrappers must call runTurnWithDeps({ ...req, adapter }, ...) ` +
        `— a bare runTurnWithDeps(req, ...) leaves the sidecar adapter audit field defaulted ` +
        `to 'claude-task' regardless of the actual transport`,
    );
  });
}

// Autopilot uses the single-mode pattern (build request, call runTurnWithDeps(request, ...)),
// so the panel-wrapper substring doesn't apply. Instead, every runTurnWithDeps call site
// in autopilot must show the request carrying an `adapter` field — pinned structurally
// by counting the literal `adapter,` field appearances in autopilot's dispatch snippets
// (round-2 critique fix).
test('autopilot: resolvedByExpertId is plumbed through drainContext (consistency)', () => {
  const content = readSkill('autopilot');
  // Round-3 critique: the runTurn wrapper reads
  // `drainContext.resolvedByExpertId[expert.id]` to compute adapter, so the
  // SAME prose must show the map being built AND passed into the drainContext
  // option. Otherwise the wrapper dereferences undefined at runtime.
  const wrapperReads = content.includes('drainContext.resolvedByExpertId');
  const builderShown = content.includes('const resolvedByExpertId = {}');
  const passedThrough = /drainContext:\s*\{[^}]*resolvedByExpertId/.test(content);

  if (wrapperReads) {
    assert.ok(
      builderShown,
      'autopilot/SKILL.md runTurn wrapper reads drainContext.resolvedByExpertId ' +
        'but the surrounding prose does not show the map being built ' +
        '(`const resolvedByExpertId = {}` not found)',
    );
    assert.ok(
      passedThrough,
      'autopilot/SKILL.md runTurn wrapper reads drainContext.resolvedByExpertId ' +
        'but the drainContext options object does not include the field — ' +
        'the wrapper would dereference undefined at runtime',
    );
  }
});

test('autopilot: every runTurnWithDeps dispatch snippet binds adapter into the request', () => {
  const content = readSkill('autopilot');

  // Count bare `runTurnWithDeps(request,` and bare `runTurnWithDeps(req,` invocations.
  // Any such call must be paired with an `adapter,` field in the surrounding request.
  // The cleanest structural guard: forbid the bare pattern entirely AND require the
  // adapter-binding pattern to appear at least as many times as runTurnWithDeps calls
  // (so every dispatch site documents the audit-field contract).
  const runTurnCalls =
    (content.match(/runTurnWithDeps\(request,/g) || []).length +
    (content.match(/runTurnWithDeps\(req,/g) || []).length +
    (content.match(/runTurnWithDeps\(\{ \.\.\.req, adapter \},/g) || []).length;
  const adapterBindings =
    (content.match(/^\s*adapter,/gm) || []).length +
    (content.match(/runTurnWithDeps\(\{ \.\.\.req, adapter \},/g) || []).length;

  assert.ok(
    runTurnCalls > 0,
    'autopilot/SKILL.md must contain at least one runTurnWithDeps dispatch snippet',
  );
  assert.ok(
    adapterBindings >= runTurnCalls,
    `autopilot/SKILL.md has ${runTurnCalls} runTurnWithDeps call site(s) but only ` +
      `${adapterBindings} adapter binding(s). Every dispatch snippet must bind adapter ` +
      `into the request (or be a panel wrapper using { ...req, adapter }). Without ` +
      `binding, slice-5b defaults the sidecar audit field to 'claude-task' regardless ` +
      `of the actual transport (round-2 critique fix).`,
  );
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

// ── v0.10.0 skill structural smokes ─────────────────────────────────────────

test('autopilot SKILL.md contains v0.10.0 implementer-experts strings', () => {
  const content = readSkill('autopilot');
  for (const required of [
    'dispatchImplementers',
    'Implementers:',
    'merge-conflict',
    'post-merge-review',
  ]) {
    assert.ok(
      content.includes(required),
      `autopilot/SKILL.md missing v0.10.0 required string: ${JSON.stringify(required)}`
    );
  }
});

test('writing-plans SKILL.md contains v0.10.0 implementer-experts strings', () => {
  const content = readSkill('writing-plans');
  for (const required of [
    '**Implementers:**',
    'When to use implementer-experts',
  ]) {
    assert.ok(
      content.includes(required),
      `writing-plans/SKILL.md missing v0.10.0 required string: ${JSON.stringify(required)}`
    );
  }
});

// ── v0.10.0 ecosystem-doc structural smokes ──────────────────────────────────

function readIntegrationDoc(name) {
  return readFileSync(join(PLUGIN_ROOT, 'docs', 'integration', name), 'utf8');
}

test('docs/integration/v0.10.0-ecosystem-notes.md contains 6 boundary topic headers', () => {
  const content = readIntegrationDoc('v0.10.0-ecosystem-notes.md');
  const requiredHeaders = [
    '## 1. Namespace claim list',
    '## 2. Sidecar reader API deferred status',
    '## 3. Ralph-loop one-sided coupling',
    '## 4. Feature-dev coexistence',
    '## 5. Commit/PR attribution',
    '## 6. Future-grep policy',
  ];
  for (const header of requiredHeaders) {
    assert.ok(
      content.includes(header),
      `v0.10.0-ecosystem-notes.md missing required header: ${JSON.stringify(header)}`
    );
  }
});

test('docs/integration/future-grep-policy.md contains canonical grep commands', () => {
  const content = readIntegrationDoc('future-grep-policy.md');
  for (const required of [
    "grep -r 'Implementers:'",
    "grep -r 'high_cost'",
    "grep -r 'expert-implementer'",
  ]) {
    assert.ok(
      content.includes(required),
      `future-grep-policy.md missing required grep: ${JSON.stringify(required)}`
    );
  }
});

test('README.md contains pointer to v0.10.0-ecosystem-notes.md', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.ok(
    readme.includes('docs/integration/v0.10.0-ecosystem-notes.md'),
    'README.md must contain a link to docs/integration/v0.10.0-ecosystem-notes.md'
  );
});

// ── v0.13.0 Slice 1 — no plugin-authored per-call model for the codex MCP tool ──
//
// Goal 2: the model is pinned to gpt-5.5 by the MCP server config; plugin skills must
// NOT pass a per-call `model` to the codex / codex-reply MCP tool (a per-call model
// overrides the server pin and can reintroduce the stale-model 400). Enumerated by glob
// so a newly added skill that reintroduces a per-call model is caught without editing
// this test's file list. Excludes implementer-adapter frontmatter (a different `model:`
// concept) and sidecar bookkeeping (`sidecar-init --model`).

function collectSkillMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSkillMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function forbiddenPerCallModelLines(text) {
  return text.split('\n').reduce((acc, line, i) => {
    // A line is a violation if it instructs USE of a per-call model for the codex MCP tool.
    const setsModel =
      /"model"\s*:\s*"gpt-/.test(line) ||                 // JSON snippet field: "model": "gpt-..."
      /\bmust pass\b[^.]*\bmodel\b[^.]*gpt-5/i.test(line) || // prose: "you MUST pass `model: gpt-5.5`"
      /MODEL INVARIANT/.test(line);                       // the old invariant banner itself
    // Exemptions: explicit prohibitions, implementer-adapter frontmatter, sidecar bookkeeping.
    // (Hazard mentions of "stale"/"examples" alone do NOT exempt — an instruction can co-mention them.)
    const isExempt =
      /\bmust NOT\b|\bdo NOT\b|never pass|don't pass|\bomit\b/i.test(line) ||
      /sidecar-init/.test(line) ||
      /adapter:|member_id:|expert-implementer/.test(line);
    if (setsModel && !isExempt) acc.push({ line: i + 1, text: line.trim() });
    return acc;
  }, []);
}

test('no plugin-authored skill passes a per-call model to the codex MCP tool (Goal 2)', () => {
  const files = collectSkillMarkdown(join(PLUGIN_ROOT, 'skills'));
  assert.ok(files.length > 0, 'expected to find skill markdown files');
  const violations = [];
  for (const f of files) {
    const hits = forbiddenPerCallModelLines(readFileSync(f, 'utf8'));
    for (const h of hits) violations.push(`${f.replace(PLUGIN_ROOT + '/', '')}:${h.line}  ${h.text}`);
  }
  assert.deepEqual(
    violations,
    [],
    `Found plugin-authored per-call model directive(s) for the codex MCP tool. The model is ` +
      `pinned to gpt-5.5 by .claude-plugin/plugin.json; skills must omit per-call model.\n` +
      violations.join('\n'),
  );
});

test('v0.13.0: brainstorming + writing-plans happy path uses sidecar-append-round-with-audits', () => {
  for (const skill of ['brainstorming', 'writing-plans']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('sidecar-append-round-with-audits'),
      `${skill}/SKILL.md happy path must use the atomic sidecar-append-round-with-audits command`,
    );
  }
});

test('v0.13.0: brainstorming + writing-plans do not persist audits separately on the happy path', () => {
  // The happy path must persist audits+round atomically via sidecar-append-round-with-audits.
  // sidecar-append-audit may be NAMED as a manual-recovery fallback, but its piped CLI invocation
  // (`cli.js sidecar-append-audit`) must NOT appear — that is the old separate-write happy path.
  for (const skill of ['brainstorming', 'writing-plans']) {
    const content = readSkill(skill);
    assert.equal(
      content.includes('cli.js sidecar-append-audit'),
      false,
      `${skill}/SKILL.md must not invoke sidecar-append-audit on the happy path; use the atomic ` +
        `sidecar-append-round-with-audits (sidecar-append-audit may be named for manual recovery only)`,
    );
  }
});

test('v0.13.0: every codex-using skill documents Codex thread-loss recovery', () => {
  // The replay over real transcripts found 8 "Session not found" thread losses across
  // subagent-driven, autopilot, and brainstorm/plan flows — so EVERY skill that continues a Codex
  // thread must document the detect→replay→rotate recovery, not just brainstorming + writing-plans.
  for (const skill of ['brainstorming', 'writing-plans', 'subagent-driven-development', 'autopilot', 'systematic-debugging']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('Session not found for thread_id'),
      `${skill}/SKILL.md must describe detecting the stale-thread response`,
    );
    assert.ok(
      content.includes('sidecar-rotate-thread-id') || content.includes('recoverStaleThread'),
      `${skill}/SKILL.md must reference the thread-recovery primitive`,
    );
  }
});

test('TIA slice-boundary refresh documented in subagent-driven-development + autopilot', () => {
  for (const skill of ['subagent-driven-development', 'autopilot']) {
    const content = readSkill(skill);
    assert.match(content, /tia\.mjs refresh/, `${skill}/SKILL.md must document the slice-boundary TIA map refresh`);
  }
});

test('v0.13.0: edit discipline present in subagent-driven-development + autopilot', () => {
  for (const skill of ['subagent-driven-development', 'autopilot']) {
    const content = readSkill(skill);
    assert.ok(content.includes('File has not been read yet'),
      `${skill}/SKILL.md edit discipline must name the "File has not been read yet" failure`);
    assert.ok(content.includes('String to replace not found'),
      `${skill}/SKILL.md edit discipline must name the "String to replace not found" failure`);
    assert.ok(/never retry the same/i.test(content),
      `${skill}/SKILL.md edit discipline must forbid byte-identical retries ("never retry the same")`);
  }
});

test('brainstorming + writing-plans audit examples include a kind field (v0.13.0)', () => {
  for (const skill of ['brainstorming', 'writing-plans']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('sidecar-append-audit'),
      `${skill}/SKILL.md must still document sidecar-append-audit`,
    );
    assert.ok(
      content.includes('"kind"'),
      `${skill}/SKILL.md audit payload examples must include a "kind" field (v0.13.0 required schema)`,
    );
  }
});

test('stale gpt-5.2-codex literal appears only in hazard text', () => {
  const files = collectSkillMarkdown(join(PLUGIN_ROOT, 'skills'));
  const violations = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/gpt-5\.2-codex/.test(line) && !/must NOT|do NOT|never pass|don't pass|stale|NOT the model/i.test(line)) {
        violations.push(`${f.replace(PLUGIN_ROOT + '/', '')}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, [], `gpt-5.2-codex may only appear in hazard text:\n${violations.join('\n')}`);
});

// ── v0.14.0 Slice 7 — hybrid orchestration documented in writing-plans + autopilot ──

// Slice out a single `## ` section by its header so an assertion can't be satisfied by prose
// living elsewhere in the skill (round-1 critique: a whole-file /contract/i match was vacuous —
// the term appears many times outside the hybrid branch).
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

test('v0.14.0: writing-plans documents the hybrid plan syntax', () => {
  // Spec §5: a hybrid slice declares `**Orchestration:** hybrid` and exactly two REQUIRED owners —
  // a `claude-ui` half (logical adapter claude-ui) and a contract-producing `codex-backend` half
  // (adapter codex-background-bash), with a UI shim under __hybrid_contracts__, the no-overlap
  // file partition, and the slice `**Files:**`/claimed-file correspondence.
  const section = sectionByHeader(readSkill('writing-plans'), '## When to use hybrid orchestration (v0.14.0)');
  for (const required of [
    '**Orchestration:** hybrid',
    'owner: claude-ui',
    'owner: codex-backend',
    'adapter: claude-ui',
    'adapter: codex-background-bash',
    'required: true',
    '__hybrid_contracts__',
  ]) {
    assert.ok(
      section.includes(required),
      `writing-plans hybrid section missing required string: ${JSON.stringify(required)}`,
    );
  }
  // The exactly-two-required-owners rule and the **Files:**/claimed-file partition rule.
  assert.match(section, /[Ee]xactly two owners/, 'hybrid section must state the exactly-two-owners rule');
  assert.match(
    section,
    /no file (appears|touched) (under both|by both)|claimed by exactly one owner/,
    'hybrid section must state the no-overlap / single-owner file partition rule',
  );
  assert.match(
    section,
    /\*\*Files:\*\*/,
    'hybrid section must tie owner claimed files back to the slice **Files:** block',
  );
});

test('v0.14.0: autopilot documents the Phase B hybrid branch', () => {
  // Spec §9: hybrid slices route away from the symmetric implementer-experts branch into
  // runHybridSlice (UI subagent + background Codex), wait on the contract, resync on a
  // contract change, recover a lost background Codex run, and verify claimed files.
  // Scope every assertion to the hybrid section so it cannot pass on unrelated prose.
  const section = sectionByHeader(readSkill('autopilot'), '## Phase B hybrid branch (v0.14.0)');
  for (const required of [
    'runHybridSlice',
    'hybrid/runner.js',
    'claude-subagent',
    'codex-background-bash',
    'hybrid-codex-background-lost',
    'hybrid-contract-stale-at-completion',
  ]) {
    assert.ok(
      section.includes(required),
      `autopilot hybrid section missing required string: ${JSON.stringify(required)}`,
    );
  }
  // The branch must explicitly route hybrid slices away from the symmetric dispatch path.
  assert.ok(
    section.includes('**Orchestration:** hybrid') && section.includes('dispatchImplementers'),
    'autopilot hybrid section must contrast `**Orchestration:** hybrid` with the dispatchImplementers (symmetric) path',
  );
  // Contract wait + contract-change resync + claimed-file verification prose, scoped to the section.
  assert.match(section, /contract/i, 'autopilot hybrid section must describe the contract wait');
  assert.match(section, /resync/i, 'autopilot hybrid section must describe contract-change resync');
  assert.match(section, /claimed[- ]file/i, 'autopilot hybrid section must describe claimed-file verification');
});

test('v0.14.0: hybrid orchestration type named consistently across both skills', () => {
  for (const skill of ['writing-plans', 'autopilot']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('**Orchestration:** hybrid'),
      `${skill}/SKILL.md must name the hybrid orchestration type as "**Orchestration:** hybrid"`,
    );
  }
});

// ── Plan 3 Slice 8 — reviewer-named skill prose (six skills) ──
//
// New write/dispatch prose must name the reviewer APIs/fields/ids. The legacy
// expert-* surface keeps working via runtime shims (validated by
// skill-dispatch-integration.test.js), but the SKILL.md instructions must point
// new work at the canonical reviewer names. Writer-side `expert-implementer` and
// `hybrid-*` ids are a DIFFERENT (implementer) sense and are out of scope.

const REVIEWER_PROSE_SKILLS = [
  'brainstorming',
  'writing-plans',
  'test-driven-development',
  'subagent-driven-development',
  'systematic-debugging',
  'autopilot',
];

// Reviewer-sense role-id stems. `implementer` is intentionally excluded (it is
// the writer-side sense, untouched by this migration).
const REVIEWER_ROLE_STEMS = ['test', 'security', 'architecture', 'ui', 'ux', 'backend', 'ai-harness'];

// Forbidden expert-sense literals in NEW write/dispatch instructions. Each is a
// reviewer-sense name with a canonical reviewer replacement. `updateExpertStatus`
// and `appendFanOutRationale` are NOT listed — they were not renamed (no reviewer
// export exists), so they remain valid.
const FORBIDDEN_EXPERT_SENSE_LITERALS = [
  'composeExperts',
  'expert-turn',      // import path expert-turn.js → reviewer-turn.js
  'expert-runtime',   // import path expert-runtime.js → reviewer-runtime.js
  'expert_teammates',
  'experts_selected',
  'expert_turn_ids',
  'expert_blockers',
  'appendExpert',     // appendExpertSelection/Turn → appendReviewer*
  ...REVIEWER_ROLE_STEMS.map((r) => `expert-${r}`),
];

test('Slice 8: writing-plans emits **Reviewers:** (canonical) and notes **Experts:** deprecated', () => {
  const content = readSkill('writing-plans');
  assert.ok(
    content.includes('**Reviewers:**'),
    'writing-plans must document the canonical **Reviewers:** plan directive',
  );
  assert.match(
    content,
    /\*\*Experts:\*\*[\s\S]{0,200}?deprecat/i,
    'writing-plans must note the **Experts:** directive is deprecated',
  );
});

test('Slice 8: autopilot + subagent-driven-development build composer signals from reviewers with experts fallback', () => {
  for (const skill of ['autopilot', 'subagent-driven-development']) {
    const content = readSkill(skill);
    // Canonical reviewers directive read, with the deprecated experts fallback.
    assert.ok(
      content.includes('reviewersDirective'),
      `${skill}/SKILL.md must build composer signals from sliceFrontmatter.reviewers (reviewersDirective)`,
    );
    assert.ok(
      content.includes('sliceFrontmatter.reviewers'),
      `${skill}/SKILL.md must read the canonical sliceFrontmatter.reviewers directive`,
    );
    assert.ok(
      content.includes('sliceFrontmatter.experts'),
      `${skill}/SKILL.md must keep sliceFrontmatter.experts as a deprecated fallback`,
    );
    // Reviewer write APIs/fields in the sidecar-write prose.
    assert.ok(
      content.includes('composeReviewers'),
      `${skill}/SKILL.md must dispatch via composeReviewers`,
    );
  }
  // autopilot sidecar-write fields specifically.
  const auto = readSkill('autopilot');
  for (const field of ['reviewer_teammates', 'reviewers_selected', 'reviewer_turn_ids', 'reviewer_blockers']) {
    assert.ok(
      auto.includes(field),
      `autopilot/SKILL.md sidecar-write prose must name reviewer field ${JSON.stringify(field)}`,
    );
  }
  assert.ok(
    auto.includes('appendReviewerSelection') && auto.includes('appendReviewerTurn'),
    'autopilot/SKILL.md must name the reviewer write APIs (appendReviewerSelection/appendReviewerTurn)',
  );
});

test('Slice 8: all six reviewer-prose skills dispatch via composeReviewers (not composeExperts)', () => {
  for (const skill of REVIEWER_PROSE_SKILLS) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('composeReviewers'),
      `${skill}/SKILL.md must reference composeReviewers`,
    );
  }
});

test('Slice 8: writing-plans + test-driven-development panel prose uses reviewer-test AND reviewer-test@${cli} composite', () => {
  for (const skill of ['writing-plans', 'test-driven-development']) {
    const content = readSkill(skill);
    assert.ok(
      content.includes('reviewer-test'),
      `${skill}/SKILL.md panel prose must dispatch the reviewer-test role`,
    );
    assert.ok(
      content.includes('reviewer-test@${cli}'),
      `${skill}/SKILL.md panel prose must build the member_id composite as reviewer-test@\${cli}`,
    );
    assert.equal(
      content.includes('expert-test@${cli}'),
      false,
      `${skill}/SKILL.md must NOT keep the legacy expert-test@\${cli} composite in a new-dispatch instruction`,
    );
  }
});

test('Slice 8: no reviewer-prose skill names forbidden expert-sense literals', () => {
  const violations = [];
  for (const skill of REVIEWER_PROSE_SKILLS) {
    const content = readSkill(skill);
    content.split('\n').forEach((line, i) => {
      for (const lit of FORBIDDEN_EXPERT_SENSE_LITERALS) {
        if (line.includes(lit)) {
          violations.push(`${skill}:${i + 1}  ${lit}  ::  ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `Found forbidden expert-sense literal(s) in reviewer-prose skills. New write/dispatch ` +
      `instructions must use reviewer naming (the expert-* runtime shims still work but skill ` +
      `prose must point new work at the canonical names):\n${violations.join('\n')}`,
  );
});

// ── Plan 2 Slice 2 — unified execution skill + /execute command ──

function readCommand(name) {
  return readFileSync(join(PLUGIN_ROOT, 'commands', name), 'utf8');
}

test('execution skill exists and names both drivers', () => {
  const content = readSkill('execution');
  assert.ok(content.includes('driver: interactive'), 'execution skill must name `driver: interactive`');
  assert.ok(content.includes('driver: autopilot'), 'execution skill must name `driver: autopilot`');
});

test('execution skill documents no-arg resume as autopilot-only (scoped to selection rules)', () => {
  // Scope to the selection-rules section so the assertion can't pass on unrelated prose.
  const section = sectionByHeader(readSkill('execution'), '## Selection rules');
  assert.match(
    section,
    /autopilot-only/i,
    'selection rules must state no-argument resume is autopilot-only (spec rule 3)',
  );
  assert.match(
    section,
    /sidecar/i,
    'selection rules must state no-arg resume reuses the /autopilot sidecar scan',
  );
  assert.match(
    section,
    /\/autopilot/,
    'selection rules must reference the same /autopilot resume behavior',
  );
});

test('execution skill states interactive requires a plan path / is non-resumable (scoped)', () => {
  const section = sectionByHeader(readSkill('execution'), '## Selection rules');
  assert.match(section, /driver: interactive/, 'selection rules must mention `driver: interactive`');
  assert.match(
    section,
    /not resum|non-resumable|requires a plan path|plan path/i,
    'selection rules must state interactive needs a plan path and is not resumed from sidecar state (spec rule 4)',
  );
});

test('/execute command exists and documents driver + no-arg autopilot resume', () => {
  const content = readCommand('execute.md');
  assert.match(
    content,
    /driver=<interactive\|autopilot>/,
    '/execute must document `driver=<interactive|autopilot>`',
  );
  assert.match(content, /plan[- ]path|plan path|<plan-path>/i, '/execute must document the plan path argument');
  assert.match(content, /autopilot/i, '/execute must document no-argument autopilot resume');
});

test('execution skill forbids internal labels in user-visible output', () => {
  const content = readSkill('execution');
  assert.match(content, /plain[- ]english/i, 'execution skill must require plain-English user-visible output');
  assert.ok(
    content.includes('slice') && content.includes('SHIP') && content.includes('Phase B'),
    'execution skill output guard must name the forbidden internal labels (slice / SHIP / Phase B)',
  );
});

test('/execute launches the execution skill and forwards arguments', () => {
  const content = readCommand('execute.md');
  assert.ok(
    content.includes('codex-paired-superpowers:execution'),
    '/execute must invoke `codex-paired-superpowers:execution`',
  );
  assert.ok(
    content.includes('Arguments: $ARGUMENTS'),
    '/execute must forward raw arguments via `Arguments: $ARGUMENTS`',
  );
});

// ── Plan 2 Slice 3 — /autopilot thin alias (behavior-identical) ──

// Byte-exact snapshot of the `## How resume works` section captured BEFORE the alias edit.
// The alias only rewrites the `## What happens` section; this section must remain unchanged so
// resume-discovery semantics (sidecar scan, terminal-halt handling, exactly-one/several/none
// branches, handoff note) cannot silently regress under a "critical" alias change.
const AUTOPILOT_RESUME_SECTION_PRE_EDIT =
  "## How resume works (read this for session handoff)\n\n- **With a plan path:** start that plan, or resume it if its sidecar already has autopilot progress.\n- **With no argument:** the spec/plan isn't known yet, so locate the in-progress run by scanning\n  sidecars, then resume it:\n  1. Enumerate sidecars under `.superpowers-codex-paired/` (they are `<spec-path>.json`).\n  2. For each, inspect its state: an app-autopilot run has `app_state.active_plan` set\n     (`app-state-get --specPath <that-spec>`); a single-plan run has an `autopilot` block with\n     `current_phase` ≠ `all_done`. Treat either as \"in progress\" unless it carries a terminal\n     `halt_reason` (those need the user to act first — surface the resume hint).\n  3. If exactly one in-progress run is found, resume it (use its `active_plan`, or the plan the\n     sidecar's spec frontmatter points to). If several, list them and ask which. If none, say so and\n     point the user at `/autopilot <plan-path>`.\n\nBecause state is in the sidecar, **handing off to a brand-new session just means running `/autopilot`\nagain** — no need to remember the plan path or re-supply any flags.\n";

test('/autopilot delegates to execution with driver: autopilot', () => {
  const content = readCommand('autopilot.md');
  assert.ok(
    content.includes('codex-paired-superpowers:execution'),
    '/autopilot must invoke `codex-paired-superpowers:execution` (thin alias)',
  );
  assert.ok(
    content.includes('driver: autopilot'),
    '/autopilot must pass `driver: autopilot`',
  );
});

test('/autopilot still forwards $ARGUMENTS via the trailing Plan line', () => {
  const content = readCommand('autopilot.md');
  assert.ok(
    content.trimEnd().endsWith('Plan: $ARGUMENTS'),
    '/autopilot must still end with `Plan: $ARGUMENTS` (plan path forwarding preserved)',
  );
});

test('/autopilot resume-discovery section is byte-identical to the pre-alias snapshot', () => {
  const section = sectionByHeader(readCommand('autopilot.md'), '## How resume works (read this for session handoff)');
  assert.equal(
    section,
    AUTOPILOT_RESUME_SECTION_PRE_EDIT,
    'the `## How resume works` section must not change under the thin-alias edit',
  );
  // Usage lines must also remain present (asserted outside the resume section).
  const content = readCommand('autopilot.md');
  assert.ok(
    content.includes('/autopilot                       # resume the in-progress autopilot run (handoff-friendly)'),
    '/autopilot usage block must keep the no-arg resume line',
  );
  assert.ok(
    content.includes('/autopilot docs/plans/<plan>.md  # start (or resume) a specific plan'),
    '/autopilot usage block must keep the plan-path line',
  );
});

test('/autopilot alias introduces no new -- flags', () => {
  const content = readCommand('autopilot.md');
  const flags = content.match(/(?<![A-Za-z0-9])--[A-Za-z][\w-]*/g) || [];
  // Today the only `--` token is `--specPath` inside the resume-discovery example prose.
  // The thin-alias edit must not add any new flag shapes beyond that baseline.
  assert.deepEqual(
    [...new Set(flags)].sort(),
    ['--specPath'],
    `/autopilot must not introduce new CLI flags; found: ${flags.join(', ')}`,
  );
});

// ── Plan 4 — canonical execution-model doc + cross-links + duplicate-matrix guard ──
//
// Goal 6: one short canonical three-choice mental model. `docs/execution-model.md` is
// the single driver/split/review doc; README + skills link to it instead of copying the
// matrix; a grep guard forbids a second full matrix from drifting out of sync.

const EXECUTION_MODEL_DOC_REL = 'docs/execution-model.md';
// The canonical driver/split table header. Any file other than the canonical doc that
// reproduces this exact header is a duplicated matrix and must point back to the doc.
const MATRIX_HEADER = '| Driver | single | two-disjoint | hybrid-ui-backend |';

function readExecutionModelDoc() {
  return readFileSync(join(PLUGIN_ROOT, 'docs', 'execution-model.md'), 'utf8');
}

test('Plan 4: docs/execution-model.md exists and contains the driver/split matrix', () => {
  const doc = readExecutionModelDoc();
  assert.ok(doc.includes(MATRIX_HEADER), `execution-model.md must contain the matrix header: ${MATRIX_HEADER}`);
  assert.match(doc, /^\|\s*interactive\s*\|/m, 'execution-model.md matrix must have an `interactive` row');
  assert.match(doc, /^\|\s*autopilot\s*\|/m, 'execution-model.md matrix must have an `autopilot` row');
});

test('Plan 4: docs/execution-model.md marks the app driver as outside v1', () => {
  const doc = readExecutionModelDoc();
  assert.match(
    doc,
    /app[\s-]?autopilot|multi-plan app driver/i,
    'execution-model.md must mention the experimental multi-plan app driver',
  );
  assert.match(
    doc,
    /outside (this table|v1)|experimental|not (in|part of) v1/i,
    'execution-model.md must mark the app driver as outside v1 / experimental',
  );
});

test('Plan 4: README links to the canonical doc and names execution as the stable entry', () => {
  const readme = readFileSync(join(PLUGIN_ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes(EXECUTION_MODEL_DOC_REL), `README must link to ${EXECUTION_MODEL_DOC_REL}`);
  assert.ok(readme.includes('`execution`'), 'README must list the `execution` skill as the stable entry point');
  assert.match(
    readme,
    /\/autopilot[^\n]*\b(alias|compatibilit)/i,
    'README must document /autopilot as a compatibility alias',
  );
});

test('Plan 4: execution skill links to the canonical doc', () => {
  const skill = readSkill('execution');
  assert.ok(
    skill.includes(EXECUTION_MODEL_DOC_REL),
    `skills/execution/SKILL.md must link to ${EXECUTION_MODEL_DOC_REL}`,
  );
});

test('Plan 4: writing-plans documents **Split:** and **Reviewers:** canonical directives', () => {
  const skill = readSkill('writing-plans');
  assert.ok(skill.includes('**Split:**'), 'writing-plans must document the canonical **Split:** directive');
  assert.ok(skill.includes('**Reviewers:**'), 'writing-plans must document the canonical **Reviewers:** directive');
});

test('Plan 4: brainstorming handoff offers execution with driver choices', () => {
  const section = sectionByHeader(readSkill('brainstorming'), '## Phase 5 — Hand off');
  assert.ok(section.includes('execution'), 'brainstorming Phase 5 handoff must offer the execution skill');
  assert.ok(
    section.includes('interactive') && section.includes('autopilot'),
    'brainstorming Phase 5 handoff must name the interactive/autopilot driver choices',
  );
});

test('Plan 4: no duplicate full matrix outside the canonical doc (grep guard)', () => {
  const candidates = [
    join(PLUGIN_ROOT, 'README.md'),
    ...collectSkillMarkdown(join(PLUGIN_ROOT, 'docs')),
    ...collectSkillMarkdown(join(PLUGIN_ROOT, 'skills')),
  ];
  const canonicalAbs = join(PLUGIN_ROOT, 'docs', 'execution-model.md');
  const violations = [];
  for (const f of candidates) {
    if (f === canonicalAbs) continue;
    const content = readFileSync(f, 'utf8');
    if (!content.includes(MATRIX_HEADER)) continue;
    // A duplicated matrix is allowed only if the file points back to the canonical doc.
    if (!content.includes(EXECUTION_MODEL_DOC_REL)) {
      violations.push(f.replace(PLUGIN_ROOT + '/', ''));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Found a full driver/split matrix outside ${EXECUTION_MODEL_DOC_REL} without a link back to it: ` +
      `${violations.join(', ')}. Link to the canonical doc instead of copying the matrix.`,
  );
});
