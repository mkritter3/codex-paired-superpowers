/**
 * Model-role configuration and transport adapters.
 *
 * Spec: docs/specs/2026-09-17-v0.16.0-model-roles-design.md §1
 */

import { loadProjectConfig } from './project-config.js';

export const MODEL_ROLES = ['planning', 'review', 'implement', 'implement_fallback'];

export const MODEL_ROLE_DEFAULTS = Object.freeze({
  planning: Object.freeze({ model: 'gpt-6-astra', effort: 'xhigh' }),
  review: Object.freeze({ model: 'gpt-6-astra', effort: 'high' }),
  implement: Object.freeze({ model: 'gpt-5.6-sol', effort: 'high' }),
  implement_fallback: Object.freeze({ model: 'gpt-6-astra', effort: 'medium' }),
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
      if (key !== 'model' && key !== 'effort') {
        return malformed(`models.${role} contains unknown key ${JSON.stringify(key)}; expected model or effort`);
      }
    }
    if ('model' in config) {
      const error = validateModelValue(config.model, `models.${role}.model`);
      if (error) return error;
    }
    if ('effort' in config) {
      const error = validateEffortValue(config.effort, `models.${role}.effort`);
      if (error) return error;
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
  const error = field === 'model'
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
    sources[role] = { model: 'default', effort: 'default' };
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
      if ('model' in config) applyValue(roles, sources, role, 'model', config.model, 'project');
      if ('effort' in config) applyValue(roles, sources, role, 'effort', config.effort, 'project');
    }
  }

  const globalModel = validateEnvValue(env, 'CODEX_PAIRED_MODEL', 'model');
  const globalEffort = validateEnvValue(env, 'CODEX_PAIRED_REASONING', 'effort');
  for (const role of MODEL_ROLES) {
    if (globalModel !== null) applyValue(roles, sources, role, 'model', globalModel, 'env');
    if (globalEffort !== null) applyValue(roles, sources, role, 'effort', globalEffort, 'env');

    const suffix = role.toUpperCase();
    const model = validateEnvValue(env, `CODEX_PAIRED_MODEL_${suffix}`, 'model');
    const effort = validateEnvValue(env, `CODEX_PAIRED_REASONING_${suffix}`, 'effort');
    if (model !== null) applyValue(roles, sources, role, 'model', model, 'env');
    if (effort !== null) applyValue(roles, sources, role, 'effort', effort, 'env');
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
  const modelError = validateModelValue(snapshot.model, `${role}.model`);
  const effortError = validateEffortValue(snapshot.effort, `${role}.effort`);
  if (modelError || effortError) throw new ModelsConfigError((modelError || effortError).detail);
  return snapshot;
}

/**
 * Build safe `codex exec` model flags for a resolved role.
 * Implements spec §1 transport adapters.
 */
export function codexExecArgs(role, roles) {
  const { model, effort } = roleSnapshot(role, roles);
  return ['-m', model, '-c', `model_reasoning_effort=${effort}`];
}

/**
 * Build the model fields accepted by the Codex MCP call.
 * Implements spec §1 transport adapters.
 */
export function mcpCallConfig(role, roles) {
  const { model, effort } = roleSnapshot(role, roles);
  return { model, config: { model_reasoning_effort: effort } };
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
