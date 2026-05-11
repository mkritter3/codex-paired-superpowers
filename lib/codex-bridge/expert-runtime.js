// v0.8.0 expert-runtime — facade module exposing the 5-method TeammateRuntime
// interface defined in the spec (§Native Agent-Teams Compatibility). The
// facade aliases each method to its existing implementation so future Anthropic
// Agent-Teams adoption can swap the facade transparently.

import { readUnreadMessages } from './mailbox.js';

export { resolveIdentity } from './expert-resolver.js';
export { composeExperts as selectTeammates } from './role-composer.js';
export { runTurn } from './expert-turn.js';

/**
 * Read unread messages addressed to the given expert identity.
 *
 * @param {string} repoRoot
 * @param {{id:string}} identity
 * @returns {Promise<object[]>}
 */
export async function pollInbox(repoRoot, identity) {
  return await readUnreadMessages(repoRoot, identity.id);
}

/**
 * Archive an expert per the lifecycle policy.
 *
 * Slice 4 stub: returns a structured record so callers can be wired and
 * tested. Slice 7 replaces this with the real archive-policy implementation
 * (mailbox archive + sidecar status transition to "archived" + audit trail).
 *
 * @param {{id:string}} identity
 * @param {string} haltReason — caller-supplied reason (e.g. "phase-advanced",
 *                              "manual-drop", "fan-out-cap")
 * @returns {Promise<{stubbed:boolean, identity:string, haltReason:string}>}
 */
export async function archive(identity, haltReason) {
  return { stubbed: true, identity: identity.id, haltReason };
}
