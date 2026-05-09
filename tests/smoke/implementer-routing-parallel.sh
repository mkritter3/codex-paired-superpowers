#!/usr/bin/env bash
# Empirical wall-clock smoke for v0.7.0 parallel slice dispatch.
#
# Spec §20 success criterion:
#   "Empirical parallelism smoke lives at
#    tests/smoke/implementer-routing-parallel.sh.
#    That smoke uses a 2-slice parallel batch where each slice performs a
#    deterministic approximately 30-second implementation task, for example
#    `sleep 25 && touch marker-N && git add marker-N && git commit -m
#    'feat(slice:N): add marker N'`.
#    The smoke measures wall-clock time from first dispatch to last
#    reconciliation.
#    Assertion: total wall-clock must be less than 1.5x the measured
#    single-slice baseline for the same deterministic task.
#    The smoke fails if dispatches are serialized across separate turns."
#
# This smoke is REAL-Codex. It invokes the bundled
# `mcp__plugin_codex-paired-superpowers_codex__codex` MCP tool from the
# user's Claude Code session. CI does not have Codex configured, so this
# smoke is gated behind SMOKE_REQUIRES_CODEX=1.
#
# Skip behavior:
#   - SMOKE_REQUIRES_CODEX unset or empty → exit 0 with skip message.
#   - SMOKE_REQUIRES_CODEX=1 → run the real-Codex empirical workflow.
#
# Acceptance run is user-driven. Slice 9 (release) only requires that:
#   1. This script exists.
#   2. It bash-syntax-validates (`bash -n`).
#   3. It skips cleanly when Codex isn't configured.
#
# Why a shell smoke can't internally invoke MCP:
#   The MCP tools are Claude Code subagent/tool calls; they aren't
#   reachable from a plain shell. To run end-to-end, the user issues a
#   single autopilot turn against the fixture plan this smoke prepares,
#   and the orchestrator dispatches both slices in one parallel batch.
#   This script therefore prepares the fixture, prints the exact prompt
#   to issue, and (when SMOKE_REQUIRES_CODEX=1) waits for the user to
#   confirm completion before reading wall-clock timestamps from the
#   resulting commits' `committer` timestamps.
#
# The expected workflow when SMOKE_REQUIRES_CODEX=1:
#   1. This script sets up a temp repo + 2-slice plan, prints the
#      autopilot command to run, and waits.
#   2. User runs `/autopilot <plan>` once for the baseline (1 slice).
#   3. User signals BASELINE_DONE; script measures elapsed via commit
#      timestamps + `slice_start_sha`.
#   4. Script resets fixture; user runs `/autopilot <plan-parallel>`
#      with both slices flagged for parallel.
#   5. User signals PARALLEL_DONE; script measures elapsed; asserts ratio.
#
# Usage:
#   bash tests/smoke/implementer-routing-parallel.sh                 # skip
#   SMOKE_REQUIRES_CODEX=1 bash tests/smoke/implementer-routing-parallel.sh
#
# Exit codes:
#   0 — skipped (no Codex) OR ratio assertion passed.
#   1 — fixture setup or measurement failure.
#   2 — assertion failed (PARALLEL_SECS >= 1.5 * BASELINE_SECS) — i.e.
#       parallel dispatch is suspect (likely serialized across turns).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- Skip gate ---------------------------------------------------------------
if [ -z "${SMOKE_REQUIRES_CODEX:-}" ]; then
  echo "SKIP: implementer-routing-parallel.sh requires SMOKE_REQUIRES_CODEX=1"
  echo "      (real-Codex MCP smoke; not run in CI)"
  echo "      To run: SMOKE_REQUIRES_CODEX=1 bash $0"
  exit 0
fi

# --- Setup -------------------------------------------------------------------
SMOKE=$(mktemp -d -t cps-impl-routing-parallel-XXXXXX)
trap 'echo "fixture left at $SMOKE for inspection"' EXIT

REPO="$SMOKE/repo"
mkdir -p "$REPO"
cd "$REPO"
git init -q -b main
git config user.email "smoke@t"
git config user.name "smoke"

# Gitignore worktree dir (spec §11 worktree-gitignore-missing prevention).
echo ".git-worktrees/" > .gitignore
mkdir -p docs/specs docs/plans

cat > docs/specs/parallel-smoke.md <<'EOF'
# Parallel Smoke Spec

Two trivial slices each create a marker file via a deterministic ~25-second
task. Used to measure wall-clock parallelism vs serial baseline.
EOF

# Baseline plan: one slice only.
cat > docs/plans/parallel-smoke-baseline.md <<'EOF'
# Parallel Smoke Plan — Baseline

**Spec:** docs/specs/parallel-smoke.md

## Slice 1: marker-1
**Validation:** standard
**Implementer:** codex
**Files:**
- marker-1.txt

### Tasks

- [ ] **1a.** Run exactly: `sleep 25 && touch marker-1.txt && git add marker-1.txt && git commit -m "feat(slice:1): add marker 1"`
- [ ] **1b.** Confirm commit exists.
EOF

# Parallel plan: two slices, non-overlapping Files.
cat > docs/plans/parallel-smoke-parallel.md <<'EOF'
# Parallel Smoke Plan — Parallel

**Spec:** docs/specs/parallel-smoke.md

## Slice 1: marker-1
**Validation:** standard
**Implementer:** codex
**Files:**
- marker-1.txt

### Tasks

- [ ] **1a.** Run exactly: `sleep 25 && touch marker-1.txt && git add marker-1.txt && git commit -m "feat(slice:1): add marker 1"`
- [ ] **1b.** Confirm commit exists.

## Slice 2: marker-2
**Validation:** standard
**Implementer:** codex
**Files:**
- marker-2.txt

### Tasks

- [ ] **2a.** Run exactly: `sleep 25 && touch marker-2.txt && git add marker-2.txt && git commit -m "feat(slice:2): add marker 2"`
- [ ] **2b.** Confirm commit exists.
EOF

git add .
git commit -qm "chore(slice:0): smoke fixture setup" >/dev/null

SLICE_START_SHA=$(git rev-parse HEAD)

cat <<EOF

================================================================================
PARALLEL DISPATCH SMOKE — REAL CODEX MCP
================================================================================

Fixture repo:    $REPO
Slice-start sha: $SLICE_START_SHA

This smoke is interactive. It requires you to run the autopilot from a
Claude Code session that has the codex-paired-superpowers plugin loaded.
Each slice runs a deterministic ~25-second task; we measure wall-clock
from first MCP dispatch to last reconciler completion.

------------------------------------------------------------------------
STEP 1 — Baseline (1 slice)
------------------------------------------------------------------------
In a Claude Code session with cwd=$REPO, run:

    /autopilot docs/plans/parallel-smoke-baseline.md

Wait for autopilot to complete slice 1. Then press ENTER here.

EOF
read -r _

# Measure baseline: time from slice_start_sha to slice-1 commit committer date.
BASELINE_HEAD=$(git -C "$REPO" rev-parse HEAD)
if [ "$BASELINE_HEAD" = "$SLICE_START_SHA" ]; then
  echo "FAIL: baseline run produced no commits on integration branch" >&2
  exit 1
fi

BASELINE_START_TS=$(git -C "$REPO" show -s --format=%ct "$SLICE_START_SHA")
BASELINE_END_TS=$(git -C "$REPO" log --format=%ct -1 "$BASELINE_HEAD")
BASELINE_SECS=$(( BASELINE_END_TS - BASELINE_START_TS ))

echo "BASELINE_SECS=$BASELINE_SECS"

if [ "$BASELINE_SECS" -lt 20 ]; then
  echo "FAIL: baseline elapsed ($BASELINE_SECS s) implausibly short for a 25s sleep task" >&2
  echo "      this likely means the prompt did not actually run the sleep" >&2
  exit 1
fi

# --- Reset fixture for the parallel run --------------------------------------
git -C "$REPO" reset --hard "$SLICE_START_SHA" >/dev/null

# Best-effort cleanup of any worktrees created by the baseline run.
if [ -d "$REPO/.git-worktrees" ]; then
  for wt in "$REPO/.git-worktrees"/*; do
    [ -d "$wt" ] || continue
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
  done
fi
git -C "$REPO" branch | awk '{print $NF}' | grep -E '^slice-[0-9]+-impl$' | while read -r b; do
  git -C "$REPO" branch -D "$b" 2>/dev/null || true
done

PARALLEL_START_SHA=$(git -C "$REPO" rev-parse HEAD)

cat <<EOF

------------------------------------------------------------------------
STEP 2 — Parallel (2 slices, non-overlapping Files)
------------------------------------------------------------------------
In the SAME Claude Code session (cwd=$REPO), run:

    /autopilot docs/plans/parallel-smoke-parallel.md

Both slices have **Implementer:** codex and non-overlapping **Files:** —
the orchestrator MUST dispatch both slice-implementer-codex subagents in
a single assistant turn (parallel-tool-call). If they are serialized
across separate turns, the wall-clock will be ~2x the baseline and this
smoke will fail.

Wait for autopilot to complete BOTH slices. Then press ENTER here.

EOF
read -r _

# Measure parallel: from PARALLEL_START_SHA to last commit on integration.
PARALLEL_HEAD=$(git -C "$REPO" rev-parse HEAD)
if [ "$PARALLEL_HEAD" = "$PARALLEL_START_SHA" ]; then
  echo "FAIL: parallel run produced no commits on integration branch" >&2
  exit 1
fi

# Wall-clock from start sha's committer date to last commit's committer date.
PARALLEL_START_TS=$(git -C "$REPO" show -s --format=%ct "$PARALLEL_START_SHA")
PARALLEL_END_TS=$(git -C "$REPO" log --format=%ct -1 "$PARALLEL_HEAD")
PARALLEL_SECS=$(( PARALLEL_END_TS - PARALLEL_START_TS ))

echo "PARALLEL_SECS=$PARALLEL_SECS"

# Verify both markers landed.
if ! git -C "$REPO" log --format=%s "$PARALLEL_START_SHA..$PARALLEL_HEAD" | grep -qE '^feat\(slice:1\): add marker 1$'; then
  echo "FAIL: slice-1 commit not found on integration branch" >&2
  exit 1
fi
if ! git -C "$REPO" log --format=%s "$PARALLEL_START_SHA..$PARALLEL_HEAD" | grep -qE '^feat\(slice:2\): add marker 2$'; then
  echo "FAIL: slice-2 commit not found on integration branch" >&2
  exit 1
fi

# --- Assertion ---------------------------------------------------------------
# PARALLEL_SECS < 1.5 * BASELINE_SECS
# Use integer math: assert (PARALLEL_SECS * 2) < (BASELINE_SECS * 3) so we don't
# need bc/awk for the 1.5x multiplier.
LHS=$(( PARALLEL_SECS * 2 ))
RHS=$(( BASELINE_SECS * 3 ))

echo
echo "================================================================================"
echo "RESULT"
echo "================================================================================"
echo "BASELINE_SECS = $BASELINE_SECS"
echo "PARALLEL_SECS = $PARALLEL_SECS"
echo "Threshold     = 1.5 * BASELINE_SECS = $(( BASELINE_SECS * 3 / 2 )) s"
echo

if [ "$LHS" -lt "$RHS" ]; then
  echo "PASS: parallel dispatch achieved wall-clock < 1.5x baseline"
  echo "      (parallel=${PARALLEL_SECS}s vs 1.5x-baseline=$(( BASELINE_SECS * 3 / 2 ))s)"
  # Cleanup on success: remove fixture.
  trap - EXIT
  rm -rf "$SMOKE"
  exit 0
else
  echo "FAIL: PARALLEL_SECS ($PARALLEL_SECS) >= 1.5 * BASELINE_SECS ($BASELINE_SECS)" >&2
  echo "      Likely cause: dispatches were serialized across separate assistant turns" >&2
  echo "      instead of issued in a single parallel-tool-call batch." >&2
  echo "      Fixture preserved at: $SMOKE" >&2
  exit 2
fi
