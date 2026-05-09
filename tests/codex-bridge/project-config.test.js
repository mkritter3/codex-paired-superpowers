import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from '../../lib/codex-bridge/project-config.js';

// Helper: create a temp repo root with .codex-paired/project.json
function makeRepo(content) {
  const base = mkdtempSync(join(tmpdir(), 'cps-pc-'));
  const root = realpathSync(base);
  mkdirSync(join(root, '.codex-paired'));
  if (content !== undefined) {
    writeFileSync(join(root, '.codex-paired', 'project.json'), content);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ── Test 1: Valid full config parses ─────────────────────────────────────────

test('valid full config parses to ok:true with config', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: {
      name: 'Example Web',
      description: 'User-facing web app',
      type: 'web',
    },
    live_verification: {
      default: 'run',
      skip_reason: null,
      takeover: {
        mode: 'scheduled_window',
        scheduled_windows: [
          { days: ['mon', 'tue'], start: '02:00', end: '06:00', timezone: 'America/Los_Angeles' },
        ],
      },
      launch: {
        command: 'npm run dev',
        cwd: '.',
        env: {},
        timeout_ms: 120000,
        shutdown: { signal: 'SIGTERM', grace_ms: 5000 },
      },
      ready: {
        strategy: 'http',
        url: 'http://127.0.0.1:3000',
        expected_status: 200,
        timeout_ms: 120000,
        poll_interval_ms: 1000,
      },
      setup: {
        reset_command: 'npm run test:reset-db',
        seed_command: 'npm run test:seed',
        login_profiles: {},
        setup_timeout_ms: 60000,
      },
      logs: {
        paths: ['logs/dev.log'],
        include_process_output: true,
        max_bytes_per_source: 262144,
        max_excerpt_bytes_per_scenario: 32768,
        error_patterns: ['ERROR', 'Unhandled'],
      },
      computer_use: {
        required: true,
        start_url: 'http://127.0.0.1:3000',
        viewport: { width: 1440, height: 900 },
        scenario_timeout_ms: 60000,
        max_action_retries: 2,
      },
      cleanup: {
        on_success: 'kill',
        on_halt: 'kill',
        shutdown_command: null,
      },
      evidence: {
        ui_globs: ['app/**/*.{tsx,jsx,css}'],
        screenshot_format: 'png',
        preserve_failure_evidence: true,
        prune_pass_evidence_on_ship: true,
      },
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, true);
  assert.equal(result.config.version, 1);
  assert.equal(result.config.app.type, 'web');
  assert.equal(result.config.live_verification.default, 'run');
  cleanup(root);
});

// ── Test 2: Valid minimal config parses with defaults ─────────────────────────

test('valid minimal config parses with documented defaults', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'My App', type: 'web' },
    live_verification: { default: 'run' },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, true);
  // cleanup defaults
  assert.equal(result.config.live_verification.cleanup.on_success, 'kill');
  assert.equal(result.config.live_verification.cleanup.on_halt, 'kill');
  // takeover default
  assert.equal(result.config.live_verification.takeover.mode, 'confirm_each_phase_e');
  cleanup(root);
});

// ── Test 3: Missing required fields → typed error ─────────────────────────────

test('missing version field → missing-field:version error', () => {
  const root = makeRepo(JSON.stringify({
    app: { name: 'X', type: 'web' },
    live_verification: { default: 'run' },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing-field:version');
  cleanup(root);
});

test('missing app field → missing-field:app error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    live_verification: { default: 'run' },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing-field:app');
  cleanup(root);
});

test('missing live_verification field → missing-field:live_verification error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'web' },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'missing-field:live_verification');
  cleanup(root);
});

// ── Test 4: Invalid app.type value → error ────────────────────────────────────

test('invalid app.type value → invalid-app-type error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'invalid' },
    live_verification: { default: 'run' },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-app-type');
  assert.ok(result.error.detail.includes('invalid'), `detail should mention the bad value, got: ${result.error.detail}`);
  cleanup(root);
});

// ── Test 5: Invalid takeover mode → error ─────────────────────────────────────

test('invalid takeover mode → invalid-takeover-mode error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'web' },
    live_verification: {
      default: 'run',
      takeover: { mode: 'weird' },
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-takeover-mode');
  cleanup(root);
});

// ── Test 6: Invalid scheduled_window time format → error ──────────────────────

test('invalid scheduled_window start time "25:00" → invalid-time-format error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'web' },
    live_verification: {
      default: 'run',
      takeover: {
        mode: 'scheduled_window',
        scheduled_windows: [
          { days: ['mon'], start: '25:00', end: '06:00', timezone: 'UTC' },
        ],
      },
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-time-format');
  cleanup(root);
});

test('invalid scheduled_window start time "not-a-time" → invalid-time-format error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'web' },
    live_verification: {
      default: 'run',
      takeover: {
        mode: 'scheduled_window',
        scheduled_windows: [
          { days: ['mon'], start: 'not-a-time', end: '06:00', timezone: 'UTC' },
        ],
      },
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid-time-format');
  cleanup(root);
});

// ── Test 7: app.type library without live_verification.default: skip → error ──

test('app.type library without live_verification.default:skip → library-must-skip error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'MyLib', type: 'library' },
    live_verification: {
      default: 'run',
      skip_reason: 'Pure library with no UI',
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'library-must-skip');
  cleanup(root);
});

// ── Test 8: app.type library without skip_reason → error ─────────────────────

test('app.type library without skip_reason → library-missing-skip-reason error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'MyLib', type: 'library' },
    live_verification: {
      default: 'skip',
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'library-missing-skip-reason');
  cleanup(root);
});

test('app.type library with empty skip_reason string → library-missing-skip-reason error', () => {
  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'MyLib', type: 'library' },
    live_verification: {
      default: 'skip',
      skip_reason: '   ',
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'library-missing-skip-reason');
  cleanup(root);
});

// ── Test 9: Missing config file returns null ──────────────────────────────────

test('missing project.json returns null', () => {
  const base = mkdtempSync(join(tmpdir(), 'cps-pc-absent-'));
  const root = realpathSync(base);
  // No .codex-paired directory, no file
  const result = loadProjectConfig(root);
  assert.equal(result, null);
  cleanup(root);
});

// ── Test 10: login_profile references unset env var → error ──────────────────

test('login_profile with unset password_env → live-verification-config-malformed error', () => {
  const envVar = 'CPS_TEST_UNSET_VAR_XYZ_' + Date.now();
  // Ensure it's definitely not set
  delete process.env[envVar];

  const root = makeRepo(JSON.stringify({
    version: 1,
    app: { name: 'X', type: 'web' },
    live_verification: {
      default: 'run',
      setup: {
        login_profiles: {
          test_user: {
            username: 'test@example.com',
            password_env: envVar,
            login_route: '/login',
          },
        },
      },
    },
  }));

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'live-verification-config-malformed');
  assert.ok(result.error.detail.includes(envVar), `detail should name the missing env var, got: ${result.error.detail}`);
  cleanup(root);
});

// ── Test 11: Malformed JSON → live-verification-config-malformed error ────────

test('malformed JSON (truncated) → live-verification-config-malformed error', () => {
  const root = makeRepo('{not json');

  const result = loadProjectConfig(root);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'live-verification-config-malformed');
  assert.ok(result.error.detail.startsWith('JSON parse error:'), `detail should start with "JSON parse error:", got: ${result.error.detail}`);
  cleanup(root);
});
