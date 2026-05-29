// Plan 3 (reviewer naming migration) — reviewer-archive: halt-reason-driven
// archival policy for reviewer mailboxes. Canonical home for the body that
// previously lived in expert-archive.js (now a shim).
//
// Per spec §Mailbox Archival:
//   - completed / abandoned-by-user → ARCHIVE (drain + rotate the mailbox).
//   - All other recognized halt reasons → PRESERVE (keep mailbox + queued
//     DMs intact for resume / debugging).
//   - Unknown halt reasons → throw ReviewerArchiveError code unknown-halt-reason
//     (no silent skip; the caller must extend the set deliberately).
//
// Records a sidecar-ready archival entry of the shape:
//   { expert_id, status: "archived" | "preserved-for-resume",
//     archive_reason, archived_at }
//
// `ExpertArchiveError` is exported as an alias bound to the SAME class object
// (one-window compatibility): existing `instanceof ExpertArchiveError` checks
// keep working unchanged.

import { archiveAndReset } from './mailbox.js';
import { writeBreadcrumb } from './hook-mailbox-inject.js';

export const HALT_REASONS_ARCHIVE = new Set([
  'completed',
  'abandoned-by-user',
]);

export const HALT_REASONS_PRESERVE = new Set([
  'external-commit-detected',
  'slice-blocker-from-mailbox',
  'expert-blocker-open',
  'expert-peer-dm-drain-cap-exceeded',
  'expert-peer-dm-enqueue-failed',
  'subagent-dispatch-failed',
  'reconcile-failed',
  'validation-failed',
  'user-input-required',
  // v0.9.0 slice 6 — panel mode halt reasons (spec § 4 + § 5).
  'panel-quorum-unavailable',
  'panel-disagreement',
  'panel-quorum-lost',
  'cli-dispatch-failed',
  // v0.9.0 slice 7b — halt-envelope module halt reasons (all PRESERVE-class).
  // These are formalized by halt-envelope.js; extend here so reviewer-archive
  // does not throw unknown-halt-reason for these codes.
  'override-cli-unavailable',
  'override-variant-unknown',
  'panel-config-invalid',
  'codex-blocked',
  'subagent-blocked',
  'codex-needs-context',
  'subagent-needs-context',
  'implementer-directive-malformed',
  'parallel-files-malformed',
  'expert-blocker',
  'role-composer-fan-out-unjustified',
  'transient-network',
  'reconciler-failed',
  'dispatch-retry-eligible',
]);

export class ReviewerArchiveError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ReviewerArchiveError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// One-window compatibility alias — SAME class object.
export { ReviewerArchiveError as ExpertArchiveError };

const realDeps = {
  archiveAndReset,
  writeBreadcrumb,
};

/**
 * Apply the halt-reason archival policy for a single reviewer identity.
 *
 * @param {{id:string}} identity — ReviewerIdentity (only `id` is required).
 * @param {string} haltReason — must be a member of HALT_REASONS_ARCHIVE
 *                              or HALT_REASONS_PRESERVE.
 * @param {object} [deps] — DI seam.
 *   @param {string} deps.repoRoot — required for ARCHIVE reasons (passed
 *                                   through to archiveAndReset). Ignored
 *                                   for PRESERVE reasons.
 *   @param {Function} [deps.archiveAndReset] — defaults to real impl from
 *                                              ./mailbox.js.
 *   @param {Function} [deps.writeBreadcrumb] — defaults to real impl from
 *                                              ./hook-mailbox-inject.js.
 * @returns {Promise<{expert_id:string, status:string, archive_reason:string,
 *                    archived_at:string}>}
 */
export async function archive(identity, haltReason, deps = {}) {
  const d = { ...realDeps, ...deps };

  if (!identity || typeof identity.id !== 'string' || identity.id.length === 0) {
    throw new ReviewerArchiveError(
      'invalid-identity',
      `archive requires a ReviewerIdentity with non-empty id; got ${JSON.stringify(identity)}`
    );
  }
  if (typeof haltReason !== 'string' || haltReason.length === 0) {
    throw new ReviewerArchiveError(
      'invalid-halt-reason',
      `archive requires non-empty haltReason string; got ${JSON.stringify(haltReason)}`
    );
  }

  const archivedAt = new Date().toISOString();

  if (HALT_REASONS_ARCHIVE.has(haltReason)) {
    if (typeof d.repoRoot !== 'string' || d.repoRoot.length === 0) {
      throw new ReviewerArchiveError(
        'missing-repo-root',
        `archive: deps.repoRoot is required for ARCHIVE halt reason "${haltReason}"`
      );
    }
    try {
      await d.archiveAndReset(d.repoRoot, identity.id);
    } catch (err) {
      // Best-effort breadcrumb so operators can audit; re-throw so callers
      // do not silently lose the failure (matches mailbox.js failure model).
      try {
        d.writeBreadcrumb(
          d.repoRoot,
          identity.id,
          `reviewer-archive archiveAndReset failed: ${err.code || err.message}`
        );
      } catch {
        /* breadcrumb best-effort */
      }
      throw err;
    }
    return {
      expert_id: identity.id,
      status: 'archived',
      archive_reason: haltReason,
      archived_at: archivedAt,
    };
  }

  if (HALT_REASONS_PRESERVE.has(haltReason)) {
    return {
      expert_id: identity.id,
      status: 'preserved-for-resume',
      archive_reason: haltReason,
      archived_at: archivedAt,
    };
  }

  throw new ReviewerArchiveError(
    'unknown-halt-reason',
    `archive: halt reason "${haltReason}" not in ARCHIVE or PRESERVE sets ` +
      `(must be one of ${[...HALT_REASONS_ARCHIVE, ...HALT_REASONS_PRESERVE].join(', ')})`,
    { haltReason }
  );
}
