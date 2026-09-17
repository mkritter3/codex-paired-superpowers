// v0.10.0 implementer-experts — shared JSDoc typedefs.
//
// Pins the shared contract from spec § Architecture L72-95.
// No runtime logic — pure types + a test witness object.

/**
 * @typedef {"codex-cli" | "claude-cli"} ImplementerRuntimeKind
 *
 * @typedef {object} ImplementerDispatchInput
 * @property {string} sliceId
 * @property {string} implementerRunId
 * @property {string} memberId
 * @property {ImplementerRuntimeKind} runtimeKind
 * @property {string} worktreePath
 * @property {string} branchName
 * @property {string} baseSha
 * @property {string[]} claimedFiles
 * @property {string} prompt
 * @property {AbortSignal} abortSignal
 * @property {Record<string,string>} env
 * @property {string} [modelRole]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [repoRoot] absolute path used for attempt evidence
 * @property {(snapshot: {model_role:string, model:string, effort:string, status_file?:string}) => Promise<void>|void} [onLaunched]
 *
 * @typedef {object} ImplementerDispatchResult
 * @property {string} memberId
 * @property {"completed" | "failed" | "cancelled" | "halted"} outcome
 * @property {number|null} exitCode
 * @property {string|null} headSha
 * @property {string|null} diffHash
 * @property {string[]} changedFiles
 * @property {object|null} haltEnvelope
 * @property {{model_role:string, model:string, effort:string}|null} [modelSnapshot]
 * @property {boolean} [attemptInFlight]
 */

/**
 * Runtime witness for the type shapes above. Used by types-contract.test.js to
 * verify that the typedef property-name lists match spec § Architecture L72-95
 * (JSDoc typedefs are erased at runtime and cannot be introspected otherwise).
 *
 * @type {{
 *   runtimeKindMembers: string[],
 *   dispatchInputProps: string[],
 *   dispatchInputOptionalProps: string[],
 *   dispatchResultProps: string[],
 *   dispatchResultOptionalProps: string[],
 * }}
 */
export const __shapesForTests = {
  /** Sorted union members for ImplementerRuntimeKind */
  runtimeKindMembers: ['claude-cli', 'codex-cli'],

  /** Sorted required property names for ImplementerDispatchInput */
  dispatchInputProps: [
    'abortSignal',
    'baseSha',
    'branchName',
    'claimedFiles',
    'env',
    'implementerRunId',
    'memberId',
    'prompt',
    'runtimeKind',
    'sliceId',
    'worktreePath',
  ],

  /** Sorted optional property names for ImplementerDispatchInput (spec §4). */
  dispatchInputOptionalProps: ['effort', 'model', 'modelRole', 'onLaunched', 'repoRoot'],

  /** Sorted required property names for ImplementerDispatchResult */
  dispatchResultProps: [
    'changedFiles',
    'diffHash',
    'exitCode',
    'haltEnvelope',
    'headSha',
    'memberId',
    'outcome',
  ],

  /** Sorted optional property names for ImplementerDispatchResult (spec §4). */
  dispatchResultOptionalProps: ['attemptInFlight', 'modelSnapshot'],
};
