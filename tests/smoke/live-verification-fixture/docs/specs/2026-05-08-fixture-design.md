# Live Verification Fixture — Design Spec

**Status:** shipped (stub for Phase E proof-point)
**Date:** 2026-05-08

## Goal

A minimal Node.js + HTML web app used exclusively as the target for Phase E live-verification autopilot smoke. The app has two user-visible features, one of which contains an intentional bug, allowing the Phase E fix loop to demonstrate end-to-end bug detection and repair.

## Features

### Feature A — Save Display Name

A form that lets the user type a display name and save it. After saving, a label shows the current saved name. The POST /save endpoint has an **intentional bug** — it writes to the wrong field key (`name` instead of `displayName`), so the displayed name never updates after save. The server logs `ERROR: missing field 'displayName'` to stdout when the field is absent, which is captured by Phase E's log tail and matched against the configured `error_patterns`.

### Feature B — Show Recent Saves

A list that displays recent save events from the backing store in reverse-chronological order. This feature has **no bug** and should pass all Phase E scenarios. Its purpose is to prove that after the fix-subagent corrects the Feature A bug, all scenarios (including Feature B) are re-run and still pass.

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /healthz | no | Ready-signal: `{ok:true}` |
| GET | / | yes | Serves index.html |
| GET | /login | no | Login form |
| POST | /login | no | Validates against SMOKE_TEST_PASSWORD env var; sets session cookie |
| GET | /saves | yes | Returns `{saves:[...]}` from store |
| GET | /display-name | yes | Returns `{displayName: store.displayName}` |
| POST | /save | yes | Saves displayName + appends to saves list. **BUG: writes to store.name not store.displayName** |

## Backing Store

`store.json` — a simple flat JSON file with shape `{ "saves": [], "displayName": "" }`.

Reset by `scripts/reset-store.js` (called as `reset_command` in project config before each scenario).

## Config

`.codex-paired/project.json` — declares Phase E launch config for this app:
- Fixed port `34567` via `PORT` env var.
- HTTP ready signal on `/healthz`.
- `reset_command: node scripts/reset-store.js`.
- `login_profiles.test_user` using `SMOKE_TEST_PASSWORD` env var.
- `error_patterns` including `ERROR: missing field`.

## Success Criteria

Phase E autopilot should:
1. Generate ≥2 scenarios (one for Save Display Name, one for Recent Saves).
2. Execute Scenario A → assertion fails (label not updated) + log shows ERROR.
3. Same-SHA retry → still fails.
4. Fix-subagent changes `store.name` to `store.displayName` in server.js.
5. All scenarios re-run → both pass.
6. Evidence double-SHIP'd; slice ships.
