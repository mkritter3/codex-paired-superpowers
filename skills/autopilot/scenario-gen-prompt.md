# Phase E Scenario Generation Prompt

**Round:** <round>  
**Slice:** <slice-N>  
**Validation tier:** <validation-tier>

---

## Context

You are generating user-visible test scenarios for a live-verification run of a behavior-changing slice of **<project-app-name>**.

**App description:** <project-app-description>  
**App type:** <project-app-type>

**Phase A task list for this slice:**

<phase-A-task-list>

**Phase A validation coverage:**

<phase-A-validation-coverage>

**UI surface targeted by this slice:**

<plan-frontmatter-ui-surface>

**Slice diff (from slice_start_sha to HEAD):**

```diff
<slice-diff>
```

**Relevant UI files / paths:**

<relevant-ui-files-or-paths>

---

## Your Task

Generate a list of **user-visible test scenarios** for this slice. Each scenario must be executable by driving the real app UI via screenshot and log observation.

Rules:

1. **Every scenario must have a unique `id`** (format: `lv-NNN`).
2. **Every step `action` must be one of:** `click`, `type`, `navigate`, `wait_for`, `assert`.
3. **Every precondition must declare an `enforcement`** from: `navigate`, `reset_command`, `seed_command`, `login_profile`, `setup_steps`, `manual_blocked`.
4. **Every assertion must be checkable from screenshot or log evidence.** Do not assert internal state, private fields, in-process variables, or memory values that are not visible in the UI or logs.
5. **Cover the happy path first.** Then add at least one failure/edge scenario if the slice introduces user-visible error handling.
6. **For behavior-changing slices, at least one scenario is required.** If you genuinely cannot write a testable scenario, explain under `deferred` with justification.
7. Preconditions that cannot be enforced through the declared mechanisms must be placed under `deferred` — do not silently omit them.

---

## Return Format

Return **strict JSON only** — no prose, no markdown fences, no explanation outside the JSON object.

```json
{
  "scenarios": [
    {
      "id": "lv-001",
      "title": "<short human-readable title>",
      "risk": "happy-path | error-path | edge-case | regression",
      "why": "<one sentence: what user-visible regression this catches>",
      "preconditions": [
        {
          "type": "<precondition type, e.g. route | auth | data | env>",
          "value": "<precondition value>",
          "enforcement": "navigate | reset_command | seed_command | login_profile | setup_steps | manual_blocked"
        }
      ],
      "steps": [
        {
          "action": "click | type | navigate | wait_for | assert",
          "target": "<human-readable description of the UI element or route>",
          "value": "<optional: text to type or value to supply>"
        }
      ],
      "assertions": [
        "<observable outcome: what is visible, shown, displayed, logged, or absent after steps execute>"
      ],
      "diagnostic_expectations": [
        "<optional: what should or should not appear in app logs or console>"
      ],
      "timeout_ms": 60000
    }
  ],
  "deferred": [
    "<optional: scenario id or description of scenario that cannot be tested in this run, with justification>"
  ]
}
```

### Schema constraints (validator will reject violations)

| Field | Constraint |
|---|---|
| `id` | Required; unique across all scenarios in this list |
| `title` | Required string |
| `risk` | Required string |
| `why` | Required string |
| `preconditions` | Array; each item must have `enforcement` from the allowed set |
| `steps[].action` | Must be one of: `click`, `type`, `navigate`, `wait_for`, `assert` |
| `assertions` | Array of strings; must be observable from screenshot or logs |
| `diagnostic_expectations` | Array of strings; may be empty |
| `timeout_ms` | Positive integer (milliseconds) |
| `deferred` | Array of strings; may be empty |

### Assertion examples

**Valid (observable):**
- `"Success message is visible without page reload"`
- `"No error toast appears"`
- `"The dashboard is displayed with the updated name"`
- `"No uncaught exception in app logs"`
- `"Server logs contain no 5xx response"`

**Invalid (non-observable — will be rejected):**
- `"internal state is set to true"` — not visible
- `"private field _data is populated"` — not visible
- `"in-process variable pendingCount is zero"` — not visible
- `"component memory holds the correct value"` — not visible

---

Respond with the JSON only. Do not include any commentary outside the JSON.
