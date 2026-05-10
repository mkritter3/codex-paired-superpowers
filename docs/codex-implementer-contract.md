# Codex Implementer Contract (v0.7.2+)

**Reference doc** — not a Claude Code subagent file. Lives in `docs/`, not `agents/`.

This document defines the contract the autopilot orchestrator follows when dispatching `codex exec` for slice implementation. It is referenced by the dispatcher registry at `agents/dispatchers.json` (`contract` field for the codex entry).

## Why this is a contract, not a subagent

In v0.7.0–v0.7.1, codex dispatch went through a Claude Code subagent (`agents/slice-implementer-codex.md`) whose only job was to shell out to `codex exec`. The wrapper added no behavior of its own and put a 10-minute synchronous Bash timeout cap on every codex run.

v0.7.2 removes the subagent wrapper. The orchestrator (Claude in autopilot) invokes `codex exec` directly via the `Bash` tool with `run_in_background: true`. This pattern mirrors Claude Code's `LocalShellTask` (per `src/tasks/LocalShellTask/` in the runtime source) and supports unbounded codex runtimes (subject to a configurable `max_runtime_ms` safety bound).

Because the dispatch is no longer via a subagent, this file does not have YAML frontmatter and is not loaded by Claude Code's plugin runtime.

## Locked invocation

The orchestrator runs codex via the `scripts/codex-exec-with-status.sh` wrapper:

```bash
scripts/codex-exec-with-status.sh \
  <status-file-path> \
  -- \
  codex exec \
    --skip-git-repo-check \
    -s workspace-write \
    -C <worktree-absolute-path> \
    -m gpt-5.5 \
    -c model_reasoning_effort=high \
    "<implementation prompt>" \
  </dev/null
```

The wrapper script captures exit code + timestamps + signal in a durable status file. See `scripts/codex-exec-with-status.sh` for details.

Mandatory flags:

- `--skip-git-repo-check` — worktree git detection is unreliable in unattended runs.
- `-s workspace-write` — sandbox writes scoped to the worktree cwd. Sufficient for unattended commits without approval prompts.
- `-C <worktree>` — pin cwd to the slice's isolated worktree.
- `-m gpt-5.5` — locked model.
- `-c model_reasoning_effort=high` — locked reasoning effort.
- `</dev/null` redirect — prevents codex from inheriting the parent shell's stdin and hanging under bash backgrounding.

**Do not use** `--dangerously-bypass-approvals-and-sandbox` — it bypasses the sandbox and would allow codex to escape the worktree.

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

## Status file schema

The `scripts/codex-exec-with-status.sh` wrapper writes a JSON status file when codex exits:

```json
{
  "exit_code": 0,
  "started_at": "2026-05-09T12:30:01.000Z",
  "completed_at": "2026-05-09T12:34:56.000Z",
  "signal": null
}
```

On signal-killed exit (e.g., orchestrator's max_runtime_ms timeout):

```json
{
  "exit_code": 143,
  "started_at": "2026-05-09T12:30:01.000Z",
  "completed_at": "2026-05-09T14:30:01.000Z",
  "signal": "SIGTERM"
}
```

Atomic write via temp+rename guarantees the orchestrator never reads partial JSON during polling.

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
| Codex exits 0 with zero commits | fallback trigger | Reset worktree; try Sonnet if domain policy allows. |
| Codex exits 0 with non-conforming commits | fallback trigger | Cite SHA; reset worktree; try Sonnet. |
| Codex exits non-zero | fallback trigger | Reset worktree; try Sonnet. |
| Codex exceeds `max_runtime_ms` | `codex-background-timeout` | Orchestrator SIGTERM + SIGKILL after 5s; treat as fallback. |
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
