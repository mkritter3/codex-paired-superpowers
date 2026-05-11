# codex-paired-superpowers

Fork of six [superpowers](https://github.com/obra/superpowers) skills paired with Codex (GPT-5.5 high reasoning) as an L11 engineering partner.

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
| `subagent-driven-development` | Per-slice Codex review scoped to that slice's tasks; out-of-slice issues go to a Deferred list |
| `receiving-code-review` | Anti-rubber-stamp discipline for Codex verdicts |
| `systematic-debugging` | Codex reviews the root-cause hypothesis before the fix |
| `test-driven-development` | Codex reviews the test list before red-green-refactor |
| `autopilot` (v0.3.0+) | Runs a double-SHIP'd plan slice-by-slice unattended; 4 phases × 7-round budgets each |
| `doctor` (v0.7.3.1+) | Preflight diagnostic — verifies Node, codex CLI, git, vendored deps, hooks, and writeable state dir |

## Prerequisites

- **`codex` CLI v0.128.0+** on PATH, authenticated against an account with GPT-5.5 access. Install:
  ```bash
  # macOS / Linux (Homebrew):
  brew install openai/codex/codex

  # or via npm (cross-platform):
  npm install -g @openai/codex

  # then authenticate:
  codex login
  ```
  See [openai/codex on GitHub](https://github.com/openai/codex) for source, alternative installers (Docker, GitHub Releases), and version requirements.
- **Node.js v20+** on PATH (the bundled MCP server + the bridge CLI run as a Node subprocess; runtime deps are vendored in `node_modules/`, no `npm install` required).
- **`git` v2.5+** for worktree-based parallel slice dispatch (v0.7.0+).

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
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
npm test                              # all bridge tests, ~1s
```

Spec: `docs/specs/2026-05-07-codex-paired-superpowers-design.md`
Plan: `docs/plans/2026-05-07-codex-paired-superpowers.md`

## Phase E live verification (v0.6.0+)

Autopilot adds a fifth phase between `docs-update` and `slice-shipped`: **Phase E** launches the actual app via per-project `.codex-paired/project.json` config, drives Codex-generated user-visible scenarios through Claude Code's native `/computer-use` (macOS only), captures evidence (screenshots + bounded logs) per scenario, runs a same-SHA flake retry before fix-loop entry, and reruns ALL slice scenarios after any fix-subagent commit.

Full spec: [`docs/specs/2026-05-08-v0.6.0-live-verification.md`](docs/specs/2026-05-08-v0.6.0-live-verification.md).

Fixture proof-point: [`tests/smoke/live-verification-fixture/`](tests/smoke/live-verification-fixture/) — a tiny Node web app with an intentional Save Display Name bug. When autopilot runs against this fixture with `/computer-use`, Phase E catches the bug, drives the fix-subagent, reruns all scenarios, and ships only after evidence double-SHIP.

## Status

v0.7.3.1 — mailbox auto-delivery for Sonnet subagents (PostToolUse hook). All implementation slices shipped; live Task-subagent verification (release gate) is the only remaining step before tag.

### Changelog

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
