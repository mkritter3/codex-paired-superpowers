/**
 * precondition-enforcer.js
 *
 * Runtime precondition enforcement for Phase E live verification.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Precondition Enforcement"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 4
 *
 * This module handles RUNTIME failures only (login command exits nonzero,
 * navigate to login route times out, etc.). Config-load-time env-var presence
 * is slice 1's responsibility (project-config.js).
 *
 * Export
 * ──────
 *   createPreconditionEnforcer({ adapter, spawn, now })
 *     → { enforce(preconditions, projectConfig) → Promise<result> }
 *
 * result shape:
 *   { status: 'ok', setup_logs, scenario_logs: [] }
 *   { status: 'blocked-precondition', reason, setup_logs, scenario_logs: [] }
 *
 * Enforcement types (spec § "Precondition Enforcement"):
 *   navigate       — adapter.openRoute(start_url + route)
 *   reset_command  — run project reset command (ONCE before preconditions)
 *   seed_command   — run project seed command (in setup phase)
 *   login_profile  — openRoute(login_route) + executeStep per profile step
 *   setup_steps    — executeStep per step
 *   manual_blocked — immediately return blocked-precondition
 *
 * Blocked reasons (exact strings per spec):
 *   reset-command-failed
 *   seed-command-failed
 *   login-step-failed
 *   setup-step-failed
 *   manual-blocked
 *   precondition-timeout
 *
 * Injection points (for test isolation):
 *   adapter  — { openRoute(url), executeStep(step) }
 *   spawn    — (cmd, args, opts) → ChildProcess  (default: node:child_process.spawn)
 *   now      — () => Date  (default: () => new Date())
 */

import { spawn as nodeSpawn } from 'node:child_process';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Run a shell command string, capturing stdout + stderr.
 * Returns Promise<{ exitCode, stdout, stderr }>.
 *
 * @param {string}   commandStr  full shell command (passed to sh -c)
 * @param {Function} spawnFn     injectable spawn
 * @param {number}   timeoutMs   abort + reject with 'precondition-timeout' after this many ms
 */
function runCommand(commandStr, spawnFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn('sh', ['-c', commandStr], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      reject(Object.assign(new Error('precondition-timeout'), { code: 'precondition-timeout' }));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Build a blocked-precondition result.
 */
function blocked(reason, setupLogs, extra = {}) {
  return {
    status: 'blocked-precondition',
    reason,
    setup_logs: setupLogs,
    scenario_logs: [],
    ...extra,
  };
}

/**
 * Build an ok result.
 */
function ok(setupLogs) {
  return {
    status: 'ok',
    setup_logs: setupLogs,
    scenario_logs: [],
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a precondition enforcer.
 *
 * @param {object}   deps
 * @param {object}   deps.adapter    { openRoute(url), executeStep(step) }
 * @param {Function} [deps.spawn]    spawn replacement for testing
 * @param {Function} [deps.now]      () => Date, for future use
 */
export function createPreconditionEnforcer({ adapter, spawn: spawnFn = nodeSpawn, now = () => new Date() } = {}) {
  if (!adapter) throw new Error('createPreconditionEnforcer: adapter is required');

  return {
    /**
     * Enforce all preconditions for a scenario attempt.
     *
     * Execution order (spec § "Precondition Enforcement" runner behavior):
     * 1. Execute project reset_command if configured.
     * 2. Execute project seed_command if configured.
     * 3. Apply scenario preconditions in listed order.
     * 4. Capture setup logs separately from scenario logs.
     *
     * @param {Array}  preconditions  array of precondition objects from scenario JSON
     * @param {object} projectConfig  loaded project config (live_verification block)
     * @returns {Promise<result>}
     */
    async enforce(preconditions, projectConfig) {
      const lv = projectConfig.live_verification || {};
      const setup = lv.setup || {};
      const computerUse = lv.computer_use || {};
      const startUrl = computerUse.start_url || '';
      const setupTimeoutMs = setup.setup_timeout_ms ?? 60000;
      const setupLogs = [];

      // ── Phase: project reset command ──────────────────────────────────────

      if (setup.reset_command) {
        let cmdResult;
        try {
          cmdResult = await runCommand(setup.reset_command, spawnFn, setupTimeoutMs);
        } catch (err) {
          if (err.code === 'precondition-timeout') {
            setupLogs.push({ phase: 'reset_command', event: 'timeout', command: setup.reset_command });
            return blocked('precondition-timeout', setupLogs);
          }
          throw err;
        }

        setupLogs.push({
          phase: 'reset_command',
          command: setup.reset_command,
          exitCode: cmdResult.exitCode,
          stdout: cmdResult.stdout,
          stderr: cmdResult.stderr,
        });

        if (cmdResult.exitCode !== 0) {
          return blocked('reset-command-failed', setupLogs, {
            logs: { stdout: cmdResult.stdout, stderr: cmdResult.stderr },
          });
        }
      }

      // ── Phase: project seed command ───────────────────────────────────────

      if (setup.seed_command) {
        let cmdResult;
        try {
          cmdResult = await runCommand(setup.seed_command, spawnFn, setupTimeoutMs);
        } catch (err) {
          if (err.code === 'precondition-timeout') {
            setupLogs.push({ phase: 'seed_command', event: 'timeout', command: setup.seed_command });
            return blocked('precondition-timeout', setupLogs);
          }
          throw err;
        }

        setupLogs.push({
          phase: 'seed_command',
          command: setup.seed_command,
          exitCode: cmdResult.exitCode,
          stdout: cmdResult.stdout,
          stderr: cmdResult.stderr,
        });

        if (cmdResult.exitCode !== 0) {
          return blocked('seed-command-failed', setupLogs, {
            logs: { stdout: cmdResult.stdout, stderr: cmdResult.stderr },
          });
        }
      }

      // ── Phase: scenario preconditions in listed order ─────────────────────

      for (const precondition of preconditions) {
        const enforcement = precondition.enforcement;

        // ── manual_blocked: short-circuit immediately ──────────────────────
        if (enforcement === 'manual_blocked') {
          setupLogs.push({
            phase: 'precondition',
            enforcement: 'manual_blocked',
            reason: precondition.reason || 'not specified',
          });
          return blocked('manual-blocked', setupLogs, {
            detail: precondition.reason,
          });
        }

        // ── navigate: open start_url + route value ─────────────────────────
        if (enforcement === 'navigate') {
          const route = precondition.value || '';
          const url = startUrl + route;
          try {
            await adapter.openRoute(url);
            setupLogs.push({ phase: 'precondition', enforcement: 'navigate', url });
          } catch (err) {
            setupLogs.push({ phase: 'precondition', enforcement: 'navigate', url, error: err.message });
            return blocked('navigate-failed', setupLogs);
          }
          continue;
        }

        // ── login_profile: navigate to login_route + run profile steps ──────
        if (enforcement === 'login_profile') {
          const profileName = precondition.value;
          const loginProfiles = setup.login_profiles || {};
          const profile = loginProfiles[profileName];

          if (!profile) {
            setupLogs.push({
              phase: 'precondition',
              enforcement: 'login_profile',
              profile: profileName,
              error: `login_profile '${profileName}' not found in config`,
            });
            return blocked('login-step-failed', setupLogs);
          }

          // Navigate to login route
          if (profile.login_route) {
            const loginUrl = startUrl + profile.login_route;
            try {
              await adapter.openRoute(loginUrl);
              setupLogs.push({ phase: 'precondition', enforcement: 'login_profile', event: 'navigate', url: loginUrl });
            } catch (err) {
              setupLogs.push({ phase: 'precondition', enforcement: 'login_profile', event: 'navigate', error: err.message });
              return blocked('login-step-failed', setupLogs);
            }
          }

          // Execute login profile setup_steps
          const profileSteps = profile.setup_steps || [];
          for (const step of profileSteps) {
            let stepResult;
            try {
              stepResult = await adapter.executeStep(step);
            } catch (err) {
              setupLogs.push({ phase: 'precondition', enforcement: 'login_profile', step, error: err.message });
              return blocked('login-step-failed', setupLogs);
            }

            setupLogs.push({ phase: 'precondition', enforcement: 'login_profile', step, ok: stepResult.ok });

            if (!stepResult.ok) {
              return blocked('login-step-failed', setupLogs, {
                detail: stepResult.error,
              });
            }
          }

          continue;
        }

        // ── setup_steps: run each UI step via adapter.executeStep ──────────
        if (enforcement === 'setup_steps') {
          const steps = precondition.steps || [];
          let failedStep = null;

          for (const step of steps) {
            let stepResult;
            try {
              stepResult = await adapter.executeStep(step);
            } catch (err) {
              setupLogs.push({ phase: 'precondition', enforcement: 'setup_steps', step, error: err.message });
              failedStep = step;
              break;
            }

            setupLogs.push({ phase: 'precondition', enforcement: 'setup_steps', step, ok: stepResult.ok });

            if (!stepResult.ok) {
              failedStep = step;
              // Continue executing remaining steps to capture all failures,
              // then return blocked after the loop
            }
          }

          if (failedStep !== null) {
            return blocked('setup-step-failed', setupLogs, {
              detail: `step failed: ${JSON.stringify(failedStep)}`,
            });
          }

          continue;
        }

        // ── Unknown enforcement type: log and skip (permissive for forward compat)
        setupLogs.push({
          phase: 'precondition',
          enforcement,
          event: 'unknown-enforcement-type-skipped',
        });
      }

      // All preconditions passed
      return ok(setupLogs);
    },
  };
}
