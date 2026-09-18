// @ts-check

/**
 * Shared public-contract types for robustness spec §1, “Gradual JSDoc type checking”.
 *
 * @typedef {'planning' | 'review' | 'implement' | 'implement_fallback'} ModelRole
 *
 * @typedef {object} RoleConfig
 * @property {'codex' | 'agy'} cli
 * @property {string} model
 * @property {string} effort
 *
 * @typedef {object} StatusFile
 * @property {'started' | 'exited'} [state]
 * @property {'completed' | 'blocked' | 'needs-context' | string} [status]
 * @property {number | null} [exit_code]
 * @property {boolean} [transient]
 * @property {string} [error]
 * @property {ModelRole} [model_role]
 * @property {string} [model]
 * @property {string} [effort]
 * @property {string} [cli]
 * @property {string} [cwd]
 *
 * @typedef {object} Round
 * @property {string} phase
 * @property {number} round
 * @property {string} [claude]
 * @property {string} [codex]
 * @property {string} [status]
 *
 * @typedef {object} Audit
 * @property {string} phase
 * @property {number} round
 * @property {string} side
 * @property {Array<Record<string, unknown>>} [commands]
 * @property {string} [verdict_basis]
 * @property {string} [verdict]
 * @property {string} [head_sha]
 *
 * @typedef {object} ThreadConfig
 * @property {ModelRole} role
 * @property {'codex' | 'agy'} cli
 * @property {string | null} model
 * @property {string | null} effort
 * @property {string} [opened_at]
 * @property {boolean} [legacy]
 *
 * @typedef {object} Sidecar
 * @property {number} version
 * @property {string} feature
 * @property {string} [model]
 * @property {string} [reasoning_effort]
 * @property {string} [created_at]
 * @property {string} [codex_session]
 * @property {Record<string, string>} [role_sessions]
 * @property {Record<string, ThreadConfig>} thread_config
 * @property {Round[]} rounds
 * @property {Audit[]} [audits]
 * @property {unknown[]} open_contentions
 * @property {Record<string, unknown>} slice_reviews
 *
 * @typedef {object} ReviewerTurnResult
 * @property {boolean} ok
 * @property {number} exit
 * @property {string} status
 * @property {string} content
 * @property {string} threadId
 * @property {Record<string, unknown> | null} usage
 * @property {string[]} warnings
 * @property {Record<string, unknown> | null} [adapterMeta]
 *
 * @typedef {object} HaltEnvelope
 * @property {string} halt
 * @property {boolean} terminal
 * @property {string} resume_hint
 *
 * @typedef {object} DoctorReport
 * @property {{pass: number, warn: number, fail: number}} summary
 * @property {Array<{name: string, status: 'pass' | 'warn' | 'fail', detail: string}>} checks
 * @property {Record<string, unknown>} availability
 */

export {};
