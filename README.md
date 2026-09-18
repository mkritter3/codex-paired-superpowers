# codex-paired-superpowers

[![ci](https://github.com/mkritter3/codex-paired-superpowers/actions/workflows/ci.yml/badge.svg)](https://github.com/mkritter3/codex-paired-superpowers/actions/workflows/ci.yml)

Fork of six [superpowers](https://github.com/obra/superpowers) skills paired with Codex as an L11 engineering partner. **Codex writes the code (GPT-5.6 Sol, high), Claude reviews it, planning runs on GPT-6 Astra at extra-high effort, and both must agree before anything ships.**

## v0.19.0 — Review panels and crash cleanup (latest)

- **Review panels (opt-in):** put more than one external reviewer on planning, on code review, or on
  both. Every member reviews independently and **all must agree** — Claude and each member say SHIP
  on the same version, or the round goes back. No vote, no tiebreaker; a member that cannot be
  reached halts the review instead of being dropped. The default stays one reviewer. See
  [Configuration](#configuration).
- **Leftover checkouts are cleaned up safely:** every checkout the plugin creates is labelled, and
  `worktree-reap` removes the ones a crashed run left behind only when they are provably safe to
  delete (not in use, all work committed and saved on another branch, clean, old enough). `doctor`
  lists them. A halted autopilot marks what it keeps for diagnosis so cleanup never touches it.
- **Fixed:** finishing a review no longer runs a repository-wide `git worktree prune`, which could
  drop other stale checkouts' records.

## v0.18.0 — Robust on other people's machines

Type checking, a written public API, CI on every supported platform, and a fresh-clone smoke:

- **Gradual JSDoc type checking** (`npm run typecheck`, run first by `npm test`): `checkJs: false` +
  per-file `// @ts-check`, an explicit allowlist (`typecheck.allowlist.json`) that the runner
  reconciles against the effective TypeScript program in both directions — nothing is checked
  silently and nothing listed can opt out. The 15 modules that define the public surface are checked
  under `strict`; contract tests pin the previously-checked call signatures.
- **Public API contract** (`docs/public-api.md`): every stable surface — skills and slash commands,
  every `cli.js` verb with flags/stdout shapes/exit codes, the implementer wrapper, `doctor`'s output,
  the `project.json` schema and the loader's documented permissive behaviours, the sidecar version —
  pinned in fenced JSON blocks that `tests/contract/public-api.test.js` executes against the real
  binaries. `scripts/cli-surface.mjs` extracts the CLI surface from the AST and digests the CLI's
  import closure, so undocumented behaviour cannot change without the document changing. Semver
  policy: `lib/codex-bridge/cli.js` is public; the rest of `lib/` is internal.
- **Support policy + CI**: macOS and Linux on Node ≥ 20 (Windows unsupported; `doctor` says so);
  GitHub Actions runs the suite, the shell suites (bash 3.2 on macOS) and the fresh-clone smoke on
  every released Node major (20–26) on both OSes for every push and pull request.
- **Fresh-clone smoke** (`npm run test:fresh-clone`): clones the repository into an isolated temp
  root, runs `doctor`, a fake-CLI implementer commit and a reviewer turn in a throwaway checkout, and
  proves the reviewer saw the implementer's commit; bounded, with ownership-based process cleanup.
- Vendored runtime deps are checked against the lockfile (`scripts/check-vendored-deps.mjs`); user
  facing scripts are guarded against bash-4-only constructs (`scripts/check-bash32.mjs`).

## v0.16.0 — Model roles for the GPT-6 era

Every Codex invocation now runs on a **model role** resolved from one place (`lib/codex-bridge/models.js`) instead of a hard-coded `gpt-5.5` (which OpenAI retires on 2026-10-14):

| Role | Default | Used for |
|---|---|---|
| `planning` | GPT-6 Astra, `xhigh` | spec drafting, plan review, per-slice plan review, debugging, test-list review |
| `review` | GPT-6 Astra, `high` | slice code review, docs-update, post-implementation reviewer panels |
| `implement` | GPT-5.6 Sol, `high` | every `codex exec` implementer attempt |
| `implement_fallback` | GPT-6 Astra, `medium` | the automatic second Codex attempt before the Claude subagent |

- **Codex writes the code.** The dispatcher registry prefers Codex in every domain; single-implementer work climbs `implement` → `implement_fallback` → Sonnet subagent. Config errors (wrapper exit 78) halt instead of falling back.
- **Claude reviews first.** Before Codex's review round, Claude reads the diff, runs verification, writes findings, and may run at most two checkpointed fix passes (`runFixPass`); both sides then SHIP the **same commit** (`reviewed_sha`, enforced by the sidecar).
- **Two threads per feature.** Planning on `paired-reviewer` (xhigh); slice reviews on the cheaper `execution-reviewer` thread (high) seeded with the spec and plan.
- **Durable attempts.** The wrapper writes the resolved model into the status file before spawning; fan-out attempts leave evidence under `.codex-paired/attempts/` so a resume observes a live attempt instead of launching a second writer.
- **Doctor** warns about missing/retiring catalog models, unsupported efforts, a stale catalog, an older-than-validated Codex CLI (`0.153.4`), and a Codex build without `mcp-server`.
- Legacy plans and sidecars that name `gpt-5.5` in member ids keep working: the model segment is a label; the effective model is the role.

## v0.9.0 — Model-routed dev team (latest)

v0.9.0 replaces the single-CLI assumption with a routing-aware dispatch layer that picks the best-suited CLI per expert role from a preference ladder.

- **CLI harness** (`lib/codex-bridge/cli-harness/`) — spawn-based dispatcher for Codex and Ollama Cloud; normalized `DispatchResult` shape across all adapters; `AbortController`-based timeout + cleanup
- **Role routing** — `role-routing.json` + `role-recommendations.json` preference ladder; `resolveAdapter()` walks the ladder with explicit override/fallback paths; full resolution-audit trail in the sidecar (`resolved_cli`, `resolution_source`, `preference_index`, etc.)
- **Doctor extension** — availability detection for each configured CLI with 1h TTL cache and smart invalidation on plugin version bump or binary path change
- **Panel mode** (`lib/codex-bridge/panel/`) — multi-CLI consensus dispatch with deterministic verdict aggregation; hard floor of 2 advisors; `panel_id` recorded in sidecar per turn
- **Halt envelope** — autopilot resume is halt-aware; terminal halt types enforced; `high_stakes` opt-in flag triggers panel dispatch automatically
- **TDD-mandatory in `writing-plans`** — writing-plans now requires a `expert-test` panel round before the plan can advance; no-escape-hatch policy
- **Sidecar schema migration** — `codex_session` → `role_sessions` (keyed by role ID); `role_prompt_version` + `role_prompt_hash` per turn; silent on-load upgrade for v0.8.x sidecars
- **7-tier test strategy** — Tier 1–3+6 run in default CI (~3m); Tier 4 (installed-smoke, `CPS_INSTALLED_SMOKE=1`) + Tier 5 (replay) opt-in; Tier 7 release gate via `./scripts/v0.9.0-release-gate.sh`

See `docs/verification/v0.9.0-release-gate.md` for the 6 PASS criteria required before tagging. DO NOT tag `v0.9.0` until the gate script exits 0.

## Why

Superpowers gives Claude a discipline. This plugin adds a second pair of eyes — Codex — that drafts specs, critiques plans, reviews per-slice code, and must agree before anything ships. One persistent Codex thread per feature.

The operating rules:

- **Question routing.** Product/UX/business questions → user. Technical/design questions → Codex.
- **7-round revision loop.** Counted only after Codex returns a draft artifact. Both Claude and Codex must emit `SHIP` to advance. Hard cap 7 rounds; deadlocks bubble to the user.
- **Anti-yes-man.** Claude evaluates each Codex critique independently, verifies against actual code, and pushes back when wrong.
- **One Codex thread per feature.** The session UUID lives in a sidecar JSON next to the spec; brainstorm, plan review, and per-slice code review all resume the same thread.

## Skills

| Skill | Purpose |
|---|---|
| `brainstorming` | Codex drafts the spec; Claude routes product questions to user, technical to Codex; 7-round revision loop |
| `writing-plans` | Codex reviews the plan structure on the same session |
| `execution` | Stable entry point for running a reviewed plan. Pick a `driver` (`interactive` or `autopilot`) and a per-slice split. See [docs/execution-model.md](docs/execution-model.md) |
| `subagent-driven-development` | Interactive driver implementation under `execution`: per-slice Codex review scoped to that slice's tasks; out-of-slice issues go to a Deferred list |
| `receiving-code-review` | Anti-rubber-stamp discipline for Codex verdicts |
| `systematic-debugging` | Codex reviews the root-cause hypothesis before the fix |
| `test-driven-development` | Codex reviews the test list before red-green-refactor |
| `autopilot` (v0.3.0+) | Autopilot driver implementation under `execution`: runs a double-SHIP'd plan slice-by-slice unattended; 4 phases × 7-round budgets each. `/autopilot` remains a compatibility alias for `execution` with `driver: autopilot` |
| `doctor` (v0.7.3.1+) | Preflight diagnostic — verifies Node, codex CLI, git, vendored deps, hooks, and writeable state dir |

For the one-page mental model of drivers, splits, and review, see
**[docs/execution-model.md](docs/execution-model.md)**.

## Prerequisites

**You bring your own CLIs and your own accounts.** This plugin orchestrates command-line coding
tools that you install and authenticate yourself. It bundles no API keys, ships no credentials, and
proxies nothing through any service of its own: each external model call is a subprocess on your
machine, signed in as you and billed to your account. (The one exception is Claude itself — the
`claude` routing entry and the Sonnet implementer fallback run as Claude Code subagents through the
Agent tool, inside the session you are already in, not as a spawned CLI. `claude-cli` is the
separate transport that *does* spawn the Claude CLI.) Run `/superpowers-doctor` (or
`bin/codex-paired-doctor`) at any time — it reports which tools are present, which pass their auth
probe, and which model roles are configured.

**Required**

- **`codex` CLI** on PATH, authenticated against an account with access to GPT-6 Astra and
  GPT-5.6 (v0.16.0 was validated against `0.153.4`; `doctor` warns on older builds and on a build
  whose MCP transport the plugin cannot use):
  ```bash
  # macOS / Linux (Homebrew):
  brew install openai/codex/codex

  # or via npm (cross-platform):
  npm install -g @openai/codex

  # then authenticate — this is your account, not the plugin's:
  codex login
  ```
  See [openai/codex on GitHub](https://github.com/openai/codex) for source, alternative installers
  (Docker, GitHub Releases), and version requirements.
- **Node.js v20+** on PATH (the bundled MCP server + the bridge CLI run as a Node subprocess;
  runtime deps are vendored in `node_modules/`, no `npm install` required). Supported platforms:
  **macOS and Linux** (Windows is unsupported; `doctor` reports it as FAIL). CI tests every
  released Node major from 20 through 26 on both platforms; `bin/codex-paired-doctor` names the
  same tested majors.
- **`git` v2.5+** for worktree-based parallel slice dispatch (v0.7.0+).

**Optional — only if you want the roles or reviewers that use them**

Each of these is a separate install with its own sign-in.

| CLI | Install + authenticate | What it unlocks |
|---|---|---|
| `agy` (Antigravity, Gemini) | install per Antigravity's own instructions, then run `agy` once and complete its sign-in (it stores auth under `~/.gemini/`); check with `agy models` | any model role on Gemini via `cli: agy` (v0.17.0) — co-reviewer and/or code writer. `doctor` validates your configured model ids against `agy models` |
| `ollama` | [ollama.com](https://ollama.com), then sign in to Ollama Cloud | the domain-reviewer rungs `ollama{kimi-k2.6}` and `ollama{glm-5.1}`. Note the bundled variants map to **cloud** models (`kimi-k2.6:cloud`, `glm-5.1:cloud`), so they need an Ollama Cloud account; point them at local models by editing `lib/codex-bridge/cli-clients/ollama.json` |
| `qwen` | — | **not supported yet.** `lib/codex-bridge/cli-clients/qwen.json` is a placeholder with no adapter, so dispatch throws `UNKNOWN_ADAPTER_MODULE`. Installing the CLI does not enable it and does not help: a `qwen` on PATH that reports a version enters the available set and can be *selected* for the backend reviewer rung, only to fail at dispatch. Leave it uninstalled until a release ships the adapter |
| `claude-cli` | already present if you are running Claude Code | the `claude-cli` reviewer transport (a spawned `claude` subprocess). Separate from the `claude` routing entry and the Sonnet implementer fallback, which are in-session subagents |

**What happens when a tool is missing or not signed in.** A CLI that is absent — or installed but
failing its auth probe — is treated as *unavailable*, and that is deliberate: the reviewer ladders
walk to the next rung, so a role may silently run on a different tool than you expected (`doctor`
and the turn's audit record name the one actually used, with a `fallback_reason`). Two cases do stop
instead: a CLI you pinned explicitly for a role halts with `override-cli-unavailable` rather than
substituting, and a ladder with nothing available halts with `no-supported-cli-for-role`. What the
plugin never does is authenticate for you or reuse another tool's account.

## Install

This plugin is published as a single-plugin marketplace: the repository itself is the marketplace, and adding it makes exactly one plugin (`codex-paired-superpowers`) available.

### From a public GitHub repo (recommended)

```bash
# 1) One-time: register the marketplace by GitHub owner/repo.
claude plugin marketplace add <owner>/codex-paired-superpowers

# 2) Install the plugin (user scope by default).
claude plugin install codex-paired-superpowers@codex-paired-superpowers

# 3) Reload (or restart Claude Code) to activate.
/reload-plugins
```

Substitute `<owner>` with the actual GitHub username/org hosting this repo. Full HTTPS or SSH URLs also work:

```bash
claude plugin marketplace add https://github.com/<owner>/codex-paired-superpowers.git
claude plugin marketplace add git@github.com:<owner>/codex-paired-superpowers.git
```

To pin a specific version (tag or branch), append `#`:

```bash
claude plugin marketplace add <owner>/codex-paired-superpowers#v0.7.3.1
```

### Inside an active Claude Code session

Use the `/plugin` slash command to browse marketplaces and install interactively. Add via the Marketplaces tab, then install from Discover.

### For local development

If you've cloned the repo and want to point Claude Code directly at the working tree (no marketplace, no install — useful when hacking on the plugin):

```bash
claude --plugin-dir /path/to/codex-paired-superpowers
```

### Why `node_modules/` is committed

Claude Code does not run `npm install` on plugin install. The four runtime deps (`proper-lockfile` + three pure-JS transitive deps) are vendored at `node_modules/`. Total 204 KB, zero native bindings, works on any platform with Node 20+. This is the same pattern other Claude Code plugins with Node deps use (e.g., `episodic-memory`).

## Uninstall

```bash
# Uninstall the plugin but keep the marketplace registered:
claude plugin uninstall codex-paired-superpowers@codex-paired-superpowers

# Disable temporarily without uninstalling:
claude plugin disable codex-paired-superpowers@codex-paired-superpowers
claude plugin enable codex-paired-superpowers@codex-paired-superpowers

# Remove the marketplace entirely (ALSO uninstalls any plugins from it):
claude plugin marketplace remove codex-paired-superpowers
```

## First-run health check

After installing, run the bundled doctor to verify all prerequisites are in place:

```bash
codex-paired-doctor
```

(It's on `PATH` while the plugin is enabled.) The doctor checks Node version, `codex` CLI presence + authentication, `git` version, vendored dependencies, and hook files. Each FAIL prints the exact command to resolve it. You can also invoke `/codex-paired-superpowers:doctor` from inside Claude Code — same output, surfaced as a skill response.

Run the doctor proactively when any skill produces errors mentioning `Cannot find module`, `codex: command not found`, `codex not authenticated`, or similar setup-shaped failures.

## Troubleshooting

**Leftover checkouts after a crash.** A run that crashed or was interrupted can leave checkouts
behind. `codex-paired-doctor` lists the ones this plugin created (the `worktrees` check) with why
each is kept. To remove the ones that are safe to delete:

```bash
node lib/codex-bridge/cli.js worktree-reap --repoRoot .            # list only
node lib/codex-bridge/cli.js worktree-reap --apply --repoRoot .    # remove the safe ones
```

A checkout is removed only if the plugin created it, it is not marked preserved, no process of
yours is using it, its commit is saved on another branch or tag, it has no uncommitted, staged,
untracked, ignored (other than `node_modules` and `.tia-cache` in implementation checkouts) or submodule content, and it is old enough (an hour
for review checkouts, a day otherwise). Anything uncertain is kept. Processes of other users are not
inspected. Worktrees you created yourself are never touched, and each removal takes out that one
checkout only; the plugin never runs `git worktree prune`.

To keep a checkout that cleanup would otherwise remove:

```bash
node lib/codex-bridge/cli.js checkout-preserve --path <checkout> --reason "<why>" --run <id> --repoRoot .
```

## Publishing your own copy

If you're forking this plugin to publish under your own GitHub account:

1. Edit `.claude-plugin/marketplace.json` and replace `REPLACE_WITH_YOUR_GITHUB_OWNER` with your GitHub username/org. The `source.repo` field must point at the GitHub repository where you'll push.
2. `git init`, commit, push to a new GitHub repo named `codex-paired-superpowers` (or pick a different repo name and update `source.repo` to match).
3. Verify by running `claude plugin marketplace add <your-org>/codex-paired-superpowers` from another machine (or against an empty plugin cache).
4. Optionally tag a release (`git tag v0.7.3.1 && git push --tags`) so users can pin versions.

The marketplace.json's `source` field uses GitHub source rather than a local relative path because the plugin and the marketplace catalog live at the same root (Claude Code's local relative-path sources expect the plugin to sit in a subdirectory of the marketplace; that pattern doesn't fit a single-plugin self-marketplace).

## Usage

After install, the six skills auto-trigger via Claude's normal skill dispatching:

- Starting creative work? → `brainstorming` opens a Codex session, drafts the spec, runs the 7-round loop.
- Plan ready to write? → `writing-plans` runs the plan through the same Codex session.
- Implementing? → `subagent-driven-development` reviews each slice's diff scoped to that slice.
- Receiving review? → `receiving-code-review` governs how Claude evaluates Codex's verdicts.
- Tough bug? → `systematic-debugging` runs hypothesis review.
- Designing tests? → `test-driven-development` reviews the test list.

Per-feature state lives in `.superpowers-codex-paired/` at the repo root; the CLI auto-discovers the sidecar from `--specPath` so you never need to compute the path manually. Don't commit sidecars (already in `.gitignore`).

## Configuration

Defaults (no config needed) — the four model roles:

| Role | Model | Effort |
|---|---|---|
| `planning` | `gpt-6-astra` | `xhigh` |
| `review` | `gpt-6-astra` | `high` |
| `implement` | `gpt-5.6-sol` | `high` |
| `implement_fallback` | `gpt-6-astra` | `medium` |

Max rounds: 7 per phase.

**Choose the CLI per role (v0.17.0).** Each role also has a `cli`: `codex` (default) or `agy`
(the Antigravity CLI, Google's Gemini models). Codex runs over its MCP server / `codex exec`;
Gemini runs over `agy` conversations / `agy -p`. Nothing changes unless you set `cli`.

```json
{ "models": {
    "review":    { "cli": "agy", "model": "gemini-3.8-flash-high" },
    "planning":  { "cli": "agy", "model": "gemini-3.8-flash-high" },
    "implement": { "cli": "agy", "model": "gemini-3.8-flash-high" },
    "implement_fallback": { "cli": "agy", "model": "gemini-3.1-pro-high" } } }
```

```bash
CODEX_PAIRED_CLI=agy CODEX_PAIRED_MODEL=gemini-3.8-flash-high claude   # everything on Gemini
CODEX_PAIRED_CLI_IMPLEMENT=agy CODEX_PAIRED_MODEL_IMPLEMENT=gemini-3.8-flash-high claude   # Gemini writes, Codex reviews
```

For `agy` the model id carries the effort (`gemini-3.8-flash-high|medium|low`, `gemini-3.1-pro-high|low`);
the role's `effort` is derived from that suffix and overrides inherited efforts. Gemini reviewer
runs execute in a throwaway checkout, never your working tree. Each `agy` call loads a large
context (80–135k input tokens even for small prompts), so per-turn cost is higher than Codex.

Overrides, later wins: defaults ← `.codex-paired/project.json` `models` ← env.

```json
// .codex-paired/project.json (fragment — the file still needs version/app/live_verification)
{ "models": { "implement": { "model": "gpt-5.6-terra" }, "planning": { "effort": "max" } } }
```

```bash
# all roles
CODEX_PAIRED_MODEL=gpt-6-astra CODEX_PAIRED_REASONING=high claude
# one role (beats the global form)
CODEX_PAIRED_MODEL_IMPLEMENT=gpt-5.6-terra CODEX_PAIRED_REASONING_REVIEW=medium claude
```

Inspect what will actually run (and where each value came from):

```bash
node lib/codex-bridge/cli.js model-roles
codex-paired-doctor      # the "models" check prints role: model effort (source)
```

**Review panels (v0.19.0, opt-in).** By default one external reviewer checks each phase. To have
several review independently and require all of them to agree, list them per phase:

```json
// .codex-paired/project.json (fragment)
{ "review_panel": {
    "planning": [ { "cli": "codex" }, { "cli": "agy", "model": "gemini-3.8-flash-high" } ],
    "review":   [ { "cli": "codex" } ] } }
```

- `planning` covers the spec, the plan and autopilot's per-slice plan review; `review` covers slice
  reviews and documentation updates. Leave a phase out to keep its single reviewer.
- An entry without `model` uses that phase's model role when the CLI matches, otherwise the CLI's
  default (`gemini-3.8-flash-high` for `agy`). The same CLI with two different models counts as two
  reviewers; the same model twice is rejected.
- Env override: `CODEX_PAIRED_REVIEW_PANEL_PLANNING=codex,agy` (and `_REVIEW`).
- Check what will run: `node lib/codex-bridge/cli.js review-panel --phase planning --repoRoot . --format status`.
- Every member must have its CLI installed and signed in; the review stops before round 1 otherwise.
- **Cost:** each extra member adds about one reviewer's usage per round, and a round lasts as long as
  its slowest member. Planning is where that is usually worth it. Gemini starts a fresh conversation
  every round with a short capped summary of earlier rounds (12,000 characters), so its cost per
  round stays flat instead of growing.
- Multi-member **review** panels are not supported on the `two-disjoint` and `hybrid-ui-backend`
  splits yet; those work items stop with `panel-unsupported-route` before creating anything.
- `doctor` warns when a reviewer is the same model as the one writing the code.

Why Sol: the Codex model catalog names `gpt-5.6-sol` as the migration target for the retired `gpt-5.5`. Switch to `gpt-5.6-terra` with the one-line override above if it suits your code better.

## Autopilot (v0.3.0+)

Run a double-SHIP'd implementation plan to completion unattended. The autopilot drives four phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with its own 7-round Claude↔Codex budget. State persists in the sidecar, so autopilot is **self-continuing**: re-running `/autopilot` resumes from where the last session left off — no external loop wrapper.

### Usage

```bash
# Start a plan (runs slices until done, a halt, or the session ends):
/autopilot docs/plans/<plan>.md

# Resume the in-progress run — handoff-friendly, no plan path needed:
/autopilot

# Optional: drive it on a timer with the built-in /loop skill:
/loop /autopilot
```

Handing off to a brand-new session is just running `/autopilot` again — it finds the in-progress run
in the sidecar and resumes. On a real blocker it halts with an actionable hint; fix the cause and
re-run `/autopilot`.

### Prerequisites
- A double-SHIP'd plan (run through `codex-paired-superpowers:writing-plans` first).
- The plan's frontmatter references the spec path.
- The spec has a sidecar with a `codex_session` threadId.

### Provenance hook
While autopilot is running, a PostToolUse hook on `git commit` checks the Commit Conventions. As of v0.7.0 the check is subject-only: subject must match `(feat|test|fix|docs|refactor|chore)(slice:N):` where N matches `autopilot.current_slice`. The previously-required `Co-Authored-By: Claude` trailer is no longer required — commits with or without it pass. The hook fires AFTER the commit (PostToolUse can't prevent it) — non-conforming commits land but the hook exits non-zero, signaling the autopilot to halt with `external-commit-detected`. The user can then `git reset` to remove the offending commit. The hook is silent when autopilot isn't running.

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
│   ├── worktree.js                    # v0.7.0: worktree primitives + symlink bootstrap
│   ├── reconciler.js                  # v0.7.0: git state as authoritative truth
│   ├── worktree-integrate.js          # v0.7.0: ordered cherry-pick + patch-id resume
│   └── prompts/                       # L11 rubric + verdict format + pre-SHIP checklist
├── agents/                            # v0.7.0: plugin subagent definitions
│   ├── slice-implementer-codex.md     # Codex MCP dispatch in fresh thread
│   └── slice-implementer-sonnet.md    # direct Sonnet implementation
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
cd path/to/codex-paired-superpowers
npm ci                                # dev deps only (typescript, @types/node, ajv); runtime deps are vendored
npm test                              # typecheck + vendored/bash-3.2 guards, then all bridge tests
npm run test:shell                    # shell suites (bash 3.2 compatible)
npm run test:fresh-clone              # isolated fresh-clone smoke with fake CLIs
```

Spec: `docs/specs/2026-05-07-codex-paired-superpowers-design.md`
Plan: `docs/plans/2026-05-07-codex-paired-superpowers.md`

## Phase E live verification (v0.6.0+)

Autopilot adds a fifth phase between `docs-update` and `slice-shipped`: **Phase E** launches the actual app via per-project `.codex-paired/project.json` config, drives Codex-generated user-visible scenarios through Claude Code's native `/computer-use` (macOS only), captures evidence (screenshots + bounded logs) per scenario, runs a same-SHA flake retry before fix-loop entry, and reruns ALL slice scenarios after any fix-subagent commit.

Full spec: [`docs/specs/2026-05-08-v0.6.0-live-verification.md`](docs/specs/2026-05-08-v0.6.0-live-verification.md).

Fixture proof-point: [`tests/smoke/live-verification-fixture/`](tests/smoke/live-verification-fixture/) — a tiny Node web app with an intentional Save Display Name bug. When autopilot runs against this fixture with `/computer-use`, Phase E catches the bug, drives the fix-subagent, reruns all scenarios, and ships only after evidence double-SHIP.

## Status

v0.19.0 — opt-in review panels with strict unanimity (independent members, no vote, no tiebreaker), safe cleanup of checkouts left by crashed runs (ownership and preservation markers, fail-closed `worktree-reap`, `doctor` checks), and the repository-wide prune removed from review teardown. Built through the pipeline itself: the spec and plan were approved unanimously by a three-voice panel (Claude, Codex, Gemini), and every slice was implemented by Codex and approved by Claude and Codex on the same commit.

Prior: v0.18.0 — robust on other people's machines: gradual strict JSDoc type checking with an explicit allowlist, a pinned public API contract with an AST-extracted CLI surface and import-closure digests, CI on macOS + Linux across Node 20–26, a bounded fresh-clone smoke, vendored-dependency and bash-3.2 guards. Built through the pipeline itself (spec: 7 rounds, plan: 3 rounds, slices implemented by Codex on GPT-5.6 Sol, reviewed by Claude then Codex on GPT-6 Astra).

Prior: v0.16.0 — model roles for the GPT-6 era: Codex writes the code (GPT-5.6 Sol high → GPT-6 Astra medium → Sonnet), Claude reviews first, both SHIP the same commit; planning on GPT-6 Astra xhigh; two threads per feature; durable attempt evidence + resume; doctor model/transport checks. Built by dogfooding the pipeline itself (spec: 5 rounds, plan: 7 rounds, slices implemented by Codex on GPT-5.6 Sol and reviewed by Claude then Codex).

Prior: v0.15.0 — reliability release driven by transcript/sidecar replay of ten days of real usage: honest-reporting hook false-positive surgery (message-wide evidence, quoted-mention stripping, stop-loop guard, marker lifecycle), hang detection for Codex dispatches (auth-aware availability probe, bounded cli-harness rule, stall watchdog + empty-reply protocol), sink-side round validation (shape/sequence/budget/SHIP-audit gates moved out of the fail-open hook regex), and stale-run surfacing (`sidecar-scan-stale`).

Prior: v0.7.3.2 — model-invariant hardening (skill docs); v0.7.3.1 hook architecture intact, release-gate INCONCLUSIVE in Claude Code 2.1.138 (Task tool lacks the `cwd` parameter the hook design relies on; doesn't invalidate the architecture — see `docs/verification/v0.7.3.1-hook-fires.md`).

### Changelog

- **v0.19.0** — review panels and crash cleanup.
  - **Review panels:** `review_panel.{planning,review}` in `project.json` (or
    `CODEX_PAIRED_REVIEW_PANEL_*`); resolver and `review-panel` verb (`--format status` adds
    `configured`); sidecar `panel_roster`, member-id audit sides and a shared panel validator on both
    append paths (the aggregate `codex` verdict is derived, never trusted); strict-unanimity reducer
    (`panel-reduce`); fresh-conversation Gemini members with a bounded replay (`panel-replay`,
    `review-panel-member`); `panel-preflight`; route check for splits that cannot host a panel.
    Unconfigured projects are byte-identical.
  - **Crash cleanup:** ownership and preservation markers in each checkout's git admin directory;
    `checkout-preserve`; `worktree-reap` (list by default, `--apply` removes one safe checkout at a
    time, re-checking every condition immediately before each removal); `doctor` `worktrees` and
    `review-panel` checks; autopilot halts preserve the checkouts they keep.
  - **Fix:** review teardown removes only its own checkout (no repository-wide prune).

- **v0.18.0** — robustness for other people's machines.
  - **Type checking:** `tsconfig.json` (`checkJs: false`, `strict`), `typecheck.allowlist.json`,
    `scripts/typecheck.mjs` (TypeScript API; allowlist injected as `files`; effective-program and
    directory reconciliation of `@ts-check` pragmas in both directions; listed files must have
    effective checking enabled; exits 0/1/2); `lib/codex-bridge/types.js` shared typedefs; 15
    public-surface owners annotated under `strict` with no behaviour change; contract tests pin the
    previously-checked signatures (JSDoc overloads keep required fields public).
  - **Public API:** `docs/public-api.md` with seven `public-api:<section>` blocks; `scripts/cli-surface.mjs`
    (AST flag/exit/stdout extraction, `unsupported`/`manual` entries, import-closure + registry
    expansion, module/input digests, `--digest --write`); `tests/contract/public-api.test.js` executes
    every inventoried case and eight negative controls; project-config loader characterized, not changed.
  - **Portability:** `doctor` `platform` check (FAIL off macOS/Linux) and CI-tested majors in the
    `node` check; `scripts/check-vendored-deps.mjs` (tracked package roots vs lockfile runtime
    closure), `scripts/check-bash32.mjs`; dev deps (`typescript`, `@types/node@20`, `ajv`) never
    vendored; `node_modules/.package-lock.json` untracked; `.github/workflows/ci.yml` (ubuntu +
    macos × Node 20–26).
  - **Fresh-clone smoke:** `scripts/fresh-clone-smoke.{sh,mjs}` + `npm run test:shell`
    (`scripts/run-shell-tests.sh`); fake-CLI modes `FAKE_CODEX_COMMIT=1` and `FAKE_AGY_RECORD`;
    hard deadline, cancellation cleanup, cwd-ownership descendant reaping, canonical-path isolation.
- **v0.16.0** — model roles for the GPT-6 era.
  - **One source of truth** (`lib/codex-bridge/models.js`, `model-role` / `model-roles` CLI verbs,
    `models` block in `project.json`, `CODEX_PAIRED_*` env): four roles, atomic resolution, no literals
    on any live path; the MCP server pin is a default only — skills pass the resolved role.
  - **Codex writes the code:** dispatcher registry prefers Codex everywhere; three-rung ladder
    (`implement` → `implement_fallback` → Sonnet); wrapper `--model-role` resolves flags, writes the
    snapshot into the status file before spawning, and exits 78 (terminal, no reset/fallback) on a
    config error or a conflicting `-m`; `--add-dir <repo>/.git` so sandboxed Codex can commit in a
    worktree.
  - **Claude reviews first:** Step C0 findings, at most two `runFixPass` passes checkpointed at
    `fix_start_sha`, `reviewed_sha` on audits with `--headSha` enforced by one consolidated SHIP gate.
  - **Two threads per feature** (`paired-reviewer` at planning, `execution-reviewer` at review) with
    `thread_config`; recovery re-seeds at the lost thread's config; seed prompts tell Codex to read
    the spec and plan.
  - **Status + attempts:** `classifyStatusFile` / `decideImplementAction` / `applyImplementDecision`;
    `dispatchCodexCliImplementer` + `observeDirectCliAttempt` with attempt evidence files, terminal
    member events, `onLaunched` checkpoints, and in-flight-safe resume; `dispatchReviewerViaHarness`
    picks the model role by phase for every non-Claude reviewer.
  - **Doctor:** `models` and `codex-transport` checks.
- **v0.15.0** — reliability: hook false-positive surgery + hang detection.
  Driven by replaying 10 days of session transcripts, 106 Codex session
  logs, and 24 sidecars from real plugin usage.
  - **Honest-reporting hook:** evidence now counts anywhere in the message
    (was: same paragraph ±200 chars — the majority of 47 observed blocks
    were false positives on already-cited messages); short quoted mentions
    ("shipped") no longer re-trigger the hook during rewrites; bare
    confirmed/installed/released dropped from the lowercase vocabulary;
    `stop_hook_active` guard caps blocking at once per stop; new
    `honest-reporting-clear` verb + skills clear the marker on completion
    (TTL remains the backstop); slice worktrees resolve to the main repo
    marker; the no-marker fast path skips the node boot entirely and
    transcript reads are tail-bounded.
  - **Hang detection:** the codex availability probe now runs
    `codex login status` — an expired login (the leading suspect for two
    observed background-exec hangs of 25min and 3h24m) reports as NOT
    LOGGED IN instead of available; skills carry a hard rule that
    reviewer/panelist dispatches go through the bounded cli-harness (15min
    cap, stderr captured), never hand-rolled background `codex exec`; every
    Codex wait gets a deadline checked each turn; empty instant replies are
    retried with backoff instead of being read as verdicts.
  - **Sidecar integrity:** rounds are validated at the sink — shape
    (bare-integer corruption guard), sequential numbering, the 7-round
    budget (overruns of 11/13/15 rounds were observed via phase-key reuse),
    and SHIP-audit backing (relocated from the PreToolUse hook's shell-string
    regex, which `--round "$VAR"` bypassed). `--force-round` /
    `--allow-over-budget` are explicit, user-approved overrides. All cli
    JSON flags now fail with usage messages instead of JSON.parse crashes.
  - **Workflow round-savers:** commit-parity preflight before slice reviews
    (two full rounds had been burned on fixes left uncommitted); a
    consistency sweep before plan re-submissions (stale-count churn
    dominated late plan rounds); `sidecar-scan-stale` surfaces in-flight
    autopilot runs gone quiet (one sat silently resumable for 11 days).

- **v0.8.0** — domain-expert teammates. Adds a curated bundle of **7
  expert roles** that compose with the existing Codex L11 reviewer: `ui`,
  `ux`, `architecture`, `backend`, `ai-harness`, `test`, `security`. Each
  role is a Claude-driven Agent dispatch with its own mailbox-rooted inbox
  (e.g., `expert-ui` peer-DMs `expert-ux` via the existing v0.7.3.1
  mailbox primitive). No native agent-teams runtime dependency — works on
  any Claude Code version where `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  is not available.

  **File map.** Curated expert prompts ship at
  `lib/codex-bridge/prompts/expert-*.md`; users override by placing
  `<repo>/.codex-paired/experts/<role>.md` in their project. The
  `lib/codex-bridge/expert-runtime.js` facade exposes the 5-method
  TeammateRuntime interface (`resolveIdentity`, `selectTeammates`,
  `runTurn`, `pollInbox`, `archive`) so a future native Agent-Teams
  adapter can swap the facade transparently.

  **Phase inserts.** Autopilot Phase B gains 4 new sub-phases (per
  `skills/autopilot/SKILL.md`):
  - **B.0.5** — expert composition: Claude infers experts from spec
    signal, validates fan-out (>=6 experts requires a rationale entry
    in sidecar's `expert_teammates.fan_out_rationales[]`).
  - **B.1.5** — optional expert pre-review before implementation
    dispatch.
  - **B.4.5-update** — between-turns polling now ALSO scans active
    expert inboxes; unread mail schedules B.5.5 drain.
  - **B.5.5** — expert post-review + peer-DM drain scheduler with caps
    (max 2 respawns per expert; max 8 total expert turns per drain).

  **Sentinel-halted-dispatch pattern.** Pre-dispatch expert blockers
  append a sentinel dispatch record so `updateDispatchExpertBlocker`
  resolves uniformly across pre- and post-dispatch findings. After the
  sentinel is appended, halt with `expert-blocker-open` — which
  PRESERVES the expert's mailbox per the archival policy below.

  **Override authority.** Claude can technical-override expert blocking
  findings only with concrete evidence (file path / line / command
  output / reconciler result); product/UX/business overrides require
  explicit human authorization (halt `expert-blocker-needs-user`).
  Rubber-stamping a non-technical override is a contract violation —
  the rationale field is auditable.

  **Caps.** Max 2 respawns per expert per slice; max 8 total expert
  turns per B.5.5 drain. Cap-exceeded halts with
  `expert-peer-dm-drain-cap-exceeded` (PRESERVES mailboxes).

  **Halt-reason archival policy.** `lib/codex-bridge/expert-archive.js`
  implements the halt-reason-driven policy from spec §Mailbox Archival.
  ARCHIVE (drain + rotate) for `completed`, `abandoned-by-user`.
  PRESERVE (keep for resume/debug) for `external-commit-detected`,
  `slice-blocker-from-mailbox`, `expert-blocker-open`,
  `expert-peer-dm-drain-cap-exceeded`, `subagent-dispatch-failed`,
  `reconcile-failed`, `validation-failed`, `user-input-required`.
  Unknown halt reasons throw `ExpertArchiveError` code
  `unknown-halt-reason` — the set must be extended deliberately.

  **Compatibility.** This is a plugin-only recreation of the
  agent-teams pattern (no native Anthropic Agent-Teams API dependency).
  A `NativeTeammateRuntime` adapter is deferred to a future release
  once Claude Code exposes a programmatic Agent dispatch surface.

  **Codex-paired discipline shipped this feature.** Spec hardened in 2
  Codex rounds; implementation plan in 6 Codex rounds; per-slice review
  caught 9+ real bugs across all 7 slices before they reached the
  trunk. Slice 7 ships the release-gate smoke as a manual user
  procedure (per spec §9.3 escape hatch) because the Agent/Task surface
  is exposed only inside a live Claude Code session — see
  `docs/verification/v0.8.0-domain-experts.md` for the procedure.

- **v0.7.3.2** — patch: harden the model invariant in skill docs after a
  real-world tool-call card showed Claude passing `model: "gpt-5.2-codex"`
  to the codex MCP tool instead of `gpt-5.5`. Root cause: the codex MCP
  tool's schema description includes `gpt-5.2` and `gpt-5.2-codex` as
  example values (stale references from the upstream codex CLI's
  docstring), and Claude was treating them as documentation hints rather
  than docstring examples — silently using one as the literal `model`
  argument. Failure mode is sticky: model is locked at thread-creation
  time, every `codex-reply` inherits it, the whole feature's review loop
  runs on the wrong model.

  Three skill files updated with prominent ⚠️ MODEL INVARIANT callouts:

  - `skills/brainstorming/codex-pairing.md`: new section right after the
    tool table; explicitly names gpt-5.2/gpt-5.2-codex as stale examples
    NOT to use; notes the post-creation-immutability of the thread model.
  - `skills/brainstorming/SKILL.md`: the JSON example already had
    `gpt-5.5`, now preceded by a strong "do NOT substitute schema-
    description example values" warning plus a "Critical — model
    invariant" paragraph explaining the failure mode.
  - `skills/systematic-debugging/SKILL.md`: this was the actual leak path
    (standalone bug → new thread, but no model guidance). Added explicit
    MODEL INVARIANT paragraph requiring `gpt-5.5` + high reasoning when
    opening a fresh thread.

  Autopilot was checked — it only uses `codex-reply` (no model
  parameter; inherits the thread's locked model), no new-thread path to
  harden there.

  No code changes; the bug is in Claude's interpretation of an upstream
  schema description. Doc-only patch.

- **v0.7.3.1** — closes the auto-delivery gap from v0.7.3. The mailbox proved
  coordination works empirically, but agents had to remember to poll between
  tool calls; v0.7.3.1 delivers messages automatically.

  **Sonnet auto-injection (PostToolUse hook).** `hooks/mailbox-inject.sh` →
  `lib/codex-bridge/hook-mailbox-inject.js`. The hook fires on
  Bash/Edit/Write/Read inside Task subagents, infers the slice identity from
  the subagent's `cwd` (right-to-left scan for `.git-worktrees/slice-N` with
  `.codex-paired/` sibling validation), reads the slice's unread inbox, and
  emits a `<codex-paired-pending-messages>` block via Claude Code's
  documented `hookSpecificOutput.additionalContext` channel. After the
  stdout flush completes, the hook marks the delivered messages read in a
  single batched lockfile acquisition.

  **Pre-injection at dispatch time.** The orchestrator pre-injects any
  already-queued messages into the dispatch prompt before invocation,
  guaranteeing zero-loss delivery even for the start-of-run case. The
  wrapper trailer differs intentionally from the hook's: pre-injected
  messages are NOT marked read until terminal result ("queued for you …
  NOT yet marked read"), so a crashed dispatch retries deliver the same
  messages. Dispatch records gain an `injected_message_ids` field
  (validated in `appendImplementDispatch`); Phase B.4.5 polling skips ids
  present there to avoid racing terminal-result mark-read ownership.

  **Codex cooperative checkpoints.** Codex transport stays cooperative
  (subprocess opacity precludes mid-run injection). The dispatch prompt
  body now lists five named semantic checkpoints — start, before-test,
  before-commit, after-long-cmd, before-final-response — at which the
  codex agent calls `mailbox-read --unread` and `mailbox-mark-read-batch`.
  Explicitly NOT pre-edit (that trains ritual polling).

  **Batch helper + CLI.** `markManyAsRead(repoRoot, sliceId, messageIds)`
  in `lib/codex-bridge/mailbox.js` does a single-lock batch with
  dedupe-by-first-occurrence, input-order results, and idempotent
  re-delivery (already-read ids preserve their original `read_at`). Exposed
  as `mailbox-mark-read-batch --for --actor --message-ids <CSV> [--repoRoot]`.
  Strict format regex `msg-YYYY-MM-DDTHH-MM-SS-mmmZ-NNNN` validates each
  CSV part at the CLI boundary; malformed ids reject the whole batch
  before any helper invocation (no partial mutation).

  **Debug env hatch.** `CPS_HOOK_DEBUG=1` in the Claude Code environment
  surfaces wrapper-level failures (node missing, module missing, syntax
  error, non-zero exit) to stderr (Claude Code logs hook stderr without
  injecting it into the subagent prompt). Production path is silent.

  **Cost.** Hook cold-start ~110ms per Bash/Edit/Write/Read tool call,
  whether the subagent is in a slice worktree or not. A 50-tool-call
  non-slice subagent (code-reviewer, explore, etc.) adds ~5-6s wall-clock.
  Future optimization candidates: compiled wrapper or long-lived daemon.

  **Concurrency characteristic (Linux).** Same-slice racing hook fires
  may each deliver the same message before any mark-read commits —
  duplicate delivery, not data loss (spec §5.4 explicitly accepts this).
  Cross-slice races are race-free because each slice has its own inbox
  file. The `read → emit → mark-read` ordering is the worker-sees-bytes-
  first invariant that requires releasing the lock between read and mark.

  **Doctor preflight + public-repo layout.** `bin/codex-paired-doctor`
  (also exposed as `/codex-paired-superpowers:doctor`) checks 8
  prerequisites (Node version, codex CLI, codex auth, git version,
  vendored deps, bridge-CLI loadability, hooks, project state dir) and
  prints exact fix commands for any failure. All user-facing skill
  files (`brainstorming`, `autopilot`, `writing-plans`, `test-driven-development`,
  `systematic-debugging`, `receiving-code-review`, `subagent-driven-development`)
  now reference the doctor as the recovery path for setup-failure error
  patterns. `.claude-plugin/marketplace.json` makes the repo a
  single-plugin self-marketplace so users can install via
  `claude plugin marketplace add <owner>/codex-paired-superpowers`.

  Spec hardened across 5 Codex review rounds (3 REVISE + 2 SHIP).
  L11 validation pass on all 7 slices including hook coexistence smoke
  (`tests/smoke/hooks-coexist.sh`), cross-slice concurrency smoke
  (`tests/smoke/hooks-cross-slice-concurrency.sh`), Linux smoke via
  Docker, sidecar backward-compat with v0.7.3 records. Release gate:
  manual live Task-subagent verification per
  `docs/verification/v0.7.3.1-hook-fires.md`.

- **v0.7.3** — Three coupled features unlock "as many parallel agents as the
  dependency graph allows, without overlap":

  **File-based mailbox** for orchestrator ↔ in-flight slice agents and
  slice ↔ slice messaging during execution. Persistent JSON inboxes per
  recipient at `<repo>/.codex-paired/mailboxes/<recipient>.json`. Atomic
  via `proper-lockfile` (50-retry policy with jittered backoff +
  stale-lock recovery). Per-recipient archive rotation when
  `mailbox.max_bytes` exceeded; unread messages always carried forward
  (all-unread overflow halts `mailbox-overflow-unread`). 3 CLI
  subcommands: `mailbox-write`, `mailbox-read`, `mailbox-mark-read`.
  `--actor` permissions enforce who can read/mark inboxes.

  **`**DependsOn:**` directive** in plan frontmatter — explicit DAG
  of slice dependencies. Block form, parsed by
  `lib/codex-bridge/plan-parsers.js`. Cycle/unknown-slice/self-reference
  validated at parse time + DAG construction.

  **Dependency-graph batching** (`lib/codex-bridge/dependency-graph.js`)
  replaces v0.7.1's consecutive-slice batching. Phase B.2 computes the
  *ready-set* (pending slices whose every dep has shipped) and dispatches
  the *deterministic first-fit non-overlap subset*. Non-consecutive
  slices can now parallelize when both deps and Files allow.

  **DAG digest persistence + revalidation.** SHA-256 digest stored in
  sidecar `autopilot.dependency_graph` block; verified at every Phase B
  turn / resume. Plan edits mid-run halt `plan-changed-during-autopilot`.

  **Failure cascade.** On any slice's `failed-halted` outcome, the
  autopilot run halts with `dependency-cascade-halt` listing transitive
  descendants (BFS over reverse adjacency). User investigates; resume
  re-validates DAG digest.

  **NEW HALT REASONS:**
  - `dep-block-malformed` — DependsOn block syntax invalid
  - `dep-unknown-slice` — DependsOn references missing slice id
  - `dep-self-reference` — Slice depends on itself
  - `dep-cycle` — Cycle in dep graph (diagnostic includes cycle path)
  - `plan-changed-during-autopilot` — DAG digest mismatch on resume
  - `mailbox-corrupt` — Inbox JSON unparseable (corrupt file archived)
  - `mailbox-overflow-unread` — All-unread overflow; user must intervene
  - `mailbox-recipient-malformed` — Path-traversal guard in recipient name
  - `mailbox-lock-timeout` — proper-lockfile retry budget exhausted
  - `mailbox-permission-denied` — Actor cannot read/mark another inbox
  - `dependency-cascade-halt` — Slice failed; descendants enumerated
  - `slice-blocker-from-mailbox` — Unread `BLOCKER:` message in slice inbox

  **First runtime npm dep.** `proper-lockfile@^4.1.2`. Distributes through
  the v0.7.0 worktree-bootstrap symlink path (`node_modules` is one of the
  default symlink candidates). Run `npm install` in the plugin dir on
  first use after pull.

  **Plan frontmatter:**

  ```markdown
  ## Slice 5: Some thing

  **Implementer:** codex
  **Domain:** backend
  **DependsOn:**
  - slice-3
  - slice-4
  **Files:**
  - lib/foo.js
  ```

  Existing v0.7.2 plans without `**DependsOn:**` directive default to
  no deps (empty array). Backward-compatible.

- **v0.7.2** — LocalShell migration for codex dispatch. Removes the
  10-minute synchronous Bash timeout cap that was killing legitimate
  long-running codex slices. Architectural changes:

  **Codex no longer ships as a subagent.** `agents/slice-implementer-codex.md`
  is removed. The codex contract moved to `docs/codex-implementer-contract.md`
  (referenced by the registry but NOT a Claude Code subagent file).

  **Transport-aware registry.** `agents/dispatchers.json` schema is now
  transport-specific:

  - `transport: claude-subagent` → entry requires `agent` field, NOT `contract`.
  - `transport: codex-background-bash` → entry requires `contract` field, NOT `agent`.

  v0.7.2 registry:

  ```json
  "codex":  { "transport": "codex-background-bash",  "contract": "docs/codex-implementer-contract.md", "tools": ["Bash"], ... }
  "sonnet": { "transport": "claude-subagent",         "agent": "slice-implementer-sonnet",            "tools": ["Read","Edit","Write","Bash"], ... }
  ```

  **Orchestrator-level codex dispatch.** Phase B.4 dispatches codex via
  `Bash run_in_background:true` calling `scripts/codex-exec-with-status.sh`,
  a wrapper that captures `{exit_code, started_at, completed_at, signal}`
  to a JSON status file. The status file is durable on-disk evidence — it
  survives orchestrator session termination, unlike Claude Code's in-memory
  Bash task registry. Crash mid-batch is recoverable.

  **Runtime bounds.** Per-project `.codex-paired/project.json` gains:

  ```json
  {
    "codex_dispatch": {
      "max_runtime_ms": 7200000,
      "log_max_bytes": 1048576
    }
  }
  ```

  Defaults: 2-hour kill threshold, 1 MB sidecar log-summary cap. Codex tasks
  exceeding `max_runtime_ms` are killed (SIGTERM + SIGKILL after 5s grace);
  halt code `codex-background-timeout`.

  **Sidecar gains async-dispatch fields.** `phases.implement.dispatches[]`
  entries now support `transport`, `task_id`, `output_file`, `status_file`
  + a new `outcome: "in-progress"` for background-dispatched but
  not-yet-reconciled state. New `finalizeImplementDispatch()` API
  promotes in-progress entries to terminal outcomes by `task_id` match.

  **New halt reasons:**

  - `codex-background-task-lost` — orchestrator crashed AND no status
    file evidence; cannot infer codex's terminal state.
  - `codex-background-timeout` — codex exceeded `max_runtime_ms`;
    orchestrator killed it.

  **Empirical performance (carry forward from v0.7.0):** two parallel
  shell `codex exec` processes complete in 18s vs 30s single-call
  baseline — true parallelism, well below the spec's 1.5× threshold.

- **v0.7.1** — domain-aware routing. Adds `agents/dispatchers.json` registry
  declaring which implementers are `forbidden` / `allowed` / `preferred` for
  each slice domain (`ui`, `ai-harness`, `backend`, `general`).
  `lib/codex-bridge/dispatchers.js` exposes `getDispatcher(implementer)` and
  `enforceDomainPolicy(implementer, domain)` for orchestrator lookup. The
  loader also validates that registry tools/agent-name exactly match agent
  frontmatter — drift throws at load time.

  **Domain policy as data.** The shipped policy:

  | | UI | AI-harness | Backend | General |
  |---|---|---|---|---|
  | **Codex** | forbidden | forbidden | preferred | allowed |
  | **Sonnet** | preferred | preferred | allowed | preferred |

  Codex is forbidden for UI/UX work (visual judgment) and AI-harness work
  (skills, agents, hooks, `lib/codex-bridge/` — the systems that govern Codex
  itself). Backend stays Codex-default. Mixed/unclear stays Sonnet-default.

  **New plan frontmatter:** `**Domain:**` directive (optional). Allowed values:
  `ui`, `ai-harness`, `backend`, `general`. If absent, Claude infers from the
  slice's `**Files:**` paths via heuristics (`web/`, `app/`, `*.tsx`, `*.css`
  → ui; `skills/`, `agents/`, `hooks/`, `lib/codex-bridge/`, `*.skill.md` →
  ai-harness; otherwise backend or general). Strongest signal wins on
  multi-signal slices, in priority order: ui > ai-harness > backend > general.

  **Behavior change vs. v0.7.0:** the `**Implementer:**` directive is no
  longer "honored unconditionally". It is honored only when the registry
  permits the (implementer, domain) pair. `**Implementer:** codex` on a
  `**Domain:** ui` slice now halts `domain-policy-violation` before any
  worktree setup. The user must change either the directive or the slice's
  domain. v0.6.0 / v0.7.0 plans without `**Domain:**` directives are
  inferred — most existing plans will continue to work, but plans that
  explicitly set `**Implementer:** codex` for slices that infer to `ui` will
  halt under v0.7.1. Fix by adding `**Domain:** backend` if the slice is
  genuinely backend, or by removing the implementer directive.

  **New halt reasons:**

  - `domain-policy-violation` — directive selects a forbidden implementer
    for the slice's domain. User explicitly picked the forbidden combo.
  - `domain-policy-ambiguous` — domain inference can't pick between
    plausible domains AND the chosen implementer is forbidden in some.
    User must add `**Domain:**`.
  - `domain-directive-malformed` — bad value in `**Domain:**` line.
  - `dispatcher-registry-malformed` — registry/agent-frontmatter drift or
    schema violation. Caught at load time.

  Distinction from `implementer-unavailable`: a `domain-policy-violation`
  means the user picked the forbidden combo. `implementer-unavailable` means
  the user didn't pick it; policy blocked the fallback after the preferred
  implementer failed.

- **v0.7.0** — implementer routing. Phase B becomes a routing dispatch instead
  of a hard-coded Sonnet subagent path. Default implementer is Codex; Sonnet is
  the fallback. Halts with `implementer-unavailable` only when both fail.
  Implementation runs as Claude Code subagents shipped with the plugin
  (`agents/slice-implementer-codex.md`, `agents/slice-implementer-sonnet.md`).
  Consecutive slices with non-overlapping `**Files:**` sets dispatch
  concurrently, each in its own bootstrapped git worktree at
  `<repo>/.git-worktrees/slice-<N>`. Mixed Codex/Sonnet parallel batches are
  allowed. Integration is via ordered cherry-pick from each slice branch onto
  the integration branch, with `git patch-id`-based resume detection.
  Provenance hook is now subject-only — the `Co-Authored-By: Claude` trailer
  is no longer required (existing trailer-bearing commits still pass).
  Architecture pivot: routing decisions live in `skills/autopilot/SKILL.md`
  prose; mechanical state (worktrees, sidecar, reconciler, integration) lives
  in `lib/codex-bridge/` Node modules. Reconciler is the source of truth for
  `head_sha`, `commit_count`, and non-conforming commit detection — subagent
  JSON status is advisory.

  **Plan frontmatter directives.** Slices may declare:

  - `**Implementer:** codex` — preferred Codex.
  - `**Implementer:** sonnet` — preferred Sonnet.
  - (no directive) — defaults to Codex.

  Allowed values are exact lower-case `codex` or `sonnet`. Literal `auto`,
  empty value, mixed case, or any other value halts with
  `implementer-directive-malformed` before any worktree setup.

  Parallel-candidate slices must declare a `**Files:**` block:

  ```markdown
  **Files:**
  - lib/codex-bridge/foo.js
  - tests/codex-bridge/foo.test.js
  ```

  Paths must be exact repo-relative file paths — no globs, no directories with
  trailing `/`, no absolute paths, no traversal segments, no backslashes, no
  duplicates, no inline form. Any malformed Files block halts with
  `parallel-files-malformed`; missing on a parallel candidate halts with
  `parallel-files-missing`. Overlapping Files sets across consecutive
  candidates force serial execution (no halt).

  **Parallel dispatch.** When the candidate window passes the checklist and
  Files sets do not overlap, the orchestrator issues all subagent dispatches
  in a single assistant turn using Claude's parallel-tool-call mechanism.
  Serial `await` across separate turns is non-conforming. The empirical
  parallel smoke at `tests/smoke/implementer-routing-parallel.sh` asserts
  total wall-clock under 1.5x the single-slice baseline; failure indicates
  serialized dispatch.

  **Commit-convention change.** The required `Co-Authored-By: Claude` trailer
  is dropped. Subjects must still match
  `^(feat|test|fix|docs|refactor|chore)\(slice:N\): <description>` with the
  slice number matching `autopilot.current_slice`. The provenance hook now
  validates subject only; commit body is ignored.

  **Upgrade note for v0.6.0 projects.** Existing plans without
  `**Implementer:**` directives or `**Files:**` blocks continue to work —
  they default to Codex and run serially. No plan changes are required unless
  you want parallel dispatch. Existing trailer-bearing commits remain valid;
  the trailer is now optional, not forbidden.

  Spec hardened across 2 Codex review rounds; plan hardened across 2 rounds.
  Empirical parallel smoke gated behind `SMOKE_REQUIRES_CODEX=1` (real Codex
  MCP required; CI skips). Structural smoke at
  `tests/smoke/phase-b-routing-structural.sh` covers all halt reasons +
  routing paths with mocked outcomes.

  **v0.7.0 halt reasons** (each halts the autopilot with the named reason
  surfaced to the user):

  - `implementer-directive-malformed` — `**Implementer:**` value is `auto`,
    empty, mixed-case, or unknown.
  - `implementer-unavailable` — preferred and fallback implementers both
    failed (5 fallback triggers: MCP error, dispatch error, 10-minute
    timeout, zero commits, non-conforming commits, missing/malformed JSON).
  - `parallel-files-missing` — a parallel-candidate slice has no
    `**Files:**` block.
  - `parallel-files-malformed` — `**Files:**` block has invalid contents
    (inline form, glob, directory, absolute path, traversal, backslash,
    duplicate, or empty bullet list).
  - `worktree-path-conflict` — `<repo>/.git-worktrees/slice-<N>` already
    exists and is not a clean worktree for the same slice.
  - `worktree-gitignore-missing` — `.git-worktrees/` is not in `.gitignore`.
  - `worktree-create-failed` — `git worktree add` exited non-zero.
  - `worktree-bootstrap-failed` — required dependency symlink source missing
    OR sidecar `phases.implement.bootstrap.completed_at` marker missing.
  - `worktree-bootstrap-stale` — `verifyBootstrap` symlink reality check
    failed (missing, not-a-symlink, or wrong-target).
  - `worktree-reset-failed` — `git reset --hard <slice_start_sha>` failed
    during fallback recovery.
  - `worktree-cleanup-failed` — `git worktree remove` failed after
    successful integration.
  - `worktree-branch-cleanup-failed` — `git branch -D` failed after commits
    reachable from integration branch.
  - `worktree-merge-conflict` — ordered cherry-pick conflicted; `git
    cherry-pick --abort` ran; branch/worktree left in place.
  - `worktree-resume-ambiguous` — patch-id resume detected partial or
    order-broken integration.
  - `worktree-integration-empty` — source range empty after a supposedly
    shipped dispatch (broken upstream invariant).
  - `codex-blocked` — Codex implementation subagent reported `BLOCKED`.
  - `codex-needs-context` — Codex implementation subagent reported
    `NEEDS_CONTEXT`.
  - `subagent-blocked` — Sonnet implementation subagent reported `BLOCKED`.
  - `subagent-needs-context` — Sonnet implementation subagent reported
    `NEEDS_CONTEXT`.

- **v0.6.0** — live verification (Phase E). Autopilot adds a fifth phase between docs-update and slice-shipped: Phase E launches the actual app via per-project `.codex-paired/project.json` config, drives Codex-generated user-visible scenarios through Claude Code's native `/computer-use` (macOS only), captures evidence (screenshots + bounded logs) per scenario, runs same-SHA flake retry before fix-loop entry, and reruns ALL slice scenarios after any fix-subagent commit (no opinion-based coupling). Safety gate prevents surprise screen takeover (default `confirm_each_phase_e`; opt-in `scheduled_window`). New 13-key `live.*` validation rubric parsed by `live-validation-parse` CLI. Skip path via `live-verification: skip - <reason>` in plan slice frontmatter (validated by `parse-skip-frontmatter`). Spec hardened across 2 Codex review rounds; plan hardened across 4 rounds. Fixture proof at `tests/smoke/live-verification-fixture/`.

  v0.5.x was reserved for an e2e smoke milestone that became this v0.6.0 release; no v0.5.x exists.

- **v0.4.1** — parser-as-code + sidecar relocation. Validation-coverage parser extracted to `lib/codex-bridge/validation-coverage.js` with full defect taxonomy + 16 unit tests + 5 CLI tests. Three-way CLI exit codes (0=success, 2=parser defect, 1=infrastructure failure). Sidecars relocated to `<repo-root>/.superpowers-codex-paired/<relative-spec-path>.json` with auto-discovery via `git rev-parse`; legacy `<spec>.codex.json` falls back outside repos and emits one-time deprecation warning when stale. Migration script with two-phase state machine (preflight halts on ambiguity; Phase 2 executes only if clean) + 5 fixture-based shell tests. Spec hardened across 4 Codex review rounds; plan across 5.
- **v0.4.0** — validation rubric. Adds `lib/codex-bridge/prompts/validation-rubric.md` enforcing structured per-slice validation coverage. Phase A enumerates Tier-1 (10 subcategories) + Tier-2 (3 triggers) + optional Tier-3 (residual-risk for critical-tier slices) with evidence-backed N/A required. Phase C verifies Phase A's locked commitments via 4 keyed `rubric.*` bullets. Plan slices declare `Validation: light|standard|critical`. Loop's serialize() preserves SHIP critique for audit trail. Sidecar gains structured `validation_coverage` per phase. Hook fix: PostToolUse exits 2 (not 1) so stderr surfaces as system reminder; hooks.json schema corrected; stdin filter for git-commit-only. Backfill: 7 edge-case unit tests (malformed JSON in sidecar/anchor, regression guards) + autopilot structural smoke (re-runnable). Rubric hardened across 4 Codex review rounds.
- **v0.3.0** — autopilot. Multi-tier loop drives plans slice-by-slice unattended; per-slice phases (plan-slice + test-list review, implement, review-slice, docs-update); cross-session continuity via ralph-loop; provenance hook enforces Commit Conventions during active runs; sidecar gains nested phase state + autopilot block + atomic writes; system rubric gains pre-SHIP checklist. Spec hardened across 6 Codex review rounds; plan hardened across 6 Codex review rounds.
- **v0.2.0** — switched from `codex exec` subprocess transport to bundled `codex mcp-server` MCP transport. Long-lived process, native JSON-RPC, faster (no spawn-per-call, no session-log replay). Removed `lib/codex-bridge/invoke.js` and the `session-start`/`session-resume`/`run-loop` CLI subcommands. Skills now invoke `mcp__plugin_codex-paired-superpowers_codex__*` tools directly.
- **v0.1.1** — clarified round semantics in brainstorming SKILL.md; removed dead `initialArtifact` parameter from `runRoundLoop`.
- **v0.1.0** — first working release.

## v0.10.0 ecosystem notes

See [docs/integration/v0.10.0-ecosystem-notes.md](docs/integration/v0.10.0-ecosystem-notes.md) for namespace, sidecar reader, ralph-loop coupling, feature-dev coexistence, and PR attribution details.
