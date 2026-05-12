// v0.9.0 slice 5a — role-prompt loader tests (CRITICAL tier).
//
// Covers frontmatter parsing, error paths, and the soft hash-verification
// helper used by the dispatcher to audit `role_prompt_hash` against
// `role-prompts.lock.json`. See spec §5 in
// docs/architecture/2026-05-11-v0.9.0-destination.md.

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
  const body = '# Expert: Architecture\n\nBody text here.\n';
  const file = `---\nversion: v0.9.0-r1\nrole_id: expert-architecture\n---\n${body}`;
  const dir = makeTempPromptsDir({ 'expert-architecture.md': file });
  try {
    const result = loadRolePrompt('expert-architecture', { promptsDir: dir });
    assert.equal(result.roleId, 'expert-architecture');
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
      () => loadRolePrompt('expert-architecture', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /not found/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws on malformed frontmatter (no closing ---)', () => {
  const file = `---\nversion: v0.9.0-r1\nrole_id: expert-ui\n# (closing fence missing)\n# body content here\n`;
  const dir = makeTempPromptsDir({ 'expert-ui.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('expert-ui', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /not terminated/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when version field is absent', () => {
  const file = `---\nrole_id: expert-test\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'expert-test.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('expert-test', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /missing required frontmatter field "version"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when role_id field is absent', () => {
  const file = `---\nversion: v0.9.0-r1\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'expert-security.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('expert-security', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /missing required frontmatter field "role_id"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt throws when role_id frontmatter disagrees with caller-supplied id', () => {
  const file = `---\nversion: v0.9.0-r1\nrole_id: expert-ui\n---\n# body\n`;
  // File on disk is expert-backend.md but declares role_id: expert-ui.
  const dir = makeTempPromptsDir({ 'expert-backend.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('expert-backend', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /declares role_id="expert-ui"/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt rejects malformed frontmatter lines', () => {
  // Line without colon → reject.
  const file = `---\nversion: v0.9.0-r1\nrole_id expert-ux\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'expert-ux.md': file });
  try {
    assert.throws(
      () => loadRolePrompt('expert-ux', { promptsDir: dir }),
      (err) => err instanceof RolePromptError && /malformed frontmatter/.test(err.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRolePrompt accepts blank lines and # comments inside frontmatter', () => {
  const file = `---\n# header comment\nversion: v0.9.0-r1\n\nrole_id: expert-ai-harness\n---\n# body\n`;
  const dir = makeTempPromptsDir({ 'expert-ai-harness.md': file });
  try {
    const r = loadRolePrompt('expert-ai-harness', { promptsDir: dir });
    assert.equal(r.version, 'v0.9.0-r1');
    assert.equal(r.roleId, 'expert-ai-harness');
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

test('verifyRolePromptHash returns true on match and false on mismatch (soft signal — does NOT throw)', () => {
  const content = `---\nversion: v0.9.0-r1\nrole_id: expert-test\n---\n# body\n`;
  const lock = {
    prompts: {
      'expert-test': { path: 'lib/codex-bridge/prompts/expert-test.md', sha256: sha256(content) },
    },
  };
  // Match.
  assert.equal(verifyRolePromptHash('expert-test', content, lock), true);
  // Mismatch (edited content).
  const tampered = content + '\nedited\n';
  assert.equal(verifyRolePromptHash('expert-test', tampered, lock), false);
  // Absent entry returns false (also a soft signal).
  assert.equal(verifyRolePromptHash('expert-test', content, { prompts: {} }), false);
  // Malformed lock returns false rather than throwing.
  assert.equal(verifyRolePromptHash('expert-test', content, null), false);
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
    const fullFile = readFileSync(join(REAL_PROMPTS_DIR, roleId === 'paired-reviewer' ? 'system-rubric.md' : `${roleId}.md`), 'utf8');
    assert.equal(verifyRolePromptHash(roleId, fullFile, lock), true);
  }
});
