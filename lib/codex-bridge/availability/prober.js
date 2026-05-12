// v0.9.0 slice 4 — per-CLI availability probe.
//
// `probeCLI(name, configEntry)` runs `<command> --version` with a 2s total
// timeout. Returns a payload describing whether the CLI is installed, the
// resolved binary path, and the version string. The result is used by
// `detector.js` + `cache.js` to feed slice 3's resolver via doctor's cache.
//
// Status taxonomy:
//   - "available" — `--version` exits 0; path resolved
//   - "missing"   — binary not on PATH (which-style ENOENT)
//   - "broken"    — binary on PATH but `--version` exits nonzero OR hangs
//
// Special handling for `runtime_kind: "claude-task"` cli-clients (per spec
// + task instructions): claude routes through Claude Code's Agent tool, not
// subprocess spawn. If a CLAUDE_CODE_SESSION-style env var is set we mark
// it available even when the `claude` binary is missing; otherwise we
// probe like any other CLI.
//
// All spawning goes through node:child_process.spawn with an AbortController
// for the 2s timeout. No use of execSync — we want to bound wall time.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_PACKAGE_JSON = join(__dirname, '..', '..', '..', 'package.json');

export const PROBE_TIMEOUT_MS = 2000;

// Env-var markers that indicate the prober is running inside a live Claude
// Code session. If any are set, a claude-task cli-client is "available" by
// definition even when the `claude` binary is missing from PATH (because
// dispatch goes through the Agent tool, not spawn).
const CLAUDE_CODE_SESSION_MARKERS = [
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
];

function readPluginVersion() {
  try {
    const raw = readFileSync(PLUGIN_PACKAGE_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === 'string') return parsed.version;
  } catch {
    // fall through
  }
  return 'unknown';
}

function isInsideClaudeCodeSession(env = process.env) {
  for (const key of CLAUDE_CODE_SESSION_MARKERS) {
    const v = env[key];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return false;
}

// Run a single command with stdin closed, capturing stdout+stderr. Resolves
// with { code, stdout, stderr, timedOut, spawnError }. Never rejects.
function runOnce(command, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }, timeoutMs);

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

// Resolve `<command>` via POSIX `which`. Returns absolute path or null.
// Windows isn't a supported platform for this plugin.
async function resolveCommandPath(command, timeoutMs) {
  const which = await runOnce('which', [command], { timeoutMs });
  if (which.spawnError || which.timedOut || which.code !== 0) return null;
  const first = which.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim() : null;
}

function extractVersion(stdout, stderr) {
  // `--version` output styles vary: some tools print "foo 1.2.3", others
  // multi-line with a warning preamble (e.g. ollama). Search the full blob
  // for the first semver-ish token; fall back to the first non-empty line.
  const blob = `${stdout || ''}\n${stderr || ''}`;
  const semverMatch = blob.match(/v?\d+\.\d+(\.\d+)?([.-][A-Za-z0-9]+)*/);
  if (semverMatch) return semverMatch[0];
  const firstLine = blob.split(/\r?\n/).find((l) => l.trim().length > 0);
  return firstLine ? firstLine.trim() : null;
}

export async function probeCLI(name, configEntry, options = {}) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('probeCLI requires a non-empty name string');
  }
  if (!configEntry || typeof configEntry !== 'object') {
    throw new TypeError('probeCLI requires a configEntry object');
  }
  const env = options.env || process.env;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : PROBE_TIMEOUT_MS;
  const command = configEntry.command || name;
  const checkedAt = new Date().toISOString();
  const pluginVersion = readPluginVersion();

  // Special path: claude-task runtime. If we're inside a Claude Code
  // session, claude is available by definition (the Agent tool, not a
  // subprocess, runs it). Otherwise fall through to the normal probe.
  if (configEntry.runtime_kind === 'claude-task' && isInsideClaudeCodeSession(env)) {
    return {
      name,
      status: 'available',
      version: 'session',
      resolved_path: null,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      runtime_kind: 'claude-task',
    };
  }

  // 1. Resolve binary path. Absolute paths skip `which`.
  let resolvedPath = null;
  if (command.startsWith('/')) {
    resolvedPath = command;
  } else {
    resolvedPath = await resolveCommandPath(command, timeoutMs);
  }

  // 2. If still unresolved, the binary is missing.
  if (!resolvedPath) {
    return {
      name,
      status: 'missing',
      version: null,
      resolved_path: null,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      error: `binary "${command}" not found on PATH`,
    };
  }

  // 3. Spawn `<resolvedPath> --version` and inspect.
  const probe = await runOnce(resolvedPath, ['--version'], { timeoutMs });
  // Timeout path: AbortController firing surfaces as `spawnError` with
  // name "AbortError" / code "ABORT_ERR" OR as `timedOut` directly.
  // Surface either as a timeout in the error string.
  const looksAborted =
    probe.spawnError &&
    (probe.spawnError.name === 'AbortError' || probe.spawnError.code === 'ABORT_ERR');
  if (probe.timedOut || looksAborted) {
    return {
      name,
      status: 'broken',
      version: null,
      resolved_path: resolvedPath,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      error: `"${command} --version" timed out after ${timeoutMs}ms`,
    };
  }
  if (probe.spawnError) {
    const msg = probe.spawnError.code === 'ENOENT'
      ? `binary "${command}" not found (ENOENT) when spawning --version`
      : `failed to spawn "${command} --version": ${probe.spawnError.message}`;
    const status = probe.spawnError.code === 'ENOENT' ? 'missing' : 'broken';
    return {
      name,
      status,
      version: null,
      resolved_path: status === 'missing' ? null : resolvedPath,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      error: msg,
    };
  }
  if (probe.timedOut) {
    return {
      name,
      status: 'broken',
      version: null,
      resolved_path: resolvedPath,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      error: `"${command} --version" timed out after ${timeoutMs}ms`,
    };
  }
  if (probe.code !== 0) {
    const tail = (probe.stderr || probe.stdout || '').split(/\r?\n/).slice(-3).join(' ').trim();
    return {
      name,
      status: 'broken',
      version: null,
      resolved_path: resolvedPath,
      checked_at: checkedAt,
      plugin_version: pluginVersion,
      error: `"${command} --version" exited with code ${probe.code}${tail ? `: ${tail}` : ''}`,
    };
  }

  const version = extractVersion(probe.stdout, probe.stderr);
  return {
    name,
    status: 'available',
    version,
    resolved_path: resolvedPath,
    checked_at: checkedAt,
    plugin_version: pluginVersion,
  };
}

// Exposed for tests so they can detect the session-marker behavior.
export const _CLAUDE_CODE_SESSION_MARKERS = CLAUDE_CODE_SESSION_MARKERS;
export { isInsideClaudeCodeSession as _isInsideClaudeCodeSession };
export { readPluginVersion as _readPluginVersion };
