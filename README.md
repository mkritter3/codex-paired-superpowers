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

## Architecture

```
codex-paired-superpowers/
├── .claude-plugin/plugin.json         # plugin manifest
├── lib/codex-bridge/                  # shared bridge (zero npm deps)
│   ├── invoke.js                      # spawn `codex exec`, parse session UUID
│   ├── sidecar.js                     # per-feature JSON state
│   ├── verdict.js                     # parse <<<VERDICT>>>...<<<END>>> blocks
│   ├── loop.js                        # 7-round Claude↔Codex orchestration
│   ├── cli.js                         # subcommand dispatcher
│   └── prompts/                       # L11 rubric + verdict format
├── skills/
│   ├── brainstorming/
│   ├── writing-plans/
│   ├── subagent-driven-development/
│   ├── receiving-code-review/
│   ├── systematic-debugging/
│   └── test-driven-development/
├── tests/codex-bridge/                # node --test
└── docs/
    ├── specs/                         # design docs
    └── plans/                         # implementation plans
```

## Bridge CLI (for skills)

All skills shell out to:

```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> ...
```

| Subcommand | Stdin | Effect |
|---|---|---|
| `session-start --specPath <p> --feature <name>` | prompt | spawn codex, capture UUID, write sidecar |
| `session-resume --specPath <p>` | prompt | resume session from sidecar |
| `sidecar-show --specPath <p>` | — | print sidecar JSON |
| `sidecar-append-round --specPath <p> --round <json>` | — | append a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | — | record slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | — | append open contention |

## Development

```bash
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
npm test                              # all bridge tests, ~1s
```

Spec: `docs/specs/2026-05-07-codex-paired-superpowers-design.md`
Plan: `docs/plans/2026-05-07-codex-paired-superpowers.md`

## Status

v0.1.0 — first working release.
