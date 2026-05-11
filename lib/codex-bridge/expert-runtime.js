// v0.8.0 expert-runtime — facade module exposing the 5-method TeammateRuntime
// interface defined in the spec (§Native Agent-Teams Compatibility). The
// facade aliases each method to its existing implementation so future Anthropic
// Agent-Teams adoption can swap the facade transparently.

import { readUnreadMessages } from './mailbox.js';

export { resolveIdentity } from './expert-resolver.js';
export { composeExperts as selectTeammates } from './role-composer.js';
export { runTurn } from './expert-turn.js';
// Slice 7: real archive impl replaces the slice 4 stub.
export { archive } from './expert-archive.js';

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

