# Execution Model

This is the one canonical description of how implementation work runs. Other docs and
skills link here instead of repeating the matrix, so there is a single source of truth.

## Who writes, who reviews (v0.16.0)

Codex writes the code; Claude reviews it first; Codex reviews it second; both must SHIP the
same commit. Every Codex invocation runs on a **model role** resolved from one place
(`lib/codex-bridge/models.js`; override in `.codex-paired/project.json` `models` or the
`CODEX_PAIRED_*` env — see the README "Configuration" section):

| Role | Default (`cli: codex`) | `cli: agy` alternative (v0.17.0) | Used for |
| --- | --- | --- | --- |
| `planning` | GPT-6 Astra, `xhigh` | e.g. `gemini-3.8-flash-high` via an `agy` conversation | spec drafting, plan review, per-slice plan review, debugging hypotheses, test-list review — the `paired-reviewer` thread |
| `review` | GPT-6 Astra, `high` | e.g. `gemini-3.8-flash-high` via an `agy` conversation | slice code review, docs-update, post-implementation reviewer panels — the `execution-reviewer` thread |
| `implement` | GPT-5.6 Sol, `high` | e.g. `gemini-3.8-flash-high` via `agy -p` | every implementer attempt (first rung) |
| `implement_fallback` | GPT-6 Astra, `medium` | e.g. `gemini-3.1-pro-high` | the automatic second attempt after an implement failure |

The CLI is chosen per role (`cli: codex | agy`); the orchestrator resolves it with `model-role
--format json` before composing any command. Two-disjoint and hybrid members stay on Codex in
v0.17.0.

Single-implementer work climbs a three-rung ladder: Codex at `implement` → Codex at
`implement_fallback` → the Claude subagent → halt `implementer-unavailable`. A configuration
error (the wrapper's exit code 78) halts immediately and never descends the ladder.

Before Codex's review round, Claude reads the committed diff, runs the verification, and writes a
findings list (`## Claude review findings`); at most two fix passes (`runFixPass`, checkpointed at
`fix_start_sha`, never reset to the slice start) may run before the diff goes to Codex with
`reviewed_sha`. The sidecar refuses a double-SHIP whose two sides reviewed different commits.

Per-transport scope of the ladder and the Claude-first rule:

| Transport | Model role | Ladder | Claude-first review |
| --- | --- | --- | --- |
| single implementer (`codex-background-bash` via the wrapper) | `implement` / `implement_fallback` | yes | yes |
| two-disjoint members (`codex-cli` direct adapter) | `implement` | no — fan-out aborts required siblings as before | **no** — the post-merge two-member panel runs concurrently (both must SHIP) |
| hybrid `codex-backend` (`codex-background-bash`) | `implement` | no — hybrid halts as before | n/a (UI half is Claude by construction) |

Those two "no" cells are stated exceptions, not omissions. Two review routes are exempt from the
Claude-first rule because they are concurrent by design: the **post-merge two-member panel** of a
two-disjoint slice (`panel/dispatcher.js`, `Promise.all`) and the **merger review** that follows the
fan-out merge. Both still require every member to SHIP the same merged commit.

Choose three independent things before running implementation work:

1. Driver: who keeps the work moving.
   - `interactive`: you and Claude move one work item at a time.
   - `autopilot`: Claude keeps going across a reviewed plan until it finishes, needs help, or the session ends.

2. Split: how one work item is written.
   - `single`: one implementer writes it.
   - `two-disjoint`: two implementers work in parallel on separate files, then the branches are merged.
   - `hybrid-ui-backend`: Claude builds the UI side while Codex builds the backend side, joined by a published contract.

3. Review: who checks the result.
   - Codex paired review always runs.
   - Additional domain reviewers may be selected from the work item, affected files, or a `Reviewers` directive.

Stable combinations:

| Driver | single | two-disjoint | hybrid-ui-backend |
| --- | --- | --- | --- |
| interactive | yes | yes | yes |
| autopilot | yes | yes | yes |

The experimental multi-plan app driver (`app-autopilot`) is intentionally outside this
table for now — it is opt-in and lives in its own skill because it documents its own
transcript-loop failure modes. It is not part of v1 of the unified execution model.

## How to launch

- **Stable entry point:** the `execution` skill. Pick a `driver` (`interactive` or
  `autopilot`) and pass a plan path; the per-work-item split comes from each slice's
  `**Split:**` directive in the plan.
- **`/autopilot`** keeps working as a thin compatibility alias for
  `execution` with `driver: autopilot` (including no-argument resume of an in-progress
  run). Its behavior is unchanged.
- **`/execute`** launches the `execution` skill with an explicit driver.

## Review lanes (v0.18.1)

Two reviewers who must both approve the same commit is the default and stays the default: it is
what catches the defects that matter. But not every change carries the same risk, and on v0.18.0 a
pure documentation correction cost three review rounds and 43 minutes. Pick the lane from what the
diff touches, not from how big it feels.

| Lane | Applies when the diff touches | Reviewers | Round cap | Writer |
| --- | --- | --- | --- | --- |
| **standard** | anything under `lib/`, `scripts/`, `bin/`, `tests/`, `skills/`, or any contract document (below) | Claude first, then the `review` role; both must approve the same commit | 7 | dispatched per the implementer contract |
| **prose** | only paths in the prose allowlist (below) | the `review` role once; Claude's own read is the first pass as always | 2 | none — the orchestrator edits directly |

**Prose allowlist:** `README.md`, `docs/**/*.md` EXCEPT the contract documents, and
`docs/specs/**` / `docs/plans/**` status blocks.

**Contract documents (always standard lane):** `docs/public-api.md`,
`docs/codex-implementer-contract.md`, `docs/execution-model.md` (this file). Structural and contract
tests assert on these, so a change to one is a behaviour change.

Three rules keep the prose lane honest:
1. `npm test` must pass. The structural tests already assert on README and the contract documents,
   so a prose edit that breaks a documented invariant still fails the gate — that is the safety net
   that makes one reviewer sufficient here.
2. Any claim about behaviour must be verified against the code before it is written, not after. On
   v0.18.0 the reviewer found three false claims in one README edit (a bundled tool's models are
   cloud-hosted, another tool has no adapter at all, and Claude runs in-session rather than as a
   spawned command). One reviewer is enough only because the claims are checked at the source.
3. If a prose change turns out to need a code change, it leaves the lane and re-enters standard.

A lane is a property of the diff: if a single commit touches both prose and code, it is standard.

**Public-API digests (v0.18.0).** `docs/public-api.md` pins module digests over the CLI's import
closure; any slice that changes a pinned module or JSON input refreshes them with
`scripts/cli-surface.mjs --digest --write` before its verification run (autopilot Phase B.5, SDD
Step B) so the commit under review is the one with green `npm test`.

The drivers and splits above map onto engines that already exist (the autopilot engine,
the interactive subagent-driven driver, the symmetric two-implementer orchestrator, and
the hybrid UI/backend runner). This model is the selection layer over them, not a new
engine.
