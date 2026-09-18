// @ts-check

/**
 * Resolve the external-reviewer roster for planning and execution review.
 *
 * Configuration only activates the panel contract when the selected phase is
 * explicitly present in project.json or its phase-specific environment
 * override is set. Otherwise the returned roster mirrors the existing model
 * role exactly, and callers retain the legacy single-reviewer path.
 */

import { loadProjectConfig } from './project-config.js';
import {
  AGY_EFFORT_SUFFIX_RE,
  MODEL_ROLE_DEFAULTS,
  ModelsConfigError,
  SAFE_TOKEN,
  VALID_CLIS,
  resolveModelRoles,
} from './models.js';

/** @typedef {'planning' | 'review'} ReviewPanelPhase */
/** @typedef {{cli: string, model?: string}} PanelConfigEntry */
/** @typedef {{member_id: string, cli: string, model: string, effort: string}} RosterEntry */
/** @typedef {{code: 'models-config-malformed', detail: string}} MalformedResult */

const PANEL_PHASES = ['planning', 'review'];
const AGY_DEFAULT_MODEL = 'gemini-3.8-flash-high';

/** @param {string} detail @returns {MalformedResult} */
function malformed(detail) {
  return { code: 'models-config-malformed', detail };
}

/**
 * Validate the optional project `review_panel` block without resolving model
 * defaults. Resolution-dependent duplicate detection happens in
 * `resolveReviewPanel`, where the effective model roles are available.
 *
 * @param {unknown} block
 * @returns {MalformedResult | null}
 */
export function validateReviewPanelBlock(block) {
  if (block === null || block === undefined) return null;
  if (typeof block !== 'object' || Array.isArray(block)) {
    return malformed('review_panel must be an object');
  }

  for (const [phase, value] of Object.entries(block)) {
    if (!PANEL_PHASES.includes(phase)) {
      return malformed(`review_panel contains unknown phase ${JSON.stringify(phase)}; expected one of: ${PANEL_PHASES.join(', ')}`);
    }
    const error = validatePhaseEntries(value, `review_panel.${phase}`);
    if (error) return error;
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {MalformedResult | null}
 */
function validatePhaseEntries(value, path) {
  if (!Array.isArray(value)) return malformed(`${path} must be an array`);
  if (value.length === 0) return malformed(`${path} must contain at least one member`);

  const explicitMembers = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return malformed(`${entryPath} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'cli' && key !== 'model') {
        return malformed(`${entryPath} contains unknown key ${JSON.stringify(key)}; expected cli or model`);
      }
    }
    if (!('cli' in entry) || typeof entry.cli !== 'string' || !VALID_CLIS.includes(entry.cli)) {
      return malformed(`${entryPath}.cli must be one of: ${VALID_CLIS.join(', ')}; got ${JSON.stringify(entry.cli)}`);
    }
    if ('model' in entry) {
      if (typeof entry.model !== 'string' || entry.model.length === 0 || !SAFE_TOKEN.test(entry.model)) {
        return malformed(`${entryPath}.model must contain only letters, digits, dot, underscore, or hyphen; got ${JSON.stringify(entry.model)}`);
      }
      if (entry.cli === 'agy' && !AGY_EFFORT_SUFFIX_RE.test(entry.model)) {
        return malformed(`${entryPath}.model must end with -low, -medium, or -high when cli is agy; got ${JSON.stringify(entry.model)}`);
      }
      const memberId = `${entry.cli}:${entry.model}`;
      if (explicitMembers.has(memberId)) return malformed(`${entryPath} duplicates ${memberId}`);
      explicitMembers.add(memberId);
    }
  }
  return null;
}

/**
 * @param {{phase: ReviewPanelPhase, repoRoot?: string, env?: Record<string, string | undefined>}} options
 * @returns {{roster: RosterEntry[], configured: boolean, warnings: string[]}}
 */
export function resolveReviewPanel({ phase, repoRoot = process.cwd(), env = process.env }) {
  if (!PANEL_PHASES.includes(phase)) {
    throw new ModelsConfigError(`review_panel phase must be one of: ${PANEL_PHASES.join(', ')}; got ${JSON.stringify(phase)}`);
  }

  const { roles } = resolveModelRoles({ repoRoot, env });
  const loaded = loadProjectConfig(repoRoot);
  if (loaded && !loaded.ok) {
    throw new ModelsConfigError(
      `project config invalid (${loaded.error.code}): ${loaded.error.detail}`,
      { cause: loaded.error },
    );
  }

  const envKey = `CODEX_PAIRED_REVIEW_PANEL_${phase.toUpperCase()}`;
  const envValue = env[envKey];
  const fromEnvironment = envValue !== undefined;
  const projectPanel = loaded?.config?.review_panel;
  const fromProject = projectPanel !== null
    && typeof projectPanel === 'object'
    && Object.prototype.hasOwnProperty.call(projectPanel, phase);
  const configured = fromEnvironment || fromProject;

  /** @type {PanelConfigEntry[]} */
  let entries;
  let entriesPath;
  if (fromEnvironment) {
    entriesPath = envKey;
    entries = String(envValue).split(',').map((cli) => ({ cli: cli.trim() }));
  } else if (fromProject) {
    entriesPath = `review_panel.${phase}`;
    entries = projectPanel[phase];
  } else {
    entriesPath = `review_panel.${phase}`;
    entries = [{ cli: roles[phase].cli }];
  }

  const entriesError = validatePhaseEntries(entries, entriesPath);
  if (entriesError) throw new ModelsConfigError(entriesError.detail);

  const seen = new Set();
  const roster = entries.map((entry, index) => {
    const role = roles[phase];
    const model = entry.model
      ?? (entry.cli === role.cli
        ? role.model
        : entry.cli === 'agy'
          ? AGY_DEFAULT_MODEL
          : MODEL_ROLE_DEFAULTS[phase].model);
    const effort = entry.cli === 'agy'
      ? /** @type {RegExpMatchArray} */ (model.match(AGY_EFFORT_SUFFIX_RE))[1]
      : role.effort;
    const member_id = `${entry.cli}:${model}`;
    if (seen.has(member_id)) {
      throw new ModelsConfigError(`${entriesPath}[${index}] duplicates resolved member ${member_id}`);
    }
    seen.add(member_id);
    return { member_id, cli: entry.cli, model, effort };
  });

  const implementModel = roles.implement.model;
  const warnings = roster
    .filter((member) => member.model === implementModel)
    .map((member) => `self-review:${member.member_id}`);
  return { roster, configured, warnings };
}
