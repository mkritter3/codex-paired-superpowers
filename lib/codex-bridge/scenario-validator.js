/**
 * scenario-validator.js — Slice 6 scenario-generation JSON validator
 *
 * Parses and validates the strict JSON that Codex returns for Phase E scenario generation.
 *
 * Export: parseScenarioList(rawJson, opts) → Result
 *
 * Result shapes:
 *   { ok: true,  scenarios: [...], deferred: [...] }
 *   { ok: false, defect: string, detail?: string }
 *
 * Defect codes:
 *   invalid-json                          — JSON.parse failed
 *   scenarios-missing                     — top-level "scenarios" key absent
 *   scenarios-not-array                   — "scenarios" is not an array
 *   scenario-missing-id:<index>           — scenario at index N has no id
 *   duplicate-scenario-id:<id>            — two scenarios share the same id
 *   unsupported-action:<action>           — step.action not in allowed set
 *   precondition-unenforceable:<index>    — precondition has no enforcement or invalid enforcement
 *   zero-scenarios                        — scenarios is empty and opts.requireScenarios is true
 *   assertion-not-visible:<scenario-id>   — assertion references non-observable state
 */

// ─── Allowed value sets ───────────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set(['click', 'type', 'navigate', 'wait_for', 'assert']);

const ALLOWED_ENFORCEMENTS = new Set([
  'navigate',
  'reset_command',
  'seed_command',
  'login_profile',
  'setup_steps',
  'manual_blocked',
]);

// ─── Assertion visibility heuristic ──────────────────────────────────────────
// Permissive — only flag clearly non-observable terms. False positives waste
// review rounds; false negatives only occur for genuinely un-checkable state.

const NON_VISIBLE_PATTERNS = [
  /\binternal\s+state\b/i,
  /\bprivate\s+field\b/i,
  /\bin-process\s+variable\b/i,
  /\bin[-_]process\s+var\b/i,
];

function isAssertionNonVisible(assertion) {
  // Check for non-visible patterns WITHOUT an observable rescue keyword.
  // Observable rescue words: visible, shown, displayed, logged, logs, console, error.
  const observableRescue = /\b(visible|shown|displayed|logged|logs|console|error)\b/i;

  for (const pattern of NON_VISIBLE_PATTERNS) {
    if (pattern.test(assertion)) {
      // If the assertion also mentions an observable channel, it's ambiguous — pass.
      if (observableRescue.test(assertion)) return false;
      return true;
    }
  }

  // "memory" is a common English word; only flag it when paired with non-observable context.
  if (/\bmemory\b/i.test(assertion) && !observableRescue.test(assertion)) {
    return true;
  }

  return false;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Parse and validate a scenario list JSON string.
 *
 * @param {string} rawJson - Raw JSON string (as returned by Codex).
 * @param {{ requireScenarios?: boolean }} [opts]
 *   requireScenarios: true → zero scenarios is a defect (behavior-changing slice).
 *   requireScenarios: false | undefined → zero scenarios is ok (library context).
 * @returns {{ ok: true, scenarios: object[], deferred: unknown[] }
 *          | { ok: false, defect: string, detail?: string }}
 */
export function parseScenarioList(rawJson, opts = {}) {
  // Step 1: Parse JSON.
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    return { ok: false, defect: 'invalid-json', detail: e.message };
  }

  // Step 2: scenarios key must exist.
  if (!Object.prototype.hasOwnProperty.call(parsed, 'scenarios')) {
    return { ok: false, defect: 'scenarios-missing', detail: 'Top-level "scenarios" key is absent' };
  }

  // Step 3: scenarios must be an array.
  if (!Array.isArray(parsed.scenarios)) {
    return {
      ok: false,
      defect: 'scenarios-not-array',
      detail: `"scenarios" must be an array, got ${typeof parsed.scenarios}`,
    };
  }

  const scenarios = parsed.scenarios;
  const deferred = Array.isArray(parsed.deferred) ? parsed.deferred : [];

  // Step 4: Zero-scenarios check (only when requireScenarios is explicitly true).
  if (opts.requireScenarios === true && scenarios.length === 0) {
    return { ok: false, defect: 'zero-scenarios', detail: 'No scenarios provided for a behavior-changing slice' };
  }

  // Step 5: Validate each scenario.
  const seenIds = new Set();

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];

    // 5a: id must be present.
    if (!scenario.id) {
      return {
        ok: false,
        defect: `scenario-missing-id:${i}`,
        detail: `Scenario at index ${i} has no "id" field`,
      };
    }

    // 5b: id must be unique.
    if (seenIds.has(scenario.id)) {
      return {
        ok: false,
        defect: `duplicate-scenario-id:${scenario.id}`,
        detail: `Scenario id "${scenario.id}" appears more than once`,
      };
    }
    seenIds.add(scenario.id);

    // 5c: Validate steps.
    if (Array.isArray(scenario.steps)) {
      for (const step of scenario.steps) {
        if (step.action && !ALLOWED_ACTIONS.has(step.action)) {
          return {
            ok: false,
            defect: `unsupported-action:${step.action}`,
            detail: `Step action "${step.action}" in scenario "${scenario.id}" is not in the allowed set: ${[...ALLOWED_ACTIONS].join(', ')}`,
          };
        }
      }
    }

    // 5d: Validate preconditions.
    if (Array.isArray(scenario.preconditions)) {
      for (let pi = 0; pi < scenario.preconditions.length; pi++) {
        const pre = scenario.preconditions[pi];
        if (!pre.enforcement || !ALLOWED_ENFORCEMENTS.has(pre.enforcement)) {
          return {
            ok: false,
            defect: `precondition-unenforceable:${pi}`,
            detail: `Precondition at index ${pi} in scenario "${scenario.id}" has no valid "enforcement". Got: ${JSON.stringify(pre.enforcement)}. Allowed: ${[...ALLOWED_ENFORCEMENTS].join(', ')}`,
          };
        }
      }
    }

    // 5e: Validate assertions — visibility heuristic.
    if (Array.isArray(scenario.assertions)) {
      for (const assertion of scenario.assertions) {
        if (typeof assertion === 'string' && isAssertionNonVisible(assertion)) {
          return {
            ok: false,
            defect: `assertion-not-visible:${scenario.id}`,
            detail: `Assertion in scenario "${scenario.id}" references non-observable state: ${JSON.stringify(assertion)}`,
          };
        }
      }
    }
  }

  return { ok: true, scenarios, deferred };
}
