// Tests for lib/codex-bridge/execution/split-dispatcher.js
// (Unified execution driver — Plan 1: shared split dispatcher).
// Validation tier: critical.
//
// All assertions are result-oriented (observable return shape / thrown .code),
// and use the REAL parsers (no mocks) so parse-order and delegation are pinned
// against actual behavior. Slice-2 routing tests inject runner spies via `deps`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSplitDirective,
  parseOrchestrationMarker,
  normalizeSplit,
  runSplit,
} from '../../../lib/codex-bridge/execution/split-dispatcher.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal plan markdown with no top frontmatter (high_cost defaults false). */
function plan(sliceSection) {
  return `# Test plan\n\n${sliceSection}\n`;
}

/** Build a slice section with an optional body. */
function slice(body) {
  return `## Slice 1: Test\n\n${body}\n`;
}

/** A valid two-disjoint **Implementers:** block (claude-cli + codex-cli). */
function twoImplementers() {
  return [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  adapter: claude-cli',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - lib/a.js',
    '- member_id: expert-implementer@codex:gpt-5.5#0',
    '  adapter: codex-cli',
    '  model: gpt-5.5',
    '  required: true',
    '  files:',
    '    - lib/b.js',
  ].join('\n');
}

/** N implementers (>=3) using the two valid adapters, alternating. */
function nImplementers(n) {
  const out = ['**Implementers:**'];
  for (let i = 0; i < n; i++) {
    const isClaude = i % 2 === 0;
    out.push(
      isClaude
        ? `- member_id: expert-implementer@claude:kimi-k2.6:cloud#${i}`
        : `- member_id: expert-implementer@codex:gpt-5.5#${i}`,
      isClaude ? '  adapter: claude-cli' : '  adapter: codex-cli',
      isClaude ? '  model: kimi-k2.6:cloud' : '  model: gpt-5.5',
      '  required: true',
      '  files:',
      `    - lib/f${i}.js`
    );
  }
  return out.join('\n');
}

/** A valid hybrid owner block: one claude-ui + one codex-backend owner. */
function hybridOwners({ uiFiles = ['ui/app.js'], beFiles = ['lib/api.js'] } = {}) {
  return [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  owner: claude-ui',
    '  adapter: claude-ui',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    ...uiFiles.map((f) => `    - ${f}`),
    '- member_id: expert-implementer@codex:gpt-5.5#0',
    '  owner: codex-backend',
    '  adapter: codex-background-bash',
    '  model: gpt-5.5',
    '  required: true',
    '  files:',
    ...beFiles.map((f) => `    - ${f}`),
  ].join('\n');
}

/** A **Files:** block listing the given paths. */
function filesBlock(paths) {
  return ['**Files:**', ...paths.map((p) => `- ${p}`)].join('\n');
}

// ── Slice 1, Task 1 (RED): directive + marker parsers ────────────────────────

test('case 1: no directive, no legacy blocks → single, empty legacy/warnings', () => {
  const sliceSection = slice('Just prose, nothing structural.');
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'single');
  assert.deepEqual(result.legacySyntax, []);
  assert.deepEqual(result.warnings, []);
});

test('case 2: **Split:** single → single', () => {
  const sliceSection = slice('**Split:** single');
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'single');
});

test('case 10: unknown **Split:** value → split-directive-unknown', () => {
  const sliceSection = slice('**Split:** parallel');
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && err.code === 'split-directive-unknown'
  );
});

test('case 11: parseOrchestrationMarker recognizes only hybrid', () => {
  assert.equal(parseOrchestrationMarker('**Orchestration:** hybrid'), 'hybrid');
  assert.equal(parseOrchestrationMarker('no marker here'), null);
  assert.equal(parseOrchestrationMarker('**Orchestration:** serial'), null);
});

// Direct unit coverage of the directive parser (supports the cases above).
test('parseSplitDirective: known values, absence, and unknown', () => {
  assert.equal(parseSplitDirective('**Split:** single'), 'single');
  assert.equal(parseSplitDirective('**Split:** two-disjoint'), 'two-disjoint');
  assert.equal(parseSplitDirective('**Split:** hybrid-ui-backend'), 'hybrid-ui-backend');
  assert.equal(parseSplitDirective('no directive'), null);
  assert.throws(
    () => parseSplitDirective('**Split:** parallel'),
    (err) => err && err.code === 'split-directive-unknown'
  );
});

// ── Slice 1: normalization cases (3-9, 12-17) ────────────────────────────────

test('case 3: **Split:** single with an **Implementers:** block → split-single-with-implementers', () => {
  const sliceSection = slice(`**Split:** single\n\n${twoImplementers()}`);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && err.code === 'split-single-with-implementers'
  );
});

test('case 4: **Split:** two-disjoint with exactly two implementers → two-disjoint', () => {
  const sliceSection = slice(`**Split:** two-disjoint\n\n${twoImplementers()}`);
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'two-disjoint');
  assert.equal(result.config.implementers.length, 2);
});

test('case 5: **Split:** two-disjoint with three implementers → split-two-disjoint-not-exactly-two', () => {
  const sliceSection = slice(`**Split:** two-disjoint\n\n${nImplementers(3)}`);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && err.code === 'split-two-disjoint-not-exactly-two'
  );
});

test('case 6: no **Split:**, legacy **Implementers:** (3 members) → two-disjoint, legacySyntax, warning', () => {
  const sliceSection = slice(nImplementers(3));
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'two-disjoint');
  assert.deepEqual(result.legacySyntax, ['implementers']);
  assert.ok(result.warnings.length >= 1);
});

test('case 7: **Split:** hybrid-ui-backend with both owners → hybrid, config.owners has both', () => {
  const body = `**Split:** hybrid-ui-backend\n\n${filesBlock(['ui/app.js', 'lib/api.js'])}\n\n${hybridOwners()}`;
  const sliceSection = slice(body);
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'hybrid-ui-backend');
  assert.equal(result.config.owners.length, 2);
  const owners = result.config.owners.map((o) => o.owner).sort();
  assert.deepEqual(owners, ['claude-ui', 'codex-backend']);
});

test('case 8: **Split:** hybrid-ui-backend missing codex-backend owner → hybrid-ownership-malformed (not implementer-directive-malformed)', () => {
  const onlyUi = [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  owner: claude-ui',
    '  adapter: claude-ui',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - ui/app.js',
  ].join('\n');
  const body = `**Split:** hybrid-ui-backend\n\n${filesBlock(['ui/app.js'])}\n\n${onlyUi}`;
  const sliceSection = slice(body);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => {
      assert.equal(err.code, 'hybrid-ownership-malformed');
      assert.notEqual(err.code, 'implementer-directive-malformed');
      return true;
    }
  );
});

test('case 9: no **Split:**, legacy **Orchestration:** hybrid + valid owners → hybrid, legacySyntax orchestration, warning', () => {
  const body = `**Orchestration:** hybrid\n\n${filesBlock(['ui/app.js', 'lib/api.js'])}\n\n${hybridOwners()}`;
  const sliceSection = slice(body);
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'hybrid-ui-backend');
  assert.deepEqual(result.legacySyntax, ['orchestration']);
  assert.ok(result.warnings.length >= 1);
});

test('case 12: **Split:** single + **Orchestration:** hybrid marker, no implementers block → split-single-with-implementers', () => {
  const sliceSection = slice('**Split:** single\n\n**Orchestration:** hybrid');
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && err.code === 'split-single-with-implementers'
  );
});

test('case 13: **Split:** single whose block uses a hybrid-like adapter → split-single-with-implementers (NOT implementer-directive-malformed)', () => {
  const hybridLikeBlock = [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  owner: claude-ui',
    '  adapter: claude-ui',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - ui/app.js',
  ].join('\n');
  const sliceSection = slice(`**Split:** single\n\n${hybridLikeBlock}`);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => {
      assert.equal(err.code, 'split-single-with-implementers');
      assert.notEqual(err.code, 'implementer-directive-malformed');
      return true;
    }
  );
});

test('case 14: **Split:** two-disjoint with exactly ONE implementer → split-two-disjoint-not-exactly-two (lower boundary)', () => {
  const oneImpl = [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  adapter: claude-cli',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - lib/a.js',
  ].join('\n');
  const sliceSection = slice(`**Split:** two-disjoint\n\n${oneImpl}`);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && err.code === 'split-two-disjoint-not-exactly-two'
  );
});

test('case 15: directive whitespace is trimmed; non-canonical casing is unknown', () => {
  const trimmed = slice(`**Split:**   two-disjoint  \n\n${twoImplementers()}`);
  const result = normalizeSplit({ planMarkdown: plan(trimmed), sliceSection: trimmed });
  assert.equal(result.split, 'two-disjoint');

  const cased = slice('**Split:** Two-Disjoint');
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(cased), sliceSection: cased }),
    (err) => err && err.code === 'split-directive-unknown'
  );
});

test('case 16: **Split:** two-disjoint + stray **Orchestration:** hybrid → two-disjoint, marker not silently dropped (warning)', () => {
  const body = `**Split:** two-disjoint\n\n**Orchestration:** hybrid\n\n${twoImplementers()}`;
  const sliceSection = slice(body);
  const result = normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection });
  assert.equal(result.split, 'two-disjoint');
  assert.ok(result.warnings.length >= 1);
  assert.ok(
    result.warnings.some((w) => /orchestration/i.test(w)),
    'a warning must name the ignored orchestration marker'
  );
});

test('case 17: **Split:** hybrid-ui-backend with valid owners but empty per-owner Files → hybrid-* halt from validateHybridOwnership', () => {
  // Owner blocks with a `files:` key but no bullets → empty per-owner files.
  const emptyOwnerFiles = [
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  owner: claude-ui',
    '  adapter: claude-ui',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '- member_id: expert-implementer@codex:gpt-5.5#0',
    '  owner: codex-backend',
    '  adapter: codex-background-bash',
    '  model: gpt-5.5',
    '  required: true',
    '  files:',
  ].join('\n');
  const body = `**Split:** hybrid-ui-backend\n\n${emptyOwnerFiles}`;
  const sliceSection = slice(body);
  assert.throws(
    () => normalizeSplit({ planMarkdown: plan(sliceSection), sliceSection }),
    (err) => err && typeof err.code === 'string' && err.code.startsWith('hybrid-')
  );
});

// ── Slice 2: runSplit routing + driver mode pass-through ─────────────────────

/** A spy returning a recording function + call log. */
function spy(returnValue) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return returnValue;
  };
  fn.calls = calls;
  return fn;
}

/** Build a workItem for a slice section. */
function workItemFor(sliceSection, extra = {}) {
  return {
    planMarkdown: plan(sliceSection),
    sliceSection,
    sliceId: 'slice-1',
    sliceStartSha: 'abc123',
    integrationBranch: 'integration/test',
    ...extra,
  };
}

test('slice-2 case 1: single routes to deps.runSingle once; other runners not called', async () => {
  const sliceSection = slice('**Split:** single');
  const runSingle = spy({ outcome: 'done' });
  const dispatchImplementers = spy({});
  const runHybridSlice = spy({});
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { runSingle, dispatchImplementers, runHybridSlice },
  });
  assert.equal(runSingle.calls.length, 1);
  assert.equal(dispatchImplementers.calls.length, 0);
  assert.equal(runHybridSlice.calls.length, 0);
});

test('slice-2 case 2: two-disjoint routes to deps.dispatchImplementers with threaded fields', async () => {
  const sliceSection = slice(`**Split:** two-disjoint\n\n${twoImplementers()}`);
  const dispatchImplementers = spy({ success: [] });
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { dispatchImplementers },
  });
  assert.equal(dispatchImplementers.calls.length, 1);
  const arg = dispatchImplementers.calls[0][0];
  assert.equal(arg.specPath, 's.md');
  assert.equal(arg.sliceId, 'slice-1');
  assert.equal(arg.implementers.length, 2);
});

test('slice-2 case 2b: two-disjoint passes RUNTIME-shaped implementers (memberId + non-empty claimedFiles), not parser shape', async () => {
  // Regression for the Codex slice-review round-1 finding: runSplit used to pass
  // parser-shaped entries ({member_id, files}) straight to dispatchImplementers,
  // which reads {memberId, claimedFiles} — keying the run by undefined and
  // dispatching with empty claimed files. This test fails on the old code.
  const sliceSection = slice(`**Split:** two-disjoint\n\n${twoImplementers()}`);
  const dispatchImplementers = spy({ success: [] });
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { dispatchImplementers },
  });
  const { implementers } = dispatchImplementers.calls[0][0];
  for (const impl of implementers) {
    assert.ok(impl.memberId, 'memberId must be defined and non-empty');
    assert.ok(Array.isArray(impl.claimedFiles) && impl.claimedFiles.length > 0, 'claimedFiles must be non-empty');
    // No parser-shaped keys leak through.
    assert.equal('member_id' in impl, false, 'parser key member_id must not leak');
    assert.equal('files' in impl, false, 'parser key files must not leak');
  }
  assert.equal(implementers[0].memberId, 'expert-implementer@claude:kimi-k2.6:cloud#0');
  assert.deepEqual(implementers[0].claimedFiles, ['lib/a.js']);
  assert.equal(implementers[1].memberId, 'expert-implementer@codex:gpt-5.5#0');
  assert.deepEqual(implementers[1].claimedFiles, ['lib/b.js']);
});

test('slice-2 case 2c: per-member worktrees map threads worktreePath/branchName into runtime shape', async () => {
  const sliceSection = slice(`**Split:** two-disjoint\n\n${twoImplementers()}`);
  const dispatchImplementers = spy({ success: [] });
  const worktrees = {
    'expert-implementer@claude:kimi-k2.6:cloud#0': { worktreePath: '/wt/a', branchName: 'slice/a' },
    'expert-implementer@codex:gpt-5.5#0': { worktreePath: '/wt/b', branchName: 'slice/b' },
  };
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection, { worktrees }),
    repoRoot: '/repo',
    deps: { dispatchImplementers },
  });
  const { implementers } = dispatchImplementers.calls[0][0];
  assert.equal(implementers[0].worktreePath, '/wt/a');
  assert.equal(implementers[0].branchName, 'slice/a');
  assert.equal(implementers[1].worktreePath, '/wt/b');
  assert.equal(implementers[1].branchName, 'slice/b');
});

test('slice-2 case 3: hybrid-ui-backend routes to deps.runHybridSlice once', async () => {
  const body = `**Split:** hybrid-ui-backend\n\n${filesBlock(['ui/app.js', 'lib/api.js'])}\n\n${hybridOwners()}`;
  const sliceSection = slice(body);
  const runHybridSlice = spy({ ok: true });
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { runHybridSlice },
  });
  assert.equal(runHybridSlice.calls.length, 1);
});

test('slice-2 case 4: driver interactive → runHybridSlice mode interactive', async () => {
  const body = `**Split:** hybrid-ui-backend\n\n${filesBlock(['ui/app.js', 'lib/api.js'])}\n\n${hybridOwners()}`;
  const sliceSection = slice(body);
  const runHybridSlice = spy({ ok: true });
  await runSplit({
    driver: 'interactive',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { runHybridSlice },
  });
  assert.equal(runHybridSlice.calls[0][0].mode, 'interactive');
});

test('slice-2 case 5: driver autopilot → runHybridSlice mode autopilot', async () => {
  const body = `**Split:** hybrid-ui-backend\n\n${filesBlock(['ui/app.js', 'lib/api.js'])}\n\n${hybridOwners()}`;
  const sliceSection = slice(body);
  const runHybridSlice = spy({ ok: true });
  await runSplit({
    driver: 'autopilot',
    planPath: 'p.md',
    specPath: 's.md',
    workItem: workItemFor(sliceSection),
    repoRoot: '/repo',
    deps: { runHybridSlice },
  });
  assert.equal(runHybridSlice.calls[0][0].mode, 'autopilot');
});

test('slice-2 case 6: invalid split throws from normalizeSplit; no runner spy called', async () => {
  const sliceSection = slice(`**Split:** two-disjoint\n\n${nImplementers(3)}`);
  const runSingle = spy({});
  const dispatchImplementers = spy({});
  const runHybridSlice = spy({});
  await assert.rejects(
    () =>
      runSplit({
        driver: 'autopilot',
        planPath: 'p.md',
        specPath: 's.md',
        workItem: workItemFor(sliceSection),
        repoRoot: '/repo',
        deps: { runSingle, dispatchImplementers, runHybridSlice },
      }),
    (err) => err && err.code === 'split-two-disjoint-not-exactly-two'
  );
  assert.equal(runSingle.calls.length, 0);
  assert.equal(dispatchImplementers.calls.length, 0);
  assert.equal(runHybridSlice.calls.length, 0);
});

test('slice-2 case 7: uniform outcome shape {ok, split, outcome} across drivers for single', async () => {
  const sliceSection = slice('**Split:** single');
  const runSingle = spy({ outcome: 'done' });
  const shapeFor = async (driver) =>
    runSplit({
      driver,
      planPath: 'p.md',
      specPath: 's.md',
      workItem: workItemFor(sliceSection),
      repoRoot: '/repo',
      deps: { runSingle },
    });
  const a = await shapeFor('interactive');
  const b = await shapeFor('autopilot');
  assert.deepEqual(Object.keys(a).sort(), ['ok', 'outcome', 'split']);
  assert.deepEqual(Object.keys(b).sort(), ['ok', 'outcome', 'split']);
  assert.equal(a.split, 'single');
  assert.equal(b.split, 'single');
});

test('slice-2 case 8: unknown driver throws split-unknown-driver before normalizeSplit or dispatch', async () => {
  // A deliberately invalid split body — if normalizeSplit ran, it would throw a
  // different code. The driver guard must fire FIRST.
  const sliceSection = slice(`**Split:** two-disjoint\n\n${nImplementers(3)}`);
  const runSingle = spy({});
  const dispatchImplementers = spy({});
  const runHybridSlice = spy({});
  await assert.rejects(
    () =>
      runSplit({
        driver: 'yolo',
        planPath: 'p.md',
        specPath: 's.md',
        workItem: workItemFor(sliceSection),
        repoRoot: '/repo',
        deps: { runSingle, dispatchImplementers, runHybridSlice },
      }),
    (err) => err && err.code === 'split-unknown-driver'
  );
  assert.equal(runSingle.calls.length, 0);
  assert.equal(dispatchImplementers.calls.length, 0);
  assert.equal(runHybridSlice.calls.length, 0);
});

test('slice-2 case 9: single with no deps.runSingle → _runSingle default throws not-yet-wired', async () => {
  const sliceSection = slice('**Split:** single');
  await assert.rejects(
    () =>
      runSplit({
        driver: 'autopilot',
        planPath: 'p.md',
        specPath: 's.md',
        workItem: workItemFor(sliceSection),
        repoRoot: '/repo',
        deps: {},
      }),
    (err) => /not yet wired/i.test(err.message)
  );
});

export {
  plan,
  slice,
  twoImplementers,
  nImplementers,
  hybridOwners,
  filesBlock,
};
