import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeAnchor, readAnchor, clearAnchor, anchorPathFor } from '../../lib/codex-bridge/active-anchor.js';

test('writeAnchor creates .codex-paired/active.json with specPath', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  writeAnchor(repo, '/abs/path/to/spec.md');
  const data = readAnchor(repo);
  assert.equal(data.specPath, '/abs/path/to/spec.md');
  rmSync(repo, { recursive: true, force: true });
});

test('readAnchor returns null when anchor absent', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  assert.equal(readAnchor(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('clearAnchor removes the anchor file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  writeAnchor(repo, '/x/y.md');
  clearAnchor(repo);
  assert.equal(readAnchor(repo), null);
  assert.equal(existsSync(anchorPathFor(repo)), false);
  rmSync(repo, { recursive: true, force: true });
});

test('clearAnchor is idempotent (no error if absent)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  clearAnchor(repo); // anchor never existed
  rmSync(repo, { recursive: true, force: true });
});

test('anchorPathFor returns repo-root/.codex-paired/active.json', () => {
  assert.equal(anchorPathFor('/repo'), '/repo/.codex-paired/active.json');
});

// --- malformed-input edge cases ---

test('readAnchor throws on malformed JSON (loud failure, not silent)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  const target = anchorPathFor(repo);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '{not json');
  // Loud failure means the orchestrator will see a thrown error and can halt
  // with a clear "anchor corrupt" reason, rather than silently treating
  // corruption as "no autopilot active".
  assert.throws(() => readAnchor(repo), /JSON/);
  rmSync(repo, { recursive: true, force: true });
});

test('readAnchor throws on empty anchor file (corrupted state)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  const target = anchorPathFor(repo);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, '');
  assert.throws(() => readAnchor(repo));
  rmSync(repo, { recursive: true, force: true });
});

test('writeAnchor handles repoRoot that does not exist yet', () => {
  // A user might invoke autopilot in a brand-new directory. mkdir -p in
  // writeAnchor must handle the parent not existing.
  const baseTmp = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  const repo = join(baseTmp, 'nested', 'repo'); // doesn't exist
  // writeAnchor must mkdir -p the .codex-paired/ dir AND any parent dirs.
  // Currently it mkdirs only .codex-paired, so this should still work
  // because mkdir({recursive:true}) handles arbitrary parent depth.
  writeAnchor(repo, '/abs/spec.md');
  const data = readAnchor(repo);
  assert.equal(data.specPath, '/abs/spec.md');
  rmSync(baseTmp, { recursive: true, force: true });
});
