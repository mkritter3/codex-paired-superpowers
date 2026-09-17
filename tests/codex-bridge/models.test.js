import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MODEL_ROLES,
  MODEL_ROLE_DEFAULTS,
  VALID_EFFORTS,
  VALID_CLIS,
  AGY_EFFORT_SUFFIX_RE,
  SAFE_TOKEN,
  CODEX_CLI_VALIDATED_VERSION,
  ModelsConfigError,
  validateModelsBlock,
  resolveModelRoles,
  codexExecArgs,
  cliExecArgs,
  mcpCallConfig,
  roleForThread,
  modelRoleForPhase,
  harnessModelOptions,
  compareVersions,
} from '../../lib/codex-bridge/models.js';

const ROOT = join(import.meta.dirname, '..', '..');
const MIN_VALID = {
  version: 1,
  app: { type: 'library' },
  live_verification: { default: 'skip', skip_reason: 'library' },
};

function makeRepo(config = null) {
  const root = mkdtempSync(join(tmpdir(), 'cps-model-roles-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  if (config !== null) {
    mkdirSync(join(root, '.codex-paired'), { recursive: true });
    writeFileSync(join(root, '.codex-paired', 'project.json'), JSON.stringify(config));
  }
  return root;
}

test('model role constants and frozen defaults match the contract', () => {
  assert.deepEqual(MODEL_ROLES, ['planning', 'review', 'implement', 'implement_fallback']);
  assert.deepEqual(MODEL_ROLE_DEFAULTS, {
    planning: { cli: 'codex', model: 'gpt-6-astra', effort: 'xhigh' },
    review: { cli: 'codex', model: 'gpt-6-astra', effort: 'high' },
    implement: { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    implement_fallback: { cli: 'codex', model: 'gpt-6-astra', effort: 'medium' },
  });
  assert.equal(Object.isFrozen(MODEL_ROLE_DEFAULTS), true);
  for (const role of MODEL_ROLES) assert.equal(Object.isFrozen(MODEL_ROLE_DEFAULTS[role]), true);
  assert.deepEqual(VALID_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(VALID_CLIS, ['codex', 'agy']);
  assert.ok(AGY_EFFORT_SUFFIX_RE instanceof RegExp);
  assert.equal(SAFE_TOKEN.test('gpt-5.6_sol-x'), true);
  assert.equal(CODEX_CLI_VALIDATED_VERSION, '0.153.4');
});

test('resolveModelRoles defaults every field and source', () => {
  const envKeys = Object.keys(process.env).filter(
    (key) => key.startsWith('CODEX_PAIRED_MODEL') || key.startsWith('CODEX_PAIRED_REASONING') || key.startsWith('CODEX_PAIRED_CLI'),
  );
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    const result = resolveModelRoles({});
    assert.deepEqual(result.roles, MODEL_ROLE_DEFAULTS);
    for (const role of MODEL_ROLES) {
      assert.deepEqual(result.sources[role], { cli: 'default', model: 'default', effort: 'default' });
    }
  } finally {
    Object.assign(process.env, original);
  }
});

test('resolveModelRoles layers project partial overrides over defaults', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { implement: { model: 'gpt-5.6-terra' } },
  });
  try {
    const result = resolveModelRoles({ repoRoot: root, env: {} });
    assert.equal(result.roles.implement.cli, 'codex');
    assert.equal(result.roles.implement.model, 'gpt-5.6-terra');
    assert.equal(result.roles.implement.effort, 'high');
    assert.deepEqual(result.sources.implement, { cli: 'default', model: 'project', effort: 'default' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project { review: { cli: "agy", model: "gemini-3.8-flash-high" } } derives effort and leaves others untouched', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { review: { cli: 'agy', model: 'gemini-3.8-flash-high' } },
  });
  try {
    const result = resolveModelRoles({ repoRoot: root, env: {} });
    assert.deepEqual(result.roles.review, {
      cli: 'agy',
      model: 'gemini-3.8-flash-high',
      effort: 'high',
    });
    assert.deepEqual(result.sources.review, {
      cli: 'project',
      model: 'project',
      effort: 'derived',
    });
    // other roles untouched
    assert.deepEqual(result.roles.planning, MODEL_ROLE_DEFAULTS.planning);
    assert.deepEqual(result.sources.planning, { cli: 'default', model: 'default', effort: 'default' });
    assert.deepEqual(result.roles.implement, MODEL_ROLE_DEFAULTS.implement);
    assert.deepEqual(result.roles.implement_fallback, MODEL_ROLE_DEFAULTS.implement_fallback);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project { planning: { cli: "agy", model: "gemini-3.8-flash-high" } } works although default effort is xhigh', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { planning: { cli: 'agy', model: 'gemini-3.8-flash-high' } },
  });
  try {
    const result = resolveModelRoles({ repoRoot: root, env: {} });
    assert.deepEqual(result.roles.planning, {
      cli: 'agy',
      model: 'gemini-3.8-flash-high',
      effort: 'high',
    });
    assert.deepEqual(result.sources.planning, {
      cli: 'project',
      model: 'project',
      effort: 'derived',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-layer mismatch { cli: "agy", model: "gemini-3.1-pro-low", effort: "high" } throws models-config-malformed naming both', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { review: { cli: 'agy', model: 'gemini-3.1-pro-low', effort: 'high' } },
  });
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: {} }),
      (err) => {
        assert.ok(err instanceof ModelsConfigError);
        assert.equal(err.code, 'models-config-malformed');
        assert.match(err.detail, /gemini-3\.1-pro-low/);
        assert.match(err.detail, /high/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agy model without suffix throws error', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { review: { cli: 'agy', model: 'gemini-3.8-flash' } },
  });
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: {} }),
      (err) => {
        assert.ok(err instanceof ModelsConfigError);
        assert.equal(err.code, 'models-config-malformed');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli: "gemini" throws error (only codex and agy are valid)', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { review: { cli: 'gemini', model: 'gemini-3.8-flash-high' } },
  });
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: {} }),
      (err) => {
        assert.ok(err instanceof ModelsConfigError);
        assert.equal(err.code, 'models-config-malformed');
        assert.match(err.detail, /cli/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('global environment overrides CODEX_PAIRED_CLI=agy and CODEX_PAIRED_MODEL=gemini-3.8-flash-medium apply to all roles', () => {
  const root = makeRepo();
  try {
    const result = resolveModelRoles({
      repoRoot: root,
      env: {
        CODEX_PAIRED_CLI: 'agy',
        CODEX_PAIRED_MODEL: 'gemini-3.8-flash-medium',
      },
    });
    for (const role of MODEL_ROLES) {
      assert.deepEqual(result.roles[role], {
        cli: 'agy',
        model: 'gemini-3.8-flash-medium',
        effort: 'medium',
      });
      assert.deepEqual(result.sources[role], {
        cli: 'env',
        model: 'env',
        effort: 'derived',
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-role environment override CODEX_PAIRED_CLI_IMPLEMENT=codex beats global CODEX_PAIRED_CLI=agy', () => {
  const root = makeRepo();
  try {
    const result = resolveModelRoles({
      repoRoot: root,
      env: {
        CODEX_PAIRED_CLI: 'agy',
        CODEX_PAIRED_MODEL: 'gemini-3.8-flash-medium',
        CODEX_PAIRED_CLI_IMPLEMENT: 'codex',
        CODEX_PAIRED_MODEL_IMPLEMENT: 'gpt-5.6-sol',
      },
    });
    assert.equal(result.roles.implement.cli, 'codex');
    assert.equal(result.roles.implement.model, 'gpt-5.6-sol');
    assert.equal(result.roles.implement.effort, 'high');
    assert.deepEqual(result.sources.implement, {
      cli: 'env',
      model: 'env',
      effort: 'default',
    });
    assert.equal(result.roles.review.cli, 'agy');
    assert.equal(result.sources.review.cli, 'env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('global environment overrides apply to all roles', () => {
  const root = makeRepo();
  try {
    const result = resolveModelRoles({
      repoRoot: root,
      env: { CODEX_PAIRED_MODEL: 'gpt-5.6-luna', CODEX_PAIRED_REASONING: 'max' },
    });
    for (const role of MODEL_ROLES) {
      assert.deepEqual(result.roles[role], { cli: 'codex', model: 'gpt-5.6-luna', effort: 'max' });
      assert.deepEqual(result.sources[role], { cli: 'default', model: 'env', effort: 'env' });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-role environment overrides beat global environment overrides', () => {
  const root = makeRepo();
  try {
    const result = resolveModelRoles({
      repoRoot: root,
      env: {
        CODEX_PAIRED_MODEL: 'gpt-5.6-luna',
        CODEX_PAIRED_MODEL_IMPLEMENT_FALLBACK: 'gpt-6-astra',
      },
    });
    assert.equal(result.roles.implement.model, 'gpt-5.6-luna');
    assert.equal(result.roles.implement_fallback.model, 'gpt-6-astra');
    assert.equal(result.sources.implement_fallback.model, 'env');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid environment value throws one ModelsConfigError, never a partial result', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: { CODEX_PAIRED_REASONING: 'turbo' } }),
      (error) => {
        assert.ok(error instanceof ModelsConfigError);
        assert.equal(error.code, 'models-config-malformed');
        assert.match(error.detail, /CODEX_PAIRED_REASONING/);
        assert.match(error.detail, /turbo/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateModelsBlock rejects malformed blocks and accepts valid partial blocks', () => {
  const invalid = [
    null,
    undefined,
    [],
    'x',
    { nope: {} },
    { planning: { nope: 'x' } },
    { planning: { model: '' } },
    { planning: { model: 'gpt 5' } },
    { planning: { model: 'a;b' } },
    { planning: { effort: 'turbo' } },
  ];
  for (const block of invalid) {
    const result = validateModelsBlock(block);
    assert.equal(result?.code, 'models-config-malformed', JSON.stringify(block));
    assert.equal(typeof result?.detail, 'string');
    assert.ok(result.detail.length > 0);
  }
  assert.equal(validateModelsBlock({}), null);
  assert.equal(validateModelsBlock({ planning: { effort: 'ultra' }, implement: { model: 'gpt-5.6-terra' } }), null);
});

test('cliExecArgs returns the frozen shape for both codex and agy roles', () => {
  // codex shape
  assert.deepEqual(cliExecArgs('implement', MODEL_ROLE_DEFAULTS), {
    cli: 'codex',
    command: 'codex',
    args: ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high'],
    insertAfter: 'exec',
  });
  // agy shape
  const agyRoles = {
    ...MODEL_ROLE_DEFAULTS,
    review: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
  };
  assert.deepEqual(cliExecArgs('review', agyRoles), {
    cli: 'agy',
    command: 'agy',
    args: ['--model', 'gemini-3.8-flash-high'],
    insertAfter: null,
  });
});

test('codexExecArgs returns exact flags for codex role, throws for agy role or unknown role', () => {
  assert.deepEqual(
    codexExecArgs('implement', MODEL_ROLE_DEFAULTS),
    ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high'],
  );
  assert.throws(
    () => codexExecArgs('nope', MODEL_ROLE_DEFAULTS),
    (error) => error instanceof ModelsConfigError && error.code === 'models-config-malformed',
  );
  const agyRoles = {
    ...MODEL_ROLE_DEFAULTS,
    review: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
  };
  assert.throws(
    () => codexExecArgs('review', agyRoles),
    (error) =>
      error instanceof ModelsConfigError &&
      error.code === 'models-config-malformed' &&
      /uses agy/.test(error.detail),
  );
});

test('mcpCallConfig returns MCP shape for codex, throws frozen message for agy role', () => {
  assert.deepEqual(mcpCallConfig('planning', MODEL_ROLE_DEFAULTS), {
    model: 'gpt-6-astra',
    config: { model_reasoning_effort: 'xhigh' },
  });
  const agyRoles = {
    ...MODEL_ROLE_DEFAULTS,
    planning: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
  };
  assert.throws(
    () => mcpCallConfig('planning', agyRoles),
    (error) => {
      assert.ok(error instanceof ModelsConfigError);
      assert.equal(error.code, 'models-config-malformed');
      assert.equal(
        error.detail,
        'role planning uses agy; the Codex MCP tool cannot open an agy thread — use reviewer-thread-open',
      );
      return true;
    },
  );
});

test('roleForThread maps known thread keys and defaults unknown keys to planning', () => {
  assert.equal(roleForThread('paired-reviewer'), 'planning');
  assert.equal(roleForThread('execution-reviewer'), 'review');
  assert.equal(roleForThread('unknown'), 'planning');
});

test('modelRoleForPhase implements every phase row and warns on unknown phases', () => {
  for (const phase of ['spec-review', 'plan-review', 'pre-dispatch', 'tdd-review', 'hypothesis-review']) {
    assert.deepEqual(modelRoleForPhase(phase), { role: 'planning', warning: null });
  }
  for (const phase of ['post-implementation-review', 'post-merge-review', 'merge-review', 'docs-update']) {
    assert.deepEqual(modelRoleForPhase(phase), { role: 'review', warning: null });
  }
  assert.deepEqual(modelRoleForPhase('weird'), { role: 'review', warning: 'unknown phase "weird"' });
  assert.deepEqual(modelRoleForPhase(undefined), { role: 'review', warning: 'unknown phase "undefined"' });
});

test('harnessModelOptions uses precomputed roles and includes cli', () => {
  assert.deepEqual(harnessModelOptions('tdd-review', { roles: MODEL_ROLE_DEFAULTS }), {
    modelRole: 'planning',
    cli: 'codex',
    model: 'gpt-6-astra',
    reasoningEffort: 'xhigh',
    warning: null,
  });

  const agyRoles = {
    ...MODEL_ROLE_DEFAULTS,
    planning: { cli: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
  };
  assert.deepEqual(harnessModelOptions('tdd-review', { roles: agyRoles }), {
    modelRole: 'planning',
    cli: 'agy',
    model: 'gemini-3.8-flash-high',
    reasoningEffort: 'high',
    warning: null,
  });
});

test('harnessModelOptions resolves roles when none are supplied', () => {
  const root = makeRepo();
  try {
    assert.deepEqual(harnessModelOptions('x', { repoRoot: root, env: {} }), {
      modelRole: 'review',
      cli: 'codex',
      model: 'gpt-6-astra',
      reasoningEffort: 'high',
      warning: 'unknown phase "x"',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareVersions performs semver-like numeric comparison', () => {
  assert.ok(compareVersions('0.153.3', '0.153.4') < 0);
  assert.equal(compareVersions('0.153.4', '0.153.4'), 0);
  assert.ok(compareVersions('1.0.0', '0.153.4') > 0);
  assert.ok(compareVersions('0.153.4', '0.153.10') < 0);
});

test('models and project-config imports are safe in either order in fresh processes', () => {
  execFileSync('node', ['-e', "import('./lib/codex-bridge/models.js').then(()=>import('./lib/codex-bridge/project-config.js'))"], { cwd: ROOT });
  execFileSync('node', ['-e', "import('./lib/codex-bridge/project-config.js').then(()=>import('./lib/codex-bridge/models.js'))"], { cwd: ROOT });
});

// ── frozen contract: ModelsConfigError.code is ALWAYS 'models-config-malformed' ──

test('resolveModelRoles: invalid project.json JSON → ModelsConfigError with the frozen code and the loader detail preserved', () => {
  const root = mkdtempSync(join(tmpdir(), 'cps-model-roles-badjson-'));
  try {
    mkdirSync(join(root, '.codex-paired'), { recursive: true });
    writeFileSync(join(root, '.codex-paired', 'project.json'), '{ "version": 1, ');
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: {} }),
      (err) =>
        err instanceof ModelsConfigError &&
        err.code === 'models-config-malformed' &&
        /live-verification-config-malformed/.test(err.detail) &&
        err.cause && err.cause.code === 'live-verification-config-malformed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveModelRoles: project.json missing "app" → ModelsConfigError with the frozen code, loader code only in detail/cause', () => {
  const root = makeRepo({ version: 1, live_verification: { default: 'skip', skip_reason: 'x' } });
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: {} }),
      (err) =>
        err instanceof ModelsConfigError &&
        err.code === 'models-config-malformed' &&
        /missing-field:app/.test(err.detail) &&
        err.cause && err.cause.code === 'missing-field:app',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Claude C0 review of slice 1: an env effort from a DIFFERENT layer than the agy model must not
// trigger the same-layer mismatch — it is overridden by the derived effort.
test('global CODEX_PAIRED_REASONING (env layer) does not conflict with a project-layer agy model; derived effort wins', () => {
  const root = makeRepo({
    ...MIN_VALID,
    models: { review: { cli: 'agy', model: 'gemini-3.8-flash-medium' } },
  });
  try {
    const { roles, sources } = resolveModelRoles({ repoRoot: root, env: { CODEX_PAIRED_REASONING: 'high' } });
    assert.equal(roles.review.effort, 'medium');
    assert.equal(sources.review.effort, 'derived');
    assert.equal(roles.implement.effort, 'high'); // codex roles still take the global env effort
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('per-role env model with a mismatching per-role env effort is a same-layer mismatch; a global env effort is not', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveModelRoles({ repoRoot: root, env: { CODEX_PAIRED_CLI_REVIEW: 'agy', CODEX_PAIRED_MODEL_REVIEW: 'gemini-3.8-flash-low', CODEX_PAIRED_REASONING_REVIEW: 'high' } }),
      /same-layer mismatch/,
    );
    const { roles } = resolveModelRoles({ repoRoot: root, env: { CODEX_PAIRED_CLI_REVIEW: 'agy', CODEX_PAIRED_MODEL_REVIEW: 'gemini-3.8-flash-low', CODEX_PAIRED_REASONING: 'high' } });
    assert.equal(roles.review.effort, 'low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
