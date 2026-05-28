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

test('v0.13.0: brainstorming + writing-plans document Codex thread-loss recovery', () => {
  for (const skill of ['brainstorming', 'writing-plans']) {
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
