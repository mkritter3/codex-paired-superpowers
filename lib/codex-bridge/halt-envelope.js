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
  // `reconciler-failed` covers git failure: bad SHA, broken worktree,
  // post-reconcile cleanup. Per autopilot/SKILL.md §B.5: "the worktree is
  // unreliable" — automatic retry is not safe (Codex round-1 slice-7b
  // finding #2). Treat as terminal; operator must inspect the worktree.
  [
    'reconciler-failed',
    {
      terminal: true,
      resume_hint:
        'The worktree reconciler failed — the worktree may be in an inconsistent state. Inspect the worktree manually (bad SHA, broken work tree, stale lockfile), recover or remove it, then re-run /autopilot.',
    },
  ],

  // ── v0.10.0 implementer-experts terminal halts ──────────────────────────────

  [
    'implementer-cap-exceeded',
    {
      terminal: true,
      resume_hint:
        'The implementers block has 4-5 members without high_cost: true. ' +
        'Add `high_cost: true` and a non-empty `high_cost_rationale` to the plan frontmatter, then re-run /autopilot.',
    },
  ],
  [
    'implementer-high-cost-rationale-missing',
    {
      terminal: true,
      resume_hint:
        'high_cost: true is set but high_cost_rationale is empty. ' +
        'Provide a concrete non-empty rationale in the plan frontmatter, then re-run /autopilot.',
    },
  ],
  [
    'implementer-member-id-invalid',
    {
      terminal: true,
      resume_hint:
        'One or more member_id values in the Implementers block are invalid or duplicated. ' +
        'Fix the member_id strings in the plan (format: <role>@<cli_kind>:<model>#<ordinal>), then re-run /autopilot.',
    },
  ],
  [
    'implementer-claimed-files-missing',
    {
      terminal: true,
      resume_hint:
        'An implementer has no claimed files, or overlapping files lack overlap_rationale. ' +
        'Add a `files:` list to every implementer entry and add overlap_rationale where files overlap, then re-run /autopilot.',
    },
  ],
  [
    'implementer-claimed-file-violation',
    {
      terminal: true,
      resume_hint:
        'An implementer edited a file outside its claimed file partition. ' +
        'Review the diff and the claimed files list in the plan; either update claimed files or revert the out-of-scope edit, then re-run /autopilot.',
    },
  ],
  [
    'implementer-required-child-failed',
    {
      terminal: true,
      resume_hint:
        'A required implementer failed. Review the implementer output in the sidecar, resolve the failure, then re-run /autopilot.',
    },
  ],
  [
    'codex-cli-blocked',
    {
      terminal: true,
      resume_hint:
        'Codex CLI returned a blocked output sentinel. Check the implementer sandbox permissions and the blocked-output log in the sidecar, then re-run /autopilot.',
    },
  ],
  [
    'claude-cli-protocol-unsupported',
    {
      terminal: true,
      resume_hint:
        'The installed Claude CLI does not support the expected machine-readable stream/result protocol. ' +
        'Upgrade the Claude CLI to a version that supports the protocol, then re-run /autopilot.',
    },
  ],
  [
    'claude-cli-auth-missing',
    {
      terminal: true,
      resume_hint:
        'No auth token was found for the Claude CLI route (checked keychain + env). ' +
        'Set OLLAMA_CLOUD_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment, then re-run /autopilot.',
    },
  ],
  [
    'claude-cli-auth-rejected',
    {
      terminal: true,
      resume_hint:
        'The Claude CLI auth token was rejected (401 or equivalent). ' +
        'Verify the token is valid for the configured route, then re-run /autopilot.',
    },
  ],
  [
    'ollama-cloud-route-invalid',
    {
      terminal: true,
      resume_hint:
        'The Ollama Cloud route configuration is invalid (bad URL or missing route config). ' +
        'Check the provider config in your project settings, then re-run /autopilot.',
    },
  ],
  [
    'mailbox-delivery-failed',
    {
      terminal: true,
      resume_hint:
        'A mailbox message could not be delivered to an implementer. ' +
        'Check the mailbox state under .codex-paired/mailboxes/ and the sidecar events for details, then re-run /autopilot.',
    },
  ],
  [
    'worktree-create-failed',
    {
      terminal: true,
      resume_hint:
        'Failed to create an implementer git worktree (branch collision or git error). ' +
        'Remove the conflicting branch or worktree under .codex-paired/worktrees/, then re-run /autopilot.',
    },
  ],
  [
    'worktree-dirty-before-dispatch',
    {
      terminal: true,
      resume_hint:
        'An implementer worktree target directory is dirty before dispatch. ' +
        'Clean or remove the dirty directory under .codex-paired/worktrees/, then re-run /autopilot.',
    },
  ],
  [
    'merge-conflict-double-ship-failed',
    {
      terminal: true,
      resume_hint:
        'The merger agent resolved a conflict but the double-SHIP review returned REVISE. ' +
        'Review the merger output and reviewer findings in the sidecar, resolve or override, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-revise',
    {
      terminal: true,
      resume_hint:
        'Post-merge paired review returned REVISE. ' +
        'Review the reviewer findings in the sidecar, address the issues, then re-run /autopilot.',
    },
  ],
  [
    'sidecar-replay-concurrent-order-invalid',
    {
      terminal: true,
      resume_hint:
        'The sidecar implementer event sequence has a gap or out-of-order event_seq. ' +
        'Inspect the sidecar for corruption; do not manually edit event_seq values. Contact the operator.',
    },
  ],
  // `merger-out-of-scope` introduced by slice 8 but pinned here in slice 1 so
  // the isTerminalHalt known-set invariant covers it from day 1.
  [
    'merger-out-of-scope',
    {
      terminal: true,
      resume_hint:
        'The merger agent edited a file outside the allowed conflict-resolution scope. ' +
        'Review the out-of-scope edits in the sidecar, revert or justify them, then re-run /autopilot.',
    },
  ],

  // ── v0.10.0 slice-7 merge coordinator terminal halts ───────────────────────

  [
    'merge-conflict',
    {
      terminal: true,
      resume_hint:
        'One or more implementer branches conflict during merge. Dispatch the slice-8 merger agent to resolve the conflict, or manually resolve and re-run /autopilot.',
    },
  ],
  [
    'merge-integration-dirty',
    {
      terminal: true,
      resume_hint:
        'The integration worktree has uncommitted changes. Run `git status` in the integration worktree, stash or commit the changes, then re-run /autopilot.',
    },
  ],
  [
    'merge-integration-busy',
    {
      terminal: true,
      resume_hint:
        'Another merge-coordinator instance holds the integration lock. Wait for it to complete or remove the stale lock file under .codex-paired/, then re-run /autopilot.',
    },
  ],
  [
    'merge-integration-not-a-git-repo',
    {
      terminal: true,
      resume_hint:
        'The integration worktree path is not inside a git repository. Verify the integrationWorktree path and ensure it was created with `git worktree add`, then re-run /autopilot.',
    },
  ],
  [
    'merge-branch-unknown',
    {
      terminal: true,
      resume_hint:
        'An implementer branch name does not resolve to a commit. Verify the branch exists in the repo (run `git branch --list`), then re-run /autopilot.',
    },
  ],
  [
    'merge-git-failure',
    {
      terminal: true,
      resume_hint:
        'A git command failed during merge coordination. Check the diagnostic field in the sidecar event for the git stderr output, resolve the git issue, then re-run /autopilot.',
    },
  ],
  [
    'merge-commit-failed',
    {
      terminal: true,
      resume_hint:
        'The `git commit` command failed after a clean merge. Check for empty merge, commit hooks, or git config issues in the integration worktree, then re-run /autopilot.',
    },
  ],
  [
    'merge-audit-divergence',
    {
      terminal: true,
      resume_hint:
        'The git commit succeeded but sidecar audit (merge_resolved event) failed after retry. The integration branch has the commit but the sidecar is missing the audit record. Manually reconcile by inspecting the integration branch and appending the missing merge_resolved event to the sidecar, then re-run /autopilot.',
    },
  ],

  // ── v0.10.0 slice-3 retroactive worktree halt codes ─────────────────────────
  // Slice 3 referenced these halt codes in tests/production code but they were
  // never registered in HALT_MAP. Registering them here (slice 7) to satisfy
  // the known-set invariant.

  [
    'worktree-path-escape',
    {
      terminal: true,
      resume_hint:
        'A computed implementer worktree path escaped the allowed worktrees root directory. This is a path traversal guard violation. Check the member_id slug for unexpected characters, then re-run /autopilot.',
    },
  ],
  [
    'worktree-path-conflict',
    {
      terminal: true,
      resume_hint:
        'A pre-existing file or symlink exists at the target worktree path. Remove or rename the conflicting path under .codex-paired/worktrees/, then re-run /autopilot.',
    },
  ],
  [
    'worktree-not-a-git-repo',
    {
      terminal: true,
      resume_hint:
        'The repoRoot passed to worktree fan-out is not a git repository. Verify the repoRoot path and ensure it contains a .git directory, then re-run /autopilot.',
    },
  ],

  // ── v0.10.0 slice-8 merger-agent terminal halts ────────────────────────────

  [
    'merger-integration-not-a-git-repo',
    {
      terminal: true,
      resume_hint:
        'The merger agent could not find a git repository at the integration worktree path. ' +
        'Verify the integrationWorktree path is a valid git worktree, then re-run /autopilot.',
    },
  ],
  [
    'merger-integration-busy',
    {
      terminal: true,
      resume_hint:
        'Another merger-agent instance holds the integration lock. ' +
        'Wait for it to complete or remove the stale lock file under .codex-paired/, then re-run /autopilot.',
    },
  ],
  [
    'merger-conflict-state-mismatch',
    {
      terminal: true,
      resume_hint:
        'The set of unmerged (conflicted) files in the integration worktree does not match the conflictedFiles argument. ' +
        'Verify the conflict state with `git diff --name-only --diff-filter=U` in the integration worktree, then re-run /autopilot.',
    },
  ],
  [
    'merger-prompt-too-large',
    {
      terminal: true,
      resume_hint:
        'The merger prompt exceeds the configured byte cap. ' +
        'Reduce the size of conflictDiffs or increase promptByteCap, then re-run /autopilot.',
    },
  ],
  [
    'merger-dispatch-failed',
    {
      terminal: true,
      resume_hint:
        'The merger agent dispatch failed or returned a non-completed outcome. ' +
        'Check the merger agent output in the sidecar and the dispatchFn implementation, then re-run /autopilot.',
    },
  ],
  [
    'merger-unresolved-conflicts',
    {
      terminal: true,
      resume_hint:
        'The merger agent left conflict markers in one or more files, or the git index still has unmerged paths. ' +
        'Review the merger output in the sidecar, manually resolve the remaining conflicts, then re-run /autopilot.',
    },
  ],
  [
    'merge-review-malformed',
    {
      terminal: true,
      resume_hint:
        'A reviewer returned a malformed verdict (not exactly "SHIP" or "REVISE") or an empty rationale. ' +
        'Review the reviewer output in the sidecar, fix the reviewer implementation, then re-run /autopilot.',
    },
  ],
  [
    'merge-review-dispatch-failed',
    {
      terminal: true,
      resume_hint:
        'One or both merge reviewers threw an error during the double-SHIP review. ' +
        'Check the reviewer output in the sidecar and the reviewer function implementations, then re-run /autopilot.',
    },
  ],
  [
    'merger-commit-failed',
    {
      terminal: true,
      resume_hint:
        'The `git commit` command failed after a successful double-SHIP review. ' +
        'Check for empty commit, commit hooks, or git config issues in the integration worktree, then re-run /autopilot.',
    },
  ],
  [
    'merger-audit-divergence',
    {
      terminal: true,
      resume_hint:
        'The merger commit succeeded but the post-commit sidecar audit event failed after retry. ' +
        'The integration branch has the commit but the sidecar is missing the audit record. ' +
        'Manually append the missing merger_completed (outcome: committed) event to the sidecar, then re-run /autopilot.',
    },
  ],

  // ── v0.10.0 slice-9 post-merge-review terminal halts ──────────────────────

  [
    'post-merge-review-malformed',
    {
      terminal: true,
      resume_hint:
        'A post-merge reviewer returned a malformed verdict (not exactly "SHIP" or "REVISE"), an empty rationale, or a shape missing required fields. ' +
        'Review the reviewer output in the sidecar, fix the reviewer implementation, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-prompt-too-large',
    {
      terminal: true,
      resume_hint:
        'The post-merge review prompt exceeds the configured byte cap (promptByteCap). ' +
        'Reduce the size of mergedDiff or slicePlan, or increase promptByteCap, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-audit-divergence',
    {
      terminal: true,
      resume_hint:
        'The post-merge review completed but the sidecar audit event (post_merge_review) failed after retry. ' +
        'The review outcome is known but the sidecar is missing the audit record. ' +
        'Manually append the missing post_merge_review event to the sidecar, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-degraded-quorum',
    {
      terminal: true,
      resume_hint:
        'The post-merge review panel did not achieve a full 2-of-2 quorum (timeout or member rejection). ' +
        'Check reviewer availability and the sidecar for details, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-quorum-failed',
    {
      terminal: true,
      resume_hint:
        'The post-merge review panel could not meet minimum size at dispatch time (panel-quorum-unavailable). ' +
        'Run /codex-paired-superpowers:doctor to check CLI availability, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-panel-error',
    {
      terminal: true,
      resume_hint:
        'The post-merge review panel dispatcher returned an unexpected error. ' +
        'Check the diagnostic field in the sidecar event for details, then re-run /autopilot.',
    },
  ],
  [
    'post-merge-review-config-invalid',
    {
      terminal: true,
      resume_hint:
        'The post-merge review panel configuration is invalid (e.g., max_size < min_size). ' +
        'Fix the panel config in your project config, then re-run /autopilot.',
    },
  ],

  // ── v0.14.0 hybrid dev-mode terminal halts ──────────────────────────────────
  // Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §6, §7, §10.
  // All hybrid-* halts are terminal. `hybrid-contract-changed` is deliberately
  // NOT registered: it is an in-progress sidecar/mailbox resync state (§10), not
  // a halt — the only terminal contract-change outcome is
  // `hybrid-contract-stale-at-completion`.

  [
    'hybrid-ownership-malformed',
    {
      terminal: true,
      resume_hint:
        'A hybrid slice has invalid or ambiguous owner declarations (missing, duplicate, optional, or unknown owners). ' +
        'Fix the claude-ui / codex-backend owner declarations in the plan, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-owner-files-overlap',
    {
      terminal: true,
      resume_hint:
        'The two owners\' file sets overlap without an overlap_rationale. ' +
        'Either de-overlap the claude-ui and codex-backend file lists or add an overlap_rationale in the plan, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-owner-files-unclaimed',
    {
      terminal: true,
      resume_hint:
        'The slice **Files:** block and the owner claimed files do not match (an unclaimed file, or an owner file not in the slice Files block, or a ui_shim_file outside claude-ui.files). ' +
        'Reconcile the slice Files block with the owner claimed files, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-preflight-dirty',
    {
      terminal: true,
      resume_hint:
        'The interactive foreground checkout is dirty before dispatch. ' +
        'Commit or stash the working-tree changes, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-dispatcher-invalid',
    {
      terminal: true,
      resume_hint:
        'A required registry transport or contract doc is missing for the hybrid slice. ' +
        'Run /codex-paired-superpowers:doctor to check transport availability and verify the contract doc path, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-contract-not-published',
    {
      terminal: true,
      resume_hint:
        'The backend owner completed without publishing a contract. ' +
        'The backend owner must publish a contract message before the UI can finish — review the backend output in the sidecar, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-contract-not-consumed',
    {
      terminal: true,
      resume_hint:
        'The UI owner completed without consuming the latest contract hash. ' +
        'The UI owner must consume the latest contract hash and update the shim/code, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-contract-stale-at-completion',
    {
      terminal: true,
      resume_hint:
        'The UI owner completed against an older contract hash after the backend published a newer version. ' +
        'Consume the latest contract and update the shim, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-codex-backend-failed',
    {
      terminal: true,
      resume_hint:
        'The background Codex backend exited with a nonzero status or a blocked sentinel. ' +
        'Inspect the backend output and status file in the sidecar, fix the underlying failure, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-codex-background-lost',
    {
      terminal: true,
      resume_hint:
        'The background Codex status file is missing and the Bash task is no longer known alive. ' +
        'Inspect the sidecar task id and status path, clean stale worktree state, then re-run the hybrid slice.',
    },
  ],
  [
    'hybrid-codex-background-timeout',
    {
      terminal: true,
      resume_hint:
        'The background Codex backend exceeded hybrid.codex_max_runtime_ms and was killed best-effort. ' +
        'Inspect why it ran long; raise the runtime limit only with rationale, then re-run hybrid mode.',
    },
  ],
  [
    'hybrid-contract-realization-mismatch',
    {
      terminal: true,
      resume_hint:
        'After integration, the real backend contract exports do not match the consumed shim shape. ' +
        'Fix either the backend contract implementation or the UI shim, then re-run verification.',
    },
  ],

  // ── Unified execution driver — split-dispatcher terminal halts ───────────────
  // Spec authority: docs/specs/2026-05-29-unified-execution-driver-design.md
  // §"Split directive". All split-* halts are terminal: a malformed split
  // declaration is an operator authoring error, not a transient condition.
  [
    'split-single-with-implementers',
    {
      terminal: true,
      resume_hint:
        'A slice declares **Split:** single but also has an implementers/hybrid owner block (or an orchestration-hybrid marker). ' +
        'Remove the block/marker or change the split, then re-run.',
    },
  ],
  [
    'split-two-disjoint-not-exactly-two',
    {
      terminal: true,
      resume_hint:
        'A **Split:** two-disjoint slice must declare exactly two implementers. ' +
        'Use exactly two, or drop **Split:** to use the legacy N-member path.',
    },
  ],
  [
    'split-directive-unknown',
    {
      terminal: true,
      resume_hint:
        'The **Split:** value must be single, two-disjoint, or hybrid-ui-backend. Fix the directive, then re-run.',
    },
  ],
  [
    'split-unknown-driver',
    {
      terminal: true,
      resume_hint:
        "The execution driver must be 'interactive' or 'autopilot'. Fix the driver argument, then re-run.",
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
    // Context spread FIRST so it cannot override the canonical halt fields.
    // If a caller passed {terminal: false} alongside a terminal halt reason,
    // we would silently flip ralph-loop into a retry loop (Codex round-1
    // slice-7b finding #1). The canonical {halt, terminal, resume_hint} are
    // load-bearing for ralph-loop's exit guard — they must always win.
    return {
      ...context,
      halt: reason,
      terminal: entry.terminal,
      resume_hint: entry.resume_hint,
    };
  }

  // Fail-closed: unknown halt reasons are always terminal. Same override-safe
  // spread order.
  return {
    ...context,
    halt: reason,
    terminal: true,
    resume_hint:
      `Unknown halt reason "${reason}" — operator triage required. ` +
      'Check the sidecar for details; this halt reason is not in the known set.',
  };
}

/**
 * Convenience: check if an envelope is terminal (ralph-loop exit guard).
 *
 * Strict fail-closed: anything that is not a well-formed envelope describing
 * a known-transient halt is treated as terminal. This is ralph-loop's
 * load-bearing safety boundary — the guard cannot rely on callers using
 * `wrapAsHaltEnvelope` correctly (Codex round-2 slice-7b finding #1).
 *
 * Returns false (i.e. ralph-loop MAY retry) only when ALL of these hold:
 *   - envelope is a non-null object
 *   - envelope.terminal === false (strict boolean)
 *   - envelope.halt is a non-empty string AND is registered in HALT_MAP
 *     as transient (`HALT_MAP.get(halt)?.terminal === false`)
 *   - envelope.resume_hint is a non-empty string
 *
 * Anything else returns true — malformed envelope, unknown halt reason
 * claiming transient, halt reason registered as terminal claiming transient.
 *
 * @param {{terminal?: boolean, halt?: string, resume_hint?: string} | null | undefined} envelope
 * @returns {boolean} true if ralph-loop must NOT re-fire.
 */
export function isTerminalHalt(envelope) {
  if (envelope === null || envelope === undefined) return true;
  if (typeof envelope !== 'object') return true;
  // Only the explicit `terminal === false` form means "transient candidate".
  if (envelope.terminal !== false) return true;
  // Validate envelope shape before consulting the registry.
  if (typeof envelope.halt !== 'string' || envelope.halt.length === 0) return true;
  if (typeof envelope.resume_hint !== 'string' || envelope.resume_hint.length === 0) return true;
  // Known-set invariant: the halt reason MUST be registered in HALT_MAP
  // as transient. An unknown halt (or one registered as terminal) with a
  // hand-crafted `terminal: false` field MUST NOT be retried (round-2 fix).
  const entry = HALT_MAP.get(envelope.halt);
  if (!entry) return true;            // unknown halt reason → terminal
  if (entry.terminal !== false) return true; // registered as terminal → terminal
  return false;
}

// Re-export the full mapping table for snapshot tests and documentation.
export { HALT_MAP };
