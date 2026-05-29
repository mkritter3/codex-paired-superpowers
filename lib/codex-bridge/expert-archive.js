// Plan 3 (reviewer naming migration) — back-compat shim.
//
// The archival policy body moved to reviewer-archive.js. This module re-exports
// it unchanged for the migration window. `ExpertArchiveError` is the alias
// (same class object) exported from reviewer-archive.js, so existing
// `instanceof ExpertArchiveError` checks keep working. New code should import
// from reviewer-archive.js directly.
export * from './reviewer-archive.js';
