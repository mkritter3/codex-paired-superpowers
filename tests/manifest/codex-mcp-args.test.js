// v0.13.0 Slice 1 — manifest pin for the Codex MCP server (Goal 2 + Goal 1 sandbox).
//
// The audit (spec §4) proved that server-level `-c model="gpt-5.5"` only applies when the caller
// omits a per-call model; pinning here is half of Goal 2 (the other half is stripping per-call model
// from skills). `danger-full-access` + `approval_policy=never` are the Goal 1 sandbox escalation so
// Codex reviews can run real verification (out-of-workspace caches, ports) without approval prompts.

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

test('codex MCP args pin model to gpt-5.5', () => {
  assert.match(joined, /model="gpt-5\.5"/);
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
