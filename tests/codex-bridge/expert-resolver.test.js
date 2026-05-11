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

// ── Role-name validation (path-traversal + identity-shape guard) ──────────
//
// resolveIdentity MUST validate the role name BEFORE constructing filesystem
// paths. Otherwise a directive like `**Experts:** ../evil` would let the
// resolver build `join(repoRoot, '.codex-paired', 'experts', '../evil.md')`
// — escaping the experts dir via path.join normalization — and return an
// identity id `expert-../evil` that fails downstream mailbox RECIPIENT_RE.

test('resolveIdentity rejects path-traversal role (../evil) with invalid-role-name', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('../evil', root),
      err =>
        err instanceof ExpertResolverError &&
        err.code === 'invalid-role-name' &&
        /role "\.\.\/evil"/.test(err.message)
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects role with embedded slash (ui/../x)', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('ui/../x', root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects uppercase role (UI)', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('UI', root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects role with underscore (a_thing)', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('a_thing', root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects empty role', () => {
  const root = makeRepo();
  try {
    assert.throws(
      () => resolveIdentity('', root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects non-string role', () => {
  const root = makeRepo();
  try {
    for (const bad of [null, undefined, 42, {}, ['ui']]) {
      assert.throws(
        () => resolveIdentity(bad, root),
        err => err instanceof ExpertResolverError && err.code === 'invalid-role-name',
        `expected throw for role=${JSON.stringify(bad)}`
      );
    }
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity accepts role at max length (48 chars: leading letter + 47 trailing)', () => {
  const root = makeRepo();
  try {
    // 48-char role with no override + no builtin → throws expert-not-found
    // (NOT invalid-role-name, which would be the wrong code).
    const longRole = 'a' + 'b'.repeat(47); // total 48 chars
    assert.equal(longRole.length, 48);
    assert.throws(
      () => resolveIdentity(longRole, root),
      err => err instanceof ExpertResolverError && err.code === 'expert-not-found'
    );
  } finally {
    cleanup(root);
  }
});

test('resolveIdentity rejects role exceeding 48 chars', () => {
  const root = makeRepo();
  try {
    const tooLong = 'a' + 'b'.repeat(48); // 49 chars
    assert.equal(tooLong.length, 49);
    assert.throws(
      () => resolveIdentity(tooLong, root),
      err => err instanceof ExpertResolverError && err.code === 'invalid-role-name'
    );
  } finally {
    cleanup(root);
  }
});
