/**
 * agent-files.test.js
 *
 * Structural tests for v0.7.0 plugin subagent definition files. See plan
 * slice 5 + spec §6 (Subagent Extension Model).
 *
 * These tests do NOT invoke the subagents end-to-end. They verify the files
 * exist, their YAML frontmatter parses, the tool allowlists match the
 * routing model, and the bodies declare the final-message JSON status
 * contract and subject-only commit conventions.
 *
 * Real subagent invocation is exercised by slice 8's structural smoke
 * (mocked outcomes) and slice 9's empirical Codex MCP smoke.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');

const CODEX_AGENT_PATH = join(PLUGIN_ROOT, 'agents', 'slice-implementer-codex.md');
const SONNET_AGENT_PATH = join(PLUGIN_ROOT, 'agents', 'slice-implementer-sonnet.md');

const CODEX_MCP_TOOL = 'mcp__plugin_codex-paired-superpowers_codex__codex';

// ── frontmatter parsing ──────────────────────────────────────────────────────

/**
 * Parse the YAML frontmatter of a markdown file. We do not depend on
 * `js-yaml`; the frontmatter we author is a flat key/value map with simple
 * scalar values, so a line-by-line regex split is sufficient and avoids an
 * npm dependency.
 *
 * Returns `{frontmatter: {...}, body: string}`.
 * Throws if the document does not start with `---` or has no closing `---`.
 */
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    throw new Error('frontmatter missing opening --- delimiter');
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error('frontmatter missing closing --- delimiter');
  }
  const fmLines = lines.slice(1, closeIdx);
  const frontmatter = {};
  for (const line of fmLines) {
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      throw new Error(`unparseable frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = m[1];
    const rawValue = m[2].trim();
    frontmatter[key] = rawValue;
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return { frontmatter, body };
}

function parseToolsList(toolsValue) {
  return toolsValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── tests ────────────────────────────────────────────────────────────────────

test('agents/slice-implementer-codex.md exists and is readable', async () => {
  const text = await readFile(CODEX_AGENT_PATH, 'utf8');
  assert.ok(text.length > 0, 'codex agent file is empty');
});

test('agents/slice-implementer-sonnet.md exists and is readable', async () => {
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  assert.ok(text.length > 0, 'sonnet agent file is empty');
});

test('codex agent frontmatter has required keys', async () => {
  const text = await readFile(CODEX_AGENT_PATH, 'utf8');
  const { frontmatter } = parseFrontmatter(text);
  for (const key of ['name', 'description', 'tools', 'model']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(frontmatter, key),
      `codex agent frontmatter missing key: ${key}`,
    );
    assert.ok(
      frontmatter[key] && frontmatter[key].length > 0,
      `codex agent frontmatter key has empty value: ${key}`,
    );
  }
  assert.equal(frontmatter.name, 'slice-implementer-codex');
  assert.equal(frontmatter.model, 'sonnet');
});

test('sonnet agent frontmatter has required keys', async () => {
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  const { frontmatter } = parseFrontmatter(text);
  for (const key of ['name', 'description', 'tools', 'model']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(frontmatter, key),
      `sonnet agent frontmatter missing key: ${key}`,
    );
    assert.ok(
      frontmatter[key] && frontmatter[key].length > 0,
      `sonnet agent frontmatter key has empty value: ${key}`,
    );
  }
  assert.equal(frontmatter.name, 'slice-implementer-sonnet');
  assert.equal(frontmatter.model, 'sonnet');
});

test('codex agent tools list does NOT include the Codex MCP tool (v0.7.0 fix: shell codex exec)', async () => {
  // v0.7.0 release validation found MCP-mediated dispatch serializes (~1.73x ratio).
  // The fix switched the codex implementer to shell-spawned `codex exec` for true
  // parallelism. The MCP tool was dropped from the codex agent's allowlist.
  const text = await readFile(CODEX_AGENT_PATH, 'utf8');
  const { frontmatter } = parseFrontmatter(text);
  const tools = parseToolsList(frontmatter.tools);
  assert.ok(
    !tools.includes(CODEX_MCP_TOOL),
    `codex agent tools list must NOT include ${CODEX_MCP_TOOL} (v0.7.0+ uses shell codex exec); got: ${JSON.stringify(tools)}`,
  );
  // Codex agent is a thin wrapper that shells out via Bash; it does not edit files.
  for (const t of ['Read', 'Bash']) {
    assert.ok(tools.includes(t), `codex agent tools missing ${t}`);
  }
});

test('sonnet agent tools list does NOT include the Codex MCP tool', async () => {
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  const { frontmatter } = parseFrontmatter(text);
  const tools = parseToolsList(frontmatter.tools);
  assert.ok(
    !tools.includes(CODEX_MCP_TOOL),
    `sonnet agent tools list must not include ${CODEX_MCP_TOOL}; got: ${JSON.stringify(tools)}`,
  );
  // Sonnet implements directly, so it needs the editing tools.
  for (const t of ['Read', 'Edit', 'Write', 'Bash']) {
    assert.ok(tools.includes(t), `sonnet agent tools missing ${t}`);
  }
});

test('both agent bodies declare the JSON status block contract', async () => {
  for (const path of [CODEX_AGENT_PATH, SONNET_AGENT_PATH]) {
    const text = await readFile(path, 'utf8');
    const { body } = parseFrontmatter(text);
    assert.ok(/"status"\s*:/.test(body), `${path}: body missing "status": key`);
    assert.ok(/\bDONE\b/.test(body), `${path}: body missing DONE status`);
    assert.ok(/\bBLOCKED\b/.test(body), `${path}: body missing BLOCKED status`);
    assert.ok(
      /\bNEEDS_CONTEXT\b/.test(body),
      `${path}: body missing NEEDS_CONTEXT status`,
    );
  }
});

test('both agent bodies reference the subject-only commit convention', async () => {
  // The convention's distinctive shape is `(feat|test|fix|docs|refactor|chore)(slice:N): ...`.
  // We accept either the literal alternation form or a concrete example like `feat(slice:3):`.
  const conventionRe = /\(feat\|test\|fix\|docs\|refactor\|chore\)\(slice:N\)/;
  const exampleRe = /\b(feat|test|fix|docs|refactor|chore)\(slice:\d+\):/;
  for (const path of [CODEX_AGENT_PATH, SONNET_AGENT_PATH]) {
    const text = await readFile(path, 'utf8');
    const { body } = parseFrontmatter(text);
    const hasConvention = conventionRe.test(body);
    const hasExample = exampleRe.test(body);
    assert.ok(
      hasConvention && hasExample,
      `${path}: body must include both the (feat|test|...)(slice:N) convention and a concrete example like feat(slice:3):`,
    );
  }
});
