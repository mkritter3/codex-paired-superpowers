// v0.9.0 slice 5b — response overflow storage tests.
//
// `storeResponse(repoRoot, text, options)` returns:
//   - { response_text_inline, response_hash } when <=cap
//   - { response_ref, response_hash } when >cap (file at
//     `<repoRoot>/.superpowers-codex-paired/responses/sha256-<hex>.txt`).
//
// `readResponse(repoRoot, turnEntry)` reads via inline or ref; verifies hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { storeResponse, readResponse, SIDECAR_DEFAULTS } from '../../lib/codex-bridge/sidecar.js';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'cps-resp-overflow-'));
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

test('storeResponse: 1KB text → inline + correct hash', () => {
  const root = makeTmp();
  const text = 'X'.repeat(1024); // 1KB
  const stored = storeResponse(root, text);
  assert.equal(stored.response_text_inline, text);
  assert.equal(stored.response_hash, `sha256:${sha256Hex(text)}`);
  assert.equal(stored.response_ref, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('storeResponse: 100KB text → response_ref + sha256-... file on disk', () => {
  const root = makeTmp();
  const text = 'A'.repeat(100 * 1024); // 100KB > 50KB cap
  const stored = storeResponse(root, text);
  assert.equal(stored.response_text_inline, undefined);
  const hashHex = sha256Hex(text);
  assert.equal(stored.response_hash, `sha256:${hashHex}`);
  assert.equal(stored.response_ref, `responses/sha256-${hashHex}.txt`);
  const onDisk = join(root, '.superpowers-codex-paired', 'responses', `sha256-${hashHex}.txt`);
  assert.ok(existsSync(onDisk), 'overflow file must exist on disk');
  assert.equal(readFileSync(onDisk, 'utf8'), text);
  // Sanity: cap default is 50 KiB.
  assert.equal(SIDECAR_DEFAULTS.MAX_INLINE_RESPONSE_BYTES, 51200);
  rmSync(root, { recursive: true, force: true });
});

test('storeResponse: identical 100KB text twice → dedupes to same file (content-addressed)', () => {
  const root = makeTmp();
  const text = 'B'.repeat(100 * 1024);
  const a = storeResponse(root, text);
  const b = storeResponse(root, text);
  assert.equal(a.response_ref, b.response_ref);
  assert.equal(a.response_hash, b.response_hash);
  // Only one file on disk.
  const expectedPath = join(root, '.superpowers-codex-paired', a.response_ref);
  assert.ok(existsSync(expectedPath));
  rmSync(root, { recursive: true, force: true });
});

test('readResponse: reads from disk for response_ref; hash mismatch → throws', () => {
  const root = makeTmp();
  const text = 'C'.repeat(100 * 1024);
  const stored = storeResponse(root, text);
  // Happy: readResponse returns the text.
  const read = readResponse(root, stored);
  assert.equal(read, text);

  // Tamper: overwrite the file with different content; readResponse must throw on hash mismatch.
  const onDiskPath = join(root, '.superpowers-codex-paired', stored.response_ref);
  writeFileSync(onDiskPath, 'tampered content');
  assert.throws(() => readResponse(root, stored), /response_ref hash mismatch/);

  rmSync(root, { recursive: true, force: true });
});
