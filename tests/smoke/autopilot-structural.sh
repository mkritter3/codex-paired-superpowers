#!/usr/bin/env bash
# Structural smoke for the autopilot orchestration flow.
#
# Mocks Codex SHIP responses and walks all 4 phases mechanically
# (plan-slice -> implement -> review-slice -> docs-update -> completed).
# Validates that the bridge CLI + state machine described in SKILL.md
# are self-consistent and the sidecar transitions reach the expected
# final shape.
#
# This is NOT an end-to-end smoke against real Codex. The real Codex
# integration is validated by the spec/plan review thread (which has
# 12 rounds of real codex-reply traffic on file). The full e2e smoke
# is dogfooded when autopilot runs a real plan.
#
# Usage: bash tests/smoke/autopilot-structural.sh
# Exits 0 on success, nonzero on any failure.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE=$(mktemp -d -t cps-autopilot-structural-XXXXXX)
SPEC="$SMOKE/docs/specs/hello-design.md"
trap 'rm -rf "$SMOKE"' EXIT

cli() {
  node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" "$@"
}

assert_eq() {
  if [ "$1" = "$2" ]; then return 0; fi
  echo "FAIL: expected '$2', got '$1' ($3)" >&2
  exit 1
}

# --- Setup ---
mkdir -p "$SMOKE/docs/specs" "$SMOKE/docs/plans"
cd "$SMOKE"
git init -q -b main
git config user.email "smoke@t"
git config user.name "smoke"
echo "# Hello CLI" > docs/specs/hello-design.md
cat > docs/plans/hello-impl.md <<'EOF'
# Hello Plan
**Spec:** docs/specs/hello-design.md

## Slice 1
- [ ] create hello.txt with content "hello"
EOF
git add .
git commit -qm "chore(slice:1): synthetic plan setup

Co-Authored-By: Claude <noreply@anthropic.com>"
INITIAL_SHA=$(git rev-parse HEAD)

# --- Phase: on run start ---
cli sidecar-init --specPath "$SPEC" --feature hello --threadId tid-structural >/dev/null
cli sidecar-set-autopilot --specPath "$SPEC" --block "{\"current_slice\":\"1\",\"current_phase\":\"plan-slice\",\"phase_attempt\":1,\"phase_start_sha\":\"$INITIAL_SHA\",\"slice_start_sha\":\"$INITIAL_SHA\",\"last_commit_sha\":\"$INITIAL_SHA\",\"inflight_subagent_id\":null,\"halt_reason\":null}"
cli anchor-write --repoRoot "$SMOKE" --specPath "$SPEC"

# --- Phase A: plan-slice + test-list review (mock SHIP) ---
cli sidecar-append-round --specPath "$SPEC" --round '{"phase":"plan-slice:1","round":1,"claude":"SHIP","codex":"SHIP"}'
cli sidecar-set-phase --specPath "$SPEC" --sliceId slice-1 --phase plan-slice --state '{"shipped":true,"rounds":[{"round":1,"claude":"SHIP","codex":"SHIP"}]}'
cli sidecar-set-autopilot --specPath "$SPEC" --block "{\"current_slice\":\"1\",\"current_phase\":\"implement\",\"phase_start_sha\":\"$INITIAL_SHA\",\"last_commit_sha\":\"$INITIAL_SHA\",\"slice_start_sha\":\"$INITIAL_SHA\",\"halt_reason\":null}"

# --- Phase B: implement (subagent simulated by direct commit) ---
echo "hello" > hello.txt
git add hello.txt
git commit -qm "feat(slice:1): create hello.txt

Co-Authored-By: Claude <noreply@anthropic.com>"
NEW_SHA=$(git rev-parse HEAD)

# Phase B reconciliation: walk last_commit_sha..HEAD, verify, update
RANGE_OK=1
while read -r line; do
  if ! echo "$line" | grep -Eq '^(feat|test|fix|docs|refactor|chore)\(slice:1\):'; then
    RANGE_OK=0; break
  fi
done < <(git log --format=%s "$INITIAL_SHA..HEAD")
assert_eq "$RANGE_OK" "1" "Phase B reconciliation: all commits should conform"
cli sidecar-set-autopilot --specPath "$SPEC" --block "{\"current_slice\":\"1\",\"current_phase\":\"review-slice\",\"phase_start_sha\":\"$NEW_SHA\",\"last_commit_sha\":\"$NEW_SHA\",\"slice_start_sha\":\"$INITIAL_SHA\",\"halt_reason\":null}"
cli sidecar-set-phase --specPath "$SPEC" --sliceId slice-1 --phase implement --state "{\"subagent_status\":\"DONE\",\"commits\":[\"$NEW_SHA\"]}"

# --- Phase C: review-slice (mock SHIP) ---
cli sidecar-append-round --specPath "$SPEC" --round '{"phase":"review-slice:1","round":1,"claude":"SHIP","codex":"SHIP"}'
cli sidecar-set-phase --specPath "$SPEC" --sliceId slice-1 --phase review-slice --state '{"shipped":true,"deferred":[]}'
cli sidecar-set-autopilot --specPath "$SPEC" --block "{\"current_slice\":\"1\",\"current_phase\":\"docs-update\",\"phase_start_sha\":\"$NEW_SHA\",\"last_commit_sha\":\"$NEW_SHA\",\"slice_start_sha\":\"$INITIAL_SHA\",\"halt_reason\":null}"

# --- Phase D: docs-update (flip checkbox, mock SHIP, single commit) ---
sed -i.bak 's/- \[ \] create hello.txt/- [x] create hello.txt/' docs/plans/hello-impl.md && rm docs/plans/hello-impl.md.bak
git add docs/plans/hello-impl.md
git commit -qm "docs(slice:1): flip slice-1 task checkbox

Co-Authored-By: Claude <noreply@anthropic.com>"
DOCS_SHA=$(git rev-parse HEAD)
cli sidecar-append-round --specPath "$SPEC" --round '{"phase":"docs-update:1","round":1,"claude":"SHIP","codex":"SHIP"}'
cli sidecar-set-phase --specPath "$SPEC" --sliceId slice-1 --phase docs-update --state '{"shipped":true}'
cli sidecar-set-slice --specPath "$SPEC" --sliceId slice-1 --state "{\"phases\":{\"plan-slice\":{\"shipped\":true},\"implement\":{\"subagent_status\":\"DONE\",\"commits\":[\"$NEW_SHA\"]},\"review-slice\":{\"shipped\":true,\"deferred\":[]},\"docs-update\":{\"shipped\":true,\"files_touched\":[\"docs/plans/hello-impl.md\"]}},\"shipped\":true}"

# --- Completion: clear anchor, set halt_reason=completed ---
cli sidecar-set-autopilot --specPath "$SPEC" --block "{\"current_slice\":\"1\",\"current_phase\":\"all_done\",\"halt_reason\":\"completed\",\"last_commit_sha\":\"$DOCS_SHA\"}"
cli anchor-clear --repoRoot "$SMOKE"

# --- Assertions on final state ---
[ ! -f "$SMOKE/.codex-paired/active.json" ] || { echo "FAIL: anchor not cleared"; exit 1; }

FINAL=$(cli sidecar-show --specPath "$SPEC")
SLICE_SHIPPED=$(echo "$FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].shipped)})")
HALT_REASON=$(echo "$FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).autopilot.halt_reason)})")
PLAN_A_SHIPPED=$(echo "$FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['plan-slice'].shipped)})")
DOCS_SHIPPED=$(echo "$FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['docs-update'].shipped)})")

assert_eq "$SLICE_SHIPPED" "true" "slice-1.shipped"
assert_eq "$HALT_REASON" "completed" "autopilot.halt_reason"
assert_eq "$PLAN_A_SHIPPED" "true" "phases.plan-slice.shipped"
assert_eq "$DOCS_SHIPPED" "true" "phases.docs-update.shipped"

# Verify rounds log captured all 3 review phases
ROUND_COUNT=$(echo "$FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).rounds.length)})")
assert_eq "$ROUND_COUNT" "3" "rounds count (plan-slice + review-slice + docs-update = 3)"

# Verify git log has the 3 expected conforming commits
COMMIT_COUNT=$(git log --oneline | wc -l | tr -d ' ')
assert_eq "$COMMIT_COUNT" "3" "git commit count"

echo "PASS: autopilot structural smoke (4 phases, 3 commits, slice shipped, anchor cleared)"
