---
description: Verify codex-paired-superpowers prerequisites are correctly installed and configured. Use when the plugin reports setup errors, when installing for the first time, when troubleshooting "module not found" / "codex not on PATH" / authentication errors, or any time you want a fast health check of the install.
---

# Doctor — codex-paired-superpowers preflight

Run the bundled diagnostic script and report results to the user.

## What to do

1. Run the script:
   ```bash
   codex-paired-doctor
   ```
   It's on `PATH` while the plugin is enabled (Claude Code installs `bin/` entries automatically).

2. Read the output. Each check produces one of:
   - **PASS** — the prerequisite is in place.
   - **WARN** — non-blocking; the user should review if they hit issues.
   - **FAIL** — blocking; the user must address before the plugin can do useful work.

3. If any check FAILs, surface the exact `fix:` line printed under that check verbatim. Don't paraphrase — the fix lines are the commands the user runs to resolve the issue.

4. If all checks pass, confirm "All checks green. Plugin is ready to use." and stop. Don't pad the response with explanation.

## When to invoke this skill

Invoke `doctor` proactively (without being asked) in these situations:

- The user has just installed the plugin and asks any "how do I get started" / "is this working" question.
- A skill (brainstorming, autopilot, etc.) errors with output mentioning: `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any "module-load" / "binary-not-found" pattern. These are setup-failure signatures; doctor pins them quickly.
- The user explicitly asks "is my setup OK" / "check my install" / "diagnose" / "preflight" / similar.

Do NOT run the doctor automatically before every skill invocation — that adds latency. The signal is errors that match the patterns above, or explicit user request.

## Machine-readable mode

For programmatic consumption (e.g., autopilot's Phase B.PRE may want to gate on doctor results), invoke with `--json`:

```bash
codex-paired-doctor --json
```

Output schema:
```json
{
  "summary": { "pass": N, "warn": N, "fail": N },
  "checks": [
    { "status": "pass|warn|fail", "name": "...", "detail": "...", "fix": "..." | null }
  ]
}
```

Exit code: 0 if all PASS or only WARN; 1 if any FAIL.

## What the doctor checks

The full check list lives in `bin/codex-paired-doctor` (the source of truth). Current set:

1. **node** — Node v20+ on PATH (required for `lib/codex-bridge/*` modules + the bundled MCP server).
2. **codex-cli** — `codex` on PATH (required for the Claude↔Codex 7-round loop via MCP).
3. **codex-auth** — codex credentials present (login state).
4. **git** — git v2.5+ (worktree support required by autopilot's parallel slice dispatch).
5. **vendored-deps** — `proper-lockfile` + transitive pure-JS deps present at `node_modules/` (mailbox lockfile requirement).
6. **bridge-cli** — `lib/codex-bridge/cli.js` loads cleanly (catches corruption / missing deps that the vendored-deps check missed).
7. **hooks** — PostToolUse hooks present and executable.
8. **project-state-dir** — `.codex-paired/` in cwd is writable (informational; auto-created by autopilot when first needed).
9. **models** (v0.16.0) — resolves the four model roles (`planning`, `review`, `implement`, `implement_fallback`) and prints `role: model effort (source)`; FAILs only on a malformed `models` config; WARNs when the Codex model catalog (`~/.codex/models_cache.json`) lacks a configured model, lists a retirement date for it, does not support the configured effort, is unreadable, or is older than seven days. An absent catalog is not an error.
10. **codex-transport** (v0.16.0) — WARNs when `codex --version` is older than the version this release was validated against (`0.153.4`), and when this Codex build no longer offers `codex mcp-server` (the transport the plugin uses).

Adding a new prerequisite? Update the script — the skill auto-tracks because it just runs the script verbatim.
11. **agy** (v0.17.0) — the availability report lists the Antigravity CLI (`agy`, Gemini); the `models` check also validates roles with `cli: agy` against `agy models` (WARN when the configured id is not listed, or when a role uses agy but it is not installed). Installs that never set `cli: agy` are unaffected.
12. **review-panel** (v0.19.0) — resolves the configured review panels; WARNs when a member uses the same model as the `implement` role (`self-review:<member_id>`: code reviewed by the model that wrote it) or when the panel configuration cannot be resolved.
13. **worktrees** (v0.19.0) — lists checkouts this plugin left behind (a crashed or halted run) with each one's kind, age and why it is kept; WARN when there are any, never FAIL. Worktrees the user created are ignored, and only the current user's processes are inspected when deciding whether a checkout is in use. Remove the safe ones with `node lib/codex-bridge/cli.js worktree-reap --apply --repoRoot <repo>` (without `--apply` it only lists).
