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
2. **codex-cli** — `codex` v0.128.0+ on PATH (required for the Claude↔Codex 7-round loop via MCP).
3. **codex-auth** — codex credentials present (login state).
4. **git** — git v2.5+ (worktree support required by autopilot's parallel slice dispatch).
5. **vendored-deps** — `proper-lockfile` + transitive pure-JS deps present at `node_modules/` (mailbox lockfile requirement).
6. **bridge-cli** — `lib/codex-bridge/cli.js` loads cleanly (catches corruption / missing deps that the vendored-deps check missed).
7. **hooks** — PostToolUse hooks present and executable.
8. **project-state-dir** — `.codex-paired/` in cwd is writable (informational; auto-created by autopilot when first needed).

Adding a new prerequisite? Update the script — the skill auto-tracks because it just runs the script verbatim.
