// v0.8.0 slice 5 — peer DM drain loop for the domain-experts runtime.
//
// Scheduler detects unread DMs across active experts and delegates each
// turn to runTurn (slice 4), which owns the full read→parse→mark-read
// cycle. Scheduler is sidecar-READ-ONLY (no append); runTurn owns appends.
//
// Loop bounds: maxRespawnsPerExpert (default 2), maxTotalTurns (default 8).
// On cap-exceeded: returns halt: "expert-peer-dm-drain-cap-exceeded".
// On restart: opts.resumeFromSidecar reads prior turns via deps.readExpertTurns
// to populate cap-counts without double-counting.
//
// Public API:
//   drainPeerDMs(activeExperts, deps, opts) → {turns, halt}
//
// deps shape:
//   hasUnread(expertId): Promise<number>
//   runTurn(expert, drainContext): Promise<TurnResult>
//   readExpertTurns(specPath, {phase, sliceId}): Promise<Turn[]>
//   writeBreadcrumb(repoRoot, slice, msg): void   (optional, best-effort)
//
// opts shape:
//   maxRespawnsPerExpert: 2 (default)
//   maxTotalTurns: 8 (default)
//   specPath: string
//   drainContext: { phase: string, sliceId?: string }   REQUIRED for restart
//   resumeFromSidecar: boolean (default false)
//   repoRoot: string                                    (optional, breadcrumbs)

const DEFAULT_MAX_RESPAWNS_PER_EXPERT = 2;
const DEFAULT_MAX_TOTAL_TURNS = 8;

export async function drainPeerDMs(activeExperts, deps, opts = {}) {
  if (!Array.isArray(activeExperts)) {
    throw new TypeError('drainPeerDMs: activeExperts must be an array');
  }
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('drainPeerDMs: deps must be an object');
  }
  if (typeof deps.hasUnread !== 'function') {
    throw new TypeError('drainPeerDMs: deps.hasUnread must be a function');
  }
  if (typeof deps.runTurn !== 'function') {
    throw new TypeError('drainPeerDMs: deps.runTurn must be a function');
  }

  const maxRespawnsPerExpert = opts.maxRespawnsPerExpert ?? DEFAULT_MAX_RESPAWNS_PER_EXPERT;
  const maxTotalTurns = opts.maxTotalTurns ?? DEFAULT_MAX_TOTAL_TURNS;
  const { specPath, drainContext, resumeFromSidecar, repoRoot } = opts;

  const respawnCounts = Object.create(null);
  let totalTurns = 0;
  const turns = [];

  // 1. Restart-recovery: load prior turns and seed cap-counts.
  //
  // Restart-recovery MUST fail closed (Codex slice-review round-1 critique).
  // Silently continuing with fresh counts when drainContext is missing or
  // readExpertTurns fails would defeat cap-tracking — the scheduler could
  // double-spawn experts already at cap from a prior session, dispatching
  // work that the spec explicitly halts.
  if (resumeFromSidecar) {
    if (!drainContext || typeof drainContext !== 'object') {
      throw new Error(
        'drainPeerDMs: opts.drainContext is REQUIRED when opts.resumeFromSidecar=true (cannot fail open — would defeat cap-tracking across restart)'
      );
    }
    if (typeof drainContext.phase !== 'string' || drainContext.phase.length === 0) {
      throw new Error(
        'drainPeerDMs: opts.drainContext.phase must be a non-empty string when resumeFromSidecar=true'
      );
    }
    if (typeof deps.readExpertTurns !== 'function') {
      throw new TypeError(
        'drainPeerDMs: deps.readExpertTurns must be a function when resumeFromSidecar=true'
      );
    }
    // Throw on readExpertTurns failure. Breadcrumb-and-continue would let
    // post-restart caps reset to zero and double-spawn experts already
    // capped from prior turns. Fail closed and let the orchestrator decide
    // whether to abort or proceed without resume.
    let prior;
    try {
      prior = await deps.readExpertTurns(specPath, drainContext);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (typeof deps.writeBreadcrumb === 'function') {
        try {
          deps.writeBreadcrumb(
            repoRoot || '',
            'expert-dm-scheduler',
            `readExpertTurns failed during resume (fail-closed): ${msg}`
          );
        } catch {
          // breadcrumb is best-effort
        }
      }
      throw new Error(
        `drainPeerDMs: readExpertTurns failed during restart-recovery; refusing to fail open (would double-spawn capped experts). Original: ${msg}`
      );
    }
    if (!Array.isArray(prior)) {
      throw new Error(
        `drainPeerDMs: readExpertTurns returned non-array (${typeof prior}); cannot seed cap counts safely`
      );
    }
    for (const t of prior) {
      if (!t || typeof t.expert_id !== 'string') continue;
      respawnCounts[t.expert_id] = (respawnCounts[t.expert_id] || 0) + 1;
      totalTurns++;
    }
  }

  if (activeExperts.length === 0) {
    return { turns, halt: null };
  }

  // 2. Main loop: round-robin across activeExperts.
  let cursor = 0;
  while (true) {
    // Total-turn cap check first.
    if (totalTurns >= maxTotalTurns) {
      return { turns, halt: 'expert-peer-dm-drain-cap-exceeded' };
    }

    // Pick next eligible expert (under cap + has unread). Round-robin from cursor.
    // Also track whether any expert that's currently capped still has unread —
    // if yes, drain has NOT converged; it's exhausted the cap with work remaining.
    let picked = null;
    let cappedWithUnread = false; // ← detects "queued DMs remain after cap"
    for (let i = 0; i < activeExperts.length; i++) {
      const idx = (cursor + i) % activeExperts.length;
      const expert = activeExperts[idx];
      if (!expert || typeof expert.id !== 'string') continue;
      const count = respawnCounts[expert.id] || 0;
      const unreadCount = await deps.hasUnread(expert.id);
      const hasUnread = typeof unreadCount === 'number' && unreadCount > 0;
      if (count >= maxRespawnsPerExpert) {
        if (hasUnread) cappedWithUnread = true;
        continue;
      }
      if (hasUnread && !picked) {
        picked = { expert, nextCursor: (idx + 1) % activeExperts.length };
        // Don't break — keep scanning to detect cappedWithUnread across the
        // remaining experts. (Inexpensive: activeExperts is typically ≤ 5.)
      }
    }

    if (!picked) {
      // No eligible (under-cap + unread) expert. Two cases:
      //  - cappedWithUnread === true: queued DMs remain but caps are
      //    exhausted. Per spec §B.5.5: record `expert-peer-dm-drain-cap-exceeded`.
      //  - cappedWithUnread === false: genuine convergence (all inboxes empty
      //    or only capped experts have empty inboxes). Clean exit.
      if (cappedWithUnread) {
        return { turns, halt: 'expert-peer-dm-drain-cap-exceeded' };
      }
      return { turns, halt: null };
    }

    // Dispatch turn (runTurn owns read/mark-read/sidecar-append internally).
    const result = await deps.runTurn(picked.expert, drainContext);
    turns.push(result);
    respawnCounts[picked.expert.id] = (respawnCounts[picked.expert.id] || 0) + 1;
    totalTurns++;
    cursor = picked.nextCursor;
  }
}
