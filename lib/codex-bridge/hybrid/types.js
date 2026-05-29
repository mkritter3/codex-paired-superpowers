// Slice 6 — hybrid runtime witness (spec §11).
//
// Pins the ACTUAL runtime kinds a hybrid run dispatches, distinct from the plan's
// logical owner adapters (claude-ui / codex-background-bash). The UI owner's logical
// `claude-ui` resolves to `claude-inline` (interactive foreground) or `claude-subagent`
// (autopilot worktree); the backend owner runs as `codex-background-bash` in both modes.
//
// The implementer-experts runtime witness (implementer/types.js) is intentionally left
// unchanged — hybrid is an additive runtime surface, not a replacement.

/** The three actual hybrid runtime kinds. */
export const HYBRID_RUNTIME_KINDS = Object.freeze(['claude-inline', 'claude-subagent', 'codex-background-bash']);

/**
 * Runtime witness for tests (JSDoc typedefs are erased at runtime). Mirrors the
 * implementer-experts `__shapesForTests` convention.
 */
export const __hybridShapesForTests = {
  runtimeKindMembers: ['claude-inline', 'claude-subagent', 'codex-background-bash'],
};
