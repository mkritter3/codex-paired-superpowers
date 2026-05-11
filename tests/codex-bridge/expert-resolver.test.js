// Tests for v0.8.0 expert-resolver — resolves a role name to an ExpertIdentity
// from either the repo override path or the plugin builtin prompts dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveIdentity,
  ExpertResolverError,
} from '../../lib/codex-bridge/expert-resolver.js';

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

test('resolveIdentity returns builtin when no repo override exists', () => {
  const root = makeRepo();
  try {
    const identity = resolveIdentity('ui', root);
    assert.equal(identity.id, 'expert-ui');
    assert.equal(identity.role, 'ui');
    assert.equal(identity.source, 'builtin');
    assert.equal(
      identity.promptPath,
      join(BUILTIN_PROMPTS_DIR, 'expert-ui.md')
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity returns repo-override when override exists', () => {
  const root = makeRepo();
  try {
    const overrideDir = join(root, '.codex-paired', 'experts');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'ui.md');
    writeFileSync(overridePath, '# custom ui expert\n', 'utf8');

    const identity = resolveIdentity('ui', root);
    assert.equal(identity.id, 'expert-ui');
    assert.equal(identity.role, 'ui');
    assert.equal(identity.source, 'repo-override');
    assert.equal(identity.promptPath, overridePath);
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity throws expert-not-found for unknown role with both paths in message', () => {
  const root = makeRepo();
  try {
    let caught;
    try {
      resolveIdentity('nonexistent', root);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ExpertResolverError, 'expected ExpertResolverError');
    assert.equal(caught.code, 'expert-not-found');
    assert.ok(
      caught.message.includes('nonexistent'),
      `error message should mention the role name: ${caught.message}`
    );
    const expectedOverride = join(
      root,
      '.codex-paired',
      'experts',
      'nonexistent.md'
    );
    const expectedBuiltin = join(BUILTIN_PROMPTS_DIR, 'expert-nonexistent.md');
    assert.ok(
      caught.message.includes(expectedOverride),
      `error message should include override path: ${caught.message}`
    );
    assert.ok(
      caught.message.includes(expectedBuiltin),
      `error message should include builtin path: ${caught.message}`
    );
    assert.ok(Array.isArray(caught.paths), 'error.paths should be an array');
    assert.deepEqual(caught.paths, [expectedOverride, expectedBuiltin]);
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity throws expert-prompt-unreadable when builtin is unreadable', () => {
  // Skip on root (where chmod 000 is ignored) — best-effort detection.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return;
  }
  const root = makeRepo();
  // Use a repo-override path because the builtin file is shared/global and
  // we must not leave it chmod 000. The resolver runs the same readability
  // check on whichever path it tries first.
  const overrideDir = join(root, '.codex-paired', 'experts');
  mkdirSync(overrideDir, { recursive: true });
  const overridePath = join(overrideDir, 'ui.md');
  writeFileSync(overridePath, '# custom\n', 'utf8');
  const originalMode = statSync(overridePath).mode;
  let modeChanged = false;
  try {
    chmodSync(overridePath, 0o000);
    modeChanged = true;
    let caught;
    try {
      resolveIdentity('ui', root);
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof ExpertResolverError,
      'expected ExpertResolverError'
    );
    assert.equal(caught.code, 'expert-prompt-unreadable');
    assert.ok(
      caught.message.includes(overridePath),
      `error message should include unreadable path: ${caught.message}`
    );
  } finally {
    if (modeChanged) {
      try {
        chmodSync(overridePath, originalMode);
      } catch {
        // ignore
      }
    }
    cleanup(root);
  }
});
