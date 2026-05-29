// Plan 3 (reviewer naming migration) — back-compat shim.
//
// The runtime façade moved to reviewer-runtime.js. This module re-exports it
// unchanged for the migration window (including `selectTeammates`). New code
// should import from reviewer-runtime.js directly.
export * from './reviewer-runtime.js';
