/**
 * safety-gate.js
 *
 * Pure function — no I/O, no side effects, no console.log.
 *
 * Evaluates the project's live-verification takeover policy and returns a
 * structured result that the autopilot orchestrator (SKILL.md slice 11) acts
 * on. This module NEVER displays the prompt itself — it returns promptText
 * and the caller renders it.
 *
 * Spec: docs/specs/2026-05-08-v0.6.0-live-verification.md § "Safety Gate"
 * Plan: docs/plans/2026-05-08-v0.6.0-implementation.md Slice 5
 *
 * Return shapes:
 *
 *   confirm_each_phase_e (default):
 *     { status: 'requires-confirmation', promptText: '<spec prompt text>' }
 *
 *   scheduled_window, IN window:
 *     { status: 'ok' }
 *
 *   scheduled_window, OUT of window:
 *     { status: 'halt', haltReason: 'live-verification-outside-scheduled-window', detail: '...' }
 */

/**
 * Day abbreviation → getDay() index (0 = Sunday).
 */
const DAY_MAP = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

/**
 * Parse "HH:MM" into minutes since midnight.
 * @param {string} hhmm
 * @returns {number}
 */
function parseMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Get the local hour and minute for `now` in the given IANA timezone,
 * and the local day-of-week index (0=Sun … 6=Sat).
 *
 * Uses Intl.DateTimeFormat — no external dependencies.
 *
 * @param {Date} now
 * @param {string} timezone  e.g. "America/Los_Angeles" or "UTC"
 * @returns {{ dayIndex: number, minutesSinceMidnight: number }}
 */
function getLocalTime(now, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',   // "Mon", "Tue", etc.
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const parts = fmt.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  // Intl weekday short in en-US: "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
  const weekdayShort = get('weekday').toLowerCase().slice(0, 3); // e.g. "mon"
  const dayIndex = DAY_MAP[weekdayShort];

  // hour12: false gives "00"–"23"; "24" can appear at midnight on some impls
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  const minutesSinceMidnight = hour * 60 + minute;

  return { dayIndex, minutesSinceMidnight };
}

/**
 * Check whether `now` falls within a single scheduled window.
 *
 * @param {{ days: string[], start: string, end: string, timezone: string }} window
 * @param {Date} now
 * @returns {boolean}
 */
function isInsideWindow(window, now) {
  const tz = window.timezone || 'UTC';
  const { dayIndex, minutesSinceMidnight } = getLocalTime(now, tz);

  // Check day
  const allowedDays = (window.days || []).map((d) => DAY_MAP[d.toLowerCase()]);
  if (!allowedDays.includes(dayIndex)) return false;

  // Check time range
  const startMin = parseMinutes(window.start);
  const endMin = parseMinutes(window.end);
  return minutesSinceMidnight >= startMin && minutesSinceMidnight < endMin;
}

/**
 * The exact prompt text from spec § "Safety Gate".
 * The `~<estimate>` token is left as a template literal; autopilot SKILL.md
 * substitutes the estimate or passes opts.estimateText at call time.
 *
 * @param {string} [estimateText]
 * @returns {string}
 */
function buildPromptText(estimateText) {
  const estimate = estimateText || '<estimate>';
  return (
    `Phase E live verification is about to take screen control via /computer-use for ~${estimate}.\n` +
    `It may move the mouse, click, type, and switch focus.\n` +
    `Continue now?`
  );
}

/**
 * Evaluate the project's live-verification takeover policy.
 *
 * @param {object} config - the parsed project config (from loadProjectConfig)
 * @param {Date}   [now]  - injectable for deterministic tests; defaults to new Date()
 * @param {object} [opts]
 * @param {string} [opts.estimateText] - substituted into promptText; e.g. "3 min"
 * @returns {{ status: 'ok' | 'requires-confirmation' | 'halt', haltReason?: string, detail?: string, promptText?: string }}
 */
export function evaluateSafetyGate(config, now = new Date(), opts = {}) {
  const takeover = config?.live_verification?.takeover;
  const mode = takeover?.mode ?? 'confirm_each_phase_e';

  if (mode === 'confirm_each_phase_e') {
    return {
      status: 'requires-confirmation',
      promptText: buildPromptText(opts.estimateText)
    };
  }

  if (mode === 'scheduled_window') {
    const windows = takeover?.scheduled_windows ?? [];

    for (const win of windows) {
      if (isInsideWindow(win, now)) {
        return { status: 'ok' };
      }
    }

    // No window matched
    const localInfo = windows.length > 0
      ? (() => {
          const tz = windows[0].timezone || 'UTC';
          const { dayIndex, minutesSinceMidnight } = getLocalTime(now, tz);
          const dayName = Object.keys(DAY_MAP).find((k) => DAY_MAP[k] === dayIndex) ?? '?';
          const h = String(Math.floor(minutesSinceMidnight / 60)).padStart(2, '0');
          const m = String(minutesSinceMidnight % 60).padStart(2, '0');
          return `current local time is ${dayName} ${h}:${m} (${tz})`;
        })()
      : 'no scheduled windows configured';

    return {
      status: 'halt',
      haltReason: 'live-verification-outside-scheduled-window',
      detail: `Outside all scheduled windows: ${localInfo}`
    };
  }

  // Unknown mode — treat as halt to be safe
  return {
    status: 'halt',
    haltReason: 'live-verification-outside-scheduled-window',
    detail: `Unknown takeover mode: ${mode}`
  };
}
