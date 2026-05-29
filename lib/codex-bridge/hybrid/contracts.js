// Hybrid contract publication/consumption + UI shim protocol (v0.14.0 Slice 3).
//
// Spec authority: docs/specs/2026-05-28-hybrid-dev-mode-design.md §7.
//
// The mailbox is the shared channel: the backend owner publishes a kind:"contract"
// message to the slice mailbox; the UI owner consumes it. Contract sync state is the
// durable implementer-event stream — `contract_published` / `contract_consumed`
// checkpoint events on phases.implementer_experts. This module DERIVES sync state from
// those events rather than introducing a parallel store (the §9 hybrid status block is a
// Slice-5 convenience mirror, not the source of truth).

import { createHash } from 'node:crypto';
import { writeToMailbox, readMailbox, recipientForMember } from '../mailbox.js';
import { appendImplementerEventLocked, readImplementerRun } from '../sidecar.js';

export class HybridContractError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'HybridContractError';
    this.code = code;
    this.detail = detail;
  }
}

const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n```/;

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function payloadHash(payload) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * The body_hash is sha256 over the EXACT message text (spec §7), so the published hash
 * binds to the literal message the UI owner reads — not a re-serialization of the parsed JSON.
 */
export function computeBodyHash(text) {
  if (!nonEmptyString(text)) {
    throw new HybridContractError('hybrid-contract-malformed', 'contract text must be a non-empty string');
  }
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

/** Parse the single fenced ```json object out of a contract message text. */
export function parseContractText(text) {
  if (!nonEmptyString(text)) {
    throw new HybridContractError('hybrid-contract-malformed', 'contract text must be a non-empty string');
  }
  const m = text.match(FENCED_JSON_RE);
  if (!m) {
    throw new HybridContractError('hybrid-contract-malformed', 'contract text must contain one fenced ```json object');
  }
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    throw new HybridContractError('hybrid-contract-malformed', `contract JSON parse failed: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HybridContractError('hybrid-contract-malformed', 'contract body must be a JSON object');
  }
  if (!Number.isInteger(parsed.contract_version) || parsed.contract_version < 1) {
    throw new HybridContractError('hybrid-contract-malformed', 'contract_version must be a positive integer');
  }
  return parsed;
}

/**
 * Derive contract sync state from the implementer event stream (the audit trail).
 * Returns the latest published/consumed hashes + versions and a sync_state in
 * none|published|consumed|hybrid-contract-changed (spec §9 contract_sync_state).
 */
export function readContractState({ specPath, sliceId }) {
  const run = readImplementerRun(specPath, sliceId);
  const events = Array.isArray(run?.events) ? run.events : [];
  const publishedHashes = [];
  let published = null; // { version, hash }
  let consumed = null;  // { version, hash }
  for (const e of events) {
    if (e.event_type !== 'checkpoint' || !e.payload) continue;
    if (e.payload.kind === 'contract_published') {
      publishedHashes.push(e.payload.body_hash);
      if (!published || e.payload.contract_version > published.version) {
        published = { version: e.payload.contract_version, hash: e.payload.body_hash };
      }
    } else if (e.payload.kind === 'contract_consumed') {
      const v = e.payload.contract_version ?? 0;
      if (!consumed || v > consumed.version) {
        consumed = { version: v, hash: e.payload.body_hash };
      }
    }
  }
  let syncState;
  if (!published) syncState = 'none';
  else if (!consumed) syncState = 'published';
  else if (consumed.version < published.version) syncState = 'hybrid-contract-changed';
  else syncState = 'consumed';
  return {
    latestPublishedHash: published?.hash ?? null,
    latestPublishedVersion: published?.version ?? 0,
    consumedHash: consumed?.hash ?? null,
    consumedVersion: consumed?.version ?? 0,
    publishedHashes,
    syncState,
  };
}

/**
 * Publish a contract. Validates monotonicity + previous_body_hash BEFORE any write, so a
 * rejected publication leaves mailbox + sidecar state byte-equivalent (spec §7 integrity).
 * Writes a kind:"contract" message to the slice mailbox and appends a `contract_published`
 * checkpoint event with body_hash = sha256(exact message text).
 */
export async function publishContract({
  repoRoot, specPath, sliceId, implementerRunId, fromMemberId, text, priority = 'urgent',
}) {
  for (const [name, v] of Object.entries({ repoRoot, specPath, sliceId, implementerRunId, fromMemberId, text })) {
    if (!nonEmptyString(v)) {
      throw new HybridContractError('hybrid-contract-malformed', `publishContract: ${name} must be a non-empty string`);
    }
  }
  const contract = parseContractText(text);
  if (contract.slice_id !== sliceId) {
    throw new HybridContractError('hybrid-contract-malformed', `contract slice_id "${contract.slice_id}" does not match "${sliceId}"`);
  }
  const bodyHash = computeBodyHash(text);

  // Monotonicity vs prior published state.
  const prior = readContractState({ specPath, sliceId });
  if (prior.latestPublishedVersion === 0) {
    if (contract.contract_version !== 1) {
      throw new HybridContractError('hybrid-contract-malformed', `first contract must be version 1 (got ${contract.contract_version})`);
    }
  } else {
    if (contract.contract_version !== prior.latestPublishedVersion + 1) {
      throw new HybridContractError(
        'hybrid-contract-malformed',
        `contract_version must be ${prior.latestPublishedVersion + 1} (got ${contract.contract_version})`,
      );
    }
    if (contract.previous_body_hash !== prior.latestPublishedHash) {
      throw new HybridContractError(
        'hybrid-contract-malformed',
        'previous_body_hash does not match the last published contract',
      );
    }
  }

  // Resolve the publishing member's runtime kind + worktree from the active run.
  const run = readImplementerRun(specPath, sliceId);
  if (!run) {
    throw new HybridContractError('hybrid-contract-malformed', `slice "${sliceId}" has no implementer run`);
  }
  if (run.implementer_run_id !== implementerRunId) {
    throw new HybridContractError(
      'hybrid-contract-malformed',
      `implementerRunId "${implementerRunId}" does not match the active run "${run.implementer_run_id}"`,
    );
  }
  const member = run.members?.[fromMemberId];
  if (!member) {
    throw new HybridContractError('hybrid-contract-malformed', `member "${fromMemberId}" is not registered on slice "${sliceId}"`);
  }

  // All validation passed → write the mailbox message, then the checkpoint event.
  const { id } = await writeToMailbox(repoRoot, sliceId, {
    from: recipientForMember(fromMemberId),
    text,
    kind: 'contract',
    priority,
    implementer_run_id: implementerRunId,
    slice_id: sliceId,
    body_hash: bodyHash,
  });

  const payload = {
    kind: 'contract_published',
    body_hash: bodyHash,
    contract_version: contract.contract_version,
    ui_shim_file: contract.ui_shim_file ?? null,
    source_files: Array.isArray(contract.source_files) ? contract.source_files : [],
  };
  await appendImplementerEventLocked(specPath, {
    event_type: 'checkpoint',
    implementer_run_id: implementerRunId,
    slice_id: sliceId,
    member_id: fromMemberId,
    runtime_kind: member.adapter,
    worktree_id: member.worktree_id,
    payload_hash: payloadHash(payload),
    payload,
    mailbox_message_id: id,
  });

  return { id, bodyHash, contractVersion: contract.contract_version };
}

/** Read the highest-version published contract for a slice from its mailbox. */
export async function readLatestContract({ repoRoot, sliceId }) {
  if (!nonEmptyString(repoRoot) || !nonEmptyString(sliceId)) {
    throw new HybridContractError('hybrid-contract-malformed', 'readLatestContract: repoRoot and sliceId must be non-empty strings');
  }
  const inbox = await readMailbox(repoRoot, sliceId);
  let best = null;
  for (const m of inbox) {
    if (m.kind !== 'contract') continue;
    let contract;
    try {
      contract = parseContractText(m.text);
    } catch {
      continue;
    }
    if (!best || contract.contract_version > best.contractVersion) {
      best = {
        message: m,
        contract,
        bodyHash: m.body_hash ?? computeBodyHash(m.text),
        contractVersion: contract.contract_version,
      };
    }
  }
  return best;
}

/**
 * Record that the UI owner consumed a contract hash. Rejects an unknown or non-latest hash
 * (the UI must consume the LATEST published contract — spec §7) and appends a
 * `contract_consumed` checkpoint event.
 */
export async function recordContractConsumed({ specPath, sliceId, memberId, bodyHash, shimPath }) {
  for (const [name, v] of Object.entries({ specPath, sliceId, memberId, bodyHash })) {
    if (!nonEmptyString(v)) {
      throw new HybridContractError('hybrid-contract-malformed', `recordContractConsumed: ${name} must be a non-empty string`);
    }
  }
  const state = readContractState({ specPath, sliceId });
  if (state.latestPublishedHash === null) {
    throw new HybridContractError('hybrid-contract-not-published', `no contract has been published for slice "${sliceId}"`);
  }
  if (bodyHash !== state.latestPublishedHash) {
    if (state.publishedHashes.includes(bodyHash)) {
      throw new HybridContractError(
        'hybrid-contract-stale-consume',
        `body_hash ${bodyHash} is an older published contract; consume the latest (${state.latestPublishedHash})`,
      );
    }
    throw new HybridContractError(
      'hybrid-contract-unknown-hash',
      `body_hash ${bodyHash} was never published for slice "${sliceId}"`,
    );
  }

  const run = readImplementerRun(specPath, sliceId);
  const member = run?.members?.[memberId];
  if (!member) {
    throw new HybridContractError('hybrid-contract-malformed', `member "${memberId}" is not registered on slice "${sliceId}"`);
  }

  const payload = {
    kind: 'contract_consumed',
    body_hash: bodyHash,
    contract_version: state.latestPublishedVersion,
    shim_file: shimPath ?? null,
  };
  return appendImplementerEventLocked(specPath, {
    event_type: 'checkpoint',
    implementer_run_id: run.implementer_run_id,
    slice_id: sliceId,
    member_id: memberId,
    runtime_kind: member.adapter,
    worktree_id: member.worktree_id,
    payload_hash: payloadHash(payload),
    payload,
  });
}

/**
 * The UI-owned shim path must be claimed by claude-ui and listed in the slice Files block
 * (spec §7.1). A shim pointing outside the UI claim halts with hybrid-owner-files-unclaimed.
 */
export function validateShimClaim({ uiShimFile, claudeUiFiles }) {
  if (!Array.isArray(claudeUiFiles) || !claudeUiFiles.includes(uiShimFile)) {
    throw new HybridContractError(
      'hybrid-owner-files-unclaimed',
      `ui_shim_file "${uiShimFile}" must be a claude-ui claimed file`,
    );
  }
}

function routeConstName(route) {
  const segs = String(route.path || '')
    .split('/')
    .filter(Boolean)
    .filter((s) => s !== 'api')
    .map((s) => s.replace(/[^a-zA-Z0-9]+/g, ' ').trim())
    .filter(Boolean);
  if (segs.length === 0) return 'route';
  const words = segs.join(' ').split(/\s+/);
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return `${camel}Route`;
}

/**
 * Render a UI-local contract shim (spec §7.1) from the parsed contract: structural TS types
 * from `types[]`, route constants from `routes[]`, and a header recording the consumed
 * body_hash so the runner can verify which hash the shim was generated against.
 */
export function renderContractShim({ contract, bodyHash }) {
  if (!contract || typeof contract !== 'object') {
    throw new HybridContractError('hybrid-contract-malformed', 'renderContractShim: contract must be an object');
  }
  if (!nonEmptyString(bodyHash)) {
    throw new HybridContractError('hybrid-contract-malformed', 'renderContractShim: bodyHash must be a non-empty string');
  }
  const lines = [];
  lines.push(`// Generated from hybrid contract body_hash ${bodyHash}`);
  lines.push('// UI-owned contract shim — imported by UI feature code during the concurrent phase.');
  lines.push('// Swapped to re-export the real backend contract after integration (spec §7.1).');
  lines.push('');
  for (const t of Array.isArray(contract.types) ? contract.types : []) {
    lines.push(`export type ${t.name} = {`);
    for (const [field, type] of Object.entries(t.fields ?? {})) {
      lines.push(`  ${field}: ${type};`);
    }
    lines.push('};');
    lines.push('');
  }
  for (const r of Array.isArray(contract.routes) ? contract.routes : []) {
    lines.push(`export const ${routeConstName(r)} = ${JSON.stringify(r.path)};`);
  }
  lines.push('');
  return lines.join('\n');
}
