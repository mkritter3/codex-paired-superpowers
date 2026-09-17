/**
 * Model-role configuration and transport adapters.
 *
 * Spec: docs/specs/2026-09-17-v0.16.0-model-roles-design.md §1
 */

import { loadProjectConfig } from './project-config.js';

export const MODEL_ROLES = ['planning', 'review', 'implement', 'implement_fallback'];

export const VALID_CLIS = ['codex', 'agy'];
export const AGY_EFFORT_SUFFIX_RE = /-(low|medium|high)$/;

export const MODEL_ROLE_DEFAULTS = Object.freeze({
  planning: Object.freeze({ cli: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }),
  review: Object.freeze({ cli: 'codex', model: 'gpt-6-astra', effort: 'high' }),
  implement: Object.freeze({ cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' }),
  implement_fallback: Object.freeze({ cli: 'codex', model: 'gpt-6-astra', effort: 'medium' }),
});

export const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
export const CODEX_CLI_VALIDATED_VERSION = '0.153.4';

/** Spec §1 — a complete model-role configuration failure. */
export class ModelsConfigError extends Error {
  /**
   * `code` is ALWAYS 'models-config-malformed' (frozen contract). Upstream causes (e.g. a
   * project-config loader failure) are preserved in `detail` and `cause`, never in `code`.
   */
  constructor(detail, options = {}) {
    super(detail, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ModelsConfigError';
    this.code = 'models-config-malformed';
    this.detail = detail;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function malformed(detail) {
  return { code: 'models-config-malformed', detail };
}

function validateCliValue(value, path) {
  if (typeof value !== 'string' || !VALID_CLIS.includes(value)) {
    return malformed(`${path} must be one of: ${VALID_CLIS.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return null;
}

function validateModelValue(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    return malformed(`${path} must be a non-empty string`);
  }
  if (!SAFE_TOKEN.test(value)) {
    return malformed(`${path} must contain only letters, digits, dot, underscore, or hyphen; got ${JSON.stringify(value)}`);
  }
  return null;
}

function validateEffortValue(value, path) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value) || !VALID_EFFORTS.includes(value)) {
    return malformed(`${path} must be one of: ${VALID_EFFORTS.join(', ')}; got ${JSON.stringify(value)}`);
  }
  return null;
}

/**
 * Validate a project `models` block without applying defaults.
 * Implements spec §1 “One source of truth”.
 */
export function validateModelsBlock(block) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return malformed('models must be an object');
  }

  for (const [role, config] of Object.entries(block)) {
    if (!MODEL_ROLES.includes(role)) {
      return malformed(`models contains unknown role ${JSON.stringify(role)}; expected one of: ${MODEL_ROLES.join(', ')}`);
    }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      return malformed(`models.${role} must be an object`);
    }
    for (const key of Object.keys(config)) {
      if (key !== 'cli' && key !== 'model' && key !== 'effort') {
        return malformed(`models.${role} contains unknown key ${JSON.stringify(key)}; expected cli, model, or effort`);
      }
    }
    if ('cli' in config) {
      const error = validateCliValue(config.cli, `models.${role}.cli`);
      if (error) return error;
    }
    if ('model' in config) {
      const error = validateModelValue(config.model, `models.${role}.model`);
      if (error) return error;
    }
    if ('effort' in config) {
      const error = validateEffortValue(config.effort, `models.${role}.effort`);
      if (error) return error;
    }
    if (config.cli === 'agy') {
      if ('model' in config) {
        if (!AGY_EFFORT_SUFFIX_RE.test(config.model)) {
          return malformed(`models.${role}.model must end with -low, -medium, or -high when cli is agy; got ${JSON.stringify(config.model)}`);
        }
        if ('effort' in config) {
          const derivedEffort = config.model.match(AGY_EFFORT_SUFFIX_RE)[1];
          if (config.effort !== derivedEffort) {
            return malformed(`same-layer mismatch in models.${role}: model ${JSON.stringify(config.model)} has effort ${derivedEffort} but explicit effort is ${JSON.stringify(config.effort)}`);
          }
        }
      }
    }
  }
  return null;
}

function applyValue(roles, sources, role, field, value, source) {
  roles[role][field] = value;
  sources[role][field] = source;
}

function validateEnvValue(env, key, field) {
  const value = env[key];
  if (value === undefined) return null;
  const error = field === 'cli'
    ? validateCliValue(value, key)
    : field === 'model'
      ? validateModelValue(value, key)
      : validateEffortValue(value, key);
  if (error) throw new ModelsConfigError(error.detail);
  return value;
}

/**
 * Resolve defaults, project overrides, and environment overrides atomically.
 * Implements spec §1 “One source of truth”.
 */
export function resolveModelRoles({ repoRoot = process.cwd(), env = process.env } = {}) {
  const roles = {};
  const sources = {};
  for (const role of MODEL_ROLES) {
    roles[role] = { ...MODEL_ROLE_DEFAULTS[role] };
    sources[role] = { cli: 'default', model: 'default', effort: 'default' };
  }

  const loaded = loadProjectConfig(repoRoot);
  if (loaded && !loaded.ok) {
    throw new ModelsConfigError(
      `project config invalid (${loaded.error.code}): ${loaded.error.detail}`,
      { cause: loaded.error },
    );
  }
  const projectModels = loaded?.config?.models;
  if (projectModels !== null && projectModels !== undefined) {
    const error = validateModelsBlock(projectModels);
    if (error) throw new ModelsConfigError(error.detail);
    for (const [role, config] of Object.entries(projectModels)) {
      if ('cli' in config) applyValue(roles, sources, role, 'cli', config.cli, 'project');
      if ('model' in config) applyValue(roles, sources, role, 'model', config.model, 'project');
      if ('effort' in config) applyValue(roles, sources, role, 'effort', config.effort, 'project');
    }
  }

  // Apply agy effort rule for project layer
  for (const role of MODEL_ROLES) {
    if (roles[role].cli === 'agy') {
      const match = roles[role].model.match(AGY_EFFORT_SUFFIX_RE);
      if (!match) {
        throw new ModelsConfigError(`role ${role} uses agy but model ${JSON.stringify(roles[role].model)} has no recognized effort suffix (-low, -medium, -high)`);
      }
      const derived = match[1];
      const projectConfig = projectModels?.[role];
      if (projectConfig && 'effort' in projectConfig && projectConfig.effort !== derived) {
        throw new ModelsConfigError(`same-layer mismatch in project config for role ${role}: model ${JSON.stringify(projectConfig.model)} has effort ${derived} but explicit effort is ${JSON.stringify(projectConfig.effort)}`);
      }
      roles[role].effort = derived;
      sources[role].effort = 'derived';
    }
  }

  const globalCli = validateEnvValue(env, 'CODEX_PAIRED_CLI', 'cli');
  const globalModel = validateEnvValue(env, 'CODEX_PAIRED_MODEL', 'model');
  const globalEffort = validateEnvValue(env, 'CODEX_PAIRED_REASONING', 'effort');
  for (const role of MODEL_ROLES) {
    if (globalCli !== null) applyValue(roles, sources, role, 'cli', globalCli, 'env');
    if (globalModel !== null) applyValue(roles, sources, role, 'model', globalModel, 'env');
    if (globalEffort !== null) applyValue(roles, sources, role, 'effort', globalEffort, 'env');

    const suffix = role.toUpperCase();
    const roleCli = validateEnvValue(env, `CODEX_PAIRED_CLI_${suffix}`, 'cli');
    const roleModel = validateEnvValue(env, `CODEX_PAIRED_MODEL_${suffix}`, 'model');
    const roleEffort = validateEnvValue(env, `CODEX_PAIRED_REASONING_${suffix}`, 'effort');
    if (roleCli !== null) applyValue(roles, sources, role, 'cli', roleCli, 'env');
    if (roleModel !== null) applyValue(roles, sources, role, 'model', roleModel, 'env');
    if (roleEffort !== null) applyValue(roles, sources, role, 'effort', roleEffort, 'env');

    // Apply agy effort rule for env layer
    if (roles[role].cli === 'agy') {
      const match = roles[role].model.match(AGY_EFFORT_SUFFIX_RE);
      if (!match) {
        throw new ModelsConfigError(`role ${role} uses agy but model ${JSON.stringify(roles[role].model)} has no recognized effort suffix (-low, -medium, -high)`);
      }
      const derived = match[1];
      // Same-layer rule (spec §1): only an effort set at the SAME env level as the agy model
      // must match the suffix. A per-role model pairs with the per-role effort; a global model
      // pairs with the global effort. An effort from a different layer (e.g. a global
      // CODEX_PAIRED_REASONING meant for Codex roles, or an inherited project/default effort)
      // is simply overridden by the derived value.
      const modelFromRoleEnv = roleModel !== null;
      const modelFromGlobalEnv = roleModel === null && globalModel !== null;
      const explicitEnvEffort = modelFromRoleEnv ? roleEffort : (modelFromGlobalEnv ? globalEffort : null);
      if (explicitEnvEffort !== null && explicitEnvEffort !== derived) {
        throw new ModelsConfigError(`same-layer mismatch in environment for role ${role}: model ${JSON.stringify(roles[role].model)} has effort ${derived} but explicit effort is ${JSON.stringify(explicitEnvEffort)}`);
      }
      roles[role].effort = derived;
      sources[role].effort = 'derived';
    } else if (sources[role].effort === 'derived') {
      sources[role].effort = 'default';
    }
  }

  return { roles, sources };
}

function roleSnapshot(role, roles) {
  if (!MODEL_ROLES.includes(role)) {
    throw new ModelsConfigError(`unknown model role ${JSON.stringify(role)}; expected one of: ${MODEL_ROLES.join(', ')}`);
  }
  const snapshot = roles?.[role];
  if (!snapshot) {
    throw new ModelsConfigError(`model role ${JSON.stringify(role)} is missing from the resolved roles`);
  }
  const cli = snapshot.cli ?? 'codex';
  const cliError = validateCliValue(cli, `${role}.cli`);
  if (cliError) throw new ModelsConfigError(cliError.detail);
  const modelError = validateModelValue(snapshot.model, `${role}.model`);
  if (modelError) throw new ModelsConfigError(modelError.detail);
  if (cli === 'agy') {
    if (!AGY_EFFORT_SUFFIX_RE.test(snapshot.model)) {
      throw new ModelsConfigError(`role ${role} uses agy but model ${snapshot.model} has no recognized effort suffix (-low, -medium, -high)`);
    }
  } else {
    const effortError = validateEffortValue(snapshot.effort, `${role}.effort`);
    if (effortError) throw new ModelsConfigError(effortError.detail);
  }
  return { cli, model: snapshot.model, effort: snapshot.effort };
}

/**
 * Build CLI execution arguments and command metadata for a resolved role.
 *
 * Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md §1
 *
 * @param {string} role
 * @param {Record<string, { cli: string, model: string, effort: string }>} roles
 * @returns {{ cli: string, command: string, args: string[], insertAfter: string | null }}
 */
export function cliExecArgs(role, roles) {
  const snapshot = roleSnapshot(role, roles);
  if (snapshot.cli === 'agy') {
    return {
      cli: 'agy',
      command: 'agy',
      args: ['--model', snapshot.model],
      insertAfter: null,
    };
  }
  return {
    cli: 'codex',
    command: 'codex',
    args: ['-m', snapshot.model, '-c', `model_reasoning_effort=${snapshot.effort}`],
    insertAfter: 'exec',
  };
}

/**
 * Build safe `codex exec` model flags for a resolved role.
 * Implements spec §1 transport adapters.
 */
export function codexExecArgs(role, roles) {
  const snapshot = roleSnapshot(role, roles);
  if (snapshot.cli === 'agy') {
    throw new ModelsConfigError(`role ${role} uses agy`);
  }
  return ['-m', snapshot.model, '-c', `model_reasoning_effort=${snapshot.effort}`];
}

/**
 * Build the model fields accepted by the Codex MCP call.
 * Implements spec §1 transport adapters.
 */
export function mcpCallConfig(role, roles) {
  const snapshot = roleSnapshot(role, roles);
  if (snapshot.cli === 'agy') {
    throw new ModelsConfigError(
      `role ${role} uses agy; the Codex MCP tool cannot open an agy thread — use reviewer-thread-open`,
    );
  }
  return { model: snapshot.model, config: { model_reasoning_effort: snapshot.effort } };
}

/**
 * Select the model role for a persistent reviewer thread.
 * Implements spec §1 role selection.
 */
export function roleForThread(key) {
  return key === 'execution-reviewer' ? 'review' : 'planning';
}

const PLANNING_PHASES = new Set([
  'spec-review',
  'plan-review',
  'pre-dispatch',
  'tdd-review',
  'hypothesis-review',
]);
const REVIEW_PHASES = new Set([
  'post-implementation-review',
  'post-merge-review',
  'merge-review',
  'docs-update',
]);

/**
 * Select a harness model role from the request phase.
 * Implements the spec §1 phase table.
 */
export function modelRoleForPhase(phase) {
  if (PLANNING_PHASES.has(phase)) return { role: 'planning', warning: null };
  if (REVIEW_PHASES.has(phase)) return { role: 'review', warning: null };
  return { role: 'review', warning: `unknown phase ${JSON.stringify(String(phase))}` };
}

/**
 * Resolve the complete harness-facing model options for one phase.
 * Implements spec §1 harness dispatch resolution.
 */
export function harnessModelOptions(phase, { repoRoot, env, roles } = {}) {
  const selection = modelRoleForPhase(phase);
  const resolvedRoles = roles ?? resolveModelRoles({ repoRoot, env }).roles;
  const snapshot = roleSnapshot(selection.role, resolvedRoles);
  return {
    modelRole: selection.role,
    cli: snapshot.cli,
    model: snapshot.model,
    reasoningEffort: snapshot.effort,
    warning: selection.warning,
  };
}

/**
 * Compare dot-separated numeric CLI versions.
 * Implements spec §1 validated CLI version support.
 */
export function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
