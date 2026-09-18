import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const PROBE_PATH = resolve(REPO_ROOT, 'probe.js');

const config = ts.readConfigFile(resolve(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(
  { ...config.config, files: [PROBE_PATH] },
  ts.sys,
  REPO_ROOT,
  undefined,
  resolve(REPO_ROOT, 'tsconfig.json'),
);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
}

function diagnosticsFor(source) {
  const host = ts.createCompilerHost(parsed.options);
  const delegateGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => path === PROBE_PATH || ts.sys.fileExists(path);
  host.readFile = (path) => path === PROBE_PATH ? source : ts.sys.readFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path === PROBE_PATH) {
      return ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.JS);
    }
    return delegateGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram({ rootNames: [PROBE_PATH], options: parsed.options, host });
  return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === PROBE_PATH);
}

function diagnosticCodes(source) {
  return diagnosticsFor(`// @ts-check\n${source}`).map((diagnostic) => diagnostic.code);
}

test('withReviewCheckout requires a callback with the declared signature', () => {
  assert.deepEqual(diagnosticCodes(`
    import { withReviewCheckout } from './lib/codex-bridge/worktree.js';
    withReviewCheckout('/repo');
  `), [2554]);
  assert.deepEqual(diagnosticCodes(`
    import { withReviewCheckout } from './lib/codex-bridge/worktree.js';
    withReviewCheckout('/repo', {}, undefined);
  `), [2345]);
  assert.deepEqual(diagnosticCodes(`
    import { withReviewCheckout } from './lib/codex-bridge/worktree.js';
    withReviewCheckout('/repo', {}, (checkoutDir) => checkoutDir.length);
  `), []);
});

test('sidecar bootstrap setter requires string completion metadata', () => {
  assert.deepEqual(diagnosticCodes(`
    import { setImplementBootstrap } from './lib/codex-bridge/sidecar.js';
    const bootstrap = { symlinks: ['node_modules'], completed_at: 42 };
    setImplementBootstrap('/repo/spec.md', 'slice-2', bootstrap);
  `), [2345]);
  assert.deepEqual(diagnosticCodes(`
    import { setImplementBootstrap } from './lib/codex-bridge/sidecar.js';
    setImplementBootstrap('/repo/spec.md', 'slice-2', { symlinks: ['node_modules'], completed_at: '2026-09-17T00:00:00Z' });
  `), []);
});

test('sidecar setters retain their required record shapes', () => {
  assert.deepEqual(diagnosticCodes(`
    import {
      appendFanOutRationale,
      setDependencyGraph,
      setImplementBootstrap,
      setImplementMeta,
    } from './lib/codex-bridge/sidecar.js';
    const bootstrap = { symlinks: 7, completed_at: '2026-09-17T00:00:00Z' };
    setImplementMeta('/repo/spec.md', 'slice-2', {});
    setImplementBootstrap('/repo/spec.md', 'slice-2', bootstrap);
    appendFanOutRationale('/repo/spec.md', {});
    setDependencyGraph('/repo/spec.md', {});
  `), [2345, 2345, 2345, 2345]);
  assert.deepEqual(diagnosticCodes(`
    import {
      appendFanOutRationale,
      setDependencyGraph,
      setImplementBootstrap,
      setImplementMeta,
    } from './lib/codex-bridge/sidecar.js';
    setImplementMeta('/repo/spec.md', 'slice-2', {
      preferred_implementer: 'codex',
      fallback_implementer: 'sonnet',
      parallel_group: null,
      parallel_suppressed_reason: null,
      worktree: '/repo/worktree',
    });
    setImplementBootstrap('/repo/spec.md', 'slice-2', {
      symlinks: ['node_modules'],
      completed_at: '2026-09-17T00:00:00Z',
    });
    appendFanOutRationale('/repo/spec.md', {
      phase: 'spec-review', selected_count: 6, rationale: 'Broad review surface',
    });
    setDependencyGraph('/repo/spec.md', { digest: 'sha256:abc', dag: {} });
  `), []);
});

test('runChildWithLifecycle requires a string command', () => {
  assert.deepEqual(diagnosticCodes(`
    import { runChildWithLifecycle } from './lib/codex-bridge/cli-harness/process-lifecycle.js';
    runChildWithLifecycle({});
  `), [2345]);
  assert.deepEqual(diagnosticCodes(`
    import { runChildWithLifecycle } from './lib/codex-bridge/cli-harness/process-lifecycle.js';
    runChildWithLifecycle({ command: 42, args: [] });
  `), [2322]);
  assert.deepEqual(diagnosticCodes(`
    import { runChildWithLifecycle } from './lib/codex-bridge/cli-harness/process-lifecycle.js';
    runChildWithLifecycle({ command: 'node', args: ['--version'] });
  `), []);
});
