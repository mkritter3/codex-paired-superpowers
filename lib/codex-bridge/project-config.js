/**
 * project-config.js
 *
 * Loads and validates .codex-paired/project.json for a given repo root.
 * JSON-only for v0.6.0. YAML support deferred (see plan Slice 12 errata note).
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Per-Project Config"
 *
 * Export
 * ──────
 *   loadProjectConfig(repoRoot)
 *     → null                                  — file absent; caller decides halt-vs-continue
 *     → { ok: true, config }                  — parsed + defaults applied
 *     → { ok: false, error: { code, detail }} — validation failure
 *
 * Defect codes
 * ────────────
 *   missing-field:<field>               required top-level or nested field absent
 *   invalid-app-type                    app.type not in allowed set
 *   invalid-takeover-mode               live_verification.takeover.mode not in allowed set
 *   invalid-time-format                 scheduled_window start/end not HH:MM 24-hour
 *   library-must-skip                   app.type=library requires live_verification.default="skip"
 *   library-missing-skip-reason         app.type=library requires non-empty skip_reason
 *   live-verification-config-malformed  JSON parse error OR login_profile password_env absent
 *   invalid-worktree-bootstrap          worktree_bootstrap.symlinks shape/content invalid
 *
 * v0.7.0 schema extension
 * ───────────────────────
 *   `worktree_bootstrap.symlinks` controls which paths are symlinked from the
 *   integration checkout into a slice worktree before subagent dispatch
 *   (spec §8). When absent, defaults to three optional candidates:
 *     [{path:"node_modules",required:false},
 *      {path:".venv",       required:false},
 *      {path:"venv",        required:false}]
 *   When the user supplies a string array, each entry becomes
 *   `{path,<entry>, required:true}` (user-listed entries are required).
 *   `symlinks: []` is a valid opt-out.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Spec § "Per-Project Config" — allowed app types
const VALID_APP_TYPES = ['web', 'desktop', 'mobile', 'cli', 'library'];

// Spec § Safety Gate — allowed takeover modes
const VALID_TAKEOVER_MODES = ['confirm_each_phase_e', 'scheduled_window'];

// HH:MM 24-hour format per plan Slice 1 implementation details
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// Spec §8 — default worktree_bootstrap symlink candidates. Each is
// `required:false` so a missing source is silently skipped.
const DEFAULT_BOOTSTRAP_SYMLINKS = [
  { path: 'node_modules', required: false },
  { path: '.venv',        required: false },
  { path: 'venv',         required: false },
];

/**
 * Build an error result.
 * @param {string} code
 * @param {string} detail
 */
function err(code, detail) {
  return { ok: false, error: { code, detail } };
}

/**
 * Apply documented defaults to the live_verification block in-place.
 * Spec § "Per-Project Config" schema lists the default values.
 *
 * Defaults applied here (spec § Cleanup And Halt Mode):
 *   cleanup.on_success: "kill"
 *   cleanup.on_halt:    "kill"
 *   cleanup.shutdown_command: null
 *
 * Defaults for takeover (spec § Safety Gate):
 *   takeover.mode: "confirm_each_phase_e"
 *   takeover.scheduled_windows: []
 *
 * Defaults for setup:
 *   setup.login_profiles: {}
 *   setup.setup_timeout_ms: 60000
 *   setup.reset_command: null
 *   setup.seed_command: null
 *
 * Defaults for logs:
 *   logs.include_process_output: true
 *   logs.max_bytes_per_source: 262144
 *   logs.max_excerpt_bytes_per_scenario: 32768
 *   logs.error_patterns: ["ERROR","Unhandled","TypeError","500"]
 *
 * @param {object} lv  live_verification object (mutated)
 */
function applyDefaults(lv) {
  // takeover
  if (!lv.takeover) lv.takeover = {};
  if (lv.takeover.mode === undefined) lv.takeover.mode = 'confirm_each_phase_e';
  if (!Array.isArray(lv.takeover.scheduled_windows)) lv.takeover.scheduled_windows = [];

  // cleanup
  if (!lv.cleanup) lv.cleanup = {};
  if (lv.cleanup.on_success === undefined) lv.cleanup.on_success = 'kill';
  if (lv.cleanup.on_halt === undefined) lv.cleanup.on_halt = 'kill';
  if (lv.cleanup.shutdown_command === undefined) lv.cleanup.shutdown_command = null;

  // setup
  if (!lv.setup) lv.setup = {};
  if (lv.setup.reset_command === undefined) lv.setup.reset_command = null;
  if (lv.setup.seed_command === undefined) lv.setup.seed_command = null;
  if (!lv.setup.login_profiles) lv.setup.login_profiles = {};
  if (lv.setup.setup_timeout_ms === undefined) lv.setup.setup_timeout_ms = 60000;

  // logs
  if (!lv.logs) lv.logs = {};
  if (lv.logs.include_process_output === undefined) lv.logs.include_process_output = true;
  if (lv.logs.max_bytes_per_source === undefined) lv.logs.max_bytes_per_source = 262144;
  if (lv.logs.max_excerpt_bytes_per_scenario === undefined) lv.logs.max_excerpt_bytes_per_scenario = 32768;
  if (!Array.isArray(lv.logs.error_patterns)) lv.logs.error_patterns = ['ERROR', 'Unhandled', 'TypeError', '500'];
  if (!Array.isArray(lv.logs.paths)) lv.logs.paths = [];
}

/**
 * Validate the optional `worktree_bootstrap` block (spec §8).
 *
 * Accepted shapes:
 *   - block absent                 → defaults applied later
 *   - { symlinks: undefined }      → defaults applied later
 *   - { symlinks: [] }             → empty (user opt-out)
 *   - { symlinks: ["a","b/c"] }    → string array; each entry → {path,required:true}
 *
 * Rejected:
 *   - block is non-object
 *   - symlinks is non-array
 *   - element is non-string / empty
 *   - element is absolute path (starts with "/")
 *   - element contains a `..` traversal segment
 *
 * @param {object} cfg  parsed JSON object
 * @returns {null | { ok: false, error: { code, detail } }}
 */
function validateWorktreeBootstrap(cfg) {
  const wb = cfg.worktree_bootstrap;
  if (wb === undefined || wb === null) return null;

  if (typeof wb !== 'object' || Array.isArray(wb)) {
    return err(
      'invalid-worktree-bootstrap',
      'worktree_bootstrap must be an object'
    );
  }

  const sl = wb.symlinks;
  if (sl === undefined) return null;

  if (!Array.isArray(sl)) {
    return err(
      'invalid-worktree-bootstrap',
      'worktree_bootstrap.symlinks must be an array of strings'
    );
  }

  for (const entry of sl) {
    if (typeof entry !== 'string') {
      return err(
        'invalid-worktree-bootstrap',
        `worktree_bootstrap.symlinks element must be a string (got ${typeof entry})`
      );
    }
    if (entry.length === 0) {
      return err(
        'invalid-worktree-bootstrap',
        'worktree_bootstrap.symlinks element must be a non-empty string'
      );
    }
    if (entry.startsWith('/')) {
      return err(
        'invalid-worktree-bootstrap',
        `worktree_bootstrap.symlinks "${entry}" must not be an absolute path`
      );
    }
    // Reject any `..` segment — covers leading "../foo" and embedded "a/../b".
    const segments = entry.split('/');
    if (segments.includes('..')) {
      return err(
        'invalid-worktree-bootstrap',
        `worktree_bootstrap.symlinks "${entry}" must not contain traversal (..) segments`
      );
    }
  }

  return null;
}

/**
 * Apply v0.7.0 worktree_bootstrap defaults in-place.
 *
 * Rules (spec §8):
 *   - block absent or symlinks absent → install DEFAULT_BOOTSTRAP_SYMLINKS
 *     (each entry `required:false`).
 *   - symlinks is a string array → each entry becomes `{path,required:true}`.
 *   - symlinks is `[]` → preserved (user opt-out).
 *
 * Mutates `cfg`.
 *
 * @param {object} cfg  parsed JSON object (post-validation)
 */
function applyWorktreeBootstrapDefaults(cfg) {
  if (!cfg.worktree_bootstrap || typeof cfg.worktree_bootstrap !== 'object') {
    cfg.worktree_bootstrap = {};
  }
  const wb = cfg.worktree_bootstrap;
  if (wb.symlinks === undefined) {
    // Clone so callers cannot mutate the shared default.
    wb.symlinks = DEFAULT_BOOTSTRAP_SYMLINKS.map((e) => ({ ...e }));
    return;
  }
  // string[] → [{path, required:true}]
  wb.symlinks = wb.symlinks.map((path) => ({ path, required: true }));
}

/**
 * Validate the parsed config object.
 * Returns null on success, or an error result on failure.
 *
 * @param {object} cfg  parsed JSON object
 * @returns {null | { ok: false, error: { code, detail } }}
 */
function validate(cfg) {
  // ── Required top-level fields ───────────────────────────────────────────────

  if (cfg.version === undefined || cfg.version === null) {
    return err('missing-field:version', 'Config must include "version" (expected: 1)');
  }

  if (!cfg.app || typeof cfg.app !== 'object') {
    return err('missing-field:app', 'Config must include "app" object');
  }

  if (!cfg.live_verification || typeof cfg.live_verification !== 'object') {
    return err('missing-field:live_verification', 'Config must include "live_verification" object');
  }

  // ── app.type ────────────────────────────────────────────────────────────────

  if (!VALID_APP_TYPES.includes(cfg.app.type)) {
    return err(
      'invalid-app-type',
      `app.type "${cfg.app.type}" is not valid. Must be one of: ${VALID_APP_TYPES.join(', ')}`
    );
  }

  const lv = cfg.live_verification;

  // ── takeover.mode ───────────────────────────────────────────────────────────

  if (lv.takeover && lv.takeover.mode !== undefined) {
    if (!VALID_TAKEOVER_MODES.includes(lv.takeover.mode)) {
      return err(
        'invalid-takeover-mode',
        `live_verification.takeover.mode "${lv.takeover.mode}" is not valid. Must be one of: ${VALID_TAKEOVER_MODES.join(', ')}`
      );
    }
  }

  // ── scheduled_window time formats ───────────────────────────────────────────

  if (lv.takeover && Array.isArray(lv.takeover.scheduled_windows)) {
    for (const win of lv.takeover.scheduled_windows) {
      if (win.start !== undefined && !TIME_RE.test(win.start)) {
        return err(
          'invalid-time-format',
          `scheduled_window.start "${win.start}" is not a valid HH:MM 24-hour time`
        );
      }
      if (win.end !== undefined && !TIME_RE.test(win.end)) {
        return err(
          'invalid-time-format',
          `scheduled_window.end "${win.end}" is not a valid HH:MM 24-hour time`
        );
      }
    }
  }

  // ── library rules (spec § "Per-Project Config" Rules) ──────────────────────

  if (cfg.app.type === 'library') {
    if (lv.default !== 'skip') {
      return err(
        'library-must-skip',
        'app.type "library" requires live_verification.default to be "skip"'
      );
    }
    const reason = typeof lv.skip_reason === 'string' ? lv.skip_reason.trim() : '';
    if (!reason) {
      return err(
        'library-missing-skip-reason',
        'app.type "library" requires a non-empty live_verification.skip_reason'
      );
    }
  }

  // ── login_profile env-var presence (config-load-time validation) ───────────
  // Spec § Precondition Enforcement + plan Slice 1 ownership clarification:
  // If password_env references an env var that is absent/empty, fail at load time.
  // Slice 4 handles runtime setup failures (e.g., login command exits nonzero).

  const loginProfiles = lv.setup && lv.setup.login_profiles;
  if (loginProfiles && typeof loginProfiles === 'object') {
    for (const [profileName, profile] of Object.entries(loginProfiles)) {
      if (profile && profile.password_env) {
        const envValue = process.env[profile.password_env];
        if (!envValue) {
          return err(
            'live-verification-config-malformed',
            `login_profiles.${profileName}.password_env refers to "${profile.password_env}" which is not set in process.env`
          );
        }
      }
    }
  }

  // ── worktree_bootstrap (v0.7.0) ─────────────────────────────────────────────
  const wbErr = validateWorktreeBootstrap(cfg);
  if (wbErr) return wbErr;

  // ── codex_dispatch (v0.7.2) ─────────────────────────────────────────────────
  const cdErr = validateCodexDispatch(cfg);
  if (cdErr) return cdErr;

  return null;
}

// v0.7.2 codex_dispatch defaults — exported for tests + SKILL.md reference.
export const CODEX_DISPATCH_DEFAULTS = Object.freeze({
  max_runtime_ms: 7200000,    // 2 hours
  log_max_bytes: 1048576,     // 1 MB
});

function validateCodexDispatch(cfg) {
  // codex_dispatch is optional. If absent, defaults are applied at load time.
  // Validation only fires when the user has explicitly set the block.
  if (!('codex_dispatch' in cfg) || cfg.codex_dispatch === null || cfg.codex_dispatch === undefined) {
    return null;
  }
  const cd = cfg.codex_dispatch;
  if (typeof cd !== 'object' || Array.isArray(cd)) {
    return err('live-verification-config-malformed', 'codex_dispatch must be an object');
  }
  // max_runtime_ms: positive integer if present
  if ('max_runtime_ms' in cd) {
    const v = cd.max_runtime_ms;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
      return err(
        'live-verification-config-malformed',
        `codex_dispatch.max_runtime_ms must be a positive integer (ms); got ${JSON.stringify(v)}`
      );
    }
  }
  // log_max_bytes: positive integer if present
  if ('log_max_bytes' in cd) {
    const v = cd.log_max_bytes;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
      return err(
        'live-verification-config-malformed',
        `codex_dispatch.log_max_bytes must be a positive integer (bytes); got ${JSON.stringify(v)}`
      );
    }
  }
  // No unknown keys (forward-compat caution)
  for (const k of Object.keys(cd)) {
    if (k !== 'max_runtime_ms' && k !== 'log_max_bytes') {
      return err(
        'live-verification-config-malformed',
        `codex_dispatch contains unknown key: ${k}`
      );
    }
  }
  return null;
}

/**
 * Apply codex_dispatch defaults. Pass-through for the provided block; missing
 * keys filled from CODEX_DISPATCH_DEFAULTS. Caller may rely on the returned
 * object having both keys defined.
 */
export function applyCodexDispatchDefaults(cfg) {
  const explicit = (cfg && cfg.codex_dispatch) || {};
  return {
    max_runtime_ms: 'max_runtime_ms' in explicit ? explicit.max_runtime_ms : CODEX_DISPATCH_DEFAULTS.max_runtime_ms,
    log_max_bytes: 'log_max_bytes' in explicit ? explicit.log_max_bytes : CODEX_DISPATCH_DEFAULTS.log_max_bytes,
  };
}

/**
 * Load and validate <repoRoot>/.codex-paired/project.json.
 *
 * @param {string} repoRoot  absolute path to the repository root
 * @returns {null | { ok: true, config: object } | { ok: false, error: { code: string, detail: string } }}
 */
export function loadProjectConfig(repoRoot) {
  const configPath = join(repoRoot, '.codex-paired', 'project.json');

  // Missing file → null (caller decides halt-vs-continue per spec)
  if (!existsSync(configPath)) {
    return null;
  }

  // Parse JSON — catch SyntaxError and return malformed error
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    return err('live-verification-config-malformed', `File read error: ${e.message}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return err('live-verification-config-malformed', `JSON parse error: ${e.message}`);
  }

  // Validate before applying defaults so errors reference the raw input
  const validationErr = validate(cfg);
  if (validationErr) return validationErr;

  // Apply defaults to the live_verification block
  applyDefaults(cfg.live_verification);

  // Apply v0.7.0 worktree_bootstrap defaults / normalization
  applyWorktreeBootstrapDefaults(cfg);

  return { ok: true, config: cfg };
}
