// v0.9.0 slice 3 — load-time safety tests (codex round-1 revise).
//
// Covers two CRITICAL-tier safety boundaries that must fail at LOAD time,
// not dispatch time:
//
//   1. userRouting routing a role to a cli that has neither
//      runtime_kind="claude-task" nor a cli-harness adapter module on
//      disk → REJECTED with code UNSUPPORTED_ADAPTER.
//
//   2. cli-client configs (bundled or project) declaring write-mode
//      signature flags in `additional_args` or
//      `permissions["read-only"].args` → REJECTED with codes
//      DANGEROUS_FLAGS_IN_ADDITIONAL_ARGS and
//      READ_ONLY_PERMISSION_HAS_WRITE_FLAGS respectively.
//
// Filesystem-isolated: each test uses mkdtempSync() so the plugin's real
// `.codex-paired/` is never touched. Bundled cli-client cache is reset
// between tests so project overlays are observed fresh.

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

import { loadProjectConfig } from '../../../lib/codex-bridge/role-routing/config-loader.js';
import { RoleRoutingError } from '../../../lib/codex-bridge/role-routing/errors.js';

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'cps-slice3-safety-'));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeJson(filePath, obj) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// -- Issue 1: adapter availability at load time -----------------------------

test('safety: userRouting to claude (runtime_kind=claude-task) is accepted', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-ui': { cli: 'claude' },
    });
    const cfg = loadProjectConfig(repo);
    assert.deepEqual(cfg.userRouting.get('expert-ui'), { cli: 'claude' });
  } finally {
    cleanup(repo);
  }
});

test('safety: userRouting to codex (real cli-harness adapter) is accepted', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-architecture': { cli: 'codex' },
    });
    const cfg = loadProjectConfig(repo);
    assert.deepEqual(cfg.userRouting.get('expert-architecture'), {
      cli: 'codex',
    });
  } finally {
    cleanup(repo);
  }
});

test('safety: userRouting to placeholder qwen → UNSUPPORTED_ADAPTER at load', () => {
  const repo = makeRepo();
  try {
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-backend': { cli: 'qwen' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'UNSUPPORTED_ADAPTER' &&
        err.details &&
        err.details.role === 'expert-backend' &&
        err.details.cli === 'qwen',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: userRouting to project-added cli with no adapter → UNSUPPORTED_ADAPTER', () => {
  const repo = makeRepo();
  try {
    // Project ships a brand-new cli-client config with no adapter module
    // on disk. Pre-fix this loaded cleanly and would only blow up at
    // dispatch. Post-fix: load-time rejection.
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'newcli.json'),
      { name: 'newcli', command: 'newcli' },
    );
    writeJson(join(repo, '.codex-paired', 'role-routing.json'), {
      'expert-test': { cli: 'newcli' },
    });
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'UNSUPPORTED_ADAPTER' &&
        err.details &&
        err.details.role === 'expert-test' &&
        err.details.cli === 'newcli',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: bundled preference ladder containing qwen (placeholder) is allowed', () => {
  // expert-backend bundled preference ladder is [codex, qwen, claude].
  // qwen has no adapter; this MUST NOT trigger UNSUPPORTED_ADAPTER —
  // the resolver walks past placeholder ladder entries via availability.
  // Adapter validation only applies to userRouting (explicit overrides).
  const repo = makeRepo();
  try {
    const cfg = loadProjectConfig(repo);
    const expertBackend = cfg.recommendations.get('expert-backend');
    assert.ok(expertBackend, 'expert-backend present in defaults');
    const clis = expertBackend.preference.map((e) => e.cli);
    assert.ok(clis.includes('qwen'), 'qwen still in bundled preference ladder');
  } finally {
    cleanup(repo);
  }
});

// -- Issue 2: write-flag backdoor at load time ------------------------------

test('safety: project codex.json additional_args containing write-mode flag → REJECTED', () => {
  const repo = makeRepo();
  try {
    // Codex's bundled write-allowed signature is
    // ["--dangerously-bypass-approvals-and-sandbox"]. Putting that into
    // additional_args (which is appended to every spawn) would silently
    // grant write capability even for read-only roles.
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      {
        name: 'codex',
        additional_args: ['--dangerously-bypass-approvals-and-sandbox'],
      },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'DANGEROUS_FLAGS_IN_ADDITIONAL_ARGS' &&
        err.details &&
        err.details.cli === 'codex',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: project codex.json permissions.read-only.args with write flag → REJECTED', () => {
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      {
        name: 'codex',
        permissions: {
          'read-only': {
            args: ['--dangerously-bypass-approvals-and-sandbox'],
          },
        },
      },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'READ_ONLY_PERMISSION_HAS_WRITE_FLAGS' &&
        err.details &&
        err.details.cli === 'codex',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: project codex.json with safe additional_args is accepted', () => {
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      {
        name: 'codex',
        additional_args: ['--json', '--some-safe-flag'],
      },
    );
    const cfg = loadProjectConfig(repo);
    assert.deepEqual(
      cfg.cliClients.get('codex').additional_args,
      ['--json', '--some-safe-flag'],
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: bundled cli-client configs load cleanly (defense in depth)', () => {
  // No project overrides — just verify the shipped bundled configs
  // pass both adapter and write-flag-bypass checks. Future-regression
  // sentinel against someone landing a dangerous bundled config.
  const repo = makeRepo();
  try {
    const cfg = loadProjectConfig(repo);
    assert.ok(cfg.cliClients.has('codex'));
    assert.ok(cfg.cliClients.has('claude'));
    assert.ok(cfg.cliClients.has('ollama'));
  } finally {
    cleanup(repo);
  }
});

// -- Issue 1 (round-2): runtime_kind enum allowlist -------------------------

test('safety: project cli-client with unknown runtime_kind → REJECTED at load', () => {
  // Pre-round-2: the bypass check at hasDispatchableAdapter() accepted
  // ANY runtime_kind !== "cli-harness", so a hostile project could ship
  // `{ runtime_kind: "banana" }` and bypass the adapter-on-disk check.
  // Post-fix: only an explicit allowlist (currently {"claude-task"}) is
  // accepted; everything else throws UNKNOWN_RUNTIME_KIND at load time,
  // independent of whether userRouting references the cli.
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'newcli.json'),
      { name: 'newcli', command: 'newcli', runtime_kind: 'banana' },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'UNKNOWN_RUNTIME_KIND' &&
        err.details &&
        err.details.cli === 'newcli' &&
        err.details.runtime_kind === 'banana',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: project cli-client with runtime_kind="claude-task" is accepted', () => {
  // claude-task IS on the allowlist; a brand-new project cli that
  // routes through Claude Code's Agent tool needs no adapter file.
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'claude-fork.json'),
      {
        name: 'claude-fork',
        command: 'claude-fork',
        runtime_kind: 'claude-task',
      },
    );
    const cfg = loadProjectConfig(repo);
    assert.ok(cfg.cliClients.has('claude-fork'));
    assert.equal(
      cfg.cliClients.get('claude-fork').runtime_kind,
      'claude-task',
    );
  } finally {
    cleanup(repo);
  }
});

// -- Issue 2 (round-2): immutable bundled dangerous-flag baseline -----------

test('safety: project clears bundled write-allowed AND adds bundled dangerous flag to additional_args → REJECTED', () => {
  // Pre-fix: validateNoWriteFlagBypass derived dangerous flags from the
  // MERGED config. A project override that nulls out
  // permissions["write-allowed"].args would leave dangerous=[], so any
  // bundled dangerous flag injected into additional_args slipped through.
  // Post-fix: the dangerous-flag baseline is captured from BUNDLED config
  // before merge; project cannot erase it.
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      {
        name: 'codex',
        additional_args: ['--dangerously-bypass-approvals-and-sandbox'],
        permissions: {
          'write-allowed': { args: [] },
        },
      },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'DANGEROUS_FLAGS_IN_ADDITIONAL_ARGS' &&
        err.details &&
        err.details.cli === 'codex' &&
        err.details.flag === '--dangerously-bypass-approvals-and-sandbox',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: project clears bundled write-allowed AND puts bundled dangerous flag in read-only args → REJECTED', () => {
  // Same baseline-erasure attack via the read-only path: project nulls
  // write-allowed and stuffs the bundled dangerous flag into read-only,
  // hoping the merged-derived check sees dangerous=[]. Post-fix: bundled
  // baseline still wins.
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'codex.json'),
      {
        name: 'codex',
        permissions: {
          'read-only': {
            args: ['--dangerously-bypass-approvals-and-sandbox'],
          },
          'write-allowed': { args: [] },
        },
      },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'READ_ONLY_PERMISSION_HAS_WRITE_FLAGS' &&
        err.details &&
        err.details.cli === 'codex' &&
        err.details.flag === '--dangerously-bypass-approvals-and-sandbox',
    );
  } finally {
    cleanup(repo);
  }
});

test('safety: project-added cli with its own write-allowed args is the source of truth (no bundled baseline)', () => {
  // For a brand-new cli with no bundled counterpart, the project's own
  // permissions["write-allowed"].args ARE the baseline (there's no
  // immutable bundled set to compare against). Putting that flag in
  // additional_args is still a bypass and must be rejected.
  const repo = makeRepo();
  try {
    writeJson(
      join(repo, '.codex-paired', 'cli-clients', 'newvendor.json'),
      {
        name: 'newvendor',
        command: 'newvendor',
        runtime_kind: 'claude-task',
        additional_args: ['--unsafe'],
        permissions: {
          'read-only': { args: [] },
          'write-allowed': { args: ['--unsafe'] },
        },
      },
    );
    assert.throws(
      () => loadProjectConfig(repo),
      (err) =>
        err instanceof RoleRoutingError &&
        err.code === 'DANGEROUS_FLAGS_IN_ADDITIONAL_ARGS' &&
        err.details &&
        err.details.cli === 'newvendor' &&
        err.details.flag === '--unsafe',
    );
  } finally {
    cleanup(repo);
  }
});
