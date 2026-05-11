---
name: systematic-debugging
description: Use when a bug is non-trivial. Claude forms hypothesis → Codex critiques → 7-round loop on root cause → fix → slice review on the fix.
---

# Systematic Debugging (Codex-paired)

## What this changes vs. upstream
After Claude forms a root-cause hypothesis, Codex reviews the hypothesis (not just the fix). The hypothesis itself is the artifact under the 7-round loop. Once the hypothesis is double-SHIP'd, the fix follows the standard slice-review flow.

## When to invoke
Trivial bugs (typos, obvious off-by-one) skip this — just fix. Use this for: intermittent failures, multi-system interactions, behavior that contradicts your mental model, "shouldn't be possible" bugs.

## Phase 0 — Reproduce
Standard upstream discipline: minimal reproduction, deterministic, captured as a failing test if possible. Don't move on until you can reproduce on demand.

## Phase 1 — Form hypothesis (Claude)
Write a 1-paragraph hypothesis: WHAT is wrong, WHERE in the code, WHY this manifests as the symptom. Cite specific files/lines. Predict an experiment that would falsify it.

## Phase 2 — Codex hypothesis review (counted, max 7 rounds)
Open or resume a session for this feature/bug. Send:

```
Phase: debug-hypothesis
Round: N

## Symptom
{{SYMPTOM}}

## Reproduction
{{REPRO_STEPS}}

## My hypothesis
{{HYPOTHESIS}}

## Falsification experiment
{{EXPERIMENT}}

## Your job
- Is this the simplest explanation?
- What did I miss? Other plausible root causes I should rule out first?
- Does the falsification experiment actually rule it out?
- End with the required verdict block.
```

Codex's critiques are typically: "you're assuming X but Y could also cause this", "your experiment doesn't actually falsify", "simpler explanation is Z".

Round loop runs as before. Sidecar phase is `debug:<short-bug-id>`.

## Phase 3 — Run the falsification experiment
Only after the hypothesis is double-SHIP'd. The experiment confirms or kills the hypothesis. If killed, restart at Phase 1 with new hypothesis (new round count).

## Phase 4 — Implement the fix
Standard TDD: write the failing regression test that the hypothesis predicts, implement the minimal fix, verify the test passes and the symptom is gone.

## Phase 5 — Slice-review the fix
The fix is a slice (even a one-task slice). Run it through `subagent-driven-development`'s per-slice review.

## Failure modes
- **Multiple hypotheses double-SHIP'd, all falsified:** the bug is in your reproduction, not your hypothesis. Go back to Phase 0.
- **7-round deadlock on hypothesis:** halt; bring to user with both positions and the symptom.

## Sidecar usage
If this debug session belongs to an in-flight feature, reuse that feature's sidecar (its threadId is the same Codex thread that drafted the spec and approved the plan — Codex remembers all prior context). If the bug is standalone, create a new spec stub at `docs/superpowers/specs/YYYY-MM-DD-debug-<bug-id>.md`, open a fresh Codex thread by invoking `mcp__plugin_codex-paired-superpowers_codex__codex` (with the L11 rubric + verdict-format prompts prepended), and persist the threadId via `sidecar-init`. Either way, all hypothesis rounds get logged in the sidecar.

**MODEL INVARIANT.** When opening a fresh codex thread for a standalone bug, you MUST pass `model: "gpt-5.5"` and `config: { model_reasoning_effort: "high" }` explicitly. The codex MCP tool's schema description shows `gpt-5.2`/`gpt-5.2-codex` as examples — those are stale references from the upstream codex CLI and are NOT the model this plugin runs on. See `skills/brainstorming/codex-pairing.md` for the canonical invocation form.

## Troubleshooting setup errors

If you see errors mentioning `Cannot find module`, `proper-lockfile`, `codex: command not found`, `codex not authenticated`, `ENOENT`, or any module-load / binary-not-found pattern, invoke `/codex-paired-superpowers:doctor` first. Resume after green.
