import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from '../../lib/codex-bridge/project-config.js';

function makeRepo(config) {
  const root = mkdtempSync(join(tmpdir(), 'cps-project-models-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'models@test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'models'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  mkdirSync(join(root, '.codex-paired'), { recursive: true });
  writeFileSync(join(root, '.codex-paired', 'project.json'), JSON.stringify(config));
  return root;
}

const base = () => ({
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'library' },
});

function load(config) {
  const root = makeRepo(config);
  try {
    return loadProjectConfig(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('valid models block is accepted and returned as given', () => {
  const models = { planning: { effort: 'max' }, implement: { model: 'gpt-5.6-terra' } };
  const result = load({ ...base(), models });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.models, models);
});

test('models null is treated as absent and left unchanged', () => {
  const result = load({ ...base(), models: null });
  assert.equal(result.ok, true);
  assert.equal(result.config.models, null);
});

test('models absent is accepted and remains absent', () => {
  const result = load(base());
  assert.equal(result.ok, true);
  assert.equal(result.config.models, undefined);
});

for (const [name, models] of [
  ['string', 'x'],
  ['array', []],
  ['unknown role', { unknown: { model: 'gpt-6-astra' } }],
  ['bad effort', { review: { effort: 'turbo' } }],
]) {
  test(`invalid models ${name} returns models-config-malformed`, () => {
    const result = load({ ...base(), models });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'models-config-malformed');
    assert.equal(typeof result.error.detail, 'string');
  });
}
