// Plan 3 (reviewer naming migration) — reviewer-runtime: the canonical façade
// over the reviewer runtime family. Formerly expert-runtime.js (now a shim).
//
// Canonical exports (the 5-method runtime interface):
//   - resolveIdentity (from reviewer-resolver)
//   - selectReviewers (= composeReviewers)
//   - runTurn         (from reviewer-turn)
//   - archive         (from reviewer-archive)
//   - pollInbox       (thin wrapper over readUnreadMessages)
//
// `selectTeammates` is kept as a compat alias of `selectReviewers` for the
// migration window (spec line 278).
import { readUnreadMessages } from './mailbox.js';

export { resolveIdentity } from './reviewer-resolver.js';
export {
  composeReviewers as selectReviewers,
  composeReviewers as selectTeammates,
} from './reviewer-composer.js';
export { runTurn } from './reviewer-turn.js';
export { archive } from './reviewer-archive.js';

export async function pollInbox(repoRoot, identity) {
  return await readUnreadMessages(repoRoot, identity.id);
}
