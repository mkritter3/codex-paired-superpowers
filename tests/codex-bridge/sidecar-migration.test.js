// v0.9.0 slice 5a — sidecar schema migration tests (CRITICAL tier).
//
// Covers the silent, idempotent on-load migration from v0.8.x's singular
// `codex_session` to v0.9.0's `role_sessions` map. See spec §5
// "Safety / Failure Semantics" in
// docs/architecture/2026-05-11-v0.9.0-destination.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSidecar, getCodexThreadId, sidecarPathFor } from '../../lib/codex-bridge/sidecar.js';

// Helper: spin up a temp dir, drop a spec.md, and write a sidecar file at the
// legacy `<spec>.codex.json` path (where sidecarPathFor falls back to when not
// in a git repo). Returns { dir, spec, sidecarPath }.
function setupTempSidecar(initialSidecarData) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-mig-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  const sidecarPath = sidecarPathFor(spec);
  writeFileSync(sidecarPath, JSON.stringify(initialSidecarData, null, 2));
  return { dir, spec, sidecarPath };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('v0.8.x sidecar loads + migrates + writes back + has migration record', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    codex_session: 'thread-abc',
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    const sc = loadSidecar(spec);
    // role_sessions map populated from codex_session.
    assert.equal(sc.role_sessions['paired-reviewer'], 'thread-abc');
    // codex_session preserved (three-release back-compat).
    assert.equal(sc.codex_session, 'thread-abc');
    // Migration record appended.
    assert.ok(Array.isArray(sc.migrations));
    assert.equal(sc.migrations.length, 1);
    assert.equal(sc.migrations[0].from_schema, 'v0.8.x');
    assert.equal(sc.migrations[0].to_schema, 'v0.9.0');
    assert.match(sc.migrations[0].migrated_at, /^\d{4}-\d{2}-\d{2}T/);
    // Written back to disk.
    const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.equal(onDisk.role_sessions['paired-reviewer'], 'thread-abc');
    assert.equal(onDisk.migrations.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('v0.9.0 sidecar (only role_sessions) loads cleanly with no migration record', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    role_sessions: { 'paired-reviewer': 'thread-xyz' },
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    const before = readFileSync(sidecarPath, 'utf8');
    const sc = loadSidecar(spec);
    assert.equal(sc.role_sessions['paired-reviewer'], 'thread-xyz');
    // No legacy field — and no migration record added.
    assert.equal(sc.codex_session, undefined);
    assert.equal(sc.migrations, undefined);
    // File unchanged on disk.
    const after = readFileSync(sidecarPath, 'utf8');
    assert.equal(before, after);
  } finally {
    cleanup(dir);
  }
});

test('mixed sidecar (both codex_session and role_sessions) loads cleanly, no migration, legacy preserved', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    codex_session: 'legacy-thread',
    role_sessions: { 'paired-reviewer': 'new-thread' },
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    const before = readFileSync(sidecarPath, 'utf8');
    const sc = loadSidecar(spec);
    // Both fields present.
    assert.equal(sc.codex_session, 'legacy-thread');
    assert.equal(sc.role_sessions['paired-reviewer'], 'new-thread');
    // No migration record — role_sessions already exists.
    assert.equal(sc.migrations, undefined);
    const after = readFileSync(sidecarPath, 'utf8');
    assert.equal(before, after);
  } finally {
    cleanup(dir);
  }
});

test('migration is idempotent — second load does not double-add migration record', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    codex_session: 'thread-1',
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    const first = loadSidecar(spec);
    assert.equal(first.migrations.length, 1);
    const afterFirst = readFileSync(sidecarPath, 'utf8');
    // Second load should not run the migration again.
    const second = loadSidecar(spec);
    assert.equal(second.migrations.length, 1);
    const afterSecond = readFileSync(sidecarPath, 'utf8');
    assert.equal(afterFirst, afterSecond);
  } finally {
    cleanup(dir);
  }
});

test('getCodexThreadId returns id for v0.9.0 role_sessions schema', () => {
  const sc = {
    role_sessions: {
      'paired-reviewer': 'pr-thread',
      'expert-architecture': 'arch-thread',
    },
  };
  assert.equal(getCodexThreadId(sc, 'paired-reviewer'), 'pr-thread');
  assert.equal(getCodexThreadId(sc, 'expert-architecture'), 'arch-thread');
});

test('getCodexThreadId falls back to legacy codex_session ONLY for paired-reviewer', () => {
  const sc = { codex_session: 'legacy-thread' };
  assert.equal(getCodexThreadId(sc, 'paired-reviewer'), 'legacy-thread');
  // Default role is paired-reviewer.
  assert.equal(getCodexThreadId(sc), 'legacy-thread');
  // Non-paired-reviewer roles do NOT fall back.
  assert.equal(getCodexThreadId(sc, 'expert-architecture'), undefined);
  assert.equal(getCodexThreadId(sc, 'expert-ui'), undefined);
});

test('three-release back-compat: legacy codex_session field is NOT removed after migration', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    codex_session: 'preserve-me',
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    loadSidecar(spec);
    const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    // The legacy field MUST remain in the on-disk file for three releases.
    assert.equal(onDisk.codex_session, 'preserve-me');
    // And role_sessions points to the same id.
    assert.equal(onDisk.role_sessions['paired-reviewer'], 'preserve-me');
  } finally {
    cleanup(dir);
  }
});

test('migration writes back atomically (no .tmp partial state left behind)', () => {
  const { dir, spec, sidecarPath } = setupTempSidecar({
    version: 1,
    feature: 'demo',
    codex_session: 'thread-atomic',
    model: 'gpt-5.5',
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  });
  try {
    loadSidecar(spec);
    // After load, the sidecar file MUST exist with valid JSON and NO tmp file.
    assert.ok(existsSync(sidecarPath));
    const onDisk = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    assert.equal(onDisk.role_sessions['paired-reviewer'], 'thread-atomic');
    // No leftover temp file with our PID.
    const tmpFiles = readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(tmpFiles, []);
  } finally {
    cleanup(dir);
  }
});
