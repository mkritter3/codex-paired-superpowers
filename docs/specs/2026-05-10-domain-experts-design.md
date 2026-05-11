# Spec: Plugin-Level Agent Teammates

> Status: DOUBLE-SHIP'd in round 2 of codex-paired brainstorming (2026-05-10). Codex thread: `019e1536-0211-7d50-a307-d16d092d44b7`. Awaiting user sign-off before plan-writing phase.

## Objective

Build a plugin-owned recreation of Claude Code native agent-teams semantics for `codex-paired-superpowers`, using Claude subagents plus the existing v0.7.3.1 mailbox primitive.

The design must support domain experts in both:

- Brainstorming/spec review
- Implementation/autopilot

It must not require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, native `InProcessTeammateTask`, or Codex as a teammate runtime.

## Core Decision

Implement experts as **ephemeral Claude subagent turns with durable mailbox/state rehydration**.

An expert is not a long-lived process. It is:

- A stable role identity, such as `expert-ui`
- A curated role prompt
- A mailbox recipient
- A sidecar participant record
- A repeatable spawn prompt that rehydrates prior context from disk

Every expert turn is a fresh Claude `Agent` call. Continuity comes only from mailbox, sidecar, spec/slice files, and explicit prompt context.

This is simpler, testable, compatible with current Claude Code constraints, and does not pretend the Agent tool has native long-lived teammate semantics.

## Goals

- Allow Claude orchestrator to spawn curated expert teammates dynamically.
- Allow experts to DM orchestrator, slices, and each other through mailbox.
- Allow experts to participate in spec review and implementation review.
- Preserve existing Codex L11 partner flow.
- Preserve mailbox as the single coordination primitive.
- Keep experts advisory by default unless explicitly dispatched as implementers in a later design.
- Keep behavior deterministic enough to test without native agent-teams.

## Non-Goals

- Do not depend on native Claude Code agent-teams.
- Do not create Codex expert teammates.
- Do not make experts continuously running background workers.
- Do not let experts bypass existing dispatch, review, reconciliation, or sidecar truth.
- Do not make users manually select experts as the primary workflow.

## Expert Identity Model

### Built-In Experts

Curated default expert prompts live in:

```text
lib/codex-bridge/prompts/expert-ui.md
lib/codex-bridge/prompts/expert-ux.md
lib/codex-bridge/prompts/expert-architecture.md
lib/codex-bridge/prompts/expert-backend.md
lib/codex-bridge/prompts/expert-ai-harness.md
lib/codex-bridge/prompts/expert-test.md
lib/codex-bridge/prompts/expert-security.md
```

Each prompt defines:

- Role scope
- What to inspect
- What not to decide
- Review rubric
- Required output format
- Mailbox behavior rules
- Whether implementation is allowed

Example identity:

```json
{
  "id": "expert-ui",
  "role": "ui",
  "source": "builtin",
  "promptPath": "lib/codex-bridge/prompts/expert-ui.md"
}
```

### User Overrides

Users may override or add experts at:

```text
<repo>/.codex-paired/experts/<role>.md
```

Resolution order:

1. Repo override: `.codex-paired/experts/ui.md`
2. Built-in prompt: `lib/codex-bridge/prompts/expert-ui.md`
3. Error if neither exists

Overrides are opt-in. The primary orchestration model remains Claude-selected, plugin-curated experts.

### Recipient Naming

Expert mailbox recipients use:

```text
expert-<role>
```

Allowed role segment:

```text
[a-z][a-z0-9-]{0,47}
```

Valid:

```text
expert-ui
expert-ux
expert-ai-harness
expert-architecture
```

Invalid:

```text
expert_UI
expert-../../x
expert-
slice-ui
```

This keeps mailbox filenames safe and avoids colliding with `orchestrator` or `slice-N`.

## Mailbox Extension

### Recipient Validation

Update `RECIPIENT_RE` in `lib/codex-bridge/mailbox.js` from:

```js
/^orchestrator$|^slice-\d+$/
```

to:

```js
/^(orchestrator|slice-\d+|expert-[a-z][a-z0-9-]{0,47})$/
```

Do not loosen this to arbitrary names. Mailbox recipients are filesystem-backed, so the regex remains a security boundary.

### Permission Model

Keep experts peer-equal, not orchestrator-equivalent.

Allowed reads:

- `orchestrator` may read any inbox.
- `slice-N` may read only `slice-N`.
- `expert-role` may read only `expert-role`.

Allowed writes:

- Any valid actor may write to any valid recipient.
- Sender must also pass the same identity regex.
- Message metadata records sender identity exactly.

This supports:

- orchestrator -> expert
- expert -> orchestrator
- expert -> expert
- expert -> slice
- slice -> expert

But only orchestrator has supervisory read privileges.

Why: peer DMs require cross-recipient writes, but cross-recipient reads would make experts implicitly privileged and would leak unrelated coordination state.

### CLI Changes

Do not add a `self` keyword.

Keep the existing CLI actor model:

```text
mailbox-read --for <recipient> --actor <orchestrator|same-recipient>
```

Current permission shape remains:

```js
args.actor !== 'orchestrator' && args.actor !== args.for
```

Examples:

```bash
node lib/codex-bridge/cli.js mailbox-write \
  --to expert-ui \
  --from expert-ux \
  --text "Please check whether this UI concern overlaps your UX finding."

node lib/codex-bridge/cli.js mailbox-read \
  --for expert-ui \
  --actor expert-ui \
  --unread \
  --json

node lib/codex-bridge/cli.js mailbox-read \
  --for expert-ui \
  --actor orchestrator \
  --unread \
  --json

node lib/codex-bridge/cli.js mailbox-mark-read-batch \
  --for expert-ui \
  --actor expert-ui \
  --message-ids "msg-1,msg-2"
```

Required CLI updates are only validation updates so `expert-*` is accepted wherever recipient/sender identity is already accepted.

## Hook Identity-Inference Extension

### Constraint

Current PostToolUse injection infers identity from:

```text
<repo>/.git-worktrees/slice-N
```

Claude Agent subagents inherit the orchestrator cwd, and prose `cd` does not change the cwd seen by hooks. Therefore expert identity cannot reliably be inferred from worktree path.

### Decision

Do not make expert auto-injection depend on PostToolUse for MVP.

Instead, expert turns use **pre-spawn mailbox rehydration**:

1. Orchestrator reads unread messages for `expert-role`.
2. Orchestrator injects those messages into the expert spawn prompt.
3. Orchestrator marks them read only after the expert turn returns and its machine-readable output parses successfully.
4. Expert can write outbound messages using mailbox CLI during its turn.
5. If the Agent call fails or output parsing fails, unread messages stay unread.

This is more reliable than trying to fake cwd-based identity.

### Hook Follow-Up

Extend hook identity inference only for future compatibility by supporting an explicit environment variable if Claude Code ever exposes reliable subagent env injection:

```text
CODEX_PAIRED_MAILBOX_IDENTITY=expert-ui
```

Do not build the MVP around this because current Agent constraints do not guarantee it.

## Spawn Pattern

### Expert Turn Input

Each expert spawn prompt is assembled from:

- Base L11/expert operating rules
- Resolved expert prompt
- Feature spec path and current draft content
- Relevant sidecar participant state
- Unread mailbox messages for that expert
- Current phase context
- Requested task
- Output contract

Example task:

```text
You are expert-ui. Review the current spec draft for UI architecture risks.
You may DM expert-ux or expert-architecture through mailbox-write if needed.
Return findings only; do not edit files.
```

### Expert Turn Output

Experts may write free-form Markdown for human readability, but all machine-parsed fields must appear in one fenced JSON block.

Required output shape:

````markdown
## Findings

Free-form findings for the orchestrator.

## Machine Result

```json
{
  "expert_id": "expert-ui",
  "phase": "spec-review",
  "status": "SHIP",
  "scope": "ui",
  "blocking_findings": [],
  "nonblocking_findings": [
    {
      "id": "ui-1",
      "summary": "Review-panel visual ownership is clear enough for this phase.",
      "location": "Autopilot Usage",
      "recommendation": "No required change."
    }
  ],
  "peer_messages_sent": [
    {
      "to": "expert-architecture",
      "summary": "Asked whether post-review blockers should halt before B.6."
    }
  ],
  "questions_for_orchestrator": []
}
```
````

Required JSON fields:

- `expert_id`
- `phase`
- `status`
- `scope`
- `blocking_findings`
- `nonblocking_findings`
- `peer_messages_sent`
- `questions_for_orchestrator`

Allowed `status` values:

```text
SHIP
REVISE
```

`blocking_findings`, `nonblocking_findings`, `peer_messages_sent`, and `questions_for_orchestrator` must be arrays. Empty arrays are valid.

### Parser Rules

Parsing is strict for the fenced JSON block and lenient for surrounding Markdown.

Rules:

- Extra Markdown sections are allowed.
- Section order does not matter.
- Exactly one `Machine Result` JSON block should be present.
- If multiple JSON blocks are present, only a block introduced by `## Machine Result` is machine-parsed.
- If the machine block is missing, invalid JSON, has the wrong `expert_id`, or fails schema validation, the turn is unparseable.

Unparseable output handling:

1. Re-prompt the same expert once with the raw invalid output and a format-repair instruction.
2. Reuse the same injected mailbox messages.
3. Do not mark injected messages read until a valid machine result is received.
4. If repair fails, record the turn as `failed` with `failure_reason: "unparseable-output"`.
5. Treat the failed expert turn as a blocking orchestration error for that phase until Claude either retries, drops the expert with rationale, or asks the user if dropping it would change product/UX/business scope.

This keeps the protocol robust without relying on brittle Markdown heading parsing.

## Rehydration State

Add sidecar fields:

```json
{
  "expert_teammates": {
    "selected": [
      {
        "id": "expert-ui",
        "role": "ui",
        "source": "builtin",
        "selected_at_phase": "spec-review",
        "selection_reason": "Spec includes visual editor and review-panel behavior",
        "status": "active"
      }
    ],
    "turns": [
      {
        "expert_id": "expert-ui",
        "phase": "spec-review",
        "mailbox_message_ids_injected": ["msg-1", "msg-2"],
        "started_at": "2026-05-11T12:00:00.000Z",
        "completed_at": "2026-05-11T12:00:45.000Z",
        "result_summary": "Raised one blocking UI state-boundary concern.",
        "verdict": "REVISE",
        "failure_reason": null
      }
    ]
  }
}
```

Do not add `prompt_hash` in MVP.

Reason: without a defined replay, verification, cache, or audit action, `prompt_hash` is premature metadata. The sidecar should record orchestration facts needed for resume and reconciliation, not speculative audit fields.

## Lifecycle

Expert status values:

```text
active
waiting
done
failed
archived
```

An expert is done when:

- It emits `SHIP` or no blocking findings for its assigned task
- It has no unread mailbox messages
- The orchestrator has no pending follow-up task for it
- The phase advances past the expert's scope

No shutdown message is required for MVP. The sidecar status is authoritative.

## Peer DM Mechanism

Experts communicate by writing mailbox messages.

Example:

```bash
node lib/codex-bridge/cli.js mailbox-write \
  --to expert-architecture \
  --from expert-ui \
  --text "The proposed review-panel state boundary may leak renderer authority..."
```

Because experts are ephemeral, the message is not delivered immediately. It is queued until the orchestrator next spawns `expert-architecture`.

### Orchestrator Responsibility

Between expert turns, the orchestrator polls:

- Orchestrator inbox
- Active expert inboxes
- Relevant slice inboxes during autopilot

If expert A sends expert B a message, the orchestrator does not need to interpret the full content immediately, but it must treat unread peer messages as a scheduling signal.

Rule:

- If an active expert has unread peer DMs, spawn that expert before concluding the phase unless the message is explicitly non-blocking or the expert has already hit the phase respawn cap.

## Claude-Driven Role Composition

### Primary Selection

The orchestrator selects experts based on feature context, not user command.

Signals:

- Spec content
- Slice frontmatter `**Domain:**`
- File paths mentioned in the task
- Architecture impact areas
- Existing dispatch domain
- Optional explicit spec directive

Optional directive:

```text
**Experts:** ui, architecture, test
```

The directive is advisory, not required. Claude may add or omit experts with rationale.

### Default Expert Set

If no strong signal exists:

- Spec phase: `expert-architecture`, `expert-test`
- UI-visible feature: add `expert-ui` and `expert-ux`
- AI/provider feature: add `expert-ai-harness`
- Security/credential feature: add `expert-security`

Do not enforce a hard default cap.

Instead, apply a selection budget:

- Select every expert with a concrete, written reason.
- Avoid duplicate neighboring expertise unless the feature needs both. Example: use both `expert-ui` and `expert-ux` only when the task touches both implementation surface and user workflow.
- If more than five experts are selected for one phase, Claude must write a short fan-out rationale in sidecar state because review volume and mailbox scheduling overhead become material.

This avoids arbitrary caps while still forcing the orchestrator to justify broad fan-out.

### Composition With Phase B.0

Phase B.0 still chooses implementer transport through `dispatchers.json`.

Experts augment that routing. They do not replace existing implementers in MVP.

Example:

```text
Domain: ui
Implementer: sonnet / slice-implementer-sonnet
Experts: expert-ui post-implementation review, expert-ux spec critique
```

## Brainstorming / Spec Review Usage

### Flow

Current flow:

```text
Claude + Codex L11 7-round loop
```

New flow:

```text
Claude drafts spec
Claude selects experts
Experts review in parallel
Claude merges expert findings
Codex L11 reviews merged artifact
Claude revises
Repeat until Claude + Codex SHIP
```

Experts participate as parallel reviewers, not as independent gatekeepers.

### Verdict Semantics

Experts use the same `SHIP`/`REVISE` status vocabulary, but their verdict is scoped:

```json
{
  "status": "REVISE",
  "scope": "ui"
}
```

Only Claude and Codex remain hard gates for the whole artifact.

However, Claude must not ignore expert `REVISE` findings. It must either:

- Address the finding
- Mark it deferred with rationale
- Override it with written technical rationale if the finding is non-product/UX/business and demonstrably wrong
- Escalate to the user if the finding is product/UX/business

### Merge Rule

Claude's next revision must include an expert merge note in sidecar state:

```json
{
  "expert_id": "expert-ui",
  "finding": "Review artifacts need durable anchors",
  "disposition": "addressed",
  "artifact_location": "Mailbox Extension / Hook Identity-Inference Extension"
}
```

Allowed dispositions:

```text
addressed
deferred
technical-override
needs-user
```

## Autopilot Usage

### Expert Role

Experts augment implementation, usually as reviewers.

MVP modes:

```text
pre_review
post_review
targeted_consult
```

- `pre_review`: critique slice plan before dispatch
- `post_review`: review implemented slice after reconciler output
- `targeted_consult`: answer a narrow technical question during fallback

Experts do not replace `slice-implementer-sonnet` in MVP.

Reason: replacing implementers changes routing, worktree ownership, and reconciliation semantics. Augmenting preserves the existing implementation path and gives immediate value.

### Blocking Finding Authority

Expert blocking findings stop integration unless resolved or overridden.

Claude may override a blocking expert finding only when all of the following are true:

- The finding is technical, not product/UX/business.
- Claude writes a specific rationale explaining why the finding is wrong.
- The rationale cites concrete evidence, such as file path, line/function, current slice version, command output, or reconciler result.
- The override is recorded in sidecar state.

Examples of valid technical overrides:

- Expert referenced a stale slice version.
- Expert misread a command boundary.
- Expert claimed a missing test that already exists at the failure boundary.
- Expert flagged a behavior that the reconciler output proves is not present.

Product/UX/business overrides require explicit human user authorization.

Examples requiring the user:

- Expert says the workflow is confusing but technically works.
- Expert says a visual choice weakens the intended product feel.
- Expert says the user-facing copy changes the promise of the feature.
- Expert says the feature scope no longer matches the requested outcome.

Sidecar override record:

```json
{
  "expert_id": "expert-ui",
  "finding_id": "ui-blocker-1",
  "disposition": "technical-override",
  "rationale": "The finding references apps/foo/OldPanel.tsx, but B.5 reconciler output removed that file and the current implementation is apps/foo/NewPanel.tsx:118.",
  "evidence": ["apps/foo/NewPanel.tsx:118", "reconciler result slice-3"]
}
```

### Dispatch Registry Extension

Extend `agents/dispatchers.json` with expert metadata separately from implementers:

```json
{
  "experts": {
    "ui": {
      "id": "expert-ui",
      "prompt": "lib/codex-bridge/prompts/expert-ui.md",
      "phases": ["spec-review", "post-implementation-review"],
      "domains": ["ui"]
    },
    "architecture": {
      "id": "expert-architecture",
      "prompt": "lib/codex-bridge/prompts/expert-architecture.md",
      "phases": ["spec-review", "pre-dispatch", "post-implementation-review"],
      "domains": ["backend", "ai-harness", "general", "ui"]
    }
  }
}
```

Do not overload existing implementer entries. Implementers and experts have different authority.

### Autopilot Phase Inserts

Add expert steps without disturbing existing order:

```text
B.0 Domain resolution
B.0.5 Expert selection per slice
B.1 Pre-dispatch checklist
B.1.5 Optional expert pre-review
B.2 Ready-set + batching
B.3 Worktree setup
B.4 Transport-aware single-turn parallel dispatch
B.4.5 Between-turns inbox polling
B.5 Reconcile
B.5.5 Expert post-review and peer-DM drain
B.6 Apply routing rules / fallback
B.7 Append dispatch records to sidecar
B.8 Integration via ordered cherry-pick
```

### B.4.5 Inbox Polling

B.4.5 now polls:

- Orchestrator inbox
- In-flight slice inboxes
- Active expert inboxes

If an active expert has unread messages at B.4.5:

- Record the inbox state.
- Do not spawn expert turns while implementation dispatches are still in-flight unless the message is addressed to orchestrator and changes dispatch safety.
- Schedule the expert for B.5.5 after reconcile, because expert review should see reconciled implementation truth rather than partial worker output.

Exception:

- If the unread message indicates a dispatch safety issue, such as stale basis, wrong slice, or command failure, Claude may halt before B.5 and route through B.6 fallback.

### B.5.5 Peer-DM Drain

B.5.5 runs after reconcile and before routing/fallback.

For each active expert selected for the slice or phase:

1. Read unread messages for that expert.
2. Spawn the expert with reconciled slice output plus unread messages.
3. Parse machine result.
4. Mark injected messages read only after parse success.
5. Record findings, DMs sent, and status in sidecar.
6. If the expert sent DMs to another active expert, schedule the recipient in the same B.5.5 drain loop.

Loop bounds:

- Maximum 2 respawns per expert per slice per B.5.5 drain.
- Maximum 8 total expert turns per slice per B.5.5 drain.
- If unread peer DMs remain after the cap, record `expert-peer-dm-drain-cap-exceeded` and stop before B.6.
- Claude may either narrow the question and retry, defer non-blocking peer discussion, or ask the user if the remaining issue is product/UX/business.

This prevents infinite expert ping-pong while preserving useful peer negotiation.

### Expert Blocker Records

Record only blocking findings in `expert_blockers`. Presence implies blocking, so no `severity` field is needed.

```json
{
  "experts_selected": ["expert-ui"],
  "expert_turn_ids": ["turn-1"],
  "expert_blockers": [
    {
      "expert_id": "expert-ui",
      "finding_id": "ui-blocker-1",
      "summary": "Implemented UI writes accepted text directly from renderer",
      "location": "apps/desktop/src/components/editor/Editor.tsx:214",
      "disposition": "open"
    }
  ]
}
```

Allowed blocker dispositions:

```text
open
resolved
technical-override
needs-user
deferred
```

`deferred` is allowed only when the blocker does not affect the current slice integration safety. If deferral changes product/UX/business behavior, it requires human user authorization.

## Native Agent-Teams Compatibility

Plugin recreation remains the canonical path.

If native agent-teams are available later, add an adapter behind the same runtime interface. The MVP implements only `PluginTeammateRuntime`.

Interface sketch:

```ts
type TeammateIdentity = {
  id: string;
  role: string;
  promptPath: string;
  source: 'builtin' | 'repo-override';
};

type TeammateTurnRequest = {
  identity: TeammateIdentity;
  phase: string;
  task: string;
  contextPaths: string[];
  unreadMessages: MailboxMessage[];
};

type TeammateTurnResult = {
  expertId: string;
  status: 'SHIP' | 'REVISE';
  blockingFindings: ExpertFinding[];
  nonblockingFindings: ExpertFinding[];
  peerMessagesSent: PeerMessageSummary[];
  questionsForOrchestrator: string[];
  rawOutputPath?: string;
};

interface TeammateRuntime {
  resolveIdentity(role: string, repoRoot: string): TeammateIdentity;
  selectTeammates(input: RoleCompositionInput): TeammateIdentity[];
  runTurn(request: TeammateTurnRequest): Promise<TeammateTurnResult>;
  pollInbox(identity: TeammateIdentity): Promise<MailboxMessage[]>;
  archive(identity: TeammateIdentity, reason: string): Promise<void>;
}
```

Runtime selection rule for now:

```text
default: PluginTeammateRuntime
native: opt-in only in a future design
```

Do not auto-switch based on env var. Native agent-teams are gated by both env and remote killswitch, so automatic delegation would make behavior nondeterministic across users.

The plugin-owned runtime is the portability baseline.

## Mailbox Archival

Expert inboxes are archived only when feature state is terminal.

Archive expert inboxes for halt reason:

```text
completed
abandoned-by-user
```

Preserve expert inboxes for resume/debugging for halt reasons:

```text
external-commit-detected
slice-blocker-from-mailbox
expert-blocker-open
expert-peer-dm-drain-cap-exceeded
subagent-dispatch-failed
reconcile-failed
validation-failed
user-input-required
```

Rationale:

- `completed` means the feature no longer needs queued teammate state.
- `abandoned-by-user` is explicit cleanup intent.
- Blocked or failed states must preserve pending DMs so resume can reconstruct why the phase stopped.

Archival action:

```text
archiveAndReset(expert-id)
```

Archival is recorded in sidecar:

```json
{
  "expert_id": "expert-ui",
  "status": "archived",
  "archive_reason": "completed",
  "archived_at": "2026-05-11T12:10:00.000Z"
}
```

## Test Plan

### Unit Tests

Mailbox validation:

- Accepts `expert-ui`
- Rejects path traversal and malformed expert names
- Existing `orchestrator` and `slice-N` still pass
- Existing invalid recipients still fail

Mailbox permissions:

- Expert can read own inbox with `--actor expert-ui --for expert-ui`
- Expert cannot read another expert inbox
- Expert cannot read orchestrator inbox
- Orchestrator can read expert inbox
- Expert can write to expert, slice, and orchestrator

CLI parsing:

- `mailbox-write --to expert-ui --from expert-ux`
- `mailbox-read --for expert-ui --actor expert-ui`
- `mailbox-read --for expert-ui --actor orchestrator`
- Batch mark-read works for expert inboxes
- No `--actor self` behavior is introduced

Role composition:

- UI spec selects `expert-ui`
- AI harness spec selects `expert-ai-harness`
- No signal falls back to architecture/test
- `**Experts:**` directive is advisory and merges with inferred experts
- More than five selected experts requires a fan-out rationale

Sidecar:

- Expert selection records validate
- Expert turn records require non-empty expert id
- Injected mailbox IDs are preserved
- Expert status transitions are valid
- `prompt_hash` is absent from MVP schema
- `expert_blockers` presence implies blocking

Output parser:

- Valid `Machine Result` JSON parses despite extra Markdown
- Missing machine block triggers one repair prompt
- Invalid JSON triggers one repair prompt
- Wrong `expert_id` fails schema validation
- Failed repair leaves injected messages unread
- Failed repair records `failure_reason: "unparseable-output"`

Autopilot drain:

- B.4.5 polls active expert inboxes
- Peer DM schedules recipient for B.5.5
- Per-expert respawn cap stops ping-pong
- Total turn cap stops phase-level loops
- Drain cap halt preserves inboxes

Override policy:

- Claude can technically override stale-code false positive with evidence
- Claude cannot override product/UX/business blocker without user authorization
- Override record requires rationale and evidence

Archival:

- `completed` archives expert inboxes
- blocked/failure halt reasons preserve expert inboxes
- resume sees preserved unread DMs

### Integration Tests

Mailbox peer DM:

- Spawn simulation for `expert-ui`
- Expert writes to `expert-architecture`
- Orchestrator sees unread message as scheduling signal
- Next architecture prompt includes the queued DM

Spec review loop:

- Expert emits REVISE
- Claude merge note records addressed/deferred/override disposition
- Codex review prompt includes expert summary

Autopilot review:

- UI slice implemented by existing implementer
- `expert-ui` post-review runs after reconcile
- Blocking expert finding prevents integration
- Technical override allows integration only with evidence record
- Product/UX/business blocker stops for user authorization

Parser repair:

- Simulated expert returns malformed output
- Repair prompt succeeds
- Messages are marked read only after repaired parse succeeds

### Smoke Tests

Claude Code subagent dispatch:

- Real Agent call receives assembled expert prompt
- Expert can invoke mailbox CLI
- Expert final response is parsed and recorded in sidecar
- Failure leaves unread messages unread

Native env smoke:

- With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, plugin still uses plugin runtime by default

## MVP Slicing

The user wants both phases to ship together if feasible. Implementation should still land in vertical slices.

### Slice 1: Expert Mailbox Identity

- Extend recipient regex
- Extend CLI recipient validation
- Add mailbox permission tests
- No Agent dispatch yet

Value: expert identities can safely communicate through mailbox.

### Slice 2: Expert Prompt Registry + Role Composer

- Add built-in expert prompts
- Add override resolution
- Add expert selection logic
- Add tests for inferred roles and fan-out rationale

Value: Claude can pick domain experts without user micromanagement.

### Slice 3: Expert Output Protocol + Parser

- Add `Machine Result` JSON schema
- Add parser and one-shot repair flow
- Add parse-failure sidecar recording
- Preserve unread injected messages on parse failure

Value: expert results become reliable enough for orchestration.

### Slice 4: Spec-Review Expert Turns

- Assemble expert spawn prompts
- Pre-inject mailbox messages
- Record expert turns in sidecar
- Merge expert findings into spec-review loop

Value: brainstorming/spec review has parallel domain critique.

### Slice 5: Peer DM Scheduling

- Poll active expert inboxes
- Treat unread peer DMs as scheduling signals
- Add B.5.5 drain loop with caps
- Add integration test with simulated expert messages

Value: peer-negotiated semantics work despite ephemeral Agent calls.

### Slice 6: Autopilot Expert Augmentation

- Add B.0.5, B.1.5, B.5.5 steps
- Select experts per slice
- Run post-review experts after reconcile
- Block integration on unresolved blocking findings
- Allow Claude technical override with evidence
- Require user for product/UX/business overrides

Value: experts improve implementation/autopilot without replacing implementers.

### Slice 7: Archival, Smoke, Docs

- Implement terminal-state archival policy
- Real Claude Code smoke test
- Update plugin docs
- Document native agent-teams compatibility
- Document user override path

Value: feature is externally understandable and releaseable.

## Deferred

- Experts as primary implementers
- Native agent-teams runtime adapter
- Hook-based expert auto-injection
- Long-running background teammate simulation
- User-facing expert management UI
- Cross-feature expert memory
- Automatic expert prompt generation
- Prompt hashing/replay audit, if a concrete replay or verification feature later needs it

## Open Contentions

(none)

## Round-2 residual concerns (recorded; do not block plan-writing)

- **Expert prompt file missing/corrupt**: spec mentions resolution order but not the explicit error shape when neither builtin nor override exists. Pin in slice 2 (role-composer tests).
- **B.5.5 cap arithmetic (2 respawns / 8 total)**: defensible starting points but not empirically grounded. Tune during slice 5 implementation if smoke shows pathological cases.
- **Mid-drain restart recovery**: if Claude restarts mid-B.5.5, sidecar marks `started_at` without `completed_at` — recovery logic not specified. Address during slice 6 plan-writing or slice-5 TDD round if needed.
