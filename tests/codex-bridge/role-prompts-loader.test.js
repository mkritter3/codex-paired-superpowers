// v0.9.0 slice 5a — role-prompt loader tests (CRITICAL tier).
//
// Covers frontmatter parsing, error paths, and the soft hash-verification
// helper used by the dispatcher to audit `role_prompt_hash` against
// `role-prompts.lock.json`. See spec §5 in
// docs/architecture/2026-05-11-v0.9.0-destination.md.
//
// Plan 3 (reviewer naming migration): the 7 role prompts were renamed
// expert-*.md → reviewer-*.md with role_id frontmatter edited to reviewer-*.
// The loader now canonicalizes legacy expert-* ids to reviewer-* before the
// strict role_id check + lock lookup, so loadRolePrompt('expert-ui') aliases to
// reviewer-ui.md. expert-template.md is NOT a reviewer role and stays as-is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRolePrompt,
  verifyRolePromptHash,
  RolePromptError,
  roleIdToFilename,
  canonicalizeRoleId,
} from '../../lib/codex-bridge/role-prompts-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_PROMPTS_DIR = join(__dirname, '..', '..', 'lib', 'codex-bridge', 'prompts');
const REAL_LOCK_FILE = join(__dirname, '..', '..', 'lib', 'codex-bridge', 'role-prompts.lock.json');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeTempPromptsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cps-rp-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test('loadRolePrompt parses frontmatter correctly and returns version, content, hash', () => {
  const body = '# Reviewer: Architecture\n\nBody text here.\n';
  const file = `---\nversion: v0.9.0-r1\nrole_id: reviewer-architecture\n---\n${body}`;
  const dir = makeTempPromptsDir({ 'reviewer-architecture.md': file });
  try {
    const result = loadRolePrompt('reviewer-architecture', { promptsDir: dir });
    assert.equal(result.roleId, 'reviewer-architecture');
    assert.equal(result.version, 'v0.9.0-r1');
    assert.equal(result.content, body);
    assert.equal(result.hash, sha256(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws RolePromptError when file is missing', () => {
  const dir = makeTempPromptsDir({});
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-architecture', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /not found/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws on malformed frontmatter (no closing ---)', () => {
  const file = `---\nversion: v0.9.0-r1\nrole_id: reviewer-ui\n# (closing fence missing)\n# body content here\n`;
  const dir = makeTempPromptsDir({ 'reviewer-ui.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-ui', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /not terminated/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when version field is absent', () => {
  const file = `---\nrole_id: reviewer-test\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'reviewer-test.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-test', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /missing required frontmatter field "version"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when role_id field is absent', () => {
  const file = `---\nversion: v0.9.0-r1\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'reviewer-security.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-security', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /missing required frontmatter field "role_id"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when role_id frontmatter disagrees with caller-supplied id', () => {
  const file = `---\nversion: v0.9.0-r1\nrole_id: reviewer-ui\n---\n# body\n`;
  // File on disk is reviewer-backend.md but declares role_id: reviewer-ui.
  const dir = makeTempPromptsDir({ 'reviewer-backend.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-backend', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /declares role_id="reviewer-ui"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt rejects malformed frontmatter lines', () => {
  // Line without colon → reject.
  const file = `---\nversion: v0.9.0-r1\nrole_id reviewer-ux\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'reviewer-ux.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('reviewer-ux', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /malformed frontmatter/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt accepts blank lines and # comments inside frontmatter', () => {
  const file = `---\n# header comment\nversion: v0.9.0-r1\n\nrole_id: reviewer-ai-harness\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'reviewer-ai-harness.md': file });
  try {
    const r = loadRolePrompt('reviewer-ai-harness', { promptsDir: dir });
    assert.equal(r.version, 'v0.9.0-r1');
    assert.equal(r.roleId, 'reviewer-ai-harness');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt resolves paired-reviewer to system-rubric.md', () => {
  const file = `---\nversion: v0.9.0-r1\nrole_id: paired-reviewer\n---\n## You are an L11 Engineering Partner\n`;
  const dir = makeTempPromptsDir({ 'system-rubric.md': file });
  try {
    const r = loadRolePrompt('paired-reviewer', { promptsDir: dir });
    assert.equal(r.roleId, 'paired-reviewer');
    assert.equal(r.version, 'v0.9.0-r1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Plan 3: reviewer-* canonical ids + expert-* alias ---------------------

test('loadRolePrompt resolves reviewer-* ids against the real prompts dir (content + lock-matching hash)', () => {
  const r = loadRolePrompt('reviewer-ui', { promptsDir: REAL_PROMPTS_DIR });
  assert.equal(r.roleId, 'reviewer-ui');
  assert.ok(r.content.length > 0, 'reviewer-ui prompt body should be non-empty');
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  const lock = JSON.parse(readFileSync(REAL_LOCK_FILE, 'utf8'));
  assert.equal(r.hash, lock.prompts['reviewer-ui'].sha256);
});

test('loadRolePrompt aliases legacy expert-* ids to the reviewer-* file (same content/hash, canonical roleId)', () => {
  const reviewer = loadRolePrompt('reviewer-ui', { promptsDir: REAL_PROMPTS_DIR });
  const expert = loadRolePrompt('expert-ui', { promptsDir: REAL_PROMPTS_DIR });
  assert.equal(expert.content, reviewer.content, 'expert-ui must alias the same body as reviewer-ui');
  assert.equal(expert.hash, reviewer.hash, 'expert-ui must alias the same hash as reviewer-ui');
  assert.equal(expert.roleId, 'reviewer-ui', 'roleId is canonicalized to reviewer-ui');
});

test('roleIdToFilename maps reviewer-*, legacy expert-*, paired-reviewer, and expert-template', () => {
  assert.equal(roleIdToFilename('reviewer-security'), 'reviewer-security.md');
  assert.equal(roleIdToFilename('expert-security'), 'reviewer-security.md');
  assert.equal(roleIdToFilename('paired-reviewer'), 'system-rubric.md');
  assert.equal(roleIdToFilename('expert-template'), 'expert-template.md');
});

test('canonicalizeRoleId maps expert-* (except expert-template) to reviewer-*', () => {
  assert.equal(canonicalizeRoleId('expert-ui'), 'reviewer-ui');
  assert.equal(canonicalizeRoleId('reviewer-ui'), 'reviewer-ui');
  assert.equal(canonicalizeRoleId('paired-reviewer'), 'paired-reviewer');
  assert.equal(canonicalizeRoleId('expert-template'), 'expert-template');
});

test('loadRolePrompt throws RolePromptError for an unknown reviewer-*/expert-* id with no backing file', () => {
  assert.throws(
    () => loadRolePrompt('reviewer-nope', { promptsDir: REAL_PROMPTS_DIR }),
    (err) => err instanceof RolePromptError && /not found/.test(err.message)
  );
  assert.throws(
    () => loadRolePrompt('expert-nope', { promptsDir: REAL_PROMPTS_DIR }),
    (err) => err instanceof RolePromptError && /not found/.test(err.message)
  );
});

test('verifyRolePromptHash returns true on match and false on mismatch (soft signal — does NOT throw)', () => {
  const content = `---\nversion: v0.9.0-r1\nrole_id: reviewer-test\n---\n# body\n`;
  const lock = {
    prompts: {
      'reviewer-test': { path: 'lib/codex-bridge/prompts/reviewer-test.md', sha256: sha256(content) },
    },
  };
  // Match.
  assert.equal(verifyRolePromptHash('reviewer-test', content, lock), true);
  // Mismatch (edited content).
  const tampered = content + '\nedited\n';
  assert.equal(verifyRolePromptHash('reviewer-test', tampered, lock), false);
  // Absent entry returns false (also a soft signal).
  assert.equal(verifyRolePromptHash('reviewer-test', content, { prompts: {} }), false);
  // Malformed lock returns false rather than throwing.
  assert.equal(verifyRolePromptHash('reviewer-test', content, null), false);
});

test('committed role-prompts.lock.json matches every prompt file on disk (end-to-end)', () => {
  const lock = JSON.parse(readFileSync(REAL_LOCK_FILE, 'utf8'));
  for (const [roleId, entry] of Object.entries(lock.prompts)) {
    const result = loadRolePrompt(roleId, { promptsDir: REAL_PROMPTS_DIR });
    assert.equal(
      result.hash,
      entry.sha256,
      `hash for "${roleId}" disagrees with role-prompts.lock.json — regenerate with scripts/generate-role-prompts-lock.mjs`
    );
    // And verifyRolePromptHash agrees.
    const fullFile = readFileSync(join(REAL_PROMPTS_DIR, roleIdToFilename(roleId)), 'utf8');
    assert.equal(verifyRolePromptHash(roleId, fullFile, lock), true);
  }
});
