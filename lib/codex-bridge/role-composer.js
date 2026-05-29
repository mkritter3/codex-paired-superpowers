// Plan 3 (reviewer naming migration) — back-compat wrapper.
//
// The selection body moved to reviewer-composer.js (composeReviewers). This
// module keeps exporting `composeExperts` for the migration window; it is a
// faithful wrapper delegating to composeReviewers. New code should import
// composeReviewers from reviewer-composer.js directly.
import { composeReviewers } from './reviewer-composer.js';

export { composeReviewers } from './reviewer-composer.js';

export function composeExperts(args) {
  return composeReviewers(args);
}
