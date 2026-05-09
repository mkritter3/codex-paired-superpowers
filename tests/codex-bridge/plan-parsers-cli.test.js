/**
 * CLI tests for `parse-implementer-directive` and `parse-files-block` subcommands.
 *
 * Focus: cross-slice isolation — the implementer directive lookup must be
 * scoped to the requested slice section, not the whole plan. Plans may carry
 * per-slice directives (e.g. slice 3 says `**Implementer:** sonnet` while
 * slice 1 has none), and the CLI must default to codex for slice 1 in that
 * case rather than picking up slice 3's directive.
 *
 * Uses spawnSync (no shell) to invoke `node lib/codex-bridge/cli.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = dirname(dirname(dirname(__filename)));
const CLI = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'cli.js');

function runCli(subcommand, args) {
  return spawnSync('node', [CLI, subcommand, ...args], { encoding: 'utf8' });
}

function withTempPlan(planText, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-parsers-cli-'));
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, planText, 'utf8');
  try {
    return fn(planPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Two-slice fixture: slice 1 no directive, slice 2 has sonnet ─────────────

const TWO_SLICE_PLAN = `# Plan

Some intro.

## Slice 1: first slice

No directive here.

**Files:**
- a.txt

## Slice 2: second slice

**Implementer:** sonnet

**Files:**
- b.txt
`;

test('parse-implementer-directive --sliceId 1 returns codex when slice 1 has no directive', () => {
  withTempPlan(TWO_SLICE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '1',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.implementer, 'codex');
  });
});

test('parse-implementer-directive --sliceId 2 returns sonnet for slice 2', () => {
  withTempPlan(TWO_SLICE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '2',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.implementer, 'sonnet');
  });
});

// ─── Cross-slice isolation: directive in slice 3 only ────────────────────────

const SLICE_3_DIRECTIVE_PLAN = `# Plan

## Slice 1: first

No directive.

## Slice 2: second

Also no directive.

## Slice 3: third

**Implementer:** sonnet

Body.
`;

test('parse-implementer-directive --sliceId 1 returns codex (default) even if slice 3 has sonnet directive', () => {
  withTempPlan(SLICE_3_DIRECTIVE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '1',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.implementer,
      'codex',
      'CLI must scope to slice 1 only, not pick up slice 3 directive',
    );
  });
});

test('parse-implementer-directive --sliceId 2 returns codex when only slice 3 has directive', () => {
  withTempPlan(SLICE_3_DIRECTIVE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '2',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.implementer, 'codex');
  });
});

test('parse-implementer-directive --sliceId 3 returns sonnet for slice 3', () => {
  withTempPlan(SLICE_3_DIRECTIVE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '3',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.implementer, 'sonnet');
  });
});

// ─── --sliceId accepts both bare number and slice-N form ─────────────────────

test('parse-implementer-directive --sliceId 3 and --sliceId slice-3 produce identical output', () => {
  withTempPlan(SLICE_3_DIRECTIVE_PLAN, (planPath) => {
    const bare = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '3',
    ]);
    const prefixed = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', 'slice-3',
    ]);
    assert.equal(bare.status, 0, `bare form failed; stderr: ${bare.stderr}`);
    assert.equal(prefixed.status, 0, `slice- form failed; stderr: ${prefixed.stderr}`);
    assert.equal(bare.stdout, prefixed.stdout);
  });
});

// ─── Missing slice section → exit 2 with slice-section-missing ───────────────

test('parse-implementer-directive missing slice → exit 2 with slice-section-missing', () => {
  withTempPlan(SLICE_3_DIRECTIVE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '5',
    ]);
    assert.equal(r.status, 2, `Expected exit 2; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
    const err = JSON.parse(r.stderr);
    assert.equal(err.defect, 'slice-section-missing');
    assert.match(err.detail, /Slice 5/);
  });
});

// ─── Malformed directive in target slice → exit 2 ────────────────────────────

const MALFORMED_PLAN = `# Plan

## Slice 1: first

**Implementer:** auto

Body.

## Slice 2: second

**Implementer:** codex
`;

test('parse-implementer-directive malformed (auto) in slice 1 → exit 2', () => {
  withTempPlan(MALFORMED_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '1',
    ]);
    assert.equal(r.status, 2, `Expected exit 2; stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
    const err = JSON.parse(r.stderr);
    assert.equal(err.defect, 'implementer-directive-malformed');
  });
});

test('parse-implementer-directive on same plan but slice 2 → exit 0 codex', () => {
  // Sanity check: cross-slice isolation also keeps slice 2 unaffected by
  // slice 1's malformed directive.
  withTempPlan(MALFORMED_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
      '--sliceId', '2',
    ]);
    assert.equal(r.status, 0, `Expected exit 0; stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.implementer, 'codex');
  });
});

// ─── Required-flag enforcement ───────────────────────────────────────────────

test('parse-implementer-directive missing --sliceId → exit 1', () => {
  withTempPlan(TWO_SLICE_PLAN, (planPath) => {
    const r = runCli('parse-implementer-directive', [
      '--planPath', planPath,
    ]);
    assert.equal(r.status, 1, `Expected exit 1 for missing --sliceId; stdout: ${r.stdout} stderr: ${r.stderr}`);
  });
});
