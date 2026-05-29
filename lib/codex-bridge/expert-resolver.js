// Plan 3 (reviewer naming migration) — back-compat shim.
//
// The resolver body moved to reviewer-resolver.js. This module re-exports the
// canonical `resolveIdentity` and aliases `ReviewerResolverError` to the legacy
// `ExpertResolverError` name so existing consumers (role-composer.js's
// `instanceof ExpertResolverError`, expert-runtime.js's re-export) keep working
// for the migration window. New code should import from reviewer-resolver.js.
export {
  resolveIdentity,
  ReviewerResolverError as ExpertResolverError,
} from './reviewer-resolver.js';
