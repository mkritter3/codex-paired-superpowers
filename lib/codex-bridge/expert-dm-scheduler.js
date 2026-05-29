// Plan 3 (reviewer naming migration) — back-compat shim.
//
// The drain-loop body moved to reviewer-dm-scheduler.js (drainPeerDMs). This
// module re-exports it unchanged for the migration window. New code should
// import drainPeerDMs from reviewer-dm-scheduler.js directly.
export * from './reviewer-dm-scheduler.js';
