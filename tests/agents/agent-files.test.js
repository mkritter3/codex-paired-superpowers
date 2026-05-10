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
//
// v0.7.2 changes: codex implementer no longer ships as a Claude Code subagent.
// It dispatches via orchestrator-level background Bash (LocalShell pattern).
// The codex contract moved to docs/codex-implementer-contract.md (NOT in
// agents/). This test file now covers ONLY the sonnet subagent file.

test('agents/slice-implementer-codex.md does NOT exist (v0.7.2: codex moved to docs/)', async () => {
  // Defense against accidental restoration. If codex returns to agents/,
  // someone must update the registry schema and this test together.
  const { existsSync } = await import('node:fs');
  assert.equal(
    existsSync(CODEX_AGENT_PATH),
    false,
    `${CODEX_AGENT_PATH} must not exist; v0.7.2 moved the codex contract to docs/codex-implementer-contract.md`,
  );
});

test('docs/codex-implementer-contract.md exists and is readable', async () => {
  const contractPath = join(PLUGIN_ROOT, 'docs', 'codex-implementer-contract.md');
  const text = await readFile(contractPath, 'utf8');
  assert.ok(text.length > 0, 'codex contract doc is empty');
});

test('agents/slice-implementer-sonnet.md exists and is readable', async () => {
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  assert.ok(text.length > 0, 'sonnet agent file is empty');
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

test('sonnet agent body declares the JSON status block contract', async () => {
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  const { body } = parseFrontmatter(text);
  assert.ok(/"status"\s*:/.test(body), `${SONNET_AGENT_PATH}: body missing "status": key`);
  assert.ok(/\bDONE\b/.test(body), `${SONNET_AGENT_PATH}: body missing DONE status`);
  assert.ok(/\bBLOCKED\b/.test(body), `${SONNET_AGENT_PATH}: body missing BLOCKED status`);
  assert.ok(
    /\bNEEDS_CONTEXT\b/.test(body),
    `${SONNET_AGENT_PATH}: body missing NEEDS_CONTEXT status`,
  );
});

test('sonnet agent body references the subject-only commit convention', async () => {
  // The convention's distinctive shape is `(feat|test|fix|docs|refactor|chore)(slice:N): ...`.
  // We accept either the literal alternation form or a concrete example like `feat(slice:3):`.
  const conventionRe = /\(feat\|test\|fix\|docs\|refactor\|chore\)\(slice:N\)/;
  const exampleRe = /\b(feat|test|fix|docs|refactor|chore)\(slice:\d+\):/;
  const text = await readFile(SONNET_AGENT_PATH, 'utf8');
  const { body } = parseFrontmatter(text);
  const hasConvention = conventionRe.test(body);
  const hasExample = exampleRe.test(body);
  assert.ok(
    hasConvention && hasExample,
    `${SONNET_AGENT_PATH}: body must include both the (feat|test|...)(slice:N) convention and a concrete example like feat(slice:3):`,
  );
});
