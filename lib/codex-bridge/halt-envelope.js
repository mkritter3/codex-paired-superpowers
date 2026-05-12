// v0.9.0 halt-envelope — structured halt return shape for autopilot and ralph-loop.
//
// Every autopilot run ends by calling wrapAsHaltEnvelope(reason, context) and
// returning the result. Ralph-loop reads `terminal: true` and exits cleanly
// with the `resume_hint`; `terminal: false` means a transient condition and
// ralph re-fires after a short delay.
//
// Fail-closed policy (per spec § 5):
//   - Terminal (operator must act): the vast majority of halt reasons.
//     Ralph-loop MUST NOT re-fire on a terminal halt.
//   - Transient (retry eligible): a short list of conditions where re-firing
//     is safe and likely to succeed (doctor + retry).
//   - Unknown halt reason → terminal: true with an explicit "unknown halt —
//     operator triage" hint. NEVER default to transient on unknown input.

/** @type {Map<string, {terminal: boolean, resume_hint: string}>} */
const HALT_MAP = new Map([
  // ── Terminal halts — operator must act ──────────────────────────────────────
  [
    'user-input-required',
    {
      terminal: true,
      resume_hint:
        'Autopilot needs user input before it can continue. Answer the question in the sidecar, then re-run /autopilot.',
    },
  ],
  [
    'panel-disagreement',
    {
      terminal: true,
      resume_hint:
        'Expert panel could not reach consensus. Review panel findings in the sidecar and resolve the disagreement, then re-run /autopilot.',
    },
  ],
  [
    'panel-quorum-unavailable',
    {
      terminal: true,
      resume_hint:
        'Panel could not meet minimum size at config time. Run /codex-paired-superpowers:doctor to check CLI availability, then re-run /autopilot.',
    },
  ],
  [
    'cli-dispatch-failed',
    {
      terminal: true,
      resume_hint:
        'No available CLI adapter found for a required reviewer role. Run /codex-paired-superpowers:doctor to diagnose, then re-run /autopilot.',
    },
  ],
  [
    'override-cli-unavailable',
    {
      terminal: true,
      resume_hint:
        'The CLI override specified is not available. Run /codex-paired-superpowers:doctor and check your role-routing config.',
    },
  ],
  [
    'override-variant-unknown',
    {
      terminal: true,
      resume_hint:
        'The CLI variant requested in the override is not recognized. Check your role-routing config for typos.',
    },
  ],
  [
    'panel-config-invalid',
    {
      terminal: true,
      resume_hint:
        'Panel configuration is invalid (e.g., max_size < min_size). Fix the panel config in your project config, then re-run /autopilot.',
    },
  ],
  [
    'codex-blocked',
    {
      terminal: true,
      resume_hint:
        'Codex implementer reported BLOCKED. Review the subagent output in the sidecar, resolve the blocker, then re-run /autopilot.',
    },
  ],
  [
    'subagent-blocked',
    {
      terminal: true,
      resume_hint:
        'Sonnet implementer reported BLOCKED. Review the subagent output in the sidecar, resolve the blocker, then re-run /autopilot.',
    },
  ],
  [
    'codex-needs-context',
    {
      terminal: true,
      resume_hint:
        'Codex implementer reported NEEDS_CONTEXT. Supply the missing context described in the subagent output, then re-run /autopilot.',
    },
  ],
  [
    'subagent-needs-context',
    {
      terminal: true,
      resume_hint:
        'Sonnet implementer reported NEEDS_CONTEXT. Supply the missing context described in the subagent output, then re-run /autopilot.',
    },
  ],
  [
    'implementer-directive-malformed',
    {
      terminal: true,
      resume_hint:
        'The **Implementer:** directive in the slice is malformed. Fix the directive in the plan, then re-run /autopilot.',
    },
  ],
  [
    'parallel-files-malformed',
    {
      terminal: true,
      resume_hint:
        'A slice\'s **Files:** block is malformed. Fix the file paths in the plan, then re-run /autopilot.',
    },
  ],
  [
    'expert-blocker',
    {
      terminal: true,
      resume_hint:
        'An expert raised a blocking finding. Review the finding in the sidecar, resolve or override it, then re-run /autopilot.',
    },
  ],
  [
    'role-composer-fan-out-unjustified',
    {
      terminal: true,
      resume_hint:
        'The role composer produced an unjustified fan-out. Review the composer output and adjust your panel or expert config, then re-run /autopilot.',
    },
  ],

  // ── Transient halts — safe to retry ─────────────────────────────────────────
  [
    'panel-quorum-lost',
    {
      terminal: false,
      resume_hint:
        'A panel member dropped mid-round. Run /codex-paired-superpowers:doctor to confirm CLI availability, then re-fire to retry.',
    },
  ],
  [
    'transient-network',
    {
      terminal: false,
      resume_hint:
        'A transient network error was detected. Wait a moment and re-fire autopilot to retry.',
    },
  ],
  [
    'reconciler-failed',
    {
      terminal: false,
      resume_hint:
        'The worktree reconciler failed. This is usually transient. Re-fire autopilot to retry once; if it persists, inspect the worktree manually.',
    },
  ],
  [
    'dispatch-retry-eligible',
    {
      terminal: false,
      resume_hint:
        'A dispatch failure was flagged as retry-eligible. Re-fire autopilot to retry.',
    },
  ],
]);

/**
 * Wrap a halt reason into the structured envelope that ralph-loop reads.
 *
 * @param {string} reason  — halt reason string (e.g. "user-input-required")
 * @param {object} [context] — optional extra fields merged into the envelope
 *   (e.g. { resolvedCLI: 'codex', sliceId: 'slice-3' })
 * @returns {{halt: string, terminal: boolean, resume_hint: string, [key: string]: unknown}}
 */
export function wrapAsHaltEnvelope(reason, context = {}) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError(
      `wrapAsHaltEnvelope: reason must be a non-empty string; got ${JSON.stringify(reason)}`
    );
  }

  const entry = HALT_MAP.get(reason);

  if (entry) {
    return {
      halt: reason,
      terminal: entry.terminal,
      resume_hint: entry.resume_hint,
      ...context,
    };
  }

  // Fail-closed: unknown halt reasons are always terminal.
  return {
    halt: reason,
    terminal: true,
    resume_hint:
      `Unknown halt reason "${reason}" — operator triage required. ` +
      'Check the sidecar for details; this halt reason is not in the known set.',
    ...context,
  };
}

/**
 * Convenience: check if an envelope is terminal (ralph-loop exit guard).
 *
 * @param {{terminal: boolean}} envelope
 * @returns {boolean}
 */
export function isTerminalHalt(envelope) {
  return envelope !== null &&
    typeof envelope === 'object' &&
    envelope.terminal === true;
}

// Re-export the full mapping table for snapshot tests and documentation.
export { HALT_MAP };
