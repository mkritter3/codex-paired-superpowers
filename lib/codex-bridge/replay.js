// v0.9.0 slice 5b — stateless replay reconstruction.
//
// Per spec § 5 "Safety / Failure Semantics": "Stateless replay is canonical
// truth." Each turn's sidecar record contains everything needed to reconstruct
// the assembled prompt and verify integrity:
//
//   - role_prompt_version + role_prompt_hash      → which prompt was used
//   - spec_path + spec_snippet_hash               → spec context
//   - mailbox_message_ids                         → injected mailbox payload
//   - inputs_hash                                 → audit hash over all of the above
//   - response_text_inline OR response_ref        → recorded response
//   - response_hash                               → audit hash of the response
//
// `replayTurn(turn, deps)` is AUDIT-ONLY. It does NOT re-dispatch; it just
// reconstructs the assembled prompt and verifies recorded hashes match
// recomputed values. Cross-CLI audit checks (codex-recorded → claude-replayed)
// surface adapter mismatches as warnings, not failures.

import { createHash } from 'node:crypto';

import { readResponse, computeInputsHash } from './sidecar.js';

/**
 * @typedef {object} ReplayDeps
 * @property {(roleId:string)=>{content:string, hash:string, version:string}} loadRolePrompt
 *   — load the role prompt file. Hash must include frontmatter (full file).
 * @property {(repoRoot:string, ids:string[])=>Array<{id:string,from:string,text:string,timestamp:string}>} readMailboxMessages
 *   — read mailbox messages by id. Order should match recorded.
 * @property {(specPath:string)=>string} readSpecSnippet
 *   — read the current spec snippet (used to recompute spec_snippet_hash).
 * @property {(repoRoot:string, ref:string)=>string} [readResponseFile]
 *   — override for overflow response read (defaults to sidecar.readResponse).
 * @property {string} [repoRoot] — required when response_ref is present.
 * @property {string} [adapter] — currently-supplied adapter id. If provided
 *   and turn.adapter differs, a warning is recorded.
 */

/**
 * @typedef {object} ReplayResult
 * @property {string} assembledPrompt
 * @property {boolean} inputsHashMatches
 * @property {boolean} responseHashMatches
 * @property {string[]} warnings
 */

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Reconstruct the assembled prompt from a recorded turn and verify all
 * recorded hashes match recomputed values.
 *
 * @param {object} turn — sidecar turn entry
 * @param {ReplayDeps} deps
 * @returns {ReplayResult}
 */
export function replayTurn(turn, deps = {}) {
  if (!turn || typeof turn !== 'object') {
    throw new Error('replayTurn: turn must be an object');
  }
  if (!deps || typeof deps !== 'object') {
    throw new Error('replayTurn: deps must be an object');
  }
  if (typeof deps.loadRolePrompt !== 'function') {
    throw new Error('replayTurn: deps.loadRolePrompt must be a function');
  }
  if (typeof deps.readMailboxMessages !== 'function') {
    throw new Error('replayTurn: deps.readMailboxMessages must be a function');
  }
  if (typeof deps.readSpecSnippet !== 'function') {
    throw new Error('replayTurn: deps.readSpecSnippet must be a function');
  }

  const warnings = [];

  // 1. Load role prompt; compare hash/version against recorded.
  const roleId = turn.requested_role || turn.role_id || turn.expert_id;
  if (typeof roleId !== 'string' || roleId.length === 0) {
    throw new Error(
      'replayTurn: turn is missing role identifier (requested_role / role_id / expert_id)'
    );
  }
  const roleResolved = deps.loadRolePrompt(roleId);
  if (!roleResolved || typeof roleResolved.content !== 'string' || typeof roleResolved.hash !== 'string') {
    throw new Error(
      `replayTurn: deps.loadRolePrompt("${roleId}") returned malformed result`
    );
  }
  if (turn.role_prompt_hash && turn.role_prompt_hash !== `sha256:${roleResolved.hash}` && turn.role_prompt_hash !== roleResolved.hash) {
    warnings.push(
      `role_prompt_hash mismatch: recorded=${turn.role_prompt_hash} recomputed=sha256:${roleResolved.hash}`
    );
  }
  if (turn.role_prompt_version && roleResolved.version && turn.role_prompt_version !== roleResolved.version) {
    warnings.push(
      `role_prompt_version drift: recorded=${turn.role_prompt_version} loaded=${roleResolved.version}`
    );
  }

  // 2. Spec snippet recompute.
  const specSnippet = deps.readSpecSnippet(turn.spec_path);
  if (typeof specSnippet !== 'string') {
    throw new Error('replayTurn: deps.readSpecSnippet returned non-string');
  }
  const recomputedSpecHash = `sha256:${sha256Hex(specSnippet)}`;
  if (turn.spec_snippet_hash && turn.spec_snippet_hash !== recomputedSpecHash) {
    warnings.push(
      `spec_snippet_hash mismatch: recorded=${turn.spec_snippet_hash} recomputed=${recomputedSpecHash}`
    );
  }

  // 3. Mailbox messages.
  const recordedIds = Array.isArray(turn.mailbox_message_ids)
    ? turn.mailbox_message_ids
    : Array.isArray(turn.mailbox_message_ids_injected)
      ? turn.mailbox_message_ids_injected
      : [];
  const messages = deps.readMailboxMessages(deps.repoRoot, recordedIds) || [];

  // 4. Adapter mismatch surface.
  if (deps.adapter && turn.adapter && deps.adapter !== turn.adapter) {
    warnings.push(
      `adapter mismatch: recorded=${turn.adapter} supplied=${deps.adapter}`
    );
  }

  // 5. Assemble the prompt (canonical replay form — minimal, deterministic).
  //    NOTE: this is the AUDIT-grade reconstruction; it intentionally mirrors
  //    the parts that feed into inputs_hash. The live dispatch prompt may add
  //    additional framing (rubric headers etc) which are deterministic given
  //    the same role-prompt content.
  const assembledPrompt = assembleReplayPrompt({
    roleId,
    rolePromptContent: roleResolved.content,
    specPath: turn.spec_path,
    specSnippet,
    mailboxMessages: messages,
    phase: turn.phase,
    task: turn.task ?? '',
  });

  // 6. Recompute inputs_hash and compare.
  const recomputedInputsHash = computeInputsHash({
    rolePromptHash: roleResolved.hash,
    specSnippetHash: sha256Hex(specSnippet),
    mailboxMessageIds: recordedIds,
    phase: turn.phase,
    task: turn.task ?? '',
    roleId,
  });
  const recordedInputsHash = turn.inputs_hash || null;
  const inputsHashMatches =
    typeof recordedInputsHash === 'string' && recordedInputsHash === recomputedInputsHash;

  if (recordedInputsHash && !inputsHashMatches) {
    warnings.push(
      `inputs_hash mismatch: recorded=${recordedInputsHash} recomputed=${recomputedInputsHash}`
    );
  } else if (!recordedInputsHash) {
    // v0.9.1 hardening: a turn missing inputs_hash cannot be hash-verified.
    // Emit an explicit "not replayable" warning rather than silently
    // returning inputsHashMatches=false. Legacy v0.8.x turns hit this path.
    warnings.push(
      'inputs_hash missing — turn not fully replayable (legacy sidecar or pre-v0.9.0 record)'
    );
  }

  // 7. Response hash verify (read inline or overflow).
  let responseHashMatches = false;
  if (turn.response_text_inline !== undefined && turn.response_text_inline !== null) {
    const computed = `sha256:${sha256Hex(turn.response_text_inline)}`;
    responseHashMatches = computed === turn.response_hash;
    if (turn.response_hash && !responseHashMatches) {
      warnings.push(
        `response_hash mismatch (inline): recorded=${turn.response_hash} recomputed=${computed}`
      );
    }
  } else if (turn.response_ref) {
    const reader = deps.readResponseFile || ((root, ref) => readResponse(root, { response_ref: ref, response_hash: turn.response_hash }));
    try {
      const text = reader(deps.repoRoot, turn.response_ref);
      const computed = `sha256:${sha256Hex(text)}`;
      responseHashMatches = computed === turn.response_hash;
      if (turn.response_hash && !responseHashMatches) {
        warnings.push(
          `response_hash mismatch (overflow): recorded=${turn.response_hash} recomputed=${computed}`
        );
      }
    } catch (err) {
      warnings.push(`response_ref read failed: ${err.message}`);
    }
  } else if (turn.response_hash) {
    warnings.push('response_hash recorded but neither response_text_inline nor response_ref present');
  }

  return {
    assembledPrompt,
    inputsHashMatches,
    responseHashMatches,
    warnings,
  };
}

/**
 * Replay implementer events from a sidecar for a given slice.
 *
 * @param {object} sidecar — full sidecar object (not the specPath)
 * @param {{sliceId:string, memberId?:string, mailboxCausal?:boolean}} opts
 * @returns {{events: object[], warnings: string[], causalChains?: Array<{root:number, chain:number[]}>}}
 */
export function replayImplementerEvents(sidecar, opts) {
  // Sync caller validation
  if (sidecar === null || sidecar === undefined || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new Error('replayImplementerEvents: sidecar must be a non-null object');
  }
  if (!opts || typeof opts !== 'object') {
    throw new Error('replayImplementerEvents: opts must be an object');
  }
  const { sliceId, memberId, mailboxCausal } = opts;
  if (typeof sliceId !== 'string' || sliceId.length === 0) {
    throw new Error('replayImplementerEvents: opts.sliceId must be a non-empty string');
  }

  const warnings = [];

  // Source: sidecar.slice_reviews[sliceId].phases.implementer_experts.events[]
  const sliceBlock = sidecar.slice_reviews?.[sliceId];
  const ieBlock = sliceBlock?.phases?.implementer_experts;
  if (!ieBlock || !Array.isArray(ieBlock.events)) {
    return {
      events: [],
      warnings: [`slice ${sliceId} has no implementer_experts block`],
      causalChains: undefined,
    };
  }

  // Validate and collect events
  const validEvents = [];
  for (let i = 0; i < ieBlock.events.length; i++) {
    const ev = ieBlock.events[i];
    if (!ev || typeof ev !== 'object') {
      warnings.push(`slice ${sliceId}[${i}]: event is not an object — skipped`);
      continue;
    }

    // Validate event_seq
    const seq = ev.event_seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      const seqStr = seq !== undefined ? JSON.stringify(seq) : 'missing';
      warnings.push(
        `slice ${sliceId}[${i}]: invalid event_seq ${seqStr} — skipped`
      );
      continue;
    }

    // Validate event_type
    if (typeof ev.event_type !== 'string' || ev.event_type.length === 0) {
      warnings.push(
        `slice ${sliceId}[${i}]: event_type missing or empty (event_seq=${seq}) — skipped`
      );
      continue;
    }

    // Validate parent_event_seq if present
    if (ev.parent_event_seq !== undefined && ev.parent_event_seq !== null) {
      const p = ev.parent_event_seq;
      if (typeof p !== 'number' || !Number.isInteger(p) || p <= 0) {
        warnings.push(
          `slice ${sliceId}[${i}]: invalid parent_event_seq ${JSON.stringify(p)} (event_seq=${seq}) — skipped`
        );
        continue;
      }
    }

    validEvents.push(ev);
  }

  // Apply memberId filter BEFORE sort
  let filtered = validEvents;
  if (typeof memberId === 'string' && memberId.length > 0) {
    filtered = validEvents.filter(ev => ev.member_id === memberId);
  }

  // Sort by event_seq ascending (global)
  filtered.sort((a, b) => a.event_seq - b.event_seq);

  // mailboxCausal: build causal chains
  let causalChains;
  if (mailboxCausal) {
    // Build a map from event_seq → event (over ALL valid events, not just filtered)
    const seqMap = new Map();
    for (const ev of validEvents) {
      if (seqMap.has(ev.event_seq)) {
        warnings.push(
          `slice ${sliceId}: duplicate event_seq ${ev.event_seq} detected`
        );
      } else {
        seqMap.set(ev.event_seq, ev);
      }
    }

    // Build parent → children map
    const childrenOf = new Map(); // seq → [child seqs]
    for (const ev of validEvents) {
      if (ev.parent_event_seq != null) {
        const p = ev.parent_event_seq;
        if (!childrenOf.has(p)) childrenOf.set(p, []);
        childrenOf.get(p).push(ev.event_seq);
      }
    }

    // Find events with mailbox_message_id set
    const mailboxEvents = validEvents.filter(ev => ev.mailbox_message_id != null);

    // Check for duplicate mailbox_message_id
    const seenMsgIds = new Map(); // msgId → event_seq
    for (const ev of mailboxEvents) {
      const msgId = ev.mailbox_message_id;
      if (seenMsgIds.has(msgId)) {
        warnings.push(
          `slice ${sliceId}: duplicate mailbox_message_id "${msgId}" at event_seq ${ev.event_seq} ` +
          `(earlier at event_seq ${seenMsgIds.get(msgId)}) — deduped`
        );
      } else {
        seenMsgIds.set(msgId, ev.event_seq);
      }
    }

    // For each unique mailbox event (by event_seq of first occurrence), walk causal chain
    const chainRoots = new Map(); // root event_seq → Set of all seqs in chain
    const visited = new Set();

    function walkChain(startSeq) {
      const chainSeqs = new Set();
      const stack = [startSeq];
      const localVisited = new Set();

      while (stack.length > 0) {
        const seq = stack.pop();

        // Cycle detection: if we've already visited this seq in this walk
        if (localVisited.has(seq)) {
          warnings.push(
            `slice ${sliceId}: cycle detected at event_seq ${seq} in causal chain — stopping traversal`
          );
          continue;
        }

        // Global visited: already consumed by a prior chain walk
        if (visited.has(seq)) continue;

        // Check event exists before marking visited/added
        const ev = seqMap.get(seq);
        if (!ev) {
          // seq points to a non-existent event (e.g., parent outside slice) — stop here
          continue;
        }

        localVisited.add(seq);
        visited.add(seq);
        chainSeqs.add(seq);

        // Walk backward via parent_event_seq
        if (ev.parent_event_seq != null) {
          stack.push(ev.parent_event_seq);
        }

        // Walk forward via children
        const children = childrenOf.get(seq) || [];
        for (const childSeq of children) {
          stack.push(childSeq);
        }
      }

      return chainSeqs;
    }

    for (const ev of mailboxEvents) {
      const msgId = ev.mailbox_message_id;
      // Only process first occurrence of each msgId
      if (seenMsgIds.get(msgId) !== ev.event_seq) continue;
      if (visited.has(ev.event_seq)) continue;

      const chainSeqs = walkChain(ev.event_seq);
      const sortedSeqs = [...chainSeqs].sort((a, b) => a - b);
      const root = sortedSeqs[0];
      chainRoots.set(root, sortedSeqs);
    }

    causalChains = [...chainRoots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([root, chain]) => ({ root, chain }));
  }

  return {
    events: filtered,
    warnings,
    causalChains,
  };
}

/**
 * Assemble a deterministic replay-grade prompt from canonical inputs.
 * Mirrors the inputs_hash domain — same components in same order.
 */
function assembleReplayPrompt({
  roleId,
  rolePromptContent,
  specPath,
  specSnippet,
  mailboxMessages,
  phase,
  task,
}) {
  const messagesBlock = (Array.isArray(mailboxMessages) && mailboxMessages.length > 0)
    ? mailboxMessages
        .map((m) => `### ${m.id} (from ${m.from}, ${m.timestamp})\n${m.text}`)
        .join('\n\n')
    : '(none)';

  return [
    `# Replay Reconstruction`,
    ``,
    `## Role`,
    roleId,
    ``,
    `## Role Prompt`,
    rolePromptContent,
    ``,
    `## Phase`,
    phase || '',
    ``,
    `## Spec Path`,
    specPath || '',
    ``,
    `## Spec Snippet`,
    specSnippet,
    ``,
    `## Mailbox Messages`,
    messagesBlock,
    ``,
    `## Task`,
    task || '',
  ].join('\n');
}
