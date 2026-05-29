// Plan 3 (reviewer naming migration) — back-compat shim.
//
// The parser body moved to reviewer-output-parser.js (parseReviewerOutput).
// This module re-exports it unchanged for the migration window;
// `parseExpertOutput` is the alias (same function reference). New code should
// import parseReviewerOutput from reviewer-output-parser.js directly.
export * from './reviewer-output-parser.js';
