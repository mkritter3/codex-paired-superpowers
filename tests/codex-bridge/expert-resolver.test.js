// Plan 3 (reviewer naming migration) — expert-resolver is now a back-compat
// shim that re-exports the canonical reviewer-resolver. `resolveIdentity`
// returns the canonical `reviewer-<role>` id; `ExpertResolverError` is an alias
// of `ReviewerResolverError` (same class object) so `role-composer.js`'s
// `instanceof ExpertResolverError` keeps working through the migration window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveIdentity,
  ExpertResolverError,
} from '../../lib/codex-bridge/expert-resolver.js';
import { ReviewerResolverError } from '../../lib/codex-bridge/reviewer-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const BUILTIN_PROMPTS_DIR = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'prompts');

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-expert-resolver-test-'));
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test('shim resolveIdentity delegates and returns the canonical reviewer-<role> id', () => {
  const root = makeRepo();
  try {
    const identity = resolveIdentity('ui', root);
    assert.equal(identity.id, 'reviewer-ui');
    assert.equal(identity.role, 'ui');
    assert.equal(identity.source, 'builtin');
    assert.equal(identity.promptPath, join(BUILTIN_PROMPTS_DIR, 'reviewer-ui.md'));
  } finally {
    cleanup(root);
  }
});

test('ExpertResolverError is the same class object as ReviewerResolverError (alias)', () => {
  assert.equal(ExpertResolverError, ReviewerResolverError);
});

test('errors thrown through the shim are instanceof ExpertResolverError', () => {
  const root = makeRepo();
  try {
    let caught;
    try {
      resolveIdentity('nonexistent', root);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ExpertResolverError, 'expected ExpertResolverError');
    assert.equal(caught.code, 'reviewer-not-found');
  } finally {
    cleanup(root);
  }
});

test('shim repo-override resolution returns canonical id', () => {
  const root = makeRepo();
  try {
    const overrideDir = join(root, '.codex-paired', 'experts');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'ui.md');
    writeFileSync(overridePath, '# custom ui reviewer\n', 'utf8');

    const identity = resolveIdentity('ui', root);
    assert.equal(identity.id, 'reviewer-ui');
    assert.equal(identity.source, 'repo-override');
    assert.equal(identity.promptPath, overridePath);
  } finally {
    cleanup(root);
  }
});

test('shim still validates role names (invalid-role-name via alias)', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('../evil', root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});
