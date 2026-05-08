---
name: receiving-code-review
description: Use whenever Codex (or a human) returns a review verdict. Required to prevent Claude from rubber-stamping or performative-disagreeing. Verify before accepting; articulate disagreement with file/line specifics.
---

# Receiving Code Review (Codex-paired)

## What this changes vs. upstream
Adds explicit anti-rubber-stamp rules for handling Codex's `<<<VERDICT>>>` blocks. The discipline applies to all reviewers, but the bar is highest for Codex because Codex is paired with you — agreement matters structurally.

## The four rules

### 1. Read slowly
Read every critique item once for what it says, then once more for what it implies about the code. If you don't fully understand a critique, ask Codex to clarify before responding.

### 2. Verify against actual code
Before accepting any critique, open the cited file/line and confirm the claim. Critiques can be wrong:
- Wrong file or line.
- Misreading control flow.
- Out-of-date assumption about the codebase.

If the critique is factually wrong, say so with the actual code excerpt. Do not silently accept.

### 3. Articulate disagreement, don't paper over it
If you disagree:
- Quote the specific critique item.
- Cite the file/line and the actual behavior.
- Explain why the critique is wrong OR why the trade-off Codex objects to is correct in context.
- Say what would change your mind.

If Codex's reply doesn't engage with your reasoning and just restates the original critique, push back again. Two such back-and-forths and the disagreement is "open contention" — record it.

### 4. No performative anything
- "Good catch, fixing now" without reading the critique = rubber stamp = failure.
- "I disagree" with no specifics = posturing = failure.
- "Let me think about it" with no follow-up = avoidance = failure.

The only acceptable shapes: agree-with-evidence, disagree-with-evidence, request-clarification.

## When to escalate
- Same critique survives 3 rounds with neither side conceding → record as open contention, surface to user.
- Codex's verdict block is malformed twice in a row → surface to user with raw output (might be a model regression).
- A critique would change spec scope → push back: "this is a spec change; let's record as open contention and bring to user."

## Sidecar logging
Both your verdict and Codex's must be recorded each round (the bridge does this automatically via `appendRound`). Don't skip rounds. Don't summarize multiple rounds into one.
