# Codex-Pairing Bridge Protocol (reference)

## Codex transport: bundled MCP server

This plugin bundles `codex mcp-server` as an MCP server (registered in `plugin.json`). When the plugin is loaded, two tools become available to Claude:

| Tool | Args | Returns |
|---|---|---|
| `mcp__plugin_codex-paired-superpowers_codex__codex` | `{ prompt, model, cwd?, sandbox?, config?, ... }` | `{ threadId, content }` |
| `mcp__plugin_codex-paired-superpowers_codex__codex-reply` | `{ threadId, prompt }` | `{ threadId, content }` |

### ⚠️ Model handling — read before every `__codex` call (v0.16.0)

Models and reasoning efforts come from **model roles**, never from literals. Resolve the role
for the thread you are opening with the bridge CLI and spread the result into the call:

```bash
# planning thread (brainstorming, writing-plans, plan-slice review, debugging, TDD review)
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role planning --format mcp --repoRoot "$REPO_ROOT"
#  → {"model":"gpt-6-astra","config":{"model_reasoning_effort":"xhigh"}}

# execution thread (slice reviews, docs-update)
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format mcp --repoRoot "$REPO_ROOT"
```

Pass **exactly** that object's `model` and `config` on the `codex` (thread-opening) call. Rules:

- **Never type a model id by hand.** The tool schema's description still lists `gpt-5.2` /
  `gpt-5.2-codex` as *examples* — those are stale upstream references and must NOT be passed
  (empirically, 2026-05-10, a thread once ran on the wrong model that way and had to be re-created).
- **If `model-role` fails (exit 2), stop and report** the error to the user. Never open a thread
  with a guessed model. A failure means `.codex-paired/project.json` `models` or a `CODEX_PAIRED_*`
  env value is invalid.
- The MCP server itself is pinned to the `planning` defaults (`gpt-6-astra`, `xhigh`) in
  `.claude-plugin/plugin.json` as a safety default only; passing the resolved role is what makes a
  project or env override actually reach the thread.
- **`codex-reply` has no model or config parameter** — a thread's model and effort are fixed when it
  is created. That is why there are two threads per feature (below), not one thread at two efforts.
- Overrides: `.codex-paired/project.json` `{"models": {"planning": {"effort": "max"}}}` or env
  `CODEX_PAIRED_MODEL_PLANNING=...` / `CODEX_PAIRED_REASONING_REVIEW=...` (global
  `CODEX_PAIRED_MODEL` / `CODEX_PAIRED_REASONING` apply to every role).

### Reviewer transports (v0.17.0): Codex over MCP, Gemini over `agy`

The role decides the transport. Resolve it first:

```bash
ROLE=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role planning --format json --repoRoot "$REPO_ROOT")
#  → {"role":"planning","cli":"codex"|"agy","model":...,"effort":...,...}
```

| `cli` | Open a thread | Continue a thread | Thread id stored as |
|---|---|---|---|
| `codex` | MCP tool `codex` with `model` + `config` from `model-role --format mcp` | MCP tool `codex-reply` with `threadId` | `role_sessions[key]` (Codex thread id) |
| `agy` | `node cli.js reviewer-thread-open --role <planning\|review> --specPath <spec> --repoRoot <repo> [--planPath <plan>] --prompt-stdin` | `node cli.js reviewer-thread-reply … --prompt-stdin` | `role_sessions[key]` (agy conversation id) |

Both paths print/return the same `{ threadId, content }` shape, so round logging, audits,
`--headSha` and verdict parsing are identical. `model-role --format mcp` exits 2 for an agy role —
that is the signal to use the `reviewer-thread-*` verbs instead. Gemini reviewer turns run in a
throwaway detached checkout of the reviewed commit (the spec/plan under review are overlaid into
it, so path audits work) and can never modify your working tree. `thread_config[key].cli` records
which CLI owns each thread; recovery of a lost thread follows the recorded CLI.

The agy verbs also report `ok`, `exit`, `status` and `warnings` and exit **1** when the turn
failed (non-`SUCCESS` status, timeout, lost conversation) — never treat an empty `content` as a
reply. On exit 1 whose warnings mention a missing conversation, rotate the thread
(`thread-recovery` → `recoverStaleThread`, which re-opens on agy) and resend the prompt once;
exit **2** is a usage/config error (wrong flags, codex role, missing spec) and is terminal.

### Two threads per feature (v0.16.0)

| `role_sessions` key | Model role | Opened by | Used by |
|---|---|---|---|
| `paired-reviewer` | `planning` | brainstorming Phase 2 | spec rounds, plan review, autopilot Phase A, debugging, TDD review |
| `execution-reviewer` | `review` | first execution-phase turn (`execution` skill hand-off / autopilot run start / SDD entry) | slice reviews (Phase C / Step C), docs-update (Phase D), post-merge Codex member |

The sidecar records what each thread actually runs in `thread_config[key] = { role, model, effort, opened_at }`.
Opening the execution thread (once per feature; skip if the key already exists):

```bash
REPLAY=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-replay-context --specPath "<spec-path>")
MCP=$(node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" model-role --role review --format mcp --repoRoot "$REPO_ROOT")
# seed prompt: composeSeedPrompt(replay, { reason: 'execution-thread', specPath, planPath, pendingPrompt })
#   from lib/codex-bridge/thread-recovery.js — it tells Codex to READ the spec and plan from disk first.
# Prepend system-rubric.md + verdict-format.md, call `codex` with MCP's model + config, then:
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-rotate-thread-id --specPath "<spec-path>" \
  --role execution-reviewer --newThreadId "<threadId>" --reason execution-thread --phase execution \
  --threadConfig '{"role":"review","model":"<model>","effort":"<effort>"}'
```

Thread loss ("Session not found") on either thread re-seeds at the **lost thread's** recorded
`thread_config` (the one exception to "resolve the current role"), so the same context is judged at
the same depth. See `lib/codex-bridge/thread-recovery.js` `recoverStaleThread`.

The first call (`codex`) opens a thread; capture `threadId` and persist it via `sidecar-init`. Every subsequent call in the same phase uses `codex-reply` with that same threadId.

### Empty replies and slow turns (v0.15.0)

Two silent failure modes observed in Codex session logs — neither produces an error:

- **Empty reply:** the tool returns ~1s after the prompt with empty/whitespace `content` and
  unchanged token usage. This is a swallowed API/stream failure, NOT a verdict. Re-send the SAME
  prompt once after ~30s; if still empty, once more after ~5min (observed outage windows were
  ≤10min). Three consecutive empties → surface to the user. Never log a round from an empty reply.
- **Slow turn:** healthy review turns run median ~1.5min, p99 ~7min, max observed 10.3min. Past
  15 minutes, treat the call as stalled and surface it — don't wait silently.

(`Session not found` thread loss is a third, loud failure — handled by the thread-recovery
protocol; see `lib/codex-bridge/thread-recovery.js`.)

## Bridge CLI subcommands (sidecar only)

```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> --<flag> <value> ...
```

| Subcommand | Effect |
|---|---|
| `sidecar-init --specPath <p> --feature <name> --threadId <id>` | write the sidecar with the `planning` role's model/effort (overridable via `--model`, `--reasoning`) and `thread_config["paired-reviewer"]` |
| `model-role --role <r> [--format json\|flags\|mcp] [--repoRoot <r>]` | resolve one model role (v0.16.0) |
| `model-roles [--repoRoot <r>]` | all roles + sources + `validated_cli_version` |
| `sidecar-show --specPath <p>` | print full sidecar JSON |
| `sidecar-thread-id --specPath <p>` | print just the threadId (for shell `$(...)` capture) |
| `sidecar-path --specPath <p>` | print the sidecar file path |
| `sidecar-append-round --specPath <p> --round <json>` | append a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | record slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | append open contention |
| `review-panel --phase <planning\|review> --repoRoot <r> [--format json\|status]` | resolve the review panel (v0.19.0); `status` adds `configured` |
| `panel-preflight --phase <p> --repoRoot <r>` | check every panel member is installed and signed in (v0.19.0) |
| `sidecar-set-panel-roster --specPath <p> --phase <p> --roster <json>` | persist a phase's panel roster once (v0.19.0) |
| `panel-replay` (stdin JSON) | build a Gemini member's bounded replay; exit 1 = overflow (v0.19.0) |
| `review-panel-member ... --prompt-file <f>` (replay on stdin) | run one Gemini member's turn, continuing its stored conversation for the phase |
| `panel-reduce` (stdin JSON) | strict-unanimity reduction of one panel round (v0.19.0) |

The CLI does NOT spawn codex anymore (v0.2.0+). All codex traffic goes through the MCP tools above.

## Verdict block format

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one sentence>
<<<END>>>
```

Parser is permissive on whitespace, strict on `status` value (`SHIP` or `REVISE` only). Missing or malformed -> synthetic REVISE returned.

## L11 rubric (sent in every initial Codex prompt)

See `lib/codex-bridge/prompts/system-rubric.md` for the canonical text. Both Claude and Codex advocate for:
1. Simple over clever
2. Small over big
3. DRY but not premature
4. Optimal locally
5. Honest about scope
6. Tests at the failure boundary

The rubric is sent **once** in the initial prompt (Phase 2). It persists in the Codex thread; do not re-prepend it in `codex-reply` calls.

## Review panel rounds (v0.19.0)

A **review panel** replaces the single external reviewer with several that review independently and
must **all** agree. It is off unless the user configures it (`review_panel` in
`.codex-paired/project.json`, or `CODEX_PAIRED_REVIEW_PANEL_PLANNING` / `_REVIEW`). The shipped
default is one reviewer; with nothing configured every skill takes its existing path unchanged.

### Activation check (every skill runs this before its review loop)

```bash
node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" review-panel --phase <planning|review> \
  --repoRoot "$REPO_ROOT" --format status
# → {"configured":false|true,"roster":[{"member_id","cli","model","effort"}],"warnings":[...]}
```

- `planning` covers spec, plan, `plan-N` and autopilot Phase A (`plan-slice:<id>`); `review` covers
  `review-slice:<id>` and `docs-update`. The two are independent: a configured planning panel leaves
  slice reviews on the single reviewer, and vice versa.
- **`configured: false` → stop here and use the skill's existing single-reviewer procedure exactly as
  written.** Nothing below applies; no roster is persisted and no `version:` is required.
- `configured: true` → run every round of that phase as a panel round (below). A configured
  one-member panel is still a panel.
- Exit 2 is a configuration error: show it to the user and stop.
- Relay each `warnings` entry (`self-review:<member_id>`: that member is the model that wrote the
  code) to the user once, in plain words.

### Before round 1 of a panel phase

1. `panel-preflight --phase <p> --repoRoot "$REPO_ROOT"`. Exit 1 names an unavailable member
   (`panel-member-unavailable`): tell the user which tool to install or sign in to, and halt. Never
   drop the member and continue; the panel never shrinks.
2. Persist the roster once: `sidecar-set-panel-roster --specPath "<spec>" --phase <p> --roster
   '<roster JSON from the activation check>'`. A later, different roster is refused
   (`panel-roster-changed`); tell the user rather than working around it.

### One panel round

1. **Artifact version V.** Spec or plan: `sha256:` plus the hex digest of the file bytes
   (`shasum -a 256 "<file>" | cut -d' ' -f1`). Code: `git rev-parse HEAD` (full 40 hex). Every
   member's prompt states V verbatim. **What is reviewed must be exactly V:** in a code phase,
   commit everything under review before the round (a panel never reviews an uncommitted draft,
   because the approval must attach to the commit that ships); a revision is a new commit and a new
   round on the new V.
2. **Claude reviews first**, independently, and writes its verdict block including `version: V`.
3. **Compose the round prompt** and write it to a file (`<scratch>/panel-round-<N>.md`). Every
   member receives this same text, in this order:
   1. the canonical instructions, verbatim, because a fresh member has not inherited them from a
      thread: `lib/codex-bridge/prompts/system-rubric.md`, then
      `lib/codex-bridge/prompts/verdict-format.md`, then — for `plan-slice:<id>`,
      `review-slice:<id>` and `docs-update` — `lib/codex-bridge/prompts/validation-rubric.md`;
   2. the skill's normal review prompt for this phase (goals, artifact, diff or file references);
   3. Claude's findings for this round;
   4. `Artifact version: V` and "include `version: V` in your verdict block";
   5. the audit-efficiency directive, verbatim. Verification comes first: this is about avoiding
      redundant work, never about auditing less.

      ```text
      Your audit decides the verdict: verify every claim you rely on, and cover everything the
      rubric requires. Within that, avoid redundant work — tool calls add to the conversation that
      is re-sent on later turns, so they cost tokens and time. Plan the audit first, then run it in
      as few calls as you can: combine searches into one command (grep -rnE 'a|b|c'), check several
      paths at once, and read the line ranges you need. Material quoted above is supplied complete;
      re-read it from disk when you need to confirm its source or version, resolve an uncertainty,
      or see its surrounding context, not to re-read what is already in front of you. Stop auditing
      once every claim you rely on is verified.
      ```

   Repeating the instructions to a member whose thread already has them is harmless.

   One paired observation (Gemini 3.8 Flash high, this repository, the same plan reviewed once with
   and once without the directive): 172s → 107s wall-clock, 1.79M → 1.22M cached re-read tokens,
   19.7k → 14.2k thinking tokens, and 242k → 260k fresh input tokens (up about 7%). Both returned
   SHIP with comparable audits. One run per configuration shows no causation and no general rate;
   treat it as the reason the directive exists, not as a measured saving.

4. **Dispatch every member in the same turn**, so none sees another's current verdict:
   - **Codex member**: one persistent thread per feature, sidecar key and member, keyed
     `<sidecarKey>:<member_id>` (`paired-reviewer` for planning, `execution-reviewer` for review);
     two Codex models means two threads. The same thread carries the spec, every plan round and
     every slice of that phase family. Look it up first:
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-thread-id --specPath "<spec>" \
       --role "<sidecarKey>:<member_id>"
     ```
     - **Empty output (no thread yet)**: open one with the `codex` MCP tool, passing that member's
       roster `model` and `config: {"model_reasoning_effort": "<effort>"}` (the resolved roster
       entry, never a hand-typed id), then store it:
       ```bash
       node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" sidecar-rotate-thread-id --specPath "<spec>" \
         --role "<sidecarKey>:<member_id>" --newThreadId "<threadId>" --reason panel-member-open
       ```
     - **A thread id**: continue it with `codex-reply`. Never open a second thread for a member
       that has one.
     - **The thread is lost** (`Session not found`): the legacy role-wide recovery does not apply
       to member threads yet. Treat it as a failed member turn: halt with
       `panel-member-unavailable` naming the member, and tell the user. The panel never shrinks.
   - **Gemini member (`cli: agy`)**: one conversation for the phase, like a Codex member's thread.
     `review-panel-member` owns it: it continues the conversation stored under
     `<sidecarKey>:<member_id>`, stores a new one after the member's first successful turn, and if
     the conversation is lost it continues in the new conversation `agy` opens (seeded with the same
     prompt and replay) and records the switch in `thread_rotations`. Never pass or store the id yourself. Every round still gets the
     bounded replay, because it carries the other members' findings. Build it, then run the member
     in the background:
     ```bash
     printf '%s' '{"goals":[...],"round":N,"unresolved":[...],"previousRound":{"findings":[...],"resolved_count":K}}' \
       | node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" panel-replay > <scratch>/replay-<N>.txt
     node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" review-panel-member --role <planning|review> \
       --specPath "<spec>" --repoRoot "$REPO_ROOT" --member-id "<member_id>" --model "<model>" \
       --version "<V>" --prompt-file <scratch>/panel-round-<N>.md [--sha <V for code>] [--planPath <plan>] \
       < <scratch>/replay-<N>.txt
     ```
     `unresolved` lists every still-open blocking finding (`{member_id, status, finding}`), first;
     `previousRound.findings` lists only the previous round's member-labelled findings; earlier
     resolved findings are only counted. `panel-replay` exit 1 is `panel-replay-overflow`: halt and
     tell the user; never trim findings to fit. `review-panel-member` prints
     `{member_id, verdict, conversation_id, usage}`; exit 1 is a failed member turn.
5. **Reduce.** Parse each Codex member's verdict block into `{status, critique, rationale, deferred,
   version}` and pipe everything to `panel-reduce`:
   ```bash
   printf '%s' '{"roster":[...],"version":"<V>","claude":{...,"version":"<V>"},
     "members":[{"member_id":"...","verdict":{...}}, ...]}' \
     | node "${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js" panel-reduce
   # → {"status":"SHIP"|"REVISE","blocking":[{member_id,finding}],"deferred":[...]}
   ```
   SHIP only when Claude and every member said SHIP on V. Exit 1 (`panel-member-unavailable`: a
   missing, failed or wrong-version member) is a halt, never a vote. Retry that member once; if it
   fails again, tell the user which member failed and stop.
6. **Log the round** with `sidecar-append-round-with-audits`, as the skill already does, with one
   audit per side: `claude` plus one per `member_id` (member ids are valid audit sides). The round
   carries the panel instead of a `codex` verdict, which the sidecar derives. Each `panel` entry is
   the member's `member_id`, `cli` and `model` from the roster, plus `version`, `status` and
   `session` (the Codex thread id, or the Gemini `conversation_id`):
   ```text
   round:  {phase, round: N, claude: "SHIP|REVISE", claude_version: V, panel: [entry, ...]}
   entry:  {member_id, cli, model, version: V, status: "SHIP|REVISE", session}
   ```
   Code phases keep the same-commit rule: pass `--headSha "$(git rev-parse HEAD)"`, and every SHIP
   side's verification audit carries `reviewed_sha: V`.
7. **REVISE** → address every blocking finding (from any member, including Claude), then run the
   next round on the new V. Deferred findings never block; batch them as the skill already does.
   The round cap (7) and the anti-yes-man rules are unchanged; a finding you believe is wrong is
   argued in the next round's prompt, not ignored.

### Cost

Each extra member adds roughly one reviewer's usage per round. Codex members cache most of their
input automatically. Gemini starts fresh every round, so its cost per round stays flat (the replay
is capped at 12,000 characters) rather than growing with the conversation.
