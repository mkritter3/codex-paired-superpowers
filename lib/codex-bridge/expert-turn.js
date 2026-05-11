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

import { readUnreadMessages, markManyAsRead } from './mailbox.js';
import { parseExpertOutput, buildRepairPrompt } from './expert-output-parser.js';
import { appendExpertTurn } from './sidecar.js';
import { writeBreadcrumb } from './hook-mailbox-inject.js';

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
    `These operating rules govern this turn. Adhere to the L11 / expert operating contract: scope your review to your declared role; emit findings, not edits; route peer questions through mailbox-write only.`,
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
    `  - peer_messages_sent: array of {to, summary} for any DMs you sent via mailbox-write`,
    `  - questions_for_orchestrator: array (may be empty)`,
  ].join('\n');
}

const realDeps = {
  readUnreadMessages,
  markManyAsRead,
  parseExpertOutput,
  buildRepairPrompt,
  agentDispatch: defaultAgentDispatch,
  appendExpertTurn,
  writeBreadcrumb,
};

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
        mailbox_message_ids_injected: [],
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
        mailbox_message_ids_injected: [], // not marked read; DO NOT claim injection succeeded
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

  // 7. Success path: mark read + append turn.
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

  const parsed = parseResult.result;
  const summary =
    parsed.status === 'SHIP'
      ? 'SHIP'
      : `REVISE: ${parsed.blocking_findings.length} blocking, ${parsed.nonblocking_findings.length} nonblocking`;

  await safeAppendTurn(
    d,
    specPath,
    {
      expert_id: identity.id,
      phase,
      slice_id: sliceId || null,
      mailbox_message_ids_injected: injectedIds,
      started_at: startedAt,
      completed_at: completedAt,
      result_summary: summary,
      verdict: parsed.status,
      failure_reason: null,
    },
    repoRoot,
    identity
  );

  return { ok: true, result: parsed };
}

// Default agent dispatch. Slice 7 wires the real Agent-tool adapter (or the
// manual user procedure per spec §9.3 escape hatch). Slice 4 leaves a clear
// error so callers that wire this up without slice 7's adapter see an explicit
// signal rather than mysterious silence.
async function defaultAgentDispatch(_prompt, _identity, _phase) {
  throw new Error(
    'expert-turn agentDispatch not wired — slice 7 implements the production Agent adapter'
  );
}

export async function runTurn(request) {
  return runTurnWithDeps(request, {});
}
