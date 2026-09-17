import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const CLI = join(ROOT, 'lib', 'codex-bridge', 'cli.js');
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('CODEX_PAIRED_MODEL') && !key.startsWith('CODEX_PAIRED_REASONING')),
);

function makeRepo(models) {
  const root = mkdtempSync(join(tmpdir(), 'cps-model-role-cli-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  if (models !== undefined) {
    mkdirSync(join(root, '.codex-paired'), { recursive: true });
    writeFileSync(join(root, '.codex-paired', 'project.json'), JSON.stringify({
      version: 1,
      app: { type: 'library' },
      live_verification: { default: 'skip', skip_reason: 'library' },
      models,
    }));
  }
  return root;
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: opts.cwd ?? ROOT,
      env: { ...CLEAN_ENV, ...opts.env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', status: error.status ?? 1 };
  }
}

test('model-role json format emits the frozen shape', () => {
  const root = makeRepo();
  const result = runCli(['model-role', '--role', 'implement', '--repoRoot', root, '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    role: 'implement', model: 'gpt-5.6-sol', effort: 'high', sources: { model: 'default', effort: 'default' },
  });
  rmSync(root, { recursive: true, force: true });
});

test('model-role flags format emits one exact unquoted line', () => {
  const result = runCli(['model-role', '--role', 'implement', '--format', 'flags']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '-m gpt-5.6-sol -c model_reasoning_effort=high');
});

test('model-role mcp format emits the exact MCP object', () => {
  const result = runCli(['model-role', '--role', 'planning', '--format', 'mcp']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { model: 'gpt-6-astra', config: { model_reasoning_effort: 'xhigh' } });
});

test('model-role defaults to json format', () => {
  const result = runCli(['model-role', '--role', 'review']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).role, 'review');
});

test('model-role rejects an unknown role with empty stdout and lists valid roles', () => {
  const result = runCli(['model-role', '--role', 'nope']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  for (const role of ['planning', 'review', 'implement', 'implement_fallback']) assert.match(result.stderr, new RegExp(role));
});

test('model-role reports invalid project models as a config error', () => {
  const root = makeRepo('x');
  const result = runCli(['model-role', '--role', 'planning', '--repoRoot', root]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /models-config-malformed/);
  rmSync(root, { recursive: true, force: true });
});

test('model-roles emits every role, source, and validated CLI version', () => {
  const root = makeRepo();
  const result = runCli(['model-roles', '--repoRoot', root]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed.roles), ['planning', 'review', 'implement', 'implement_fallback']);
  assert.deepEqual(parsed.sources.planning, { model: 'default', effort: 'default' });
  assert.equal(parsed.validated_cli_version, '0.153.4');
  rmSync(root, { recursive: true, force: true });
});

test('sidecar-init defaults to the planning model role', () => {
  const root = makeRepo();
  const spec = join(root, 'spec.md');
  writeFileSync(spec, '# spec');
  const result = runCli(['sidecar-init', '--specPath', spec, '--feature', 'f', '--threadId', 't'], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.model, 'gpt-6-astra');
  assert.equal(parsed.reasoning_effort, 'xhigh');
  rmSync(root, { recursive: true, force: true });
});

test('sidecar-init honors planning per-role environment overrides', () => {
  const root = makeRepo();
  const spec = join(root, 'spec.md');
  writeFileSync(spec, '# spec');
  const result = runCli(['sidecar-init', '--specPath', spec, '--feature', 'f', '--threadId', 't'], {
    cwd: root,
    env: { CODEX_PAIRED_MODEL_PLANNING: 'gpt-5.6-terra' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.model, 'gpt-5.6-terra');
  assert.equal(parsed.reasoning_effort, 'xhigh');
  rmSync(root, { recursive: true, force: true });
});
