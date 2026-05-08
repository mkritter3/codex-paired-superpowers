import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
