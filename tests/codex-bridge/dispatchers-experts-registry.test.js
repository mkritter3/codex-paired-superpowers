// v0.8.0 slice 6 — agents/dispatchers.json must declare an `experts`
// registry alongside the existing `codex` and `sonnet` entries.
//
// Validates JSON shape, prompt-path existence, phases/domains enums,
// id naming convention, and no-regression on existing entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const REGISTRY_PATH = join(PLUGIN_ROOT, 'agents', 'dispatchers.json');

const ALLOWED_PHASES = new Set([
  'spec-review',
  'pre-dispatch',
  'post-implementation-review',
]);

const EXPECTED_EXPERTS = [
  'ui',
  'ux',
  'architecture',
  'backend',
  'ai-harness',
  'test',
  'security',
];

function loadRegistry() {
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw);
}

test('dispatchers.json parses without error', () => {
  assert.doesNotThrow(() => loadRegistry());
});

test('top-level keys include experts (alongside codex and sonnet)', () => {
  const reg = loadRegistry();
  assert.ok(reg.codex, 'codex entry present');
  assert.ok(reg.sonnet, 'sonnet entry present');
  assert.ok(reg.experts, 'experts entry present');
  assert.equal(typeof reg.experts, 'object');
  assert.ok(!Array.isArray(reg.experts), 'experts is an object map, not an array');
});

test('existing codex entry is unchanged (no regression)', () => {
  const reg = loadRegistry();
  assert.deepEqual(reg.codex, {
    transport: 'codex-background-bash',
    contract: 'docs/codex-implementer-contract.md',
    tools: ['Bash'],
    domains: {
      ui: 'forbidden',
      'ai-harness': 'forbidden',
      backend: 'preferred',
      general: 'allowed',
    },
  });
});

test('existing sonnet entry is unchanged (no regression)', () => {
  const reg = loadRegistry();
  assert.deepEqual(reg.sonnet, {
    transport: 'claude-subagent',
    agent: 'slice-implementer-sonnet',
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    domains: {
      ui: 'preferred',
      'ai-harness': 'preferred',
      backend: 'allowed',
      general: 'preferred',
    },
  });
});

test('experts registry has all 7 expected roles', () => {
  const reg = loadRegistry();
  const got = Object.keys(reg.experts).sort();
  const want = [...EXPECTED_EXPERTS].sort();
  assert.deepEqual(got, want);
});

for (const role of EXPECTED_EXPERTS) {
  test(`expert "${role}" has required fields`, () => {
    const reg = loadRegistry();
    const entry = reg.experts[role];
    assert.ok(entry, `${role} entry exists`);
    assert.equal(typeof entry.id, 'string', 'id is string');
    assert.equal(typeof entry.prompt, 'string', 'prompt is string');
    assert.ok(Array.isArray(entry.phases), 'phases is array');
    assert.ok(Array.isArray(entry.domains), 'domains is array');
  });

  test(`expert "${role}" id matches expert-<role> convention`, () => {
    const reg = loadRegistry();
    const entry = reg.experts[role];
    assert.equal(entry.id, `expert-${role}`);
  });

  test(`expert "${role}" prompt path resolves to a real file`, () => {
    const reg = loadRegistry();
    const entry = reg.experts[role];
    assert.ok(
      entry.prompt.startsWith('lib/codex-bridge/prompts/'),
      `prompt should live under lib/codex-bridge/prompts/, got ${entry.prompt}`,
    );
    const abs = join(PLUGIN_ROOT, entry.prompt);
    assert.ok(existsSync(abs), `prompt file does not exist: ${entry.prompt}`);
  });

  test(`expert "${role}" phases are subset of allowed enum`, () => {
    const reg = loadRegistry();
    const entry = reg.experts[role];
    assert.ok(entry.phases.length > 0, 'phases is non-empty');
    for (const p of entry.phases) {
      assert.ok(
        ALLOWED_PHASES.has(p),
        `phase "${p}" not in allowed set ${[...ALLOWED_PHASES].join(',')}`,
      );
    }
  });

  test(`expert "${role}" domains is non-empty array of strings`, () => {
    const reg = loadRegistry();
    const entry = reg.experts[role];
    assert.ok(entry.domains.length > 0, 'domains is non-empty');
    for (const d of entry.domains) {
      assert.equal(typeof d, 'string', `domain entry "${d}" is string`);
      assert.ok(d.length > 0, 'domain entry is non-empty string');
    }
  });
}

test('architecture and test experts include pre-dispatch phase', () => {
  const reg = loadRegistry();
  assert.ok(
    reg.experts.architecture.phases.includes('pre-dispatch'),
    'architecture must run at pre-dispatch',
  );
  assert.ok(
    reg.experts.test.phases.includes('pre-dispatch'),
    'test must run at pre-dispatch',
  );
});

test('all experts include spec-review phase', () => {
  const reg = loadRegistry();
  for (const role of EXPECTED_EXPERTS) {
    assert.ok(
      reg.experts[role].phases.includes('spec-review'),
      `${role} must run at spec-review`,
    );
  }
});
