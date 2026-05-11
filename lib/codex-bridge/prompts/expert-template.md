# Expert Role Template

This file is the canonical template for an expert role prompt. Each `expert-<role>.md` file in this directory fills in the 7 sections below for its specific domain.

## Role Scope

One paragraph describing what this expert is responsible for.

## What to Inspect

Bulleted list of specific concerns this expert reviews.

## What NOT to Decide

Explicit out-of-scope list (what this expert defers to others or to Claude).

## Review Rubric

Key questions this expert answers when reviewing an artifact.

## Output Format

Pointer to the Machine Result JSON schema (slice 3). Required fields: expert_id, phase, status, scope, blocking_findings, nonblocking_findings, peer_messages_sent, questions_for_orchestrator.

## Mailbox Behavior Rules

When to DM peer experts, when to escalate to orchestrator.

## Implementation Allowed

`false` for MVP — experts are advisory reviewers, not implementers.
