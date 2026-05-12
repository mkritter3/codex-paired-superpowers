// v0.9.0 slice 3 — role-routing error class.
//
// All role-routing failures throw RoleRoutingError with a stable `.code`
// field. Codes are part of the contract — sidecar audit + callers may
// switch on them. See `_TESTS.md` for the enumerated set.

export class RoleRoutingError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = 'RoleRoutingError';
    if (code) this.code = code;
    if (details !== undefined) this.details = details;
  }
}
