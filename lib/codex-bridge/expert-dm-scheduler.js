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
  if (resumeFromSidecar && drainContext) {
    if (typeof deps.readExpertTurns !== 'function') {
      throw new TypeError(
        'drainPeerDMs: deps.readExpertTurns must be a function when resumeFromSidecar=true'
      );
    }
    try {
      const prior = await deps.readExpertTurns(specPath, drainContext);
      if (Array.isArray(prior)) {
        for (const t of prior) {
          if (!t || typeof t.expert_id !== 'string') continue;
          respawnCounts[t.expert_id] = (respawnCounts[t.expert_id] || 0) + 1;
          totalTurns++;
        }
      }
    } catch (err) {
      if (typeof deps.writeBreadcrumb === 'function') {
        try {
          deps.writeBreadcrumb(
            repoRoot || '',
            'expert-dm-scheduler',
            `readExpertTurns failed during resume: ${err && err.message ? err.message : String(err)}`
          );
        } catch {
          // breadcrumb is best-effort; never bubble up.
        }
      }
      // Continue with fresh counts — best-effort recovery.
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
    let picked = null;
    for (let i = 0; i < activeExperts.length; i++) {
      const idx = (cursor + i) % activeExperts.length;
      const expert = activeExperts[idx];
      if (!expert || typeof expert.id !== 'string') continue;
      const count = respawnCounts[expert.id] || 0;
      if (count >= maxRespawnsPerExpert) continue;
      const unreadCount = await deps.hasUnread(expert.id);
      if (typeof unreadCount === 'number' && unreadCount > 0) {
        picked = { expert, nextCursor: (idx + 1) % activeExperts.length };
        break;
      }
    }

    if (!picked) {
      // No expert has work eligible under caps → drain converged.
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
