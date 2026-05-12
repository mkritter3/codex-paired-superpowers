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
import { appendExpertTurn, storeResponse, computeInputsHash } from './sidecar.js';
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

// v0.9.0 slice 5b round-1 fix: read role-prompt file + extract version
// from frontmatter. Used on the success path to populate role_prompt_hash
// (sha256 of full file content) + role_prompt_version (parsed frontmatter).
// Returns { hashHex, version } or { hashHex, version: null } when missing.
//
// We avoid pulling in the role-prompts-loader to keep this resilient to
// prompt files without strict frontmatter (the loader rejects those; the
// dispatcher must still record the audit data).
function readRolePromptAudit(promptPath) {
  let text;
  try {
    text = readFileSync(promptPath, 'utf8');
  } catch {
    return null;
  }
  const hashHex = createHash('sha256').update(text, 'utf8').digest('hex');
  let version = null;
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const afterOpen = text.replace(/^---\r?\n/, '');
    const closeMatch = afterOpen.match(/^---\r?\n/m);
    if (closeMatch) {
      const fm = afterOpen.slice(0, closeMatch.index);
      const m = fm.match(/^\s*version\s*:\s*(.+?)\s*$/m);
      if (m) version = m[1];
    }
  }
  return { hashHex, version };
}

function sha256HexUtf8(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
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
  storeResponse,
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

  // v0.9.0 slice 5b round-1 fix: compute + attach replay/response audit fields.
  // Best-effort: any failure here does NOT abort the turn (the turn record is
  // the source of replay truth, but losing one field's value should not lose
  // the whole record). Errors are recorded as breadcrumbs only.
  try {
    // 1. Response storage (inline vs overflow).
    const stored = d.storeResponse(repoRoot, rawOutput);
    if (typeof stored.response_text_inline === 'string') {
      turnRecord.response_text_inline = stored.response_text_inline;
    }
    if (typeof stored.response_ref === 'string') {
      turnRecord.response_ref = stored.response_ref;
    }
    if (typeof stored.response_hash === 'string') {
      turnRecord.response_hash = stored.response_hash;
    }

    // 2. Role-prompt hash + version (sha256 of full file, version from frontmatter).
    const roleAudit = readRolePromptAudit(identity.promptPath);
    if (roleAudit) {
      turnRecord.role_prompt_hash = `sha256:${roleAudit.hashHex}`;
      if (roleAudit.version) {
        turnRecord.role_prompt_version = roleAudit.version;
      }
    }

    // 3. Spec path + spec snippet hash.
    turnRecord.spec_path = specPath;
    const specSnippetHashHex = sha256HexUtf8(specSnippet ?? '');
    turnRecord.spec_snippet_hash = `sha256:${specSnippetHashHex}`;

    // 4. inputs_hash over the canonical replay domain.
    //    roleId here MUST match what's recorded in requested_role and what
    //    replayTurn() will read back — defaults to identity.id, which is the
    //    role id (e.g. "expert-ui"). Slice 6's panel dispatcher will pass an
    //    explicit `request.requestedRole` when the resolved role differs from
    //    the role originally requested.
    turnRecord.inputs_hash = computeInputsHash({
      rolePromptHash: roleAudit ? roleAudit.hashHex : '',
      specSnippetHash: specSnippetHashHex,
      mailboxMessageIds: injectedIds,
      phase,
      task: task ?? '',
      roleId: request.requestedRole || identity.id,
    });

    // 5. mailbox_message_ids (plain name per replay spec; mirrors injected ids).
    turnRecord.mailbox_message_ids = injectedIds.slice();

    // 6. Adapter (defaults to claude-task per Fix B; panel dispatcher will set explicitly).
    turnRecord.adapter = typeof request.adapter === 'string' && request.adapter.length > 0
      ? request.adapter
      : 'claude-task';

    // 7. requested_role: distinguished from resolved identity.role/id when caller
    // supplies it (slice 6 panel dispatcher will set this; today defaults to identity.id).
    turnRecord.requested_role = typeof request.requestedRole === 'string' && request.requestedRole.length > 0
      ? request.requestedRole
      : identity.id;

    // 8. task text verbatim.
    if (typeof task === 'string' && task.length > 0) {
      turnRecord.task = task;
    }

    // 9. Resolution-audit block (v0.9.0 slice 8 follow-up, per spec § 7
    //    Tier 1). If the caller supplies request.resolution (the return shape
    //    of resolveAdapter — { cli, variant, resolution_source,
    //    preference_index, preference_ladder, unavailable_candidates,
    //    fallback_reason, ... }), persist it on the turn record. The sidecar
    //    validator (appendExpertTurn) enforces field types and silently
    //    ignores anything not in its whitelist, so passing the resolver's
    //    return object verbatim is safe.
    const r = request.resolution;
    if (r && typeof r === 'object') {
      if (typeof r.cli === 'string' && r.cli.length > 0) {
        turnRecord.resolved_cli = r.cli;
      }
      if (typeof r.resolution_source === 'string' && r.resolution_source.length > 0) {
        turnRecord.resolution_source = r.resolution_source;
      }
      if (typeof r.preference_index === 'number' && Number.isInteger(r.preference_index)) {
        turnRecord.preference_index = r.preference_index;
      }
      if (Array.isArray(r.preference_ladder)) {
        turnRecord.preference_ladder = r.preference_ladder.slice();
      }
      if (Array.isArray(r.unavailable_candidates)) {
        turnRecord.unavailable_candidates = r.unavailable_candidates.slice();
      }
      // fallback_reason: null is a valid value (no fallback occurred).
      // Persist null explicitly so the gate's presence-check passes.
      if ('fallback_reason' in r) {
        turnRecord.fallback_reason = r.fallback_reason === null ? null : (
          typeof r.fallback_reason === 'string' && r.fallback_reason.length > 0
            ? r.fallback_reason
            : null
        );
      }
    }
  } catch (err) {
    try {
      d.writeBreadcrumb(
        repoRoot,
        identity.id,
        `replay-field-audit compute failed: ${err.message}`,
      );
    } catch {
      /* best-effort */
    }
  }

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
