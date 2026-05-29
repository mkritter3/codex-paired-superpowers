// Plan 3 (reviewer naming migration) — canonical reviewer-resolver.
//
// The resolver body moved from expert-resolver.js to reviewer-resolver.js. It
// stamps the canonical `reviewer-<role>` id onto every selected reviewer and
// resolves the `reviewer-<role>.md` prompt-file convention. Error codes are
// `invalid-role-name`, `reviewer-prompt-unreadable`, `reviewer-not-found`.
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
  ReviewerResolverError,
} from '../../lib/codex-bridge/reviewer-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const BUILTIN_PROMPTS_DIR = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'prompts');

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-reviewer-resolver-test-'));
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test('resolveIdentity returns canonical reviewer-<role> builtin when no override exists', () => {
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

test('resolveIdentity returns repo-override when override exists', () => {
  const root = makeRepo();
  try {
    const overrideDir = join(root, '.codex-paired', 'experts');
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, 'ui.md');
    writeFileSync(overridePath, '# custom ui reviewer\n', 'utf8');

    const identity = resolveIdentity('ui', root);
    assert.equal(identity.id, 'reviewer-ui');
    assert.equal(identity.role, 'ui');
    assert.equal(identity.source, 'repo-override');
    assert.equal(identity.promptPath, overridePath);
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity throws reviewer-not-found for unknown role with both paths in message', () => {
  const root = makeRepo();
  try {
    let caught;
    try {
      resolveIdentity('nonexistent', root);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ReviewerResolverError, 'expected ReviewerResolverError');
    assert.equal(caught.code, 'reviewer-not-found');
    assert.ok(caught.message.includes('nonexistent'), caught.message);
    const expectedOverride = join(root, '.codex-paired', 'experts', 'nonexistent.md');
    const expectedBuiltin = join(BUILTIN_PROMPTS_DIR, 'reviewer-nonexistent.md');
    assert.ok(caught.message.includes(expectedOverride), caught.message);
    assert.ok(caught.message.includes(expectedBuiltin), caught.message);
    assert.deepEqual(caught.paths, [expectedOverride, expectedBuiltin]);
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity throws reviewer-prompt-unreadable when a candidate is unreadable', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const root = makeRepo();
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
    assert.ok(caught instanceof ReviewerResolverError, 'expected ReviewerResolverError');
    assert.equal(caught.code, 'reviewer-prompt-unreadable');
    assert.ok(caught.message.includes(overridePath), caught.message);
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

test('resolveIdentity rejects path-traversal role (../evil) with invalid-role-name', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('../evil', root),
      err =>
        err instanceof ReviewerResolverError &&
        err.code === 'invalid-role-name' &&
        /role "\.\.\/evil"/.test(err.message)
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects invalid names (slash, uppercase, underscore, empty, non-string)', () => {
  const root = makeRepo();
  try {
    for (const bad of ['ui/../x', 'UI', 'a_thing', '', null, undefined, 42, {}, ['ui']]) {
      assert.throws(
        () => resolveIdentity(bad, root),
        err => err instanceof ReviewerResolverError && err.code === 'invalid-role-name',
        `expected invalid-role-name for ${JSON.stringify(bad)}`
      );
    }
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity accepts a 48-char role (reviewer-not-found, not invalid-role-name)', () => {
  const root = makeRepo();
  try {
    const longRole = 'a' + 'b'.repeat(47);
    assert.equal(longRole.length, 48);
    assert.throws(
      () => resolveIdentity(longRole, root),
      err => err instanceof ReviewerResolverError && err.code === 'reviewer-not-found'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects role exceeding 48 chars', () => {
  const root = makeRepo();
  try {
    const tooLong = 'a' + 'b'.repeat(48);
    assert.equal(tooLong.length, 49);
    assert.throws(
      () => resolveIdentity(tooLong, root),
      err => err instanceof ReviewerResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});
