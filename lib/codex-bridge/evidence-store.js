/**
 * evidence-store.js
 *
 * Per-scenario evidence directory layout and retention-pruning for Phase E
 * live verification.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md
 *       § "Sidecar Persistence" (retention rules)
 *       § "Scenario Execution" (evidence layout)
 *
 * Evidence layout under <repoRoot>/.superpowers-codex-paired/evidence/<sliceId>/:
 *
 *   scenarios.json
 *   launch.json
 *   summary.json
 *   <scenario-id>/
 *     attempt-<N>/
 *       before.png
 *       after.png
 *       logs.txt
 *       setup-logs.txt
 *       result.json
 *
 * JSON writes use atomic temp-then-rename to match sidecar.js.
 * Screenshot/log writes use direct writeFileSync (binary data, no temp-rename
 * needed for integrity on macOS HFS+/APFS).
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Compute the evidence root for a given slice.
 *
 * @param {string} repoRoot
 * @param {string} sliceId
 * @returns {string}
 */
function sliceEvidenceRoot(repoRoot, sliceId) {
  return join(repoRoot, '.superpowers-codex-paired', 'evidence', sliceId);
}

/**
 * Compute the per-scenario/per-attempt directory.
 *
 * @param {string} repoRoot
 * @param {string} sliceId
 * @param {string} scenarioId
 * @param {number} attempt
 * @returns {string}
 */
function attemptDir(repoRoot, sliceId, scenarioId, attempt) {
  return join(sliceEvidenceRoot(repoRoot, sliceId), scenarioId, `attempt-${attempt}`);
}

/**
 * Atomic JSON write: write to a temp file, then rename to target.
 * Creates parent directories as needed.
 *
 * @param {string} targetPath
 * @param {unknown} data
 */
function writeJsonAtomic(targetPath, data) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = join(dirname(targetPath), `.${basename(targetPath)}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, targetPath);
}

/**
 * Write a binary or text file, creating parent directories as needed.
 *
 * @param {string} targetPath
 * @param {Buffer|string} content
 */
function writeFileDirect(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content);
}

// ── Top-level names that are NEVER pruned ─────────────────────────────────────

const TOP_LEVEL_PROTECTED = new Set(['summary.json', 'scenarios.json', 'launch.json', 'log-sources.json']);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an evidence store bound to a given repo root.
 *
 * @param {string} repoRoot - absolute path to the repository root
 * @returns {EvidenceStore}
 */
export function createEvidenceStore(repoRoot) {
  return {
    /**
     * Expose the repoRoot so upstream modules (e.g. scenario-runner) can
     * build canonical evidence paths without re-implementing the layout.
     */
    _repoRoot: repoRoot,

    /**
     * Ensure the evidence directory for a slice exists.
     * Idempotent — repeated calls are safe.
     *
     * @param {string} sliceId
     */
    init(sliceId) {
      mkdirSync(sliceEvidenceRoot(repoRoot, sliceId), { recursive: true });
    },

    /**
     * Write a scenario attempt result to
     * <evidence_root>/<scenarioId>/attempt-<N>/result.json
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @param {object} payload
     */
    writeScenarioResult(sliceId, scenarioId, attempt, payload) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'result.json');
      writeJsonAtomic(target, payload);
    },

    /**
     * Read back a scenario result.
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @returns {object}
     */
    readScenarioResult(sliceId, scenarioId, attempt) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'result.json');
      return JSON.parse(readFileSync(target, 'utf8'));
    },

    /**
     * Write the before-screenshot for a scenario attempt.
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @param {Buffer} data - raw PNG bytes
     */
    writeBeforeScreenshot(sliceId, scenarioId, attempt, data) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'before.png');
      writeFileDirect(target, data);
    },

    /**
     * Write the after-screenshot for a scenario attempt.
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @param {Buffer} data - raw PNG bytes
     */
    writeAfterScreenshot(sliceId, scenarioId, attempt, data) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'after.png');
      writeFileDirect(target, data);
    },

    /**
     * Write scenario execution logs.
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @param {string} content
     */
    writeLogs(sliceId, scenarioId, attempt, content) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'logs.txt');
      writeFileDirect(target, content);
    },

    /**
     * Write scenario precondition/setup logs, separated from scenario logs.
     *
     * @param {string} sliceId
     * @param {string} scenarioId
     * @param {number} attempt
     * @param {string} content
     */
    writeSetupLogs(sliceId, scenarioId, attempt, content) {
      const target = join(attemptDir(repoRoot, sliceId, scenarioId, attempt), 'setup-logs.txt');
      writeFileDirect(target, content);
    },

    /**
     * Write the slice summary to <evidence_root>/summary.json.
     *
     * @param {string} sliceId
     * @param {object} summary
     */
    writeSummary(sliceId, summary) {
      const target = join(sliceEvidenceRoot(repoRoot, sliceId), 'summary.json');
      writeJsonAtomic(target, summary);
    },

    /**
     * Write the scenario list to <evidence_root>/scenarios.json.
     *
     * @param {string} sliceId
     * @param {Array} scenarioList
     */
    writeScenarios(sliceId, scenarioList) {
      const target = join(sliceEvidenceRoot(repoRoot, sliceId), 'scenarios.json');
      writeJsonAtomic(target, scenarioList);
    },

    /**
     * Write app launch metadata to <evidence_root>/launch.json.
     *
     * @param {string} sliceId
     * @param {object} metadata
     */
    writeLaunchMetadata(sliceId, metadata) {
      const target = join(sliceEvidenceRoot(repoRoot, sliceId), 'launch.json');
      writeJsonAtomic(target, metadata);
    },

    /**
     * Prune evidence according to the project retention policy.
     *
     * Algorithm:
     *   1. Compute preserved set: union(failed_fixed, flaky, deferred).
     *   2. If prune_pass_evidence_on_ship: true, delete each scenario directory
     *      whose id is NOT in the preserved set.
     *   3. If prune_pass_evidence_on_ship: false, no-op.
     *   4. Top-level files (summary.json, scenarios.json, launch.json,
     *      log-sources.json) are NEVER pruned regardless of config.
     *
     * @param {string} sliceId
     * @param {object} sliceState - { failed_fixed: string[], flaky: string[], deferred: string[] }
     * @param {object} projectConfig - { prune_pass_evidence_on_ship: boolean }
     */
    pruneOnShip(sliceId, sliceState, projectConfig) {
      if (!projectConfig.prune_pass_evidence_on_ship) {
        return;
      }

      const { failed_fixed = [], flaky = [], deferred = [] } = sliceState;

      // Build the preserved set: union of all three lists.
      const preserved = new Set([...failed_fixed, ...flaky, ...deferred]);

      const root = sliceEvidenceRoot(repoRoot, sliceId);
      if (!existsSync(root)) {
        return;
      }

      // Iterate entries in the evidence root.
      const entries = readdirSync(root, { withFileTypes: true });

      for (const entry of entries) {
        // Never prune top-level protected files.
        if (TOP_LEVEL_PROTECTED.has(entry.name)) {
          continue;
        }

        // Only prune directories (scenario directories are directories).
        if (!entry.isDirectory()) {
          continue;
        }

        // If the scenario id is in the preserved set, keep it.
        if (preserved.has(entry.name)) {
          continue;
        }

        // Prune the scenario directory.
        rmSync(join(root, entry.name), { recursive: true, force: true });
      }
    },
  };
}
