# Codex Implementer Contract (v0.7.2+)

**Reference doc** — not a Claude Code subagent file. Lives in `docs/`, not `agents/`.

This document defines the contract the autopilot orchestrator follows when dispatching `codex exec` for slice implementation. It is referenced by the dispatcher registry at `agents/dispatchers.json` (`contract` field for the codex entry).

## Why this is a contract, not a subagent

In v0.7.0–v0.7.1, codex dispatch went through a Claude Code subagent (`agents/slice-implementer-codex.md`) whose only job was to shell out to `codex exec`. The wrapper added no behavior of its own and put a 10-minute synchronous Bash timeout cap on every codex run.

v0.7.2 removes the subagent wrapper. The orchestrator (Claude in autopilot) invokes `codex exec` directly via the `Bash` tool with `run_in_background: true`. This pattern mirrors Claude Code's `LocalShellTask` (per `src/tasks/LocalShellTask/` in the runtime source) and supports unbounded codex runtimes (subject to a configurable `max_runtime_ms` safety bound).

Because the dispatch is no longer via a subagent, this file does not have YAML frontmatter and is not loaded by Claude Code's plugin runtime.

## Locked invocation (v0.16.0, CLI-aware since v0.17.0)

The orchestrator runs the implementer via the `scripts/codex-exec-with-status.sh` wrapper (the name
is historical; it launches whichever CLI the role names). The wrapper — not the orchestrator —
resolves the model and effort for the attempt's **model role** and inserts the flags; the
orchestrator never writes `-m` / `--model` itself. **The orchestrator picks the command from the
resolved role**: run `node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" model-role --role implement --format json`
and read `cli` — `codex` → the codex form, `agy` → the agy form. Wrapping the wrong CLI for the
role is a 78 (`model-role-conflicting-args`: "config says agy, command runs codex").

**Codex form:**

```bash
scripts/codex-exec-with-status.sh \
  <status-file-path> \
  --model-role implement \
  -- \
  codex exec \
    --skip-git-repo-check \
    -s workspace-write \
    -C <worktree-absolute-path> \
    --add-dir <repo-root>/.git \
    "<implementation prompt>" \
  </dev/null
```

**Antigravity (`agy`, Gemini) form (v0.17.0):**

```bash
scripts/codex-exec-with-status.sh \
  <status-file-path> \
  --model-role implement \
  --cwd <worktree-absolute-path> \
  -- \
  agy -p "<implementation prompt>" \
      --sandbox --dangerously-skip-permissions \
      --add-dir <repo-root>/.git \
      --output-format json --print-timeout 2h \
  </dev/null
```

The wrapper inserts `--model <id>` right after the `agy` token (`agy` has no `-C`, so `--cwd`
sets the working directory; `--print-timeout` should equal `codex_dispatch.max_runtime_ms`). On
timeout `agy` exits non-zero with a JSON body whose `status` is not `SUCCESS`; that is classified
`failed` (fallback), like a codex non-zero exit. The command token may be a path (`/opt/homebrew/bin/agy`)
or preceded by `env`/`VAR=value`; the wrapper compares the basename.

**`agy` permissions.** Headless `agy` cannot ask for approval, so the form above uses
`--sandbox --dangerously-skip-permissions`: no prompts, and the sandbox confines writes to the
worktree (plus the `--add-dir`). Observed 2026-09-18: writes outside the folder were blocked,
network access was allowed. With `--model-role` (always used by the recipes) the wrapper exits 78
with `agy-sandbox-required` when `--sandbox` is missing (only real flags count, never the `-p` prompt
text or anything after a bare `--`) or when `--sandbox=…` / `--dangerously-skip-permissions=…` is
used (a Go flag, so `--sandbox=false` would switch the sandbox off). With
`CODEX_PAIRED_AGY_PERMISSIONS=accept-edits` the wrapper removes `--dangerously-skip-permissions`
and inserts `--mode accept-edits`; commands must then match the user's own `agy` allow-list, and a
refused command ends the turn without a commit, so the attempt fails over to the next rung. Any
other value exits 78 with `agy-permissions-invalid`.

The second rung of the ladder passes `--model-role implement_fallback`. See
[docs/execution-model.md](execution-model.md) for the ladder.

Mandatory flags:

- `--model-role <implement|implement_fallback>` (wrapper option, before `--`) — the wrapper resolves
  the role through `lib/codex-bridge/cli.js model-role`, writes the resolved `model_role` / `model` /
  `effort` into the status file **before** spawning, and inserts `-m <model> -c model_reasoning_effort=<effort>`
  right after `codex exec`. If resolution fails, or the wrapped command already carries `-m`,
  `--model`, or a `model_reasoning_effort` override, the wrapper writes a status file with
  `exit_code: 78` and `error: "model-role-resolution-failed" | "model-role-conflicting-args"` and
  exits 78 without starting codex. Exit 78 is **terminal** for the orchestrator: no worktree reset, no
  next rung, no Claude fallback (halt reasons of the same names).
- `--skip-git-repo-check` — worktree git detection is unreliable in unattended runs.
- `-s workspace-write` — sandbox writes scoped to the worktree cwd.
- `--add-dir <repo-root>/.git` — a git worktree's metadata lives under the main repo's
  `.git/worktrees/<id>`, outside the worktree cwd; without this the sandbox blocks `git commit`
  (observed in the v0.16.0 dogfood run: the implementer finished but could not commit).
  **Trust boundary:** with `--add-dir <repo>/.git` (either CLI) plus Codex `workspace-write` or
  `agy --sandbox --dangerously-skip-permissions`, the implementer can run shell commands and write under the
  shared `.git` (refs, hooks). That is the same trust the v0.16.0 Codex contract already grants; it
  is not a sandbox against a hostile model. Never grant `--add-dir` beyond the repo's `.git`.
- `</dev/null` redirect — prevents codex from inheriting the parent shell's stdin and hanging under bash backgrounding.

**Do not use** `--dangerously-bypass-approvals-and-sandbox` — it bypasses the sandbox and would allow codex to escape the worktree.

### Member ids and the effective model

For Codex members in an `**Implementers:**` block (`adapter: codex-cli` or
`codex-background-bash`), the model segment of the `member_id` and the `model:` field are
**identity only** — a label that keeps existing plans, sidecars, worktrees and mailboxes valid. The
model that actually runs is the `implement` role, recorded on the attempt evidence
(`model_role`, `model`, `effort` on the dispatch record or the `started` event). Legacy plans whose
member ids name the retired previous-generation model keep working unchanged. Claude-cli / ollama members still use their `model:` field.

## Implementation prompt template

The `<implementation prompt>` argument passed to codex must include:

- **Slice id** — for example `slice-3`. Used in commit subjects.
- **Slice section text** — the full markdown for this slice from the plan, including its task list, `**Files:**` block, and any `**Implementer:**` directive.
- **Worktree absolute path** — for context; codex's cwd is already pinned via `-C`.
- **`slice_start_sha`** — the commit the worktree was branched from.
- **Phase A validation coverage** — tier + rubric coverage when available.
- **Required test/verification commands** — `npm test` or specific `node --test` invocation. Codex must run these before declaring done.
- **Commit Conventions** (see below).
- **Instruction:** "leave all changes committed before exiting."

The orchestrator composes this prompt as a single string and passes it as the final positional argument to `codex exec`.

## Commit Conventions

Codex must produce commits with subject-only conformance:

```
(feat|test|fix|docs|refactor|chore)(slice:N): <description>
```

Where `N` is the numeric portion of the slice id. Examples for `slice-3`:

```
feat(slice:3): add implementer routing worktree support
test(slice:3): cover bootstrap stale symlink detection
fix(slice:3): recover from empty integration range
```

Rules:

- Subject only. The provenance hook does not inspect the body.
- The `Co-Authored-By: Claude` trailer is **not required**. Presence is fine; absence is fine.
- The slice number in the subject must match the slice id codex was dispatched for. Wrong-slice subjects will be rejected by the reconciler as non-conforming and will trigger a fallback.

Codex must leave all changes committed before its process exits. Uncommitted edits will be detected by the reconciler as zero-commit output and will trigger fallback.

## Status file schema (v0.16.0 lifecycle)

The `scripts/codex-exec-with-status.sh` wrapper writes the status file **twice** when
`--model-role` is used: once before spawning (nonterminal) and once on exit (terminal).

Initial, nonterminal (`exit_code` is `null`):

```json
{
  "state": "started",
  "exit_code": null,
  "signal": null,
  "started_at": "2026-09-17T12:30:01.000Z",
  "completed_at": null,
  "model_role": "implement",
  "model": "gpt-5.6-sol",
  "effort": "high"
}
```

Terminal (the snapshot fields are preserved):

```json
{
  "state": "exited",
  "exit_code": 0,
  "signal": null,
  "started_at": "2026-09-17T12:30:01.000Z",
  "completed_at": "2026-09-17T12:34:56.000Z",
  "model_role": "implement",
  "model": "gpt-5.6-sol",
  "effort": "high"
}
```

On signal-killed exit (e.g., the orchestrator's max_runtime_ms timeout) `exit_code` is
`128 + signal` and `signal` is e.g. `"SIGTERM"`. A configuration failure writes `exit_code: 78`
plus `error`.

Readers classify the file with `classifyStatusFile` (`lib/codex-bridge/dispatch-status.js`): a
nonterminal file is polled only while the Bash task is known alive; otherwise it falls through to
the existing task-lost halt — a wrapper that dies after the initial write cannot hide task loss
until the timeout. Atomic write via temp+rename guarantees the orchestrator never reads partial
JSON during polling. The orchestrator copies `model_role` / `model` / `effort` from the status
file into the dispatch record; it never resolves them itself for this transport.

## Output file

The orchestrator generates a unique log file path per dispatch (e.g., `~/Library/Application Support/Inkling/diagnostics/codex-dispatch/<slice-id>-<timestamp>.log`) and passes it through Claude Code's Bash tool as the standard captured-output path. The output captures codex's stdout + stderr.

Output logs are bounded by `codex_dispatch.log_max_bytes` in `.codex-paired/project.json` (default 1 MB). Logs exceeding the bound are tail-truncated in sidecar summaries; the full file remains on disk for forensic inspection.

## Runtime bounds (v0.7.2 timeout)

Per-project configuration:

```json
{
  "codex_dispatch": {
    "max_runtime_ms": 7200000,
    "log_max_bytes": 1048576
  }
}
```

- `max_runtime_ms`: default 7200000 (2 hours). Codex tasks exceeding this are killed by the orchestrator (SIGTERM, then SIGKILL after 5s grace). Halt code: `codex-background-timeout`.
- `log_max_bytes`: default 1048576 (1 MB). Output logs above this are tail-truncated in sidecar references.

## Failure modes and orchestrator response

| Condition | Halt or fallback | Behavior |
|---|---|---|
| Codex exits 0 with conforming commits | success | Reconciler ships; orchestrator integrates. |
| Codex exits 0 with zero commits | fallback trigger | Reset worktree; next rung. |
| Codex exits 0 with non-conforming commits | fallback trigger | Cite SHA; reset worktree; next rung. |
| Codex exits non-zero (other than 78) | fallback trigger | Reset worktree; next rung (`implement_fallback`, then Sonnet). |
| Status file `exit_code: 78` (model-role resolution failed / conflicting args) | **halt** (terminal) | No reset, no next rung. Fix `.codex-paired/project.json` `models` or the `CODEX_PAIRED_*` env, re-run. |
| Codex exceeds `max_runtime_ms` | **halt** `codex-background-timeout` (terminal) | Orchestrator SIGTERM + SIGKILL after 5s; `decideImplementAction` classifies it `timeout` → `halt` with `halts.timeout` = `codex-background-timeout`, never `fallback` — the worktree is preserved for forensics, no reset, no next rung; the user decides whether to resume or re-run. (`implementer-attempt-timeout` is a different reason: the direct-CLI observer giving up on a still-live fan-out attempt.) |
| Status file missing AND Bash task lost (after orchestrator crash) | `codex-background-task-lost` | Halt with output_file path for forensics. User investigates. |
| Status file shows non-zero exit BEFORE orchestrator-side timeout fires | normal failure path | Reconcile; trigger fallback per outcome. |

## See also

- Spec §6 — Implementation Dispatch Model (v0.7.2 split)
- Spec §6.6 — Codex Implementer Contract (this section)
- Spec §6.7 — Codex Background Dispatch Runtime Bounds
- `scripts/codex-exec-with-status.sh` — the wrapper itself
- `tests/scripts/codex-exec-with-status.test.sh` — wrapper tests
- `agents/dispatchers.json` — registry entry references this contract
- `lib/codex-bridge/dispatchers.js` — loader that validates this contract path exists
