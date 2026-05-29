// Slice 6 — hybrid runner (interactive + autopilot).
//
// Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §6 (preflight),
// §7 (contract handoff + shim), §8 (interactive run), §9 (autopilot run), §10
// (background classification + halts), §11 (runtime kinds / injectable deps).
//
// This module composes existing primitives — ownership (Slice 1), contracts (Slice 3),
// worktree create + integrate, sidecar run lifecycle (Slice 5), halt-envelope (Slice 4),
// and the autopilot DAG batch selector. Every effectful primitive is injected via `deps`
// so unit tests never shell out, touch a worktree, or dispatch a real worker.

import { createHash } from 'node:crypto';

import { parseHybridOwners as _parseHybridOwners, validateHybridOwnership as _validateHybridOwnership } from './ownership.js';
import { wrapAsHaltEnvelope, isTerminalHalt } from '../halt-envelope.js';
import * as worktree from '../worktree.js';
import { integrate as _integrate } from '../worktree-integrate.js';
import { computeReadySet, maximalFirstFitNonOverlap } from '../dependency-graph.js';
import {
  startImplementerRun as _startImplementerRun,
  appendImplementerEventLocked as _appendImplementerEventLocked,
  completeImplementerRun as _completeImplementerRun,
  setHybridStatus as _setHybridStatus,
} from '../sidecar.js';
import { writeToMailbox as _writeToMailbox, recipientForMember as _recipientForMember } from '../mailbox.js';
import { loadRegistry as _loadRegistry } from '../dispatchers.js';
import { readContractState as _readContractState, verifyShimRealization as _verifyShimRealization } from './contracts.js';

const UI_OWNER = 'claude-ui';
const BACKEND_OWNER = 'codex-backend';
const BACKEND_RUNTIME_KIND = 'codex-background-bash';

function payloadHash(payload) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Verify the dispatcher registry actually offers a transport (spec §6.6). The hybrid
 * runner maps logical owners to ACTUAL transports — `codex-background-bash` for backend
 * and (autopilot) `claude-subagent` for the UI subagent — so it must resolve against the
 * registry's `transport` field, never the logical `claude-ui` adapter. loadRegistry's
 * own drift check verifies the Codex contract doc exists as a side effect.
 *
 * @param {string} transport
 * @returns {object} the matching registry entry
 */
function defaultVerifyTransport(transport) {
  const registry = _loadRegistry();
  const hit = Object.values(registry).find((e) => e && typeof e === 'object' && e.transport === transport);
  if (!hit) {
    throw new Error(`no dispatcher in the registry offers transport "${transport}"`);
  }
  return hit;
}

/**
 * Resolve the UI owner's ACTUAL runtime kind from the run mode (spec §8/§9). The plan's
 * logical `claude-ui` adapter maps to a foreground inline worker (interactive) or a
 * worktree subagent (autopilot); the backend owner is always `codex-background-bash`.
 *
 * @param {'interactive'|'autopilot'} mode
 * @returns {'claude-inline'|'claude-subagent'}
 */
export function resolveUiRuntimeKind(mode) {
  if (mode === 'interactive') return 'claude-inline';
  if (mode === 'autopilot') return 'claude-subagent';
  throw new Error(`resolveUiRuntimeKind: unknown mode "${mode}" (expected "interactive" or "autopilot")`);
}

/**
 * Classify a background Codex status-file observation into a terminal/non-terminal
 * outcome (spec §10). Runtime-limit breach overrides everything; otherwise the
 * status file (or its absence + task liveness) decides.
 *
 * @returns {{ state: string, terminal: boolean, haltReason: string|null }}
 */
export function classifyBackgroundStatus({ statusFile, taskAlive, runtimeMs, maxRuntimeMs }) {
  if (typeof maxRuntimeMs === 'number' && typeof runtimeMs === 'number' && runtimeMs > maxRuntimeMs) {
    return { state: 'timeout', terminal: true, haltReason: 'hybrid-codex-background-timeout' };
  }
  if (statusFile && typeof statusFile === 'object') {
    if (statusFile.status === 'completed' && statusFile.exit_code === 0) {
      return { state: 'completed', terminal: false, haltReason: null };
    }
    // Explicit transient infrastructure marker → keep polling.
    if (statusFile.transient === true) {
      return { state: 'transient', terminal: false, haltReason: null };
    }
    // Nonzero exit or a blocked sentinel → terminal failure.
    if ((typeof statusFile.exit_code === 'number' && statusFile.exit_code !== 0) || statusFile.status === 'blocked') {
      return { state: 'failed', terminal: true, haltReason: 'hybrid-codex-backend-failed' };
    }
    // Status present but not yet terminal (e.g. still running) → keep polling.
    return { state: 'transient', terminal: false, haltReason: null };
  }
  // Status file missing.
  if (taskAlive) {
    return { state: 'transient', terminal: false, haltReason: null };
  }
  return { state: 'lost', terminal: true, haltReason: 'hybrid-codex-background-lost' };
}

/**
 * Verify an owner's actual changed files are within its claim (spec §8.7/§8.8). A
 * rationalized overlap file is part of the owner's claim, so it passes the subset check;
 * any change outside the claim is a violation.
 *
 * @returns {{ ok: true } | { ok: false, haltReason: string, detail: object }}
 */
export function verifyOwnerClaimedFiles({ changedFiles, claimedFiles }) {
  const claim = new Set(Array.isArray(claimedFiles) ? claimedFiles : []);
  const unclaimed = (Array.isArray(changedFiles) ? changedFiles : []).filter((f) => !claim.has(f));
  if (unclaimed.length > 0) {
    return { ok: false, haltReason: 'implementer-claimed-file-violation', detail: { unclaimed } };
  }
  return { ok: true };
}

/**
 * Choose a non-overlapping batch of ready hybrid slices (spec §9, AC-G4). This reuses
 * the existing slice-level DAG selector unchanged, so two hybrid slices co-run only when
 * their whole slice file sets are disjoint.
 *
 * @returns {string[]}
 */
export function selectHybridReadyBatch({ dag, sliceStates, filesIndex, deps = {} }) {
  const ready = (deps.computeReadySet ?? computeReadySet)(dag, sliceStates);
  return (deps.maximalFirstFitNonOverlap ?? maximalFirstFitNonOverlap)(ready, filesIndex);
}

function ownerByRole(owners, role) {
  return owners.find((o) => o.owner === role);
}

function backendWorktreeSliceId(sliceId) {
  return `${sliceId}-codex-backend`;
}

function uiWorktreeSliceId(sliceId) {
  return `${sliceId}-claude-ui`;
}

/**
 * Hybrid preflight (spec §6). Parses + validates owners, resolves runtime kinds, checks
 * the dispatcher registry + contract doc, enforces a clean checkout (interactive), creates
 * the mode-appropriate worktree topology, and starts a two-member implementer run with
 * owner + actual-runtime-kind metadata. On any failure it wraps a halt and dispatches
 * neither owner.
 *
 * Worktree topology (spec §8 vs §9):
 *   - interactive: ONLY the backend worktree (UI edits the foreground checkout, soft-enforced).
 *   - autopilot:   BOTH worktrees from the same slice-start SHA (hard isolation for both halves).
 *
 * @returns {Promise<{ ok: true, implementerRunId: string, mode: string, owners: object, members: object }
 *                   | { ok: false, halt: object }>}
 */
export async function hybridPreflight({
  mode, repoRoot, specPath, sliceId, planMarkdown, sliceSection, sliceFiles, sliceStartSha, deps = {},
}) {
  const parseOwners = deps.parseHybridOwners ?? _parseHybridOwners;
  const validateOwnership = deps.validateHybridOwnership ?? _validateHybridOwnership;
  const verifyTransport = deps.verifyTransport ?? defaultVerifyTransport;
  const contractDocExists = deps.contractDocExists ?? (() => true);
  const isCleanCheckout = deps.isCleanCheckout ?? (() => true);
  const worktreeCreate = deps.worktreeCreate ?? ((root, wtSliceId, sha) => worktree.create(root, wtSliceId, sha));
  const startRun = deps.startImplementerRun ?? _startImplementerRun;
  const setHybrid = deps.setHybridStatus ?? _setHybridStatus;
  const wrapHalt = deps.wrapAsHaltEnvelope ?? wrapAsHaltEnvelope;

  const uiRuntimeKind = resolveUiRuntimeKind(mode);

  // ── 1. ownership parse + validation (Slice 1) ──────────────────────────────
  let owners;
  try {
    owners = parseOwners(planMarkdown, sliceSection);
    owners = validateOwnership({ sliceFiles, implementers: owners });
  } catch (err) {
    return { ok: false, halt: wrapHalt(err.code ?? 'hybrid-ownership-malformed', { slice_id: sliceId, cause: err.message }) };
  }

  const ui = ownerByRole(owners, UI_OWNER);
  const backend = ownerByRole(owners, BACKEND_OWNER);

  // ── 2. dispatcher transport verification + contract doc check (spec §6.6) ──
  // Verify ACTUAL transports through the registry, not the logical `claude-ui` adapter:
  // backend must offer `codex-background-bash`; the autopilot UI subagent must offer
  // `claude-subagent`. Interactive UI is the foreground inline worker and needs no
  // registry transport. loadRegistry's drift check also verifies the Codex contract doc.
  try {
    verifyTransport(BACKEND_RUNTIME_KIND);
    if (mode === 'autopilot') verifyTransport(uiRuntimeKind);
    if (!contractDocExists({ owner: backend })) {
      return { ok: false, halt: wrapHalt('hybrid-dispatcher-invalid', { slice_id: sliceId, detail: 'backend contract doc missing' }) };
    }
  } catch (err) {
    return { ok: false, halt: wrapHalt('hybrid-dispatcher-invalid', { slice_id: sliceId, cause: err.message }) };
  }

  // ── 3. interactive clean-checkout requirement ──────────────────────────────
  if (mode === 'interactive' && !isCleanCheckout(repoRoot)) {
    return { ok: false, halt: wrapHalt('hybrid-preflight-dirty', { slice_id: sliceId }) };
  }

  // ── 4. worktree topology by mode ───────────────────────────────────────────
  const worktrees = {};
  const backendWt = worktreeCreate(repoRoot, backendWorktreeSliceId(sliceId), sliceStartSha);
  if (!backendWt.ok) {
    return { ok: false, halt: wrapHalt(backendWt.halt?.reason ?? 'hybrid-dispatcher-invalid', { slice_id: sliceId, detail: backendWt.halt?.detail }) };
  }
  worktrees[BACKEND_OWNER] = backendWt;

  if (mode === 'autopilot') {
    const uiWt = worktreeCreate(repoRoot, uiWorktreeSliceId(sliceId), sliceStartSha);
    if (!uiWt.ok) {
      return { ok: false, halt: wrapHalt(uiWt.halt?.reason ?? 'hybrid-dispatcher-invalid', { slice_id: sliceId, detail: uiWt.halt?.detail }) };
    }
    worktrees[UI_OWNER] = uiWt;
  } else {
    // Interactive UI is the foreground checkout — no worktree, soft-enforced.
    worktrees[UI_OWNER] = { ok: true, worktreePath: repoRoot, branchName: null, foreground: true };
  }

  // ── 5. start the two-member run with owner + runtime metadata ──────────────
  const members = {
    [ui.member_id]: {
      adapter: ui.adapter,
      model: ui.model,
      required: true,
      worktree_id: mode === 'autopilot' ? uiWorktreeSliceId(sliceId) : `${sliceId}-foreground`,
      branch: worktrees[UI_OWNER].branchName ?? `${sliceId}-foreground`,
      claimed_files: [...ui.files],
      owner: UI_OWNER,
      runtime_kind: uiRuntimeKind,
    },
    [backend.member_id]: {
      adapter: backend.adapter,
      model: backend.model,
      required: true,
      worktree_id: backendWorktreeSliceId(sliceId),
      branch: backendWt.branchName,
      claimed_files: [...backend.files],
      owner: BACKEND_OWNER,
      runtime_kind: BACKEND_RUNTIME_KIND,
    },
  };
  if (ui.overlap_rationale) members[ui.member_id].overlap_rationale = ui.overlap_rationale;
  if (backend.overlap_rationale) members[backend.member_id].overlap_rationale = backend.overlap_rationale;

  const { implementer_run_id } = await startRun(specPath, sliceId, { base_sha: sliceStartSha, members });

  // Seed the §9 hybrid status block (convenience mirror; event stream stays authoritative).
  setHybrid(specPath, sliceId, {
    owners: {
      [UI_OWNER]: {
        member_id: ui.member_id, status: 'in-progress', worktree: worktrees[UI_OWNER].worktreePath,
        claimed_files: [...ui.files], contract_consumed_hash: null,
        contract_shim_file: ui.files.find((f) => f.includes('__hybrid_contracts__')) ?? null,
        shim_swapped_to_real_contract: false,
      },
      [BACKEND_OWNER]: {
        member_id: backend.member_id, status: 'in-progress', worktree: backendWt.worktreePath,
        claimed_files: [...backend.files], contract_published_hash: null,
      },
    },
    latest_contract_hash: null, contract_version: 0, contract_sync_state: 'none',
  });

  return {
    ok: true,
    implementerRunId: implementer_run_id,
    mode,
    owners: {
      [UI_OWNER]: {
        member_id: ui.member_id, runtime_kind: uiRuntimeKind, worktree: worktrees[UI_OWNER],
        worktree_id: members[ui.member_id].worktree_id, claimed_files: [...ui.files],
      },
      [BACKEND_OWNER]: {
        member_id: backend.member_id, runtime_kind: BACKEND_RUNTIME_KIND, worktree: backendWt,
        worktree_id: members[backend.member_id].worktree_id, claimed_files: [...backend.files],
      },
    },
    members,
  };
}

/**
 * Bounded wait for the backend contract (spec §7). The timer represents the window the
 * UI owner is blocked on contract-dependent work; it does not bound the whole UI session.
 *
 *   - a contract is published       → { state: 'published', latestPublishedHash }
 *   - timeout while backend is live  → { state: 'blocked', terminal: false } (non-terminal pause)
 *   - timeout while backend terminal → { state: 'halt', haltReason: 'hybrid-contract-not-published' }
 *
 * @returns {Promise<object>}
 */
export async function awaitContract({ specPath, sliceId, backendTerminal, contractWaitMs, deps = {} }) {
  const readState = deps.readContractState ?? ((args) => _readContractState(args));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 250;
  const start = now();

  for (;;) {
    const state = readState({ specPath, sliceId });
    if (state.latestPublishedHash) {
      return { state: 'published', latestPublishedHash: state.latestPublishedHash, syncState: state.syncState };
    }
    if (now() - start >= contractWaitMs) {
      const terminal = typeof backendTerminal === 'function' ? backendTerminal() : Boolean(backendTerminal);
      if (terminal) {
        return { state: 'halt', terminal: true, haltReason: 'hybrid-contract-not-published' };
      }
      return { state: 'blocked', terminal: false };
    }
    await sleep(pollMs);
  }
}

/**
 * Run a hybrid slice end to end (spec §8 interactive / §9 autopilot). Composes preflight →
 * concurrent dispatch (UI + backend under one run) → contract handoff → claimed-file
 * verification → integration → shim swap + final typecheck against the real backend
 * contract. Required-owner failure aborts the live sibling; every halt is wrapped and
 * checked against `isTerminalHalt` before any retry (this runner never auto-retries).
 *
 * @returns {Promise<{ ok: true, headSha: string, shimSwapped: boolean }
 *                   | { ok: false, halt: object, retried: boolean }>}
 */
export async function runHybridSlice(args) {
  const { mode, repoRoot, specPath, sliceId, sliceStartSha, integrationBranch, contractWaitMs, deps = {} } = args;
  const wrapHalt = deps.wrapAsHaltEnvelope ?? wrapAsHaltEnvelope;
  const terminalCheck = deps.isTerminalHalt ?? isTerminalHalt;
  const integrate = deps.integrate ?? ((a) => _integrate(a));
  const typecheck = deps.typecheck ?? (() => ({ ok: true }));
  const verifyShim = deps.verifyShimRealization
    ?? (({ bodyHash, backendContractFiles }) => _verifyShimRealization({ bodyHash, backendContractFiles, typecheck }));
  const readContractState = deps.readContractState ?? ((a) => _readContractState(a));
  const awaitContractFn = deps.awaitContract ?? awaitContract;
  const completeRun = deps.completeImplementerRun ?? _completeImplementerRun;
  const appendEvent = deps.appendImplementerEventLocked ?? _appendImplementerEventLocked;
  const writeMailbox = deps.writeToMailbox ?? _writeToMailbox;
  const toRecipient = deps.recipientForMember ?? _recipientForMember;
  const isCleanCheckout = deps.isCleanCheckout ?? (() => true);

  // Surface a halt: wrap, consult isTerminalHalt before any retry, never auto-retry.
  const halt = (reason, context = {}) => {
    const envelope = wrapHalt(reason, { slice_id: sliceId, ...context });
    terminalCheck(envelope);
    return { ok: false, halt: envelope, retried: false };
  };

  // ── preflight ──────────────────────────────────────────────────────────────
  const pre = await hybridPreflight({ ...args, deps });
  if (!pre.ok) {
    terminalCheck(pre.halt);
    return { ok: false, halt: pre.halt, retried: false };
  }
  const { owners, implementerRunId } = pre;
  const ui = owners[UI_OWNER];
  const backend = owners[BACKEND_OWNER];

  // ── concurrent dispatch under a shared abort signal (spec §9.9) ────────────
  const abortController = new AbortController();
  const signal = abortController.signal;
  const dispatchInput = (owner) => ({
    sliceId, implementerRunId, memberId: owner.member_id, runtimeKind: owner.runtime_kind,
    worktreePath: owner.worktree.worktreePath, branchName: owner.worktree.branchName,
    baseSha: sliceStartSha, claimedFiles: owner.claimed_files, abortSignal: signal, env: {},
  });

  const recordEvent = async (owner, eventType, payload) => {
    await appendEvent(specPath, {
      event_type: eventType,
      implementer_run_id: implementerRunId,
      slice_id: sliceId,
      member_id: owner.member_id,
      runtime_kind: owner.runtime_kind,
      worktree_id: owner.worktree_id,
      payload_hash: payloadHash(payload),
      payload,
    });
  };

  const runOne = async (owner, fn) => {
    await recordEvent(owner, 'started', { phase: 'dispatch-start', owner: owner.member_id });
    try {
      const result = await fn(dispatchInput(owner));
      const eventType = result.outcome === 'completed' ? 'completed' : result.outcome === 'cancelled' ? 'cancelled' : 'failed';
      await recordEvent(owner, eventType, { outcome: result.outcome });
      if (result.outcome !== 'completed' && result.outcome !== 'cancelled') {
        abortController.abort(); // required owner failed → abort the live sibling
      }
      return { owner, result };
    } catch (err) {
      abortController.abort();
      await recordEvent(owner, 'failed', { outcome: 'failed', cause: err.message });
      return { owner, result: { memberId: owner.member_id, outcome: 'failed', changedFiles: [], haltEnvelope: null, error: err.message } };
    }
  };

  const [uiOut, backendOut] = await Promise.all([
    runOne(ui, deps.dispatch.ui),
    runOne(backend, deps.dispatch.backend),
  ]);

  // ── classify owner outcomes; a required failure aborts integration ─────────
  const failed = [uiOut, backendOut].find((o) => o.result.outcome === 'failed' || o.result.outcome === 'halted');
  if (failed) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'failed' });
    // Honor a halt envelope the dispatch surfaced — the background poller classifies the
    // precise §10 reason via classifyBackgroundStatus (hybrid-codex-background-lost /
    // -timeout, or hybrid-codex-backend-failed) and carries it on the dispatch result.
    const env = failed.result.haltEnvelope;
    if (env && (env.halt || env.reason)) {
      terminalCheck(env);
      return { ok: false, halt: env, retried: false };
    }
    // No envelope: backend → hybrid-codex-backend-failed; UI → required-child-failed.
    const fallback = failed.owner === backend ? 'hybrid-codex-backend-failed' : 'implementer-required-child-failed';
    return halt(fallback, { failed_owner: failed.owner.member_id });
  }

  // ── contract handoff: backend must have published; UI must consume latest ──
  const backendTerminal = () => true; // both owners reached terminal above
  const contract = await awaitContractFn({ specPath, sliceId, backendTerminal, contractWaitMs, deps });
  // Only a published contract may proceed. A terminal timeout halts; a non-terminal
  // `blocked` (timer expired while the backend is still live) must NOT fall through to
  // integration/shim with a null bodyHash — surface it as the not-published halt.
  if (contract.state !== 'published') {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    return halt(contract.haltReason ?? 'hybrid-contract-not-published');
  }

  const state = readContractState({ specPath, sliceId });
  if (state.latestPublishedHash && state.consumedHash !== state.latestPublishedHash) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    // Older hash consumed → stale-at-completion; nothing consumed → not-consumed.
    const reason = state.consumedHash ? 'hybrid-contract-stale-at-completion' : 'hybrid-contract-not-consumed';
    return halt(reason);
  }

  // Surface the UI→orchestrator contract acknowledgement (spec §7: the UI owner acks the
  // consumed hash to orchestrator in addition to the sidecar checkpoint). recordContractConsumed
  // only writes the checkpoint, so the runner emits the visible mailbox ack here.
  if (state.consumedHash) {
    await writeMailbox(repoRoot, 'orchestrator', {
      from: toRecipient(ui.member_id),
      kind: 'progress',
      slice_id: sliceId,
      implementer_run_id: implementerRunId,
      body_hash: state.consumedHash,
      text: `UI owner consumed hybrid contract ${state.consumedHash} for ${sliceId}`,
    });
  }

  // ── claimed-file verification, both owners (spec §8.7/§8.8) ────────────────
  for (const out of [uiOut, backendOut]) {
    const v = verifyOwnerClaimedFiles({ changedFiles: out.result.changedFiles, claimedFiles: out.owner.claimed_files });
    if (!v.ok) {
      await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
      return halt(v.haltReason, { owner: out.owner.member_id, ...v.detail });
    }
  }

  // ── §8.10: no cherry-pick onto a dirty foreground checkout ─────────────────
  // The interactive UI half edits the foreground tree directly. Before cherry-picking
  // the backend branch in, that UI work must be committed/stashed (autopilot commit
  // convention); a dirty tree halts so the operator commits/stashes and re-runs.
  if (mode === 'interactive' && !isCleanCheckout(repoRoot)) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    return halt('hybrid-preflight-dirty', { detail: 'foreground UI work must be committed or stashed before the backend cherry-pick (spec §8.10)' });
  }

  // ── integration: backend branch first (contract source), then UI ──────────
  const slices = [];
  if (backend.worktree.branchName) {
    slices.push({ sliceId: backendWorktreeSliceId(sliceId), branchName: backend.worktree.branchName, sliceStartSha });
  }
  if (ui.worktree.branchName) {
    slices.push({ sliceId: uiWorktreeSliceId(sliceId), branchName: ui.worktree.branchName, sliceStartSha });
  }
  const integration = integrate({ repoRoot, integrationBranch, slices });
  if (!integration.ok) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    return halt(integration.halt?.reason ?? 'worktree-integration-empty', { detail: integration.halt?.detail });
  }

  // ── shim swap + final typecheck against the REAL backend contract (spec §7.1) ─
  const realized = verifyShim({ bodyHash: state.consumedHash, backendContractFiles: backend.claimed_files });
  if (!realized.ok) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    return halt('hybrid-contract-realization-mismatch');
  }
  const typed = typecheck({ repoRoot, integrationBranch });
  if (!typed.ok) {
    await completeRun(specPath, sliceId, implementerRunId, { status: 'halted' });
    return halt('hybrid-contract-realization-mismatch', { detail: 'final typecheck failed' });
  }

  await completeRun(specPath, sliceId, implementerRunId, { status: 'completed' });
  return { ok: true, headSha: integration.head_sha, shimSwapped: true };
}
