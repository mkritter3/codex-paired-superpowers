// v0.16.0 Slice 5 — manifest pin for the Codex MCP server (spec §3).
//
// The server-level pin is a safety default for callers that omit per-call role configuration.
// `danger-full-access` + `approval_policy=never` retain the existing review sandbox policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(
  readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
);
const args = manifest.mcpServers.codex.args;
const joined = args.join(' ');

test('codex MCP args pin the planning model to gpt-6-astra', () => {
  assert.match(joined, /model="gpt-6-astra"/);
});

test('codex MCP args pin planning reasoning effort to xhigh', () => {
  assert.match(joined, /model_reasoning_effort="xhigh"/);
});

test('codex MCP args contain no retired gpt-5.5 pin', () => {
  assert.doesNotMatch(joined, /gpt-5\.5/);
});

test('codex MCP args set danger-full-access sandbox', () => {
  assert.match(joined, /sandbox_mode="danger-full-access"/);
});

test('codex MCP args set approval_policy never', () => {
  assert.match(joined, /approval_policy="never"/);
});

test('codex MCP server command is still codex mcp-server', () => {
  assert.equal(manifest.mcpServers.codex.command, 'codex');
  assert.equal(args[0], 'mcp-server');
});
