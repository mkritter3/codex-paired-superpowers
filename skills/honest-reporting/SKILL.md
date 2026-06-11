---
name: honest-reporting
description: v0.8.1 — codifies the three-tier reporting vocabulary (VERIFIED / ASSUMED / UNTESTED) and explains how to respond when the honest-reporting Stop/PreToolUse hook fires. Activated automatically by brainstorming, writing-plans, subagent-driven-development, autopilot, test-driven-development, and systematic-debugging.
---

# Honest-reporting

## Why

The orchestrator (Claude) has a tendency to confidently report success on things it hasn't actually checked — "tests pass" without running them, "install path verified" when only checked locally, "both parts of the release gate cleared" when only one was actually exercised. The v0.8.1 honest-reporting hook surfaces this mechanically: a deterministic scanner over the last assistant turn (or recent turns, on `git tag` / `git push` / `gh release create` / `npm publish`) checks for high-precision claim vocabulary and requires nearby evidence.

This skill defines the vocabulary you should reach for so the hook stays out of the way — and so reports remain trustworthy when the hook isn't active.

## Three-tier reporting vocabulary

- **VERIFIED** — I ran a tool in this turn (or the immediately prior turn) and its output established this. **Cite the tool name and the relevant output.** Example: "VERIFIED: `npm test` exited 0 with 88 tests passing (see test output above)."

- **ASSUMED** — based on prior session state or unverified inference. Honest about the lack of evidence in this turn. Example: "ASSUMED stable from prior session: the v0.8.0 install was confirmed at session start; I have not re-checked this turn."

- **UNTESTED** — deferred or known-not-yet-verified. Useful for surfacing coverage gaps. Example: "UNTESTED: cross-platform (Linux/Windows); only macOS was exercised."

## When the hook fires

The hook activates when `<repo-root>/.codex-paired/honest-reporting-active.json` is present and its `expiresAt` is in the future. It fires on:

- **Stop** — after every assistant turn. Scans the turn's text for claim vocabulary; exit 2 (block + show stderr) if any match lacks nearby evidence.
- **PreToolUse:Bash** — when Claude is about to run `git tag`, `git push`, `gh release create`, or `npm publish`. Scans the last 1–2 assistant turns the same way.

The exit-2 message names each unsourced claim and asks you to rewrite the turn citing the tool call OR reclassifying as ASSUMED / UNTESTED.

## Excluded regions (won't trigger the scanner)

The scanner strips these before scanning:

- Fenced code blocks (` ``` ... ``` `)
- Codex verdict blocks (`<<<VERDICT>>> ... <<<END>>>`)
- `## Machine Result` sections
- Blockquoted lines (`> ...`)
- Content inside single backticks (the backticks themselves remain as evidence markers)
- Short double-quoted mentions (≤3 words) — `the flagged word "shipped"` is a meta-mention,
  not a claim (v0.15.0; this is what previously caused re-block loops when a rewrite
  discussed the word the hook flagged)

So you can quote user text or include verdict blocks without false positives.

## Evidence markers the scanner accepts

Anywhere in the same message as a claim match (v0.15.0 — previously the window was
"same paragraph ±200 chars", which punished the honest tool-output-then-summary shape):

- Inline backticks (any short code reference)
- Tool/CLI references: `Bash`, `Edit`, `Read`, `Write`, `gh `, `git `, `node `, `npm `, `pnpm`, `pytest`, `jest`, etc.
- File paths matching `dir/file.ext`
- Line-number references (`:42`)
- Caveat markers: `ASSUMED`, `UNTESTED`, `not verified`, `haven't checked`, `based on prior session`, `recall from memory`
- The word `ran` (e.g., "ran `npm test`")
- The phrase `exit code`

## Phrasing patterns

| Bad (will fire) | Good (will pass) |
| --- | --- |
| "Tests pass and we're shipped." | "VERIFIED: `npm test` exited 0; tag pushed via `git push --tags`." |
| "v0.8.0 shipped cleanly." | "v0.8.0 shipped cleanly — ASSUMED stable from prior session (last release-gate run was 2026-05-10)." |
| "Install verified across platforms." | "VERIFIED on macOS: `claude plugin install` returned Version 0.8.0. UNTESTED on Linux/Windows." |
| "Everything is deployed." | "Deployed to staging (ASSUMED based on the run earlier; not re-checked this turn). UNTESTED on production." |

## Activation marker

The marker file is `<repo-root>/.codex-paired/honest-reporting-active.json`:

```json
{
  "skillName": "autopilot",
  "sessionStartedAt": "2026-05-11T14:30:00.000Z",
  "expiresAt":         "2026-05-11T22:30:00.000Z",
  "specPath":          "/abs/path/to/spec.md"
}
```

Default TTL: 8 hours. After expiry, the hook is inactive. Skills GC stale markers (>24h old) on their next entry.

The marker is written by the entry block of each codex-paired skill — they invoke:

```bash
node "$CLAUDE_PLUGIN_ROOT/lib/codex-bridge/cli.js" honest-reporting-mark-active --skill <name> [--spec <path>] [--ttl-hours N]
```

**Clearing on completion (v0.15.0).** The TTL is the backstop, not the lifecycle. When the
workflow finishes — the loop double-SHIPs, autopilot writes `halt_reason: "completed"` or halts,
or the skill's work is otherwise wrapped up — clear the marker so the hook stops policing
unrelated work in the same repo for the rest of the TTL window:

```bash
node "$CLAUDE_PLUGIN_ROOT/lib/codex-bridge/cli.js" honest-reporting-clear
```

This mirrors autopilot's anchor-clear. Sessions that die without cleanup are still covered by
TTL expiry. The marker also now resolves slice worktrees (`.git-worktrees/slice-N`) to the main
repo root, so implementer subagents are policed by the same marker.

**One block per stop (v0.15.0).** The Stop hook honors `stop_hook_active`: it blocks a turn at
most once. The rewrite goes through even if imperfect — fix the substance, don't fight the hook.
When rewriting, do NOT quote or discuss the flagged word; state the evidence or reclassify.

## When NOT active

The hook respects normal-user freedom. Outside of codex-paired skill sessions, you can use any phrasing; the scanner doesn't run. The discipline is still good practice, but only the codex-paired workflows enforce it.

## Disabling temporarily

If a particular session needs to bypass the hook (e.g., demos, deliberate prose writing about past releases), delete or expire the marker:

```bash
rm <repo-root>/.codex-paired/honest-reporting-active.json
```

Re-running any codex-paired skill re-creates it.
