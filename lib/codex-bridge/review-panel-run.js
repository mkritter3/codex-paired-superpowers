// @ts-check

import { detectAvailableCLIs as defaultDetectAvailableCLIs } from './availability/detector.js';
import { resolveReviewPanel } from './review-panel.js';
import { openPanelMemberThread } from './reviewer-thread.js';
import { parseVerdict } from './verdict.js';

const REPLAY_BUDGET = 12_000;
const MEMBER_ID_RE = /^(codex|agy):[A-Za-z0-9._-]+$/;
const ROUTES = new Set(['single', 'two-disjoint', 'hybrid-ui-backend']);

/** @typedef {{member_id: string, cli: string, model: string, effort: string}} RosterEntry */
/** @typedef {{status: 'SHIP'|'REVISE', critique: string[], rationale: string, deferred?: string[], version: string|null}} Verdict */
/** @typedef {{member_id: string, finding: string}} LabelledFinding */

export class PanelRuntimeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PanelRuntimeError';
    this.code = code;
  }
}

/** @param {string} memberId @param {string} reason */
function unavailable(memberId, reason) {
  return new PanelRuntimeError(
    'panel-member-unavailable',
    `${memberId}: ${reason}; install or sign in to the CLI, or remove it from review_panel`,
  );
}

/** @param {unknown} value @param {string} field */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/** @param {Record<string, any>} value @param {string[]} allowed @param {string} field */
function rejectUnknownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${field} contains unknown field ${JSON.stringify(unknown[0])}`);
}

/** Normalize the quoted/whitespace-tolerant version representation used by verdicts. */
/** @param {unknown} value @returns {string|null} */
function normalizeVersion(value) {
  if (typeof value !== 'string') return null;
  let normalized = value.trim();
  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  return normalized || null;
}

/** @param {unknown} input @returns {RosterEntry[]} */
function normalizeRoster(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('roster must be a non-empty array');
  }
  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`roster[${index}] must be an object`);
    }
    rejectUnknownKeys(/** @type {Record<string, any>} */ (raw), ['member_id', 'cli', 'model', 'effort'], `roster[${index}]`);
    const member_id = requiredString(raw.member_id, `roster[${index}].member_id`);
    const cli = requiredString(raw.cli, `roster[${index}].cli`);
    const model = requiredString(raw.model, `roster[${index}].model`);
    const effort = requiredString(raw.effort, `roster[${index}].effort`);
    if (!MEMBER_ID_RE.test(member_id) || !['codex', 'agy'].includes(cli) || member_id !== `${cli}:${model}`) {
      throw new TypeError(`roster[${index}] has an invalid or inconsistent member identity`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(effort)) throw new TypeError(`roster[${index}].effort must be a safe token`);
    if (seen.has(member_id)) throw new TypeError(`roster contains duplicate member ${member_id}`);
    seen.add(member_id);
    return { member_id, cli, model, effort };
  });
}

/** @param {unknown} raw @param {string} label @returns {Verdict} */
function normalizeVerdict(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unavailable(label, 'verdict is missing');
  const value = /** @type {Record<string, any>} */ (raw);
  try {
    rejectUnknownKeys(value, ['status', 'critique', 'rationale', 'deferred', 'version'], `${label} verdict`);
  } catch (error) {
    throw unavailable(label, /** @type {Error} */ (error).message);
  }
  if (value.status !== 'SHIP' && value.status !== 'REVISE') throw unavailable(label, 'verdict status is invalid');
  if (!Array.isArray(value.critique)
    || value.critique.some((/** @type {unknown} */ item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw unavailable(label, 'verdict critique is invalid');
  }
  if (typeof value.rationale !== 'string') throw unavailable(label, 'verdict rationale is invalid');
  if (value.deferred !== undefined && (!Array.isArray(value.deferred)
    || value.deferred.some((/** @type {unknown} */ item) => typeof item !== 'string' || item.trim().length === 0))) {
    throw unavailable(label, 'verdict deferred findings are invalid');
  }
  return {
    status: value.status,
    critique: value.critique.map((/** @type {string} */ item) => item.trim()).filter(Boolean),
    rationale: value.rationale.trim(),
    deferred: (value.deferred ?? []).map((/** @type {string} */ item) => item.trim()).filter(Boolean),
    version: normalizeVersion(value.version),
  };
}

/**
 * Strict-unanimity reduction for one configured panel round.
 *
 * @param {{roster: unknown, version: unknown, claude: unknown, members: unknown}} input
 * @returns {{status: 'SHIP'|'REVISE', blocking: LabelledFinding[], deferred: LabelledFinding[]}}
 */
export function reducePanelRound({ roster: rawRoster, version: rawVersion, claude: rawClaude, members: rawMembers }) {
  const roster = normalizeRoster(rawRoster);
  const version = normalizeVersion(rawVersion);
  if (!version) throw new TypeError('version must be a non-empty string');
  const claude = normalizeVerdict(rawClaude, 'claude');
  if (claude.version !== version) throw unavailable('claude', 'verdict version is missing or does not match the artifact');
  if (!Array.isArray(rawMembers)) throw new TypeError('members must be an array');

  const rosterIds = new Set(roster.map((member) => member.member_id));
  /** @type {Map<string, Verdict>} */
  const byId = new Map();
  for (let index = 0; index < rawMembers.length; index += 1) {
    const entry = rawMembers[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`members[${index}] must be an object`);
    }
    const memberId = requiredString(entry.member_id, `members[${index}].member_id`);
    if (!rosterIds.has(memberId)) throw unavailable(memberId, 'member is not in the fixed roster');
    if (byId.has(memberId)) throw unavailable(memberId, 'duplicate member result');
    try {
      rejectUnknownKeys(
        /** @type {Record<string, any>} */ (entry),
        ['member_id', 'verdict', 'conversation_id', 'usage', 'ok', 'error'],
        `members[${index}]`,
      );
    } catch (error) {
      throw unavailable(memberId, /** @type {Error} */ (error).message);
    }
    if (entry.ok === false || entry.error !== undefined) {
      const detail = typeof entry.error === 'string' && entry.error.trim() ? entry.error.trim() : 'member turn failed';
      throw unavailable(memberId, detail);
    }
    byId.set(memberId, normalizeVerdict(entry.verdict, memberId));
  }

  /** @type {LabelledFinding[]} */
  const blocking = [];
  /** @type {LabelledFinding[]} */
  const deferred = [];
  let allShip = claude.status === 'SHIP';
  if (claude.status === 'REVISE') {
    blocking.push(...claude.critique.map((finding) => ({ member_id: 'claude', finding })));
  }
  deferred.push(...(claude.deferred ?? []).map((finding) => ({ member_id: 'claude', finding })));

  for (const member of roster) {
    const memberVerdict = byId.get(member.member_id);
    if (!memberVerdict) throw unavailable(member.member_id, 'member result is missing');
    if (memberVerdict.version !== version) {
      throw unavailable(member.member_id, 'verdict version is missing or does not match the artifact');
    }
    if (memberVerdict.status === 'REVISE') {
      allShip = false;
      blocking.push(...memberVerdict.critique.map((finding) => ({ member_id: member.member_id, finding })));
    }
    deferred.push(...(memberVerdict.deferred ?? []).map((finding) => ({ member_id: member.member_id, finding })));
  }
  return { status: allShip ? 'SHIP' : 'REVISE', blocking, deferred };
}

/** @param {unknown} values @param {string} field */
function normalizeGoals(values, field) {
  if (typeof values === 'string' && values.trim()) return [values.trim()];
  if (Array.isArray(values) && values.length > 0 && values.every((item) => typeof item === 'string' && item.trim())) {
    return values.map((item) => item.trim());
  }
  throw new TypeError(`${field} must be a non-empty string or array of non-empty strings`);
}

/** @param {unknown} values @param {string} field */
function normalizeReplayFindings(values, field) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  return values.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${field}[${index}] must be an object`);
    const value = /** @type {Record<string, any>} */ (raw);
    rejectUnknownKeys(value, ['member_id', 'status', 'finding'], `${field}[${index}]`);
    return {
      member_id: requiredString(raw.member_id, `${field}[${index}].member_id`),
      status: raw.status === undefined ? 'open' : requiredString(raw.status, `${field}[${index}].status`),
      finding: requiredString(raw.finding, `${field}[${index}].finding`),
    };
  });
}

/**
 * Assemble the complete fixed-budget replay used to seed a fresh agy turn.
 *
 * @param {{goals: unknown, round: unknown, unresolved: unknown, previousRound: unknown}} input
 * @returns {string}
 */
export function composeMemberReplay({ goals: rawGoals, round: rawRound, unresolved: rawUnresolved, previousRound: rawPrevious }) {
  if (typeof rawRound !== 'number' || !Number.isInteger(rawRound) || rawRound < 1 || rawRound > 7) {
    throw new TypeError('round must be an integer from 1 through 7');
  }
  const goals = normalizeGoals(rawGoals, 'goals');
  const unresolved = normalizeReplayFindings(rawUnresolved, 'unresolved');
  if ((rawPrevious === null || rawPrevious === undefined) && rawRound !== 1) {
    throw new TypeError('previousRound is required after round 1');
  }
  const previousValue = Array.isArray(rawPrevious)
    ? { findings: rawPrevious, resolved_count: 0 }
    : rawPrevious === null || rawPrevious === undefined
      ? { findings: [], resolved_count: 0 }
      : typeof rawPrevious === 'object'
        ? /** @type {Record<string, any>} */ (rawPrevious)
        : null;
  if (!previousValue) throw new TypeError('previousRound must be an object, array, or null in round 1');
  rejectUnknownKeys(previousValue, ['findings', 'resolved_count'], 'previousRound');
  const previous = normalizeReplayFindings(previousValue.findings ?? [], 'previousRound.findings');
  const resolvedCount = previousValue.resolved_count ?? 0;
  if (!Number.isInteger(resolvedCount) || resolvedCount < 0) {
    throw new TypeError('previousRound.resolved_count must be a non-negative integer');
  }

  const lines = [
    `Round: ${rawRound}`,
    'Goals:',
    ...goals.map((goal) => `- ${goal}`),
    '',
    'Unresolved blocking findings:',
    ...(unresolved.length
      ? unresolved.map((entry) => `- [${entry.member_id}] (${entry.status}) ${entry.finding}`)
      : ['- none']),
    '',
    'Previous round findings:',
    ...(previous.length
      ? previous.map((entry) => `- [${entry.member_id}] (${entry.status}) ${entry.finding}`)
      : ['- none']),
    '',
    `Earlier resolved findings: ${resolvedCount}`,
  ];
  const replay = lines.join('\n');
  if (replay.length > REPLAY_BUDGET) {
    throw new PanelRuntimeError('panel-replay-overflow', `assembled replay is ${replay.length} characters; limit is ${REPLAY_BUDGET}`);
  }
  return replay;
}

/**
 * Check every configured member CLI before round 1.
 *
 * @param {{repoRoot: unknown, roster: unknown}} input
 * @param {{detectAvailableCLIs?: typeof defaultDetectAvailableCLIs}} [deps]
 */
export async function assertPanelMembersAvailable({ repoRoot: rawRepoRoot, roster: rawRoster }, deps = {}) {
  const repoRoot = requiredString(rawRepoRoot, 'repoRoot');
  const roster = normalizeRoster(rawRoster);
  const detectAvailableCLIs = deps.detectAvailableCLIs ?? defaultDetectAvailableCLIs;
  const detected = await detectAvailableCLIs(repoRoot, { force: true });
  if (!(detected instanceof Map)) throw new TypeError('detectAvailableCLIs must return a Map');
  for (const member of roster) {
    const result = detected.get(member.cli);
    if (!result || result.status !== 'available') {
      const reason = result && typeof result.reason === 'string'
        ? result.reason
        : result && typeof result.error === 'string'
          ? result.error
          : `${member.cli} binary or authentication probe failed`;
      throw unavailable(member.member_id, reason);
    }
  }
}

/**
 * Fail before checkout creation for routes whose review gate cannot represent a configured panel.
 *
 * @param {{repoRoot: string, split: string}} input
 */
export function assertPanelRouteSupported({ repoRoot, split }) {
  requiredString(repoRoot, 'repoRoot');
  if (typeof split !== 'string' || !ROUTES.has(split)) throw new TypeError(`split must be one of: ${[...ROUTES].join(', ')}`);
  const panel = resolveReviewPanel({ phase: 'review', repoRoot });
  if (panel.configured && panel.roster.length > 1 && (split === 'two-disjoint' || split === 'hybrid-ui-backend')) {
    throw new PanelRuntimeError('panel-unsupported-route', `${split} does not support a configured multi-member review panel`);
  }
}

/**
 * Production entry point behind the review-panel-member CLI verb.
 *
 * @param {Record<string, any>} options
 * @param {Record<string, any>} [deps]
 */
export async function reviewPanelMember(options, deps = {}) {
  const memberId = requiredString(options?.member_id, 'member_id');
  const version = normalizeVersion(options?.version);
  if (!version) throw new TypeError('version must be a non-empty string');
  const result = await openPanelMemberThread(/** @type {any} */ ({ ...options, member_id: memberId, version }), deps);
  if (!result.ok) throw unavailable(memberId, `member turn failed with status ${result.status}`);
  const parsed = parseVerdict(result.content);
  const normalized = normalizeVerdict(parsed, memberId);
  if (normalized.version !== version) throw unavailable(memberId, 'verdict version is missing or does not match the artifact');
  return {
    member_id: memberId,
    verdict: normalized,
    conversation_id: result.threadId ?? null,
    usage: result.usage ?? null,
  };
}

/**
 * Test helper that fans out through injected transports and reduces with the production reducer.
 *
 * @param {Record<string, any>} input
 * @param {{dispatchMember?: Function, transports?: Map<string, Function>|Record<string, Function>, detectAvailableCLIs?: typeof defaultDetectAvailableCLIs}} [deps]
 */
export async function runPanelRound(input, deps = {}) {
  const roster = normalizeRoster(input?.roster);
  const round = input?.round;
  if (!Number.isInteger(round) || round < 1 || round > 7) throw new TypeError('round must be an integer from 1 through 7');
  const prompt = requiredString(input?.prompt, 'prompt');
  if (round === 1) {
    await assertPanelMembersAvailable({ repoRoot: input?.repoRoot, roster }, { detectAvailableCLIs: deps.detectAvailableCLIs });
  }
  const dispatchMember = deps.dispatchMember ?? (async (/** @type {Record<string, any>} */ request) => {
    const transports = deps.transports;
    const transport = transports instanceof Map
      ? transports.get(request.member_id) ?? transports.get(request.member.cli)
      : transports?.[request.member_id] ?? transports?.[request.member.cli];
    if (typeof transport === 'function') return transport(request);
    if (request.member.cli === 'agy') return reviewPanelMember(request);
    throw unavailable(request.member_id, 'no injected Codex MCP transport');
  });
  const memberResults = await Promise.all(roster.map((member) => dispatchMember({
    ...input,
    member,
    member_id: member.member_id,
    model: member.model,
    prompt,
    replay: prompt,
    sessionKey: `${input?.sidecarKey ?? 'execution-reviewer'}:${member.member_id}`,
  })));
  return reducePanelRound({ roster, version: input?.version, claude: input?.claude, members: memberResults });
}
