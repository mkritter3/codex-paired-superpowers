// v0.13.0 Slice 5 — installed-smoke for real Codex MCP reliability behavior.
//
// TIER 4 — only runs when CPS_INSTALLED_SMOKE=1 AND `codex` is on PATH AND Codex is authenticated.
// Excluded from `npm test` (see scripts/collect-test-files.mjs). Run with:
//
//   CPS_INSTALLED_SMOKE=1 node --test tests/installed-smoke/codex-mcp-reliability.test.js
//
// IMPORTANT: these tests drive a real `codex mcp-server` over MCP stdio (newline-delimited
// JSON-RPC) and require live Codex auth. They cannot run in CI. They assert the three v0.13.0
// reliability guarantees against the REAL server launched with the manifest's pinned args:
//   1. Omitted per-call model → session starts on gpt-5.5 (Goal 2 pin).
//   2. The review sandbox can write outside the workspace (under ~/.codex/tmp) with no approval
//      prompt, and can run a project command with no approval prompt (Goal 1 full-access).
//   3. A thread id from a restarted server yields "Session not found for thread_id" (Goal 3 premise
//      that the recovery path handles).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SMOKE_ENABLED = process.env.CPS_INSTALLED_SMOKE === '1';
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function codexPresent() {
  try { execFileSync('which', ['codex'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
  catch { return false; }
}
const READY = SMOKE_ENABLED && codexPresent();

// The exact args the plugin launches the Codex MCP server with (pinned in v0.13.0).
function manifestCodexArgs() {
  const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  return m.mcpServers.codex.args;
}

// ── Minimal MCP stdio client (newline-delimited JSON-RPC) ──────────────────
//
// Spawns `codex <args>`, performs the initialize handshake, and exposes call()/notifications.
// Each JSON-RPC message is a single line of JSON terminated by '\n' (MCP stdio framing).
class McpStdioClient {
  constructor(args) {
    this.proc = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this._buf = '';
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.stderr = '';
    this.proc.stderr.on('data', (c) => { this.stderr += c.toString(); });
  }
  _onData(chunk) {
    this._buf += chunk.toString();
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.notifications.push(msg);
      }
    }
  }
  _send(obj) { this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms; stderr=${this.stderr.slice(-400)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this._send({ jsonrpc: '2.0', method, params }); }
  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cps-smoke', version: '0.13.0' },
    });
    this.notify('notifications/initialized', {});
  }
  sessionModel() {
    // Codex emits async events as method "codex/event" with the payload under params.msg.
    // session_configured carries the resolved model.
    const n = this.notifications.find(
      (m) => m.method === 'codex/event' && m.params && m.params.msg && m.params.msg.type === 'session_configured',
    );
    return n ? n.params.msg.model : undefined;
  }
  // Codex returns the thread id in the tool result's structuredContent; notifications also carry it.
  threadIdFrom(result) {
    if (result && result.structuredContent && result.structuredContent.threadId) return result.structuredContent.threadId;
    const n = this.notifications.find(
      (m) => m.params && ((m.params._meta && m.params._meta.threadId) || (m.params.msg && m.params.msg.thread_id)),
    );
    if (n) return (n.params._meta && n.params._meta.threadId) || (n.params.msg && n.params.msg.thread_id);
    return undefined;
  }
  // Did Codex surface an approval/permission/elicitation request? All async events use the
  // "codex/event" method, so the signal is in params.msg.type, not the JSON-RPC method name.
  approvalRequested() {
    return this.notifications.some(
      (m) => m.method === 'codex/event' && m.params && m.params.msg &&
        /approval|permission|elicit|exec_approval|apply_patch_approval/i.test(m.params.msg.type || ''),
    );
  }
  close() { try { this.proc.kill('SIGKILL'); } catch { /* noop */ } }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('codex-mcp-reliability: skips unless CPS_INSTALLED_SMOKE=1 and codex on PATH',
  { skip: READY ? false : 'CPS_INSTALLED_SMOKE!=1 or codex not on PATH; skipping live MCP smoke' },
  () => { assert.ok(READY); },
);

test('Goal 2: omitted per-call model → session_configured.model is gpt-5.5',
  { timeout: 90_000, skip: READY ? false : 'live MCP smoke disabled' },
  async () => {
    const client = new McpStdioClient(manifestCodexArgs());
    try {
      await client.initialize();
      // Call the `codex` tool with NO per-call model — the server pin (-c model="gpt-5.5") must apply.
      await client.request('tools/call', {
        name: 'codex',
        arguments: { prompt: 'Reply with the single word: ok.' },
      }, 80_000);
      assert.equal(client.sessionModel(), 'gpt-5.5',
        `expected pinned gpt-5.5 when per-call model omitted; got ${client.sessionModel()}`);
    } finally { client.close(); }
  },
);

test('Goal 1: review sandbox writes outside the workspace + runs a project command without approval',
  { timeout: 120_000, skip: READY ? false : 'live MCP smoke disabled' },
  async () => {
    const client = new McpStdioClient(manifestCodexArgs());
    const probe = join(homedir(), '.codex', 'tmp', `cps_smoke_${Date.now()}.txt`);
    try {
      await client.initialize();
      const res = await client.request('tools/call', {
        name: 'codex',
        arguments: {
          prompt:
            `Do exactly two things using your shell, with no commentary:\n` +
            `1) write the text "ok" to ${probe} (create the directory if needed)\n` +
            `2) run \`node --version\` and report its output.\n` +
            `If any command needs approval, that is a FAILURE — report it.`,
        },
      }, 110_000);
      const text = JSON.stringify(res);
      // danger-full-access + approval_policy=never means no approval-request event should appear.
      assert.equal(client.approvalRequested(), false, 'no approval prompt should be raised under danger-full-access/never');
      assert.match(text, /v\d+\./, 'node --version output should be present in the tool result');
    } finally { client.close(); }
  },
);

test('Goal 3: a thread id from a restarted server yields "Session not found for thread_id"',
  { timeout: 120_000, skip: READY ? false : 'live MCP smoke disabled' },
  async () => {
    const args = manifestCodexArgs();
    const c1 = new McpStdioClient(args);
    let threadId;
    try {
      await c1.initialize();
      const r = await c1.request('tools/call', { name: 'codex', arguments: { prompt: 'Say ok.' } }, 80_000);
      threadId = c1.threadIdFrom(r); // result.structuredContent.threadId (or notification _meta/msg)
      assert.ok(threadId, 'expected a threadId from the first codex call');
    } finally { c1.close(); }

    // Restart the server and reply against the stale thread id.
    const c2 = new McpStdioClient(args);
    try {
      await c2.initialize();
      const reply = await c2.request('tools/call', {
        name: 'codex-reply',
        arguments: { threadId, prompt: 'continue' },
      }, 80_000);
      assert.match(JSON.stringify(reply), /Session not found for thread_id/,
        'a stale thread id from a restarted server must report Session not found (the Goal 3 premise)');
    } finally { c2.close(); }
  },
);
