// v0.8.0 expert-turn — assembles spawn prompts for a single expert turn,
// dispatches to an agent, parses output (with one-shot repair), marks unread
// mailbox messages read on success, and appends a turn record to the sidecar.
//
// Contract (DI seam):
//   runTurnWithDeps(request, deps)
//     request = {
//       identity:                  ExpertIdentity { id, role, promptPath, source },
//       repoRoot:                  string,
//       specPath:                  string,
//       specSnippet:               string,
//       phase:                     "spec-review" | "pre-dispatch" | "post-implementation-review",
//       sliceId:                   string | null,
//       sidecarParticipantState:   string,    — prior-summary snippet for rehydration
//       task:                      string,
//     }
//     deps (optional override): {
//       readUnreadMessages, markManyAsRead, parseExpertOutput,
//       buildRepairPrompt, agentDispatch, appendExpertTurn, writeBreadcrumb,
//     }
//
// Order of operations:
//   1. Read unread mailbox messages for identity.id.
//   2. Assemble spawn prompt.
//   3. Dispatch.
//   4. Parse; if fail, repair-dispatch once.
//   5. On parse success → mark messages read AND append turn (best-effort sidecar).
//   6. On parse fail / dispatch error → append turn with failure_reason; DO NOT mark read.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { readUnreadMessages, markManyAsRead, writeToMailbox, MailboxError } from './mailbox.js';
import { parseExpertOutput, buildRepairPrompt } from './expert-output-parser.js';
import { appendExpertTurn } from './sidecar.js';
import { writeBreadcrumb } from './hook-mailbox-inject.js';

// Resolve the plugin-bundled system rubric path so we can embed its full
// content into every spawn prompt. The hardcoded "L11 partner..." sentence
// was insufficient — Codex round-1 caught that the test's substring match
// on "L11" would pass even if the actual rubric were omitted.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_RUBRIC_PATH = join(
  __dirname,
  'prompts',
  'system-rubric.md',
);
let cachedSystemRubric = null;
function getSystemRubric() {
  if (cachedSystemRubric === null) {
    cachedSystemRubric = readFileSync(SYSTEM_RUBRIC_PATH, 'utf8');
  }
  return cachedSystemRubric;
}

/**
 * Assemble the spawn prompt that includes ALL spec-mandated inputs:
 *   - L11 / expert operating rules.
 *   - Resolved expert prompt body (read from identity.promptPath).
 *   - Spec path + current snippet.
 *   - Sidecar participant state (rehydration context for round-N≥2 critiques).
 *   - Unread mailbox messages verbatim.
 *   - Phase string.
 *   - Task text.
 *   - Output contract — Machine Result schema reference.
 *   - Mailbox identity for outbound DMs.
 */
export function assembleSpawnPrompt({
  identity,
  specPath,
  specSnippet,
  phase,
  sidecarParticipantState,
  unreadMessages,
  task,
}) {
  const expertPromptBody = readFileSync(identity.promptPath, 'utf8');
  const messagesBlock = (Array.isArray(unreadMessages) && unreadMessages.length > 0)
    ? unreadMessages
        .map(
          (m) =>
            `### ${m.id} (from ${m.from}, ${m.timestamp})\n${m.text}`
        )
        .join('\n\n')
    : '(none)';

  return [
    `# L11 Expert Review Turn`,
    ``,
    `## Base L11 Operating Rules (from lib/codex-bridge/prompts/system-rubric.md)`,
    ``,
    getSystemRubric(),
    ``,
    `## Identity`,
    `Expert ID (mailbox identity for outbound DMs): \`${identity.id}\``,
    `Role: ${identity.role}`,
    `Source: ${identity.source}`,
    ``,
    `## Your Role Prompt`,
    expertPromptBody,
    ``,
    `## Phase`,
    phase,
    ``,
    `## Spec Under Review`,
    `Path: ${specPath}`,
    ``,
    `### Current Spec Snippet`,
    specSnippet,
    ``,
    `## Sidecar Participant State (rehydration context)`,
    sidecarParticipantState && sidecarParticipantState.length > 0
      ? sidecarParticipantState
      : '(no prior state — this is your first turn for this feature)',
    ``,
    `## Unread Mailbox Messages`,
    messagesBlock,
    ``,
    `## Your Task`,
    task,
    ``,
    `## Output Contract`,
    `Your response MUST include exactly one \`## Machine Result\` section containing one fenced \`\`\`json ... \`\`\` block. Surrounding Markdown is free-form (e.g., a "## Findings" section is encouraged).`,
    `Required Machine Result fields:`,
    `  - expert_id: must be "${identity.id}"`,
    `  - phase: must be "${phase}"`,
    `  - status: "SHIP" or "REVISE"`,
    `  - scope: a string identifying your domain scope (e.g., "${identity.role}")`,
    `  - blocking_findings: array (may be empty)`,
    `  - nonblocking_findings: array (may be empty)`,
    `  - peer_messages_requested: array of {to, body, summary?} — messages you want delivered to another active expert. \`body\` is the full text; \`summary\` is an optional one-liner for sidecar audit. The orchestrator's runtime enqueues these into recipient mailboxes on parse success. Do NOT call mailbox-write yourself.`,
    `  - questions_for_orchestrator: array (may be empty)`,
  ].join('\n');
}

const realDeps = {
  readUnreadMessages,
  markManyAsRead,
  writeToMailbox,
  parseExpertOutput,
  buildRepairPrompt,
  agentDispatch: defaultAgentDispatch,
  appendExpertTurn,
  writeBreadcrumb,
};

// v0.8.1 — classify and enqueue peer-DM requests from the expert's Machine
// Result. The expert lists messages it wants delivered; runtime is the only
// thing that can actually write to recipient mailboxes (subagents don't have
// CLI access to the plugin's mailbox-write). Per-item failures DO NOT fail
// the turn — they're recorded under `peer_messages_failed` for audit and
// the scheduler halts on summary.failed > 0.
//
// Returns: { enqueued: [{to, message_id, summary}], failed: [{to, reason, code?, ...overflow?}] }
const PEER_RECIPIENT_RE = /^(orchestrator|slice-\d+|expert-[a-z][a-z0-9-]{0,47})$/;

// v0.8.1.1 — per-turn cap on `peer_messages_requested` length. A runaway
// or malicious subagent could emit thousands of DM requests; each
// `writeToMailbox` acquires a proper-lockfile lock (~5ms baseline). Without
// a cap, a 10K-item array hangs the turn 50s+. Cap at 16 (legit turns
// rarely exceed 3-4 recipients); the scheduler's existing
// `peer_dm_summary.failed > 0` halt surfaces overflow to the operator.
// Overflow is recorded as ONE bounded audit entry, not per-item, to prevent
// the DoS from shifting into sidecar/memory growth (Codex round-1 critique).
const MAX_PEER_MESSAGES_PER_TURN = 16;
const OVERFLOW_SAMPLE_SIZE = 5;       // bounded `to` sample for triage
const OVERFLOW_SAMPLE_MAX_LEN = 80;   // truncate each sampled `to` (Codex round-2 critique)

async function enqueuePeerMessages(parsed, identity, repoRoot, deps) {
  const enqueued = [];
  const failed = [];
  const allRequests = Array.isArray(parsed.peer_messages_requested)
    ? parsed.peer_messages_requested
    : [];

  // Cap injection seam: tests override via `deps.maxPeerMessagesPerTurn`.
  // `>= 0` permits the testing edge-case cap=0 (all items overflow).
  const cap = typeof deps.maxPeerMessagesPerTurn === 'number' && deps.maxPeerMessagesPerTurn >= 0
    ? deps.maxPeerMessagesPerTurn
    : MAX_PEER_MESSAGES_PER_TURN;

  // Apply cap BEFORE per-item normalization. Single bounded audit record
  // covers all overflow regardless of input size.
  let requests;
  if (allRequests.length > cap) {
    const overflowCount = allRequests.length - cap;
    const sampleTo = [];
    for (let i = cap; i < allRequests.length && sampleTo.length < OVERFLOW_SAMPLE_SIZE; i++) {
      const item = allRequests[i];
      if (item && typeof item === 'object' && typeof item.to === 'string' && item.to.length > 0) {
        // Truncate so the sample stays bounded under adversarial input
        // (a subagent could send pathological recipient strings beyond
        // RECIPIENT_RE's max length; the sample audit must not balloon).
        sampleTo.push(item.to.slice(0, OVERFLOW_SAMPLE_MAX_LEN));
      }
    }
    failed.push({
      to: null,
      reason: 'count-cap-exceeded',
      code: 'count-cap-exceeded',
      overflow_count: overflowCount,
      max_allowed: cap,
      sample_to: sampleTo,
    });
    requests = allRequests.slice(0, cap);
  } else {
    requests = allRequests;
  }

  for (const item of requests) {
    // Per-item shape check.
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      failed.push({ to: null, reason: 'malformed-item', code: 'malformed-item' });
      continue;
    }
    const to = item.to;
    if (typeof to !== 'string' || to.length === 0) {
      failed.push({ to: to ?? null, reason: 'malformed-item', code: 'malformed-item' });
      continue;
    }
    // Self-DM check (recorded, not silent).
    if (to === identity.id) {
      failed.push({ to, reason: 'self-dm', code: 'self-dm' });
      continue;
    }
    // Recipient pattern check. The mailbox layer also validates, but we
    // classify here so the failure record has a clean reason and we avoid
    // a thrown MailboxError just for predictable malformed input.
    if (!PEER_RECIPIENT_RE.test(to)) {
      failed.push({ to, reason: 'invalid-recipient', code: 'mailbox-recipient-malformed' });
      continue;
    }
    // Body fallback: `body` preferred; `summary` accepted as fallback for
    // v0.8.0 transcripts that only emitted summary.
    const body = typeof item.body === 'string' && item.body.length > 0
      ? item.body
      : (typeof item.summary === 'string' && item.summary.length > 0
        ? item.summary
        : null);
    if (body === null) {
      failed.push({ to, reason: 'empty-body', code: 'empty-body' });
      continue;
    }
    const summary = typeof item.summary === 'string' && item.summary.length > 0
      ? item.summary
      : null;

    // Attempt the write. MailboxError → record failure, do not throw.
    try {
      const { id: messageId } = await deps.writeToMailbox(repoRoot, to, {
        from: identity.id,
        text: body,
        summary,
      });
      enqueued.push({ to, message_id: messageId, summary });
    } catch (err) {
      const code = err instanceof MailboxError ? err.code : 'write-error';
      const reason = err && err.message ? err.message : String(err);
      failed.push({ to, reason, code });
    }
  }
  return { enqueued, failed };
}

async function safeAppendTurn(deps, specPath, turn, repoRoot, identity) {
  try {
    await deps.appendExpertTurn(specPath, turn);
  } catch (err) {
    try {
      deps.writeBreadcrumb(repoRoot, identity.id, `sidecar appendExpertTurn failed: ${err.message}`);
    } catch {
      /* breadcrumbs are best-effort */
    }
  }
}

/**
 * v0.9.0 slice 5b — suppress peer-DM enqueue in panel mode.
 *
 * Iterates `parsed.peer_messages_requested` the same way `enqueuePeerMessages`
 * does, but records each draft as a `panel_peer_messages_suppressed` entry
 * (body_hash + optional summary_hash) instead of writing to recipient mailboxes.
 *
 * Per spec § 4 "Panel peer DMs are suppressed":
 *   - In panel mode, `peer_messages_requested` from any panelist is not enqueued.
 *   - Sidecar records the suppression with body_hash for audit.
 *   - Cross-panel exposure happens only via the consensus round.
 */
function suppressPeerMessages(parsed) {
  const suppressed = [];
  const requests = Array.isArray(parsed.peer_messages_requested)
    ? parsed.peer_messages_requested
    : [];
  for (const item of requests) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      // Still record a suppression entry for malformed items so the audit
      // captures the count — `to: null` per Codex round-7 SHIP.
      suppressed.push({
        to: null,
        body_hash: `sha256:${createHash('sha256').update('', 'utf8').digest('hex')}`,
      });
      continue;
    }
    const to = typeof item.to === 'string' && item.to.length > 0 ? item.to : null;
    const body = typeof item.body === 'string' && item.body.length > 0
      ? item.body
      : (typeof item.summary === 'string' && item.summary.length > 0 ? item.summary : '');
    const entry = {
      to,
      body_hash: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
    };
    if (typeof item.summary === 'string' && item.summary.length > 0) {
      entry.summary_hash = `sha256:${createHash('sha256').update(item.summary, 'utf8').digest('hex')}`;
    }
    suppressed.push(entry);
  }
  return suppressed;
}

export async function runTurnWithDeps(request, deps = {}) {
  const d = { ...realDeps, ...deps };
  const {
    identity,
    repoRoot,
    specPath,
    specSnippet,
    phase,
    sliceId,
    sidecarParticipantState,
    task,
    suppressPeerMessages: suppressPeerMessagesFlag,
    panelId,
    panelMemberIndex,
    panelSize,
  } = request;
  const startedAt = new Date().toISOString();

  // 1. Read unread.
  let unreadMessages;
  try {
    unreadMessages = await d.readUnreadMessages(repoRoot, identity.id);
  } catch (err) {
    return { ok: false, reason: 'unread-read-failed', error: err.message };
  }
  const injectedIds = unreadMessages.map((m) => m.id);

  // 2. Assemble prompt.
  const prompt = assembleSpawnPrompt({
    identity,
    specPath,
    specSnippet,
    phase,
    sidecarParticipantState,
    unreadMessages,
    task,
  });

  // 3. Dispatch.
  let rawOutput;
  try {
    rawOutput = await d.agentDispatch(prompt, identity, phase);
  } catch (err) {
    await safeAppendTurn(
      d,
      specPath,
      {
        expert_id: identity.id,
        phase,
        slice_id: sliceId || null,
        // Record what was INJECTED into the prompt regardless of dispatch
        // outcome — the expert saw these even though the dispatch threw.
        // Mark-read is separate (not called on failure paths; messages stay
        // unread for re-delivery).
        mailbox_message_ids_injected: injectedIds,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        result_summary: `dispatch error: ${err.message}`,
        verdict: 'REVISE',
        failure_reason: 'dispatch-error',
      },
      repoRoot,
      identity
    );
    return { ok: false, reason: 'dispatch-error', error: err.message };
  }

  // 4. Parse.
  let parseResult = d.parseExpertOutput(rawOutput, {
    expectedExpertId: identity.id,
    expectedPhase: phase,
  });

  // 5. Repair if needed.
  if (!parseResult.ok) {
    const repairPrompt = d.buildRepairPrompt({
      rawOutput,
      reason: parseResult.reason,
      expectedExpertId: identity.id,
      expectedPhase: phase,
    });
    try {
      const repaired = await d.agentDispatch(repairPrompt, identity, phase);
      parseResult = d.parseExpertOutput(repaired, {
        expectedExpertId: identity.id,
        expectedPhase: phase,
      });
    } catch {
      /* repair dispatch threw — fall through to failure path */
    }
  }

  const completedAt = new Date().toISOString();

  // 6. Outcome.
  if (!parseResult.ok) {
    await safeAppendTurn(
      d,
      specPath,
      {
        expert_id: identity.id,
        phase,
        slice_id: sliceId || null,
        // Record what was INJECTED into the prompt — the expert saw these
        // messages even though output parsing failed. This preserves the
        // audit/rehydration evidence the spec requires; mark-read remains
        // separate (not called on this path; messages stay unread and
        // will re-appear in the next turn's unread list).
        mailbox_message_ids_injected: injectedIds,
        started_at: startedAt,
        completed_at: completedAt,
        result_summary: `unparseable output after repair: ${parseResult.reason}`,
        verdict: 'REVISE',
        failure_reason: 'unparseable-output',
      },
      repoRoot,
      identity
    );
    return { ok: false, reason: 'unparseable-output', parseResult };
  }

  // 7. Success path:
  //    (a) enqueue peer DMs (v0.8.1) OR suppress them (v0.9.0 slice 5b panel mode) —
  //        must happen before mark-read so that if the runtime crashes between
  //        enqueue and mark-read, the worst case is duplicate-delivery of inbound
  //        messages on retry, not lost outbound DMs. Per-item failures recorded;
  //        scheduler observes peer_dm_summary.failed > 0 → halt.
  //    (b) mark inbound messages read.
  //    (c) append sidecar turn with full peer-DM audit fields.
  const parsed = parseResult.result;

  let peerResult;
  let panelSuppressed = null;
  if (suppressPeerMessagesFlag === true) {
    // Slice 5b panel-mode path: do NOT call writeToMailbox. Record each draft
    // as a panel_peer_messages_suppressed entry for audit.
    panelSuppressed = suppressPeerMessages(parsed);
    peerResult = { enqueued: [], failed: [] };
  } else {
    peerResult = await enqueuePeerMessages(parsed, identity, repoRoot, d);
  }

  if (injectedIds.length > 0) {
    try {
      await d.markManyAsRead(repoRoot, identity.id, injectedIds);
    } catch (err) {
      try {
        d.writeBreadcrumb(repoRoot, identity.id, `mark-read failed: ${err.message}`);
      } catch {
        /* best-effort */
      }
    }
  }

  const blockCount = Array.isArray(parsed.blocking_findings) ? parsed.blocking_findings.length : 0;
  const nonblockCount = Array.isArray(parsed.nonblocking_findings) ? parsed.nonblocking_findings.length : 0;
  const summary =
    parsed.status === 'SHIP'
      ? 'SHIP'
      : `REVISE: ${blockCount} blocking, ${nonblockCount} nonblocking`;

  const turnRecord = {
    expert_id: identity.id,
    phase,
    slice_id: sliceId || null,
    mailbox_message_ids_injected: injectedIds,
    started_at: startedAt,
    completed_at: completedAt,
    result_summary: summary,
    verdict: parsed.status,
    failure_reason: null,
  };
  if (suppressPeerMessagesFlag !== true) {
    turnRecord.peer_messages_enqueued = peerResult.enqueued;
    turnRecord.peer_messages_failed = peerResult.failed;
  }
  if (panelSuppressed !== null) {
    turnRecord.panel_peer_messages_suppressed = panelSuppressed;
  }
  // Slice 5b — raw findings preservation per panelist (spec § 4).
  if (Array.isArray(parsed.blocking_findings)) {
    turnRecord.blocking_findings = parsed.blocking_findings;
  }
  if (Array.isArray(parsed.nonblocking_findings)) {
    turnRecord.nonblocking_findings = parsed.nonblocking_findings;
  }
  if (typeof panelId === 'string' && panelId.length > 0) turnRecord.panel_id = panelId;
  if (typeof panelMemberIndex === 'number') turnRecord.panel_member_index = panelMemberIndex;
  if (typeof panelSize === 'number') turnRecord.panel_size = panelSize;

  await safeAppendTurn(d, specPath, turnRecord, repoRoot, identity);

  const peerDmSummary = {
    enqueued: peerResult.enqueued.length,
    failed: peerResult.failed.length,
  };
  if (suppressPeerMessagesFlag === true) {
    peerDmSummary.suppressed = panelSuppressed ? panelSuppressed.length : 0;
  }

  return {
    ok: true,
    result: parsed,
    peer_dm_summary: peerDmSummary,
  };
}

// Default agent dispatch — INTENTIONALLY UNWIRED.
//
// Claude Code's Agent tool is not exposed via a Node API in current
// versions, so a generic `agentDispatch(prompt) => responseText` adapter
// is not implementable from inside a Node module. The production
// orchestration pattern is two-step, driven by Claude itself:
//
//   1. Orchestrator (Claude in autopilot or a brainstorming session)
//      calls `assembleSpawnPrompt(request)` to get the prompt string.
//   2. Orchestrator dispatches the Task tool with that prompt, captures
//      the subagent's final response text.
//   3. Orchestrator calls `runTurnWithDeps(request, { agentDispatch: async () => taskResponseText })`
//      to drive the rest of the pipeline (parse → repair if needed →
//      mark-read on success → append sidecar turn).
//
// Calling `runTurn(request)` directly without that two-step pattern
// reaches this stub. That's not a bug — it's an explicit refusal to
// fabricate an Agent invocation that Claude Code can't expose. Wire
// your own `agentDispatch` and call `runTurnWithDeps` directly.
//
// See skills/autopilot/SKILL.md §Phase B.1.5 / B.5.5 for the prose
// version of the two-step pattern.
async function defaultAgentDispatch(_prompt, _identity, _phase) {
  throw new Error(
    'expert-turn defaultAgentDispatch is intentionally unwired. ' +
    'Claude Code does not expose the Agent tool to Node modules. ' +
    'The production orchestration pattern is two-step: ' +
    '(1) Claude orchestrator calls assembleSpawnPrompt(request) and ' +
    'dispatches Task itself; (2) Claude calls runTurnWithDeps(request, ' +
    '{ agentDispatch: async () => taskResponseText }) once the Task ' +
    'returns. See skills/autopilot/SKILL.md Phase B.1.5 / B.5.5.'
  );
}

// `runTurn(request)` is the convenience wrapper for environments that
// HAVE a working Agent-dispatch adapter (none exist today in Claude
// Code's Node API surface, but a future version might add one). Today,
// callers must use `runTurnWithDeps(request, { agentDispatch: <impl> })`.
export async function runTurn(request) {
  return runTurnWithDeps(request, {});
}
