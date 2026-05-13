// v0.10.0 mailbox-poller — polls an implementer's mailbox inbox during execution.
//
// Export: createMailboxPoller({ ... }) → { pollNow, start, stop, on }
// Export: injectMailboxDelivery(adapter, messages) → void (stub; wired in slice 10)
//
// Design decisions:
//  - ES module.
//  - All timers injected via scheduler/clearScheduler seams (no global state).
//  - Dedupe set is per-instance; stop() clears it for clean restart.
//  - mailbox_poll event is debounced: only emitted if >1000ms since last poll-event.
//  - Partial-batch failure (appendImplementerEventLocked throws mid-batch):
//      - Events already written to sidecar remain (they're persisted).
//      - Message IDs for failed/unprocessed messages are NOT added to the dedupe Set.
//      - pollNow() rejects so the caller can handle / retry.

import { createHash } from 'node:crypto';
import { recipientForMember } from '../mailbox.js';
import {
  readUnreadMessages,
  writeToMailbox as _writeToMailbox,  // only imported so we can verify mailbox.js exports it
} from '../mailbox.js';
import { appendImplementerEventLocked } from '../sidecar.js';

function sha256hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Validate that a value is a non-empty string.
 * @param {unknown} v
 * @param {string} fieldName
 */
function requireNonEmptyString(v, fieldName) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new TypeError(
      `createMailboxPoller: ${fieldName} must be a non-empty string; got ${JSON.stringify(v)}`
    );
  }
}

/**
 * Create a mailbox poller that reads unread messages for an implementer member
 * on a regular cadence and appends sidecar events for each delivery.
 *
 * @param {object} opts
 * @param {string}   opts.specPath             — path to the spec file (for sidecar writes)
 * @param {string}   opts.repoRoot             — repo root (for readUnreadMessages)
 * @param {string}   opts.sliceId              — slice being implemented (cross-field in events)
 * @param {string}   opts.implementerRunId     — active implementer run id (cross-field)
 * @param {string}   opts.memberId             — implementer member id (cross-field + recipient)
 * @param {string}   opts.runtimeKind          — 'claude-cli' or 'codex-cli' (cross-field)
 * @param {string}   opts.worktreeId           — worktree id (cross-field)
 * @param {number}   [opts.cadenceMs=45000]    — base poll interval in milliseconds
 * @param {number}   [opts.jitterMs=10000]     — max absolute jitter in milliseconds
 * @param {function} [opts.clockNow=Date.now]  — seam for getting current time
 * @param {function} [opts.scheduler=setTimeout]      — seam for scheduling callbacks
 * @param {function} [opts.clearScheduler=clearTimeout] — seam for cancelling scheduled callbacks
 * @param {function} [opts.jitterSource]       — seam: () => number in [-jitterMs, +jitterMs]
 * @param {object}   [opts._deps={}]           — DI: { appendImplementerEventLocked, readUnreadMessages }
 * @returns {{ pollNow: () => Promise<{polled:number, delivered:object[]}>, start: () => void, stop: () => void, on: (event:string, handler:function) => void }}
 */
export function createMailboxPoller({
  specPath,
  repoRoot,
  sliceId,
  implementerRunId,
  memberId,
  runtimeKind,
  worktreeId,
  cadenceMs = 45_000,
  jitterMs = 10_000,
  clockNow = Date.now,
  scheduler = setTimeout,
  clearScheduler = clearTimeout,
  jitterSource,
  _deps = {},
}) {
  // ── Input validation (synchronous, throws before returning the controller) ──

  requireNonEmptyString(specPath, 'specPath');
  requireNonEmptyString(repoRoot, 'repoRoot');
  requireNonEmptyString(sliceId, 'sliceId');
  requireNonEmptyString(implementerRunId, 'implementerRunId');
  requireNonEmptyString(memberId, 'memberId');
  requireNonEmptyString(runtimeKind, 'runtimeKind');
  requireNonEmptyString(worktreeId, 'worktreeId');

  if (!Number.isInteger(cadenceMs) || cadenceMs <= 0) {
    throw new TypeError(
      `createMailboxPoller: cadenceMs must be a positive integer; got ${cadenceMs}`
    );
  }
  if (!Number.isInteger(jitterMs) || jitterMs < 0) {
    throw new TypeError(
      `createMailboxPoller: jitterMs must be a non-negative integer; got ${jitterMs}`
    );
  }
  if (cadenceMs <= jitterMs) {
    throw new TypeError(
      `createMailboxPoller: cadenceMs (${cadenceMs}) must be greater than jitterMs (${jitterMs}) ` +
      `to prevent negative delays`
    );
  }

  // ── Resolved dependencies ──

  const _appendEvent = _deps.appendImplementerEventLocked ?? appendImplementerEventLocked;
  const _readUnread = _deps.readUnreadMessages ?? readUnreadMessages;
  const _jitterSource = jitterSource ?? (() => (Math.random() * 2 - 1) * jitterMs);

  // Pre-compute the recipient once (throws if memberId is unparseable).
  const recipient = recipientForMember(memberId);

  // ── Internal state ──

  /** @type {Set<string>} message IDs already delivered this run */
  const deliveredIds = new Set();

  /**
   * Message IDs currently being delivered by a concurrent pollNow() call.
   * Used to prevent duplicate delivery when two polls run simultaneously.
   * An ID is added when delivery begins; removed on failure (so it can be
   * retried), left in deliveredIds on success.
   * @type {Set<string>}
   */
  const inFlightIds = new Set();

  /** @type {Map<string, Set<function>>} event listeners */
  const listeners = new Map();

  /** @type {ReturnType<typeof setTimeout>|null} current scheduled handle */
  let schedulerHandle = null;

  /** @type {boolean} whether the poller is currently scheduled */
  let running = false;

  /** @type {number} timestamp of last mailbox_poll sidecar event */
  let lastPollEventAt = -Infinity;

  // ── Private helpers ──

  function emit(eventName, ...args) {
    const handlers = listeners.get(eventName);
    if (handlers) {
      for (const h of handlers) {
        h(...args);
      }
    }
  }

  function buildCrossFields() {
    return {
      implementer_run_id: implementerRunId,
      slice_id: sliceId,
      member_id: memberId,
      runtime_kind: runtimeKind,
      worktree_id: worktreeId,
    };
  }

  // ── Public API ──

  /**
   * Register an event handler. Supported events: 'delivered'.
   * @param {string} eventName
   * @param {function} handler
   */
  function on(eventName, handler) {
    if (!listeners.has(eventName)) listeners.set(eventName, new Set());
    listeners.get(eventName).add(handler);
  }

  /**
   * Poll for unread messages now. Returns { polled: number, delivered: message[] }.
   *
   * - Reads unread messages from the mailbox.
   * - Skips already-delivered IDs (in-memory Set).
   * - For each new message: emits 'delivered', appends mailbox_delivered sidecar event,
   *   adds to Set.
   * - Appends ONE mailbox_poll sidecar event (debounced: skip if <= 1000ms since last one).
   * - On sidecar append failure: rejects; does NOT add the failed message ID to Set;
   *   messages for which appends already succeeded remain persisted.
   *
   * @returns {Promise<{polled: number, delivered: object[]}>}
   */
  async function pollNow() {
    const messages = await _readUnread(repoRoot, recipient);
    // Pre-filter only using deliveredIds (stable across concurrent polls).
    // The inFlightIds check is done lazily inside the loop so that concurrent polls
    // racing past the readUnread checkpoint can still coordinate.
    const candidates = messages.filter(m => m && m.id && !deliveredIds.has(m.id));

    const delivered = [];

    for (const msg of candidates) {
      // Check inFlightIds inside the loop — this is the critical section for deduplication.
      // If a concurrent pollNow already claimed this ID, skip it.
      if (inFlightIds.has(msg.id)) continue;

      // Claim this message ID optimistically to block concurrent polls from re-delivering it.
      // If the sidecar append fails below, we remove it from inFlightIds so it can be retried.
      inFlightIds.add(msg.id);

      // Emit delivered event first (in-memory, does not depend on sidecar).
      emit('delivered', msg);

      // Build sidecar event for this message.
      const bodyHash = 'sha256:' + sha256hex(msg.text ?? '');
      const deliveredPayload = {
        from: msg.from,
        to: msg.to,
        body_hash: bodyHash,
      };
      const deliveredPayloadHash = 'sha256:' + sha256hex(JSON.stringify(deliveredPayload));

      // Append sidecar event. On throw: remove from inFlight + re-throw.
      // Do NOT add to deliveredIds on failure; do NOT keep in inFlightIds.
      try {
        await _appendEvent(specPath, {
          event_type: 'mailbox_delivered',
          ...buildCrossFields(),
          payload_hash: deliveredPayloadHash,
          payload: deliveredPayload,
          mailbox_message_id: msg.id,
        });
      } catch (err) {
        inFlightIds.delete(msg.id);
        throw err;
      }

      // Only add to deliveredIds (permanent Set) after successful sidecar write.
      deliveredIds.add(msg.id);
      // inFlightIds entry can stay (it's redundant now but harmless; cleared on stop())
      delivered.push(msg);
    }

    // Append mailbox_poll event (debounced: skip if <= 1000ms since last one).
    const now = clockNow();
    if (now - lastPollEventAt > 1000) {
      const pollPayload = {
        polled_count: messages.length,
        delivered_count: delivered.length,
      };
      const pollPayloadHash = 'sha256:' + sha256hex(JSON.stringify(pollPayload));
      await _appendEvent(specPath, {
        event_type: 'mailbox_poll',
        ...buildCrossFields(),
        payload_hash: pollPayloadHash,
        payload: pollPayload,
      });
      lastPollEventAt = now;
    }

    return { polled: messages.length, delivered };
  }

  /**
   * Start the periodic poller. Idempotent: second call while running is a no-op.
   */
  function start() {
    if (running) return;
    running = true;

    function scheduleNext() {
      const delay = cadenceMs + _jitterSource();
      schedulerHandle = scheduler(() => {
        pollNow().catch(() => {
          // Errors from scheduled polls are swallowed to prevent unhandled rejections;
          // the caller can listen for error events if needed.
        }).finally(() => {
          if (running) scheduleNext();
        });
      }, delay);
    }

    scheduleNext();
  }

  /**
   * Stop the periodic poller. Idempotent: second call is a no-op.
   * Clears the in-memory delivered/in-flight Sets (fresh start next run).
   * The set clearing always happens, even if the scheduler was not started,
   * so that pollNow() + stop() + pollNow() cycles work correctly.
   */
  function stop() {
    if (running) {
      running = false;
      if (schedulerHandle !== null) {
        clearScheduler(schedulerHandle);
        schedulerHandle = null;
      }
    }
    deliveredIds.clear();
    inFlightIds.clear();
  }

  return { pollNow, start, stop, on };
}

/**
 * Inject mailbox messages into an active implementer run for testing / hook delivery.
 * Stub implementation — wired up in slice 10 with adapter-specific delivery.
 *
 * @param {string} _adapter — 'claude-cli' or 'codex-cli'
 * @param {object[]} _messages — array of mailbox message objects
 * @returns {void}
 */
export function injectMailboxDelivery(_adapter, _messages) {
  // No-op stub. Slice 10 will wire this to the adapter-specific delivery mechanism.
}
