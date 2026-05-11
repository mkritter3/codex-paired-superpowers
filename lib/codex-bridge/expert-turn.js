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

import { readUnreadMessages, markManyAsRead } from './mailbox.js';
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
