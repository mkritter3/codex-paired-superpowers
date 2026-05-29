// Tests for lib/codex-bridge/hybrid/ownership.js (Slice 1).
// Validation tier: critical.
// All assertions are result-oriented (return values, thrown error `.code`).
// Pure parsing/validation tests, no I/O. Style mirrors
// tests/codex-bridge/sidecar-goals-audits.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHybridOwners,
  validateHybridOwnership,
} from '../../../lib/codex-bridge/hybrid/ownership.js';
import {
  parseImplementersBlock,
  validateClaimedFileOverlap,
} from '../../../lib/codex-bridge/implementer/frontmatter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLAN = '---\nslice_id: slice-4\n---\n\n## Slice 4: hybrid\n';

/**
 * Build a hybrid slice section with `**Orchestration:** hybrid`, a `**Files:**`
 * block, and a `**Implementers:**` block of owner entries.
 *
 * @param {object} opts
 * @param {string[]} opts.sliceFiles
 * @param {Array<{
 *   member_id: string,
 *   owner?: string,
 *   adapter?: string,
 *   model?: string,
 *   required?: boolean,
 *   files: string[],
 *   overlap_rationale?: string,
 * }>} opts.members
 * @returns {string}
 */
function buildSlice({ sliceFiles, members }) {
  const lines = ['## Slice 4: hybrid', '', '**Orchestration:** hybrid', ''];
  lines.push('**Files:**');
  for (const f of sliceFiles) lines.push(`- ${f}`);
  lines.push('');
  lines.push('**Implementers:**');
  for (const m of members) {
    lines.push(`- member_id: ${m.member_id}`);
    if (m.owner !== undefined) lines.push(`  owner: ${m.owner}`);
    lines.push(`  adapter: ${m.adapter ?? 'claude-ui'}`);
    lines.push(`  model: ${m.model ?? 'sonnet'}`);
    lines.push(`  required: ${m.required ?? true}`);
    lines.push('  files:');
    for (const f of m.files) lines.push(`    - ${f}`);
    if (m.overlap_rationale !== undefined) {
      lines.push(`  overlap_rationale: ${m.overlap_rationale}`);
    }
  }
  lines.push('', '**Commit:** ...');
  return lines.join('\n');
}

const UI_MEMBER = {
  member_id: 'hybrid-ui@claude:sonnet#0',
  owner: 'claude-ui',
  adapter: 'claude-ui',
  model: 'sonnet',
  files: ['app/ui.tsx', 'app/__hybrid_contracts__/c.ts'],
};
const BACKEND_MEMBER = {
  member_id: 'hybrid-backend@codex:gpt-5.5#0',
  owner: 'codex-backend',
  adapter: 'codex-background-bash',
  model: 'gpt-5.5',
  files: ['lib/route.ts', 'lib/contract.ts'],
};
const HAPPY_FILES = [...UI_MEMBER.files, ...BACKEND_MEMBER.files];

// ── Case 1: accepts one claude-ui + one codex-backend ──────────────────────────

test('parseHybridOwners + validateHybridOwnership: accepts one claude-ui + one codex-backend', () => {
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [UI_MEMBER, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);

  assert.equal(implementers.length, 2);
  const owners = implementers.map((m) => m.owner).sort();
  assert.deepEqual(owners, ['claude-ui', 'codex-backend']);

  // Does not throw.
  const out = validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers });
  const ui = out.find((m) => m.owner === 'claude-ui');
  const backend = out.find((m) => m.owner === 'codex-backend');
  assert.ok(ui && backend);
  assert.deepEqual(ui.files, UI_MEMBER.files);
  assert.deepEqual(backend.files, BACKEND_MEMBER.files);
});

// ── Case 2: malformed owner declarations → hybrid-ownership-malformed ───────────

test('validateHybridOwnership: missing owner → hybrid-ownership-malformed', () => {
  const noOwner = { ...UI_MEMBER, owner: undefined };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [noOwner, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

test('validateHybridOwnership: duplicate owner → hybrid-ownership-malformed', () => {
  const dupBackend = {
    ...UI_MEMBER,
    member_id: 'hybrid-ui2@claude:sonnet#1',
    owner: 'codex-backend',
  };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [dupBackend, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

test('validateHybridOwnership: unknown owner → hybrid-ownership-malformed', () => {
  const weird = { ...UI_MEMBER, owner: 'claude-frontend' };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [weird, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

test('validateHybridOwnership: optional owner (required:false) → hybrid-ownership-malformed', () => {
  const optionalUi = { ...UI_MEMBER, required: false };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [optionalUi, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

// ── Case 2b: adapter/owner pairing (spec §5/§6) — Codex slice-review finding ─────

test('validateHybridOwnership: swapped owner adapters → hybrid-ownership-malformed', () => {
  // claude-ui declaring the backend adapter, and codex-backend declaring the UI adapter.
  const uiWrong = { ...UI_MEMBER, adapter: 'codex-background-bash' };
  const backendWrong = { ...BACKEND_MEMBER, adapter: 'claude-ui' };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [uiWrong, backendWrong] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

test('validateHybridOwnership: unsupported adapter for an owner → hybrid-ownership-malformed', () => {
  const uiBadAdapter = { ...UI_MEMBER, adapter: 'codex-cli' };
  const slice = buildSlice({ sliceFiles: HAPPY_FILES, members: [uiBadAdapter, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles: HAPPY_FILES, implementers }),
    (e) => e.code === 'hybrid-ownership-malformed'
  );
});

// ── Case 3: slice/owner file mismatch → hybrid-owner-files-unclaimed ────────────

test('validateHybridOwnership: slice **Files:** entry claimed by neither owner → hybrid-owner-files-unclaimed', () => {
  const sliceFiles = [...HAPPY_FILES, 'app/orphan.tsx'];
  const slice = buildSlice({ sliceFiles, members: [UI_MEMBER, BACKEND_MEMBER] });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles, implementers }),
    (e) => e.code === 'hybrid-owner-files-unclaimed'
  );
});

test('validateHybridOwnership: owner-claimed file absent from slice **Files:** → hybrid-owner-files-unclaimed', () => {
  // sliceFiles omits one of the backend's claimed files.
  const sliceFiles = ['app/ui.tsx', 'app/__hybrid_contracts__/c.ts', 'lib/route.ts'];
  const slice = buildSlice({
    sliceFiles: HAPPY_FILES,
    members: [UI_MEMBER, BACKEND_MEMBER],
  });
  const implementers = parseHybridOwners(PLAN, slice);
  assert.throws(
    () => validateHybridOwnership({ sliceFiles, implementers }),
    (e) => e.code === 'hybrid-owner-files-unclaimed'
  );
});

// ── Case 4: overlap delegates to the shared frontmatter validator ──────────────

test('validateHybridOwnership: overlap without rationale → hybrid-owner-files-overlap (delegates to shared validator)', () => {
  // Both owners claim the same file, no rationale.
  const overlapFile = 'lib/shared.ts';
  const ui = { ...UI_MEMBER, files: ['app/ui.tsx', overlapFile] };
  const backend = { ...BACKEND_MEMBER, files: ['lib/route.ts', overlapFile] };
  const sliceFiles = ['app/ui.tsx', 'lib/route.ts', overlapFile];
  const slice = buildSlice({ sliceFiles, members: [ui, backend] });
  const implementers = parseHybridOwners(PLAN, slice);

  // Sanity: the shared frontmatter validator itself rejects this overlap.
  assert.throws(
    () => validateClaimedFileOverlap(implementers),
    (e) => e.code === 'implementer-claimed-files-missing'
  );

  // The hybrid wrapper translates that into the hybrid halt reason.
  assert.throws(
    () => validateHybridOwnership({ sliceFiles, implementers }),
    (e) => e.code === 'hybrid-owner-files-overlap'
  );
});

test('validateHybridOwnership: rationalized overlap is allowed and rationale preserved', () => {
  const overlapFile = 'lib/shared.ts';
  const ui = {
    ...UI_MEMBER,
    files: ['app/ui.tsx', overlapFile],
    overlap_rationale: 'UI needs the shared enum',
  };
  const backend = {
    ...BACKEND_MEMBER,
    files: ['lib/route.ts', overlapFile],
    overlap_rationale: 'backend owns the shared enum source',
  };
  const sliceFiles = ['app/ui.tsx', 'lib/route.ts', overlapFile];
  const slice = buildSlice({ sliceFiles, members: [ui, backend] });
  const implementers = parseHybridOwners(PLAN, slice);

  // The shared validator accepts a fully-rationalized overlap.
  assert.doesNotThrow(() => validateClaimedFileOverlap(implementers));

  const out = validateHybridOwnership({ sliceFiles, implementers });
  const outUi = out.find((m) => m.owner === 'claude-ui');
  const outBackend = out.find((m) => m.owner === 'codex-backend');
  assert.equal(outUi.overlap_rationale, 'UI needs the shared enum');
  assert.equal(outBackend.overlap_rationale, 'backend owns the shared enum source');
});

// ── Case 5: non-hybrid Implementers blocks still parse unchanged (regression) ──

test('frontmatter: non-hybrid **Implementers:** block parses unchanged (no owner field)', () => {
  const plan = '---\nslice_id: legacy\n---\n\n## Slice 1: legacy\n';
  const slice = [
    '## Slice 1: legacy',
    '',
    '**Implementers:**',
    '- member_id: expert-implementer@claude:kimi-k2.6:cloud#0',
    '  adapter: claude-cli',
    '  model: kimi-k2.6:cloud',
    '  required: true',
    '  files:',
    '    - lib/foo.js',
    '- member_id: expert-implementer@codex:gpt-5.5#0',
    '  adapter: codex-cli',
    '  model: gpt-5.5',
    '  required: true',
    '  files:',
    '    - lib/bar.js',
    '',
    '**Commit:** ...',
  ].join('\n');

  const result = parseImplementersBlock(plan, slice);
  assert.equal(result.implementers.length, 2);
  for (const m of result.implementers) {
    // No owner key leaks into legacy parse output.
    assert.ok(!('owner' in m), 'legacy entry must not carry an owner field');
  }
  assert.equal(result.implementers[0].adapter, 'claude-cli');
  assert.equal(result.implementers[1].adapter, 'codex-cli');
});
