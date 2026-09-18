import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveReviewPanel } from '../../lib/codex-bridge/review-panel.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'lib', 'codex-bridge', 'cli.js');

const base = () => ({
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'library' },
});

function makeRepo(config = base()) {
  const root = mkdtempSync(join(tmpdir(), 'cps-review-panel-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(join(root, '.codex-paired'), { recursive: true });
  writeFileSync(join(root, '.codex-paired', 'project.json'), `${JSON.stringify(config)}\n`);
  return root;
}

function withRepo(config, fn) {
  const root = makeRepo(config);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('unconfigured planning and review use today\'s single reviewer without activating the panel contract', () => {
  withRepo(base(), (repoRoot) => {
    assert.deepEqual(resolveReviewPanel({ phase: 'planning', repoRoot, env: {} }), {
      roster: [{ member_id: 'codex:gpt-6-astra', cli: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }],
      configured: false,
      warnings: [],
    });
    assert.deepEqual(resolveReviewPanel({ phase: 'review', repoRoot, env: {} }), {
      roster: [{ member_id: 'codex:gpt-6-astra', cli: 'codex', model: 'gpt-6-astra', effort: 'high' }],
      configured: false,
      warnings: [],
    });
  });
});

test('a configured phase is active even with one member', () => {
  withRepo({ ...base(), review_panel: { planning: [{ cli: 'codex' }] } }, (repoRoot) => {
    const result = resolveReviewPanel({ phase: 'planning', repoRoot, env: {} });
    assert.equal(result.configured, true);
    assert.equal(result.roster.length, 1);
  });
});

test('phase environment override activates the panel and wins over the project file', () => {
  withRepo({ ...base(), review_panel: { planning: [{ cli: 'agy', model: 'gemini-file-low' }] } }, (repoRoot) => {
    const result = resolveReviewPanel({
      phase: 'planning',
      repoRoot,
      env: { CODEX_PAIRED_REVIEW_PANEL_PLANNING: 'codex, agy' },
    });
    assert.equal(result.configured, true);
    assert.deepEqual(result.roster.map(({ cli, model }) => ({ cli, model })), [
      { cli: 'codex', model: 'gpt-6-astra' },
      { cli: 'agy', model: 'gemini-3.8-flash-high' },
    ]);
  });
});

test('two different Codex models are independent accepted members', () => {
  withRepo({
    ...base(),
    review_panel: { review: [{ cli: 'codex', model: 'gpt-6-astra' }, { cli: 'codex', model: 'gpt-5.6-terra' }] },
  }, (repoRoot) => {
    const result = resolveReviewPanel({ phase: 'review', repoRoot, env: {} });
    assert.deepEqual(result.roster.map((member) => member.member_id), ['codex:gpt-6-astra', 'codex:gpt-5.6-terra']);
  });
});

test('the same resolved cli and model pair twice is rejected with its path', () => {
  withRepo({
    ...base(),
    review_panel: { planning: [{ cli: 'codex' }, { cli: 'codex', model: 'gpt-6-astra' }] },
  }, (repoRoot) => {
    assert.throws(
      () => resolveReviewPanel({ phase: 'planning', repoRoot, env: {} }),
      (error) => error?.code === 'models-config-malformed' && /review_panel\.planning\[1\]/.test(error.detail),
    );
  });
});

for (const [name, value, path] of [
  ['unknown cli', [{ cli: 'other' }], 'review_panel.planning[0].cli'],
  ['empty array', [], 'review_panel.planning'],
  ['non-array', { cli: 'codex' }, 'review_panel.planning'],
  ['invalid model token', [{ cli: 'codex', model: 'model with spaces' }], 'review_panel.planning[0].model'],
]) {
  test(`${name} is rejected as models-config-malformed and names ${path}`, () => {
    withRepo({ ...base(), review_panel: { planning: value } }, (repoRoot) => {
      assert.throws(
        () => resolveReviewPanel({ phase: 'planning', repoRoot, env: {} }),
        (error) => error?.code === 'models-config-malformed' && error.detail.includes(path),
      );
    });
  });
}

test('agy effort comes from the model suffix', () => {
  withRepo({ ...base(), review_panel: { review: [{ cli: 'agy', model: 'gemini-custom-medium' }] } }, (repoRoot) => {
    assert.deepEqual(resolveReviewPanel({ phase: 'review', repoRoot, env: {} }).roster, [{
      member_id: 'agy:gemini-custom-medium',
      cli: 'agy',
      model: 'gemini-custom-medium',
      effort: 'medium',
    }]);
  });
});

test('a member using the implement model emits a self-review warning', () => {
  withRepo({
    ...base(),
    models: { implement: { model: 'gpt-5.6-terra' } },
    review_panel: { review: [{ cli: 'codex', model: 'gpt-5.6-terra' }] },
  }, (repoRoot) => {
    assert.deepEqual(
      resolveReviewPanel({ phase: 'review', repoRoot, env: {} }).warnings,
      ['self-review:codex:gpt-5.6-terra'],
    );
  });
});

test('review-panel CLI prints roster JSON and exits 0', () => {
  withRepo({ ...base(), review_panel: { review: [{ cli: 'agy', model: 'gemini-cli-high' }] } }, (repoRoot) => {
    const run = spawnSync(process.execPath, [CLI, 'review-panel', '--phase', 'review', '--repoRoot', repoRoot, '--format', 'json'], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_PAIRED_REVIEW_PANEL_REVIEW: undefined },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [{
      member_id: 'agy:gemini-cli-high', cli: 'agy', model: 'gemini-cli-high', effort: 'high',
    }]);
  });
});

test('review-panel CLI exits 2 for usage and configuration errors', () => {
  const usage = spawnSync(process.execPath, [CLI, 'review-panel', '--phase', 'other'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /planning.*review/);

  const missingRoot = spawnSync(process.execPath, [CLI, 'review-panel', '--phase', 'planning'], { encoding: 'utf8' });
  assert.equal(missingRoot.status, 2);
  assert.match(missingRoot.stderr, /--repoRoot/);

  withRepo({ ...base(), review_panel: { review: [] } }, (repoRoot) => {
    const malformed = spawnSync(process.execPath, [CLI, 'review-panel', '--phase', 'review', '--repoRoot', repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_PAIRED_REVIEW_PANEL_REVIEW: undefined },
    });
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /models-config-malformed.*review_panel\.review/);
  });
});
