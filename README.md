# codex-paired-superpowers

Fork of six [superpowers](https://github.com/obra/superpowers) skills paired with Codex (GPT-5.5 high reasoning) as an L11 engineering partner.

## Why

Superpowers gives Claude a discipline. This plugin adds a second pair of eyes — Codex — that drafts specs, critiques plans, reviews per-slice code, and must agree before anything ships. One persistent Codex thread per feature.

The operating rules:

- **Question routing.** Product/UX/business questions → user. Technical/design questions → Codex.
- **7-round revision loop.** Counted only after Codex returns a draft artifact. Both Claude and Codex must emit `SHIP` to advance. Hard cap 7 rounds; deadlocks bubble to the user.
- **Anti-yes-man.** Claude evaluates each Codex critique independently, verifies against actual code, and pushes back when wrong.
- **One Codex thread per feature.** The session UUID lives in a sidecar JSON next to the spec; brainstorm, plan review, and per-slice code review all resume the same thread.

## Skills (forked)

| Skill | What changes vs. upstream |
|---|---|
| `brainstorming` | Codex drafts the spec; Claude routes product questions to user, technical to Codex; 7-round revision loop |
| `writing-plans` | Codex reviews the plan structure on the same session |
| `subagent-driven-development` | Per-slice Codex review scoped to that slice's tasks; out-of-slice issues go to a Deferred list |
| `receiving-code-review` | Anti-rubber-stamp discipline for Codex verdicts |
| `systematic-debugging` | Codex reviews the root-cause hypothesis before the fix |
| `test-driven-development` | Codex reviews the test list before red-green-refactor |

## Prerequisites

- `codex` CLI v0.128.0+ on PATH, authenticated against an account with GPT-5.5 access.
- Node.js v20+ (built-in `node --test` runner; v24+ tested).

## Install

This plugin lives at `/Users/mkr/local-coding/plugins/codex-paired-superpowers/`. Install via the personal local marketplace:

```bash
# 1) Add the local marketplace (one-time)
claude plugin marketplace add /Users/mkr/local-coding/plugins

# 2) Install this plugin
claude plugin install codex-paired-superpowers@mkr-personal

# 3) Reload (or restart Claude Code)
claude plugin list
```

Inside an active Claude Code session, you can also use the `/plugin` slash command.

## Usage

After install, the six skills auto-trigger via Claude's normal skill dispatching:

- Starting creative work? → `brainstorming` opens a Codex session, drafts the spec, runs the 7-round loop.
- Plan ready to write? → `writing-plans` runs the plan through the same Codex session.
- Implementing? → `subagent-driven-development` reviews each slice's diff scoped to that slice.
- Receiving review? → `receiving-code-review` governs how Claude evaluates Codex's verdicts.
- Tough bug? → `systematic-debugging` runs hypothesis review.
- Designing tests? → `test-driven-development` reviews the test list.

Per-feature state lives in `<spec-path>.codex.json` next to the spec. Don't commit it (already in `.gitignore`).

## Configuration

Defaults (no config needed):

- Model: `gpt-5.5`
- Reasoning: `high`
- Max rounds: 7

Overrides (env var, per-invocation):

```bash
CODEX_PAIRED_MODEL=gpt-5.5 CODEX_PAIRED_REASONING=high claude
```

## Autopilot (v0.3.0+)

Run a double-SHIP'd implementation plan to completion unattended. The autopilot drives four phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with its own 7-round Claude↔Codex budget. State persists in the sidecar; `ralph-loop` provides cross-session continuity.

### Usage

```bash
# One-shot in current session:
/autopilot docs/superpowers/plans/<plan>.md

# Or wrapped in ralph-loop for cross-session continuity:
/ralph-loop /autopilot docs/superpowers/plans/<plan>.md --completion-promise "autopilot completed"
```

### Prerequisites
- A double-SHIP'd plan (run through `codex-paired-superpowers:writing-plans` first).
- The plan's frontmatter references the spec path.
- The spec has a sidecar with a `codex_session` threadId.

### Provenance hook
While autopilot is running, a PostToolUse hook on `git commit` checks the Commit Conventions: subject must match `(feat|test|fix|docs|refactor|chore)(slice:N):` and include `Co-Authored-By: Claude`. The hook fires AFTER the commit (PostToolUse can't prevent it) — non-conforming commits land but the hook exits non-zero, signaling the autopilot to halt with `external-commit-detected`. The user can then `git reset` to remove the offending commit. The hook is silent when autopilot isn't running.

### Active anchor file
`<repo>/.codex-paired/active.json` (auto-gitignored) tells the hook which sidecar to consult. Created on autopilot start, removed on halt/completion.

## Architecture

```
codex-paired-superpowers/
├── .claude-plugin/plugin.json         # plugin manifest + bundled codex MCP server
├── lib/codex-bridge/                  # shared bridge (zero npm deps)
│   ├── sidecar.js                     # per-feature JSON state (atomic writes)
│   ├── active-anchor.js               # .codex-paired/active.json lifecycle
│   ├── verdict.js                     # parse <<<VERDICT>>>...<<<END>>> blocks
│   ├── loop.js                        # 7-round Claude<->Codex orchestration
│   ├── cli.js                         # subcommand dispatcher
│   └── prompts/                       # L11 rubric + verdict format + pre-SHIP checklist
├── hooks/                             # provenance hook (PostToolUse on git commit)
│   ├── hooks.json
│   └── check-commit-provenance.sh
├── skills/
│   ├── autopilot/                     # the multi-tier loop orchestrator
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── subagent-driven-development/
│   ├── receiving-code-review/
│   ├── systematic-debugging/
│   └── test-driven-development/
├── commands/
│   └── autopilot.md                   # /autopilot slash command
├── tests/
│   ├── codex-bridge/                  # node --test
│   └── hooks/                         # bash test harness
└── docs/
    ├── specs/                         # design docs
    └── plans/                         # implementation plans
```

## Codex transport: bundled MCP server

As of v0.2.0, the plugin bundles `codex mcp-server` as an MCP server (registered in `plugin.json`). Two tools become available to Claude when the plugin is loaded:

- `mcp__plugin_codex-paired-superpowers_codex__codex` — open a Codex thread; returns `{ threadId, content }`.
- `mcp__plugin_codex-paired-superpowers_codex__codex-reply` — continue a thread by `threadId`; returns `{ threadId, content }`.

This replaces the v0.1.x `codex exec` subprocess transport. The MCP server is long-lived; there is no per-call process spawn or session-log replay, so latency matches zen's `clink`.

## Bridge CLI (sidecar persistence only)

All skills shell out for sidecar operations:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> ...
```

| Subcommand | Effect |
|---|---|
| `sidecar-init --specPath <p> --feature <name> --threadId <id>` | write sidecar at `<p>.codex.json` |
| `sidecar-show --specPath <p>` | print sidecar JSON |
| `sidecar-thread-id --specPath <p>` | print just the threadId (for shell capture) |
| `sidecar-path --specPath <p>` | print the sidecar file path |
| `sidecar-append-round --specPath <p> --round <json>` | append a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | record slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | append open contention |

The CLI does NOT spawn codex anymore. All codex traffic goes through the MCP tools above.

## Development

```bash
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
npm test                              # all bridge tests, ~1s
```

Spec: `docs/specs/2026-05-07-codex-paired-superpowers-design.md`
Plan: `docs/plans/2026-05-07-codex-paired-superpowers.md`

## Status

v0.4.0 — validation rubric. Autopilot now enforces structured per-slice validation coverage at Phase A and verifies it at Phase C.

### Changelog

- **v0.4.0** — validation rubric. Adds `lib/codex-bridge/prompts/validation-rubric.md` enforcing structured per-slice validation coverage. Phase A enumerates Tier-1 (10 subcategories) + Tier-2 (3 triggers) + optional Tier-3 (residual-risk for critical-tier slices) with evidence-backed N/A required. Phase C verifies Phase A's locked commitments via 4 keyed `rubric.*` bullets. Plan slices declare `Validation: light|standard|critical`. Loop's serialize() preserves SHIP critique for audit trail. Sidecar gains structured `validation_coverage` per phase. Hook fix: PostToolUse exits 2 (not 1) so stderr surfaces as system reminder; hooks.json schema corrected; stdin filter for git-commit-only. Backfill: 7 edge-case unit tests (malformed JSON in sidecar/anchor, regression guards) + autopilot structural smoke (re-runnable). Rubric hardened across 4 Codex review rounds.
- **v0.3.0** — autopilot. Multi-tier loop drives plans slice-by-slice unattended; per-slice phases (plan-slice + test-list review, implement, review-slice, docs-update); cross-session continuity via ralph-loop; provenance hook enforces Commit Conventions during active runs; sidecar gains nested phase state + autopilot block + atomic writes; system rubric gains pre-SHIP checklist. Spec hardened across 6 Codex review rounds; plan hardened across 6 Codex review rounds.
- **v0.2.0** — switched from `codex exec` subprocess transport to bundled `codex mcp-server` MCP transport. Long-lived process, native JSON-RPC, faster (no spawn-per-call, no session-log replay). Removed `lib/codex-bridge/invoke.js` and the `session-start`/`session-resume`/`run-loop` CLI subcommands. Skills now invoke `mcp__plugin_codex-paired-superpowers_codex__*` tools directly.
- **v0.1.1** — clarified round semantics in brainstorming SKILL.md; removed dead `initialArtifact` parameter from `runRoundLoop`.
- **v0.1.0** — first working release.
