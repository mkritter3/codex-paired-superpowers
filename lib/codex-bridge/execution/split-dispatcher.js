// Unified execution driver — Plan 1: shared split dispatcher.
//
// Spec: docs/specs/2026-05-29-unified-execution-driver-design.md
//   §"Split directive"  — how a slice declares its split, and the legacy forms.
//   §"Shared split dispatcher" — normalizeSplit + runSplit contracts.
//
// This module is the pure routing-and-normalization core every later plan wires
// through. `normalizeSplit` does no I/O beyond reading the passed markdown; it
// only decides which of the three splits a slice is and validates the combo.
// `runSplit` (slice 2) adds dependency-injected dispatch on top.
//
// CRITICAL parse-order invariant (round-1 fix): hybrid slices are detected and
// routed to `parseHybridOwners` BEFORE `parseImplementersBlock` is ever called,
// because `parseImplementersBlock`'s adapter allow-list ({claude-cli, codex-cli})
// throws `implementer-directive-malformed` on hybrid owner adapters (claude-ui /
// codex-background-bash). See lib/codex-bridge/implementer/frontmatter.js:303.

import {
  parseImplementersBlock,
  extractImplementersBlockLines,
} from '../implementer/frontmatter.js';
import {
  parseHybridOwners,
  validateHybridOwnership,
} from '../hybrid/ownership.js';
import { parseFilesBlock } from '../plan-parsers.js';
import { dispatchImplementers } from '../implementer/orchestrator.js';
import { runHybridSlice } from '../hybrid/runner.js';

/** Valid execution drivers. */
export const DRIVERS = Object.freeze(['interactive', 'autopilot']);

/** The three canonical, case-sensitive split values. */
export const SPLIT_VALUES = Object.freeze(['single', 'two-disjoint', 'hybrid-ui-backend']);

/**
 * Build a halt-shaped Error carrying `.code` (mirrors hybrid/ownership.js).
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function haltError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Read the `**Split:** <value>` directive from a slice section.
 *
 * Line-anchored; the captured value is trimmed and matched case-sensitively
 * against the three canonical lowercase values.
 *
 * @param {string} sliceSection
 * @returns {('single'|'two-disjoint'|'hybrid-ui-backend')|null} the split, or
 *   null when no directive is present.
 * @throws {Error} `.code === 'split-directive-unknown'` for any non-canonical value.
 */
export function parseSplitDirective(sliceSection) {
  if (typeof sliceSection !== 'string') return null;
  const re = /^\s*\*\*Split:\*\*\s*(.+?)\s*$/;
  for (const raw of sliceSection.split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    const value = m[1].trim();
    if (SPLIT_VALUES.includes(value)) return value;
    throw haltError(
      'split-directive-unknown',
      `**Split:** value must be one of ${SPLIT_VALUES.join(', ')}; got "${value}"`
    );
  }
  return null;
}

/**
 * Read the legacy `**Orchestration:** <value>` marker. Only `hybrid` is
 * recognized; any other value (or absence) yields null. This is the sole
 * programmatic reader for that marker — it previously lived only in skill prose.
 *
 * @param {string} sliceSection
 * @returns {'hybrid'|null}
 */
export function parseOrchestrationMarker(sliceSection) {
  if (typeof sliceSection !== 'string') return null;
  const re = /^\s*\*\*Orchestration:\*\*\s*(.+?)\s*$/;
  for (const raw of sliceSection.split('\n')) {
    const m = re.exec(raw);
    if (!m) continue;
    return m[1].trim() === 'hybrid' ? 'hybrid' : null;
  }
  return null;
}

/**
 * @typedef {object} NormalizedSplit
 * @property {'single'|'two-disjoint'|'hybrid-ui-backend'} split
 * @property {string[]} legacySyntax  — markers used the legacy inference path
 *   (subset of ['implementers','orchestration']); [] for explicit directives.
 * @property {string[]} warnings      — non-fatal advisories (e.g. ignored markers).
 * @property {object} config          — split-specific payload:
 *   single → {}; two-disjoint → { implementers }; hybrid → { owners }.
 */

/**
 * Decide a slice's split and validate the declaration.
 *
 * Resolution order (the parse-order invariant):
 *   1. directive = parseSplitDirective(sliceSection)
 *   2. orchestrationHybrid = parseOrchestrationMarker(sliceSection) === 'hybrid'
 *   3. directive === 'hybrid-ui-backend' OR (directive == null AND orchestrationHybrid)
 *        → hybrid path (parseHybridOwners + validateHybridOwnership)
 *   4. directive === 'two-disjoint' → parseImplementersBlock, require exactly two
 *   5. directive == null AND an **Implementers:** block present → legacy two-disjoint
 *   6. else → single (guard: a raw implementers block OR orchestration-hybrid
 *        marker → split-single-with-implementers)
 *
 * @param {object} args
 * @param {string} args.planMarkdown
 * @param {string} args.sliceSection
 * @returns {NormalizedSplit}
 * @throws {Error} with `.code` set to a split-* / hybrid-* / implementer-* halt
 *   reason on an invalid declaration.
 */
export function normalizeSplit({ planMarkdown, sliceSection }) {
  const directive = parseSplitDirective(sliceSection);
  const orchestrationHybrid = parseOrchestrationMarker(sliceSection) === 'hybrid';

  // ── Hybrid path (explicit directive, or legacy marker inference). ──────────
  if (directive === 'hybrid-ui-backend' || (directive === null && orchestrationHybrid)) {
    const owners = parseHybridOwners(planMarkdown, sliceSection);
    const sliceFiles = parseFilesBlock(sliceSection);
    validateHybridOwnership({ sliceFiles, implementers: owners }); // .code propagates
    return {
      split: 'hybrid-ui-backend',
      legacySyntax: directive === null ? ['orchestration'] : [],
      warnings:
        directive === null
          ? ['legacy **Orchestration:** hybrid marker inferred hybrid-ui-backend; prefer **Split:** hybrid-ui-backend']
          : [],
      config: { owners },
    };
  }

  // ── Explicit two-disjoint: exactly two implementers required. ──────────────
  if (directive === 'two-disjoint') {
    const impl = parseImplementersBlock(planMarkdown, sliceSection);
    if (!impl || impl.implementers.length !== 2) {
      throw haltError(
        'split-two-disjoint-not-exactly-two',
        `**Split:** two-disjoint requires exactly two implementers; got ${impl ? impl.implementers.length : 0}`
      );
    }
    const warnings = orchestrationHybrid
      ? ['orchestration marker ignored; **Split:** directive takes precedence']
      : [];
    return { split: 'two-disjoint', legacySyntax: [], warnings, config: { implementers: impl.implementers } };
  }

  // ── Legacy two-disjoint: no directive, but an **Implementers:** block present.
  if (directive === null && extractImplementersBlockLines(sliceSection) !== null) {
    const impl = parseImplementersBlock(planMarkdown, sliceSection); // caps enforced here
    return {
      split: 'two-disjoint',
      legacySyntax: ['implementers'],
      warnings: ['legacy **Implementers:** block without **Split:**; inferred two-disjoint'],
      config: { implementers: impl.implementers },
    };
  }

  // ── Single (default). Guard against contradictory structure. ───────────────
  // Block presence is detected with the RAW extractor, not parseImplementersBlock,
  // so split-single-with-implementers wins even when the block body uses
  // hybrid-like adapters (which would otherwise throw implementer-directive-malformed).
  if (extractImplementersBlockLines(sliceSection) !== null || orchestrationHybrid) {
    throw haltError(
      'split-single-with-implementers',
      'a single slice cannot also declare an implementers/hybrid owner block or an orchestration-hybrid marker'
    );
  }
  return { split: 'single', legacySyntax: [], warnings: [], config: {} };
}

/**
 * Placeholder single-implementer path. Plan 2 replaces this by injecting the
 * real single runner via `deps.runSingle`. Until then a `single` slice with no
 * injected runner throws explicitly rather than silently no-op'ing.
 *
 * @returns {never}
 */
function _runSingle() {
  throw new Error(
    'single-implementer path not yet wired — inject deps.runSingle (Plan 2 replaces this placeholder)'
  );
}

/**
 * Map parser-shaped implementer entries to the runtime shape that
 * `dispatchImplementers` consumes.
 *
 * `parseImplementersBlock` emits `{ member_id, adapter, model, required, files }`
 * (snake_case, no worktree fields), but `dispatchImplementers` reads
 * `{ memberId, adapter, model, required, worktreePath, branchName, claimedFiles }`
 * (orchestrator.js:122-128,165-170). Passing the parser shape directly keys the
 * sidecar run by `undefined` and dispatches with empty claimed files (Codex
 * slice-review round-1 finding). This adapter bridges the two.
 *
 * Worktree creation is git I/O that `runSplit` does not own (it routes only), so
 * `worktreePath`/`branchName` are threaded from a per-member `worktrees` map the
 * caller supplies (Plan 2's wiring layer populates it from worktree fan-out). If
 * absent, they fall through as `undefined` and `dispatchImplementers` applies its
 * own '' defaults — but `memberId` and `claimedFiles` are always correct.
 *
 * @param {Array<{member_id: string, adapter: string, model: string, required?: boolean, files: string[]}>} parsed
 * @param {Record<string, {worktreePath?: string, branchName?: string}>} [worktrees]
 * @returns {Array<{memberId: string, adapter: string, model: string, required: boolean, worktreePath: (string|undefined), branchName: (string|undefined), claimedFiles: string[]}>}
 */
function toRuntimeImplementers(parsed, worktrees = {}) {
  return parsed.map((e) => {
    const wt = worktrees[e.member_id] ?? {};
    return {
      memberId: e.member_id,
      adapter: e.adapter,
      model: e.model,
      required: e.required ?? true,
      worktreePath: wt.worktreePath,
      branchName: wt.branchName,
      claimedFiles: e.files,
    };
  });
}

/**
 * Route a work item to the runner for its split, passing along whether the user
 * is driving (interactive) or it runs unattended (autopilot).
 *
 * runSplit only routes: it calls `normalizeSplit`, validates the driver, then
 * delegates to the existing runners. It owns NO sidecar state (spec
 * §"Non-responsibilities"). Every downstream runner is dependency-injectable so
 * tests assert routing in isolation without spawning real workers.
 *
 * @param {object} args
 * @param {'interactive'|'autopilot'} args.driver
 * @param {string} args.planPath
 * @param {string} args.specPath
 * @param {{planMarkdown: string, sliceSection: string, sliceId: string,
 *   sliceStartSha?: string, integrationBranch?: string}} args.workItem
 * @param {string} args.repoRoot
 * @param {object} [args.deps]  — { runSingle, dispatchImplementers, runHybridSlice,
 *   dispatchFn, hybridDeps }
 * @returns {Promise<{ok: boolean, split: string, outcome: unknown}>}
 */
export async function runSplit({ driver, planPath, specPath, workItem, repoRoot, deps = {} }) {
  // 1. Driver enum guard FIRST — never silently fall back to autopilot.
  if (!DRIVERS.includes(driver)) {
    throw haltError('split-unknown-driver', `driver must be one of ${DRIVERS.join(', ')}; got "${driver}"`);
  }

  // 2. Normalize the split (lets split-*/hybrid-*/implementer-* halts throw
  //    BEFORE any dispatch runs).
  const normalized = normalizeSplit({
    planMarkdown: workItem.planMarkdown,
    sliceSection: workItem.sliceSection,
  });

  // 3. Resolve runners (DI defaults to the real ones).
  const runSingle = deps.runSingle ?? _runSingle;
  const dispatch = deps.dispatchImplementers ?? dispatchImplementers;
  const runHybrid = deps.runHybridSlice ?? runHybridSlice;
  const mode = driver === 'interactive' ? 'interactive' : 'autopilot';

  let outcome;
  switch (normalized.split) {
    case 'single':
      outcome = await runSingle({ driver, specPath, sliceId: workItem.sliceId, repoRoot });
      break;
    case 'two-disjoint':
      outcome = await dispatch({
        specPath,
        repoRoot,
        sliceId: workItem.sliceId,
        baseSha: workItem.sliceStartSha,
        implementers: toRuntimeImplementers(normalized.config.implementers, workItem.worktrees),
        dispatchFn: deps.dispatchFn,
      });
      break;
    case 'hybrid-ui-backend':
      outcome = await runHybrid({
        mode,
        repoRoot,
        specPath,
        sliceId: workItem.sliceId,
        sliceStartSha: workItem.sliceStartSha,
        integrationBranch: workItem.integrationBranch,
        deps: deps.hybridDeps,
      });
      break;
    default:
      // Unreachable: normalizeSplit only returns the three canonical values.
      throw haltError('split-directive-unknown', `unroutable split "${normalized.split}"`);
  }

  return { ok: true, split: normalized.split, outcome };
}
