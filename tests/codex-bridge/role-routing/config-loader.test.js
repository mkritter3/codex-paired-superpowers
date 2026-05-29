// v0.9.0 slice 3 — tests for lib/codex-bridge/role-routing/config-loader.js.
//
// Filesystem-isolated: each test creates its own mkdtemp() repoRoot so the
// real `.codex-paired/` of this plugin is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadProjectConfig,
} from '../../../lib/codex-bridge/role-routing/config-loader.js';
import { RoleRoutingError } from '../../../lib/codex-bridge/role-routing/errors.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-slice3-cfg-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJson(filePath, obj) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

test('no project overrides → returns bundled defaults', () => {
  const repo = makeRepo();
  try {
    const cfg = loadProjectConfig(repo);
    assert.ok(cfg.recommendations.has('paired-reviewer'));
    assert.ok(cfg.recommendations.has('implementer'));
    assert.ok(cfg.cliClients.has('codex'));
    assert.ok(cfg.cliClients.has('ollama'));
    assert.equal(cfg.userRouting.size, 0);
  } finally {
    cleanup(repo);
  }
});

test('.codex-paired/cli-clients/<name>.json merges with bundled', () => {
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'newcli.json'),
      { name: 'newcli', command: 'newcli' },
    );
    const cfg = loadProjectConfig(repo);
    assert.ok(cfg.cliClients.has('newcli'));
    assert.equal(cfg.cliClients.get('newcli').command, 'newcli');
    // Bundled entries still present.
    assert.ok(cfg.cliClients.has('codex'));
  } finally {
    cleanup(repo);
  }
});

test('.codex-paired/role-routing.json populates userRouting', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-architecture': { cli: 'claude' },
    });
    const cfg = loadProjectConfig(repo);
    assert.equal(cfg.userRouting.size, 1);
    assert.deepEqual(
      cfg.userRouting.get('expert-architecture'),
      { cli: 'claude' },
    );
  } finally {
    cleanup(repo);
  }
});

test('userRouting references unknown role → throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-mystery': { cli: 'codex' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_UNKNOWN_ROLE',
    );
  } finally {
    cleanup(repo);
  }
});

test('userRouting references unknown cli → throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-architecture': { cli: 'ghost' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_UNKNOWN_CLI',
    );
  } finally {
    cleanup(repo);
  }
});

test('userRouting references unknown variant on known cli → throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-ux': { cli: 'ollama', variant: 'nonexistent' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_UNKNOWN_VARIANT',
    );
  } finally {
    cleanup(repo);
  }
});

test('userRouting specifies unknown permission mode → throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-architecture': { cli: 'codex', permissions: 'sudo' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_INVALID_PERMISSIONS',
    );
  } finally {
    cleanup(repo);
  }
});

test('malformed JSON in .codex-paired/role-routing.json → throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, '.codex-paired'), { recursive: true });
    writeFileSync(
      join(repo, '.codex-paired', 'role-routing.json'),
      '{ not valid json',
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_INVALID_JSON',
    );
  } finally {
    cleanup(repo);
  }
});

test('project cli-client extends bundled (adds new variant)', () => {
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'ollama.json'),
      {
        name: 'ollama',
        variants: { 'deepseek-r2': { model_name: 'deepseek-r2:cloud' } },
      },
    );
    const cfg = loadProjectConfig(repo);
    const ollama = cfg.cliClients.get('ollama');
    assert.ok(ollama.variants['deepseek-r2'], 'new variant present');
    // Bundled variants preserved.
    assert.ok(ollama.variants['kimi-k2.6'], 'bundled variant preserved');
    // Routing referencing the new variant now validates.
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-ux': { cli: 'ollama', variant: 'deepseek-r2' },
    });
    const cfg2 = loadProjectConfig(repo);
    assert.deepEqual(
      cfg2.userRouting.get('expert-ux'),
      { cli: 'ollama', variant: 'deepseek-r2' },
    );
  } finally {
    cleanup(repo);
  }
});

test('project cli-client replacing bundled overrides command path', () => {
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      { name: 'codex', command: '/opt/local/bin/codex' },
    );
    const cfg = loadProjectConfig(repo);
    assert.equal(cfg.cliClients.get('codex').command, '/opt/local/bin/codex');
    // Permissions still inherited from bundled (shallow-merged).
    assert.ok(cfg.cliClients.get('codex').permissions);
    assert.deepEqual(
      cfg.cliClients.get('codex').permissions['read-only'].args,
      ['--sandbox', 'read-only'],
    );
  } finally {
    cleanup(repo);
  }
});

// ── Plan 3 (reviewer naming migration): reviewer-* override keys load ────────
//
// The recommendation set stays keyed expert-*; a reviewer-* override key in
// .codex-paired/role-routing.json canonicalizes to its expert-* twin for the
// "references unknown role" check so reviewer override keys are accepted.

test('userRouting with a reviewer-* override key loads (canonicalized to expert-* twin)', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'reviewer-test': { cli: 'claude' },
    });
    const cfg = loadProjectConfig(repo);
    assert.equal(cfg.userRouting.size, 1);
    assert.deepEqual(cfg.userRouting.get('reviewer-test'), { cli: 'claude' });
  } finally {
    cleanup(repo);
  }
});

test('userRouting with a genuinely-unknown reviewer-* role still throws at LOAD time', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'reviewer-nope': { cli: 'codex' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'USER_ROUTING_UNKNOWN_ROLE',
    );
  } finally {
    cleanup(repo);
  }
});
