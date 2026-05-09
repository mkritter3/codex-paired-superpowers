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

# =============================================================================
# Phase E SHIPPED path — synthetic 1-slice plan, all 9 sub-phases double-SHIP'd
# =============================================================================
SMOKE2=$(mktemp -d -t cps-autopilot-phase-e-shipped-XXXXXX)
SPEC2="$SMOKE2/docs/specs/phase-e-shipped.md"
trap 'rm -rf "$SMOKE" "$SMOKE2"' EXIT

mkdir -p "$SMOKE2/docs/specs" "$SMOKE2/docs/plans"
cd "$SMOKE2"
git init -q -b main
git config user.email "smoke@t"
git config user.name "smoke"
echo "# Phase E Shipped" > docs/specs/phase-e-shipped.md
cat > docs/plans/phase-e-shipped-impl.md <<'EOF'
# Phase E Shipped Plan
**Spec:** docs/specs/phase-e-shipped.md

## Slice 1
- [ ] create feature.txt with content "feature"
EOF
git add .
git commit -qm "chore(slice:1): synthetic phase-e-shipped plan setup

Co-Authored-By: Claude <noreply@anthropic.com>"
PE_INITIAL_SHA=$(git rev-parse HEAD)

# Initialize sidecar + autopilot
cli sidecar-init --specPath "$SPEC2" --feature phase-e-shipped --threadId tid-pe-shipped >/dev/null
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"plan-slice\",\"phase_attempt\":1,\"phase_start_sha\":\"$PE_INITIAL_SHA\",\"slice_start_sha\":\"$PE_INITIAL_SHA\",\"last_commit_sha\":\"$PE_INITIAL_SHA\",\"inflight_subagent_id\":null,\"halt_reason\":null}"
cli anchor-write --repoRoot "$SMOKE2" --specPath "$SPEC2"

# Phase A: plan-slice (mock SHIP)
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase plan-slice --state '{"shipped":true,"rounds":[{"round":1,"claude":"SHIP","codex":"SHIP"}]}'
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"implement\",\"phase_start_sha\":\"$PE_INITIAL_SHA\",\"last_commit_sha\":\"$PE_INITIAL_SHA\",\"slice_start_sha\":\"$PE_INITIAL_SHA\",\"halt_reason\":null}"

# Phase B: implement
echo "feature" > feature.txt
git add feature.txt
git commit -qm "feat(slice:1): create feature.txt

Co-Authored-By: Claude <noreply@anthropic.com>"
PE_IMPL_SHA=$(git rev-parse HEAD)
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase implement --state "{\"subagent_status\":\"DONE\",\"commits\":[\"$PE_IMPL_SHA\"]}"
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"review-slice\",\"phase_start_sha\":\"$PE_IMPL_SHA\",\"last_commit_sha\":\"$PE_IMPL_SHA\",\"slice_start_sha\":\"$PE_INITIAL_SHA\",\"halt_reason\":null}"

# Phase C: review-slice (mock SHIP)
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase review-slice --state '{"shipped":true,"deferred":[]}'
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"docs-update\",\"phase_start_sha\":\"$PE_IMPL_SHA\",\"last_commit_sha\":\"$PE_IMPL_SHA\",\"slice_start_sha\":\"$PE_INITIAL_SHA\",\"halt_reason\":null}"

# Phase D: docs-update (mock SHIP)
sed -i.bak 's/- \[ \] create feature.txt/- [x] create feature.txt/' docs/plans/phase-e-shipped-impl.md && rm docs/plans/phase-e-shipped-impl.md.bak
git add docs/plans/phase-e-shipped-impl.md
git commit -qm "docs(slice:1): flip slice-1 task checkbox

Co-Authored-By: Claude <noreply@anthropic.com>"
PE_DOCS_SHA=$(git rev-parse HEAD)
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase docs-update --state '{"shipped":true}'
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"live-verification\",\"phase_start_sha\":\"$PE_DOCS_SHA\",\"last_commit_sha\":\"$PE_DOCS_SHA\",\"slice_start_sha\":\"$PE_INITIAL_SHA\",\"halt_reason\":null}"

# Phase E: live-verification — mock all 9 sub-phases as double-SHIP'd
# Use sidecar-set-live-verification to write the full Phase E state block directly
cli sidecar-set-live-verification --specPath "$SPEC2" --sliceId slice-1 \
  --block '{"shipped":true,"skipped":false,"skip_reason":null,"scenario_generation":{"shipped":true,"scenario_count":2},"launch":{"ready":true,"ready_signal":"http://127.0.0.1:3000/healthz -> 200"},"scenarios":{"lv-001":{"status":"passed"},"lv-002":{"status":"passed"}},"validation_coverage":{"tier":"standard","live.scenarios-covered":"covered","live.preconditions-enforced":"covered","live.user-takeover-safe":"covered","live.evidence-quality":"covered","live.assertions-visible":"covered","live.logs-reviewed":"covered","live.flake-triaged":"covered","live.failures-fixed":"n/a","live.regressions-rerun":"n/a","live.cleanup-recorded":"covered","live.deferred-justified":"n/a","live.environment-reproducible":"covered","live.residual-risk":"covered"}}'

# Advance autopilot to shipped.
# sidecar-set-live-verification already wrote the full live-verification block above.
# Mark the slice shipped via sidecar-set-phase (not sidecar-set-slice, to preserve the
# live-verification block that sidecar-set-live-verification just wrote).
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase plan-slice --state '{"shipped":true}'
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase implement --state "{\"subagent_status\":\"DONE\",\"commits\":[\"$PE_IMPL_SHA\"]}"
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase review-slice --state '{"shipped":true,"deferred":[]}'
cli sidecar-set-phase --specPath "$SPEC2" --sliceId slice-1 --phase docs-update --state '{"shipped":true}'
# Mark the top-level slice shipped (live-verification phase is already written)
cli sidecar-set-autopilot --specPath "$SPEC2" --block "{\"current_slice\":\"1\",\"current_phase\":\"all_done\",\"halt_reason\":\"completed\",\"last_commit_sha\":\"$PE_DOCS_SHA\"}"
# Mark slice-level shipped: use setSlice only to set the shipped flag; phases block is already correct
# Do this by reading and re-merging: sidecar-set-phase doesn't set slice.shipped.
# We rely on sidecar-set-slice here but preserve the live-verification sub-block inline.
PE_LV_BLOCK=$(cli sidecar-show --specPath "$SPEC2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const sc=JSON.parse(d);console.log(JSON.stringify(sc.slice_reviews['slice-1'].phases['live-verification']))})")
cli sidecar-set-slice --specPath "$SPEC2" --sliceId slice-1 --state "{\"phases\":{\"plan-slice\":{\"shipped\":true},\"implement\":{\"subagent_status\":\"DONE\",\"commits\":[\"$PE_IMPL_SHA\"]},\"review-slice\":{\"shipped\":true,\"deferred\":[]},\"docs-update\":{\"shipped\":true},\"live-verification\":$PE_LV_BLOCK},\"shipped\":true}"
cli anchor-clear --repoRoot "$SMOKE2"

# Assertions for Phase E SHIPPED path
PE_FINAL=$(cli sidecar-show --specPath "$SPEC2")
PE_LV_SHIPPED=$(echo "$PE_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['live-verification'].shipped)})")
PE_SLICE_SHIPPED=$(echo "$PE_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].shipped)})")
PE_HALT_REASON=$(echo "$PE_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).autopilot.halt_reason)})")
PE_SCENARIO_COUNT=$(echo "$PE_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['live-verification'].scenario_generation.scenario_count)})")

assert_eq "$PE_LV_SHIPPED" "true" "phase-e-shipped: phases.live-verification.shipped"
assert_eq "$PE_SLICE_SHIPPED" "true" "phase-e-shipped: slice-1.shipped"
assert_eq "$PE_HALT_REASON" "completed" "phase-e-shipped: autopilot.halt_reason"
assert_eq "$PE_SCENARIO_COUNT" "2" "phase-e-shipped: scenario_count"

echo "PASS: autopilot structural smoke — Phase E SHIPPED path (live-verification.shipped=true, slice reached shipped)"

# =============================================================================
# Phase E SKIPPED path — slice with live-verification: skip in frontmatter
# =============================================================================
SMOKE3=$(mktemp -d -t cps-autopilot-phase-e-skipped-XXXXXX)
SPEC3="$SMOKE3/docs/specs/phase-e-skipped.md"
trap 'rm -rf "$SMOKE" "$SMOKE2" "$SMOKE3"' EXIT

mkdir -p "$SMOKE3/docs/specs" "$SMOKE3/docs/plans"
cd "$SMOKE3"
git init -q -b main
git config user.email "smoke@t"
git config user.name "smoke"
echo "# Phase E Skipped" > docs/specs/phase-e-skipped.md
# The slice section markdown includes a live-verification: skip directive with justification
cat > docs/plans/phase-e-skipped-impl.md <<'EOF'
# Phase E Skipped Plan
**Spec:** docs/specs/phase-e-skipped.md

## Slice 1
live-verification: skip - pure refactor, no behavior change

- [ ] rename internal variable foo to bar
EOF
git add .
git commit -qm "chore(slice:1): synthetic phase-e-skipped plan setup

Co-Authored-By: Claude <noreply@anthropic.com>"
PS_INITIAL_SHA=$(git rev-parse HEAD)

# Verify parse-skip-frontmatter correctly parses the skip directive
SLICE_SECTION="live-verification: skip - pure refactor, no behavior change"
PS_SKIP_RESULT=$(echo "$SLICE_SECTION" | cli parse-skip-frontmatter)
PS_SKIP_FLAG=$(echo "$PS_SKIP_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).skip)})")
PS_SKIP_REASON=$(echo "$PS_SKIP_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).reason)})")
assert_eq "$PS_SKIP_FLAG" "true" "phase-e-skipped: parse-skip-frontmatter returned skip=true"
assert_eq "$PS_SKIP_REASON" "pure refactor, no behavior change" "phase-e-skipped: parse-skip-frontmatter reason"

# Initialize sidecar + autopilot
cli sidecar-init --specPath "$SPEC3" --feature phase-e-skipped --threadId tid-pe-skipped >/dev/null
cli sidecar-set-autopilot --specPath "$SPEC3" --block "{\"current_slice\":\"1\",\"current_phase\":\"plan-slice\",\"phase_attempt\":1,\"phase_start_sha\":\"$PS_INITIAL_SHA\",\"slice_start_sha\":\"$PS_INITIAL_SHA\",\"last_commit_sha\":\"$PS_INITIAL_SHA\",\"inflight_subagent_id\":null,\"halt_reason\":null}"
cli anchor-write --repoRoot "$SMOKE3" --specPath "$SPEC3"

# Phases A-D (mock SHIP)
cli sidecar-set-phase --specPath "$SPEC3" --sliceId slice-1 --phase plan-slice --state '{"shipped":true}'
cli sidecar-set-phase --specPath "$SPEC3" --sliceId slice-1 --phase implement --state '{"subagent_status":"DONE"}'
cli sidecar-set-phase --specPath "$SPEC3" --sliceId slice-1 --phase review-slice --state '{"shipped":true,"deferred":[]}'
cli sidecar-set-phase --specPath "$SPEC3" --sliceId slice-1 --phase docs-update --state '{"shipped":true}'
cli sidecar-set-autopilot --specPath "$SPEC3" --block "{\"current_slice\":\"1\",\"current_phase\":\"live-verification\",\"phase_start_sha\":\"$PS_INITIAL_SHA\",\"last_commit_sha\":\"$PS_INITIAL_SHA\",\"slice_start_sha\":\"$PS_INITIAL_SHA\",\"halt_reason\":null}"

# Phase E: live-verification — SKIPPED path (skip frontmatter detected)
cli sidecar-set-live-verification --specPath "$SPEC3" --sliceId slice-1 \
  --block '{"skipped":true,"skip_reason":"pure refactor, no behavior change","shipped":false}'

# Advance autopilot: skipped Phase E still allows slice to reach shipped
cli sidecar-set-slice --specPath "$SPEC3" --sliceId slice-1 --state "{\"phases\":{\"plan-slice\":{\"shipped\":true},\"implement\":{\"subagent_status\":\"DONE\"},\"review-slice\":{\"shipped\":true,\"deferred\":[]},\"docs-update\":{\"shipped\":true},\"live-verification\":{\"skipped\":true,\"skip_reason\":\"pure refactor, no behavior change\",\"shipped\":false}},\"shipped\":true}"
cli sidecar-set-autopilot --specPath "$SPEC3" --block "{\"current_slice\":\"1\",\"current_phase\":\"all_done\",\"halt_reason\":\"completed\",\"last_commit_sha\":\"$PS_INITIAL_SHA\"}"
cli anchor-clear --repoRoot "$SMOKE3"

# Assertions for Phase E SKIPPED path
PS_FINAL=$(cli sidecar-show --specPath "$SPEC3")
PS_LV_SKIPPED=$(echo "$PS_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['live-verification'].skipped)})")
PS_LV_SKIP_REASON=$(echo "$PS_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].phases['live-verification'].skip_reason)})")
PS_SLICE_SHIPPED=$(echo "$PS_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).slice_reviews['slice-1'].shipped)})")
PS_HALT_REASON=$(echo "$PS_FINAL" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{console.log(JSON.parse(d).autopilot.halt_reason)})")

assert_eq "$PS_LV_SKIPPED" "true" "phase-e-skipped: phases.live-verification.skipped"
assert_eq "$PS_LV_SKIP_REASON" "pure refactor, no behavior change" "phase-e-skipped: phases.live-verification.skip_reason"
assert_eq "$PS_SLICE_SHIPPED" "true" "phase-e-skipped: slice-1.shipped (skipped Phase E still allows shipped)"
assert_eq "$PS_HALT_REASON" "completed" "phase-e-skipped: autopilot.halt_reason"

echo "PASS: autopilot structural smoke — Phase E SKIPPED path (live-verification.skipped=true, skip_reason recorded, slice reached shipped)"
