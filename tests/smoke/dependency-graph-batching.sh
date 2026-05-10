#!/usr/bin/env bash
# v0.7.3 smoke — dependency graph batching against fixture plans.
# Validates: linear deps run serial; diamond runs middle layer in parallel;
# cycle detected; unknown slice rejected; digest stable.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE=$(mktemp -d -t cps-dag-smoke-XXXXXX)
trap 'rm -rf "$SMOKE"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "  PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Helper: invoke buildDAG + computeReadySet + maximalFirstFitNonOverlap from
# Node and emit the batch as JSON on stdout.
run_dag() {
  local plan_path="$1"
  local states_json="${2-}"
  if [ -z "$states_json" ]; then
    states_json='{}'
  fi
  CPS_DAG_PLAN="$plan_path" CPS_DAG_STATES="$states_json" node -e '
    (async () => {
      const m = await import(process.env.CPS_DAG_PLUGIN_ROOT + "/lib/codex-bridge/dependency-graph.js");
      const built = m.buildDAG(process.env.CPS_DAG_PLAN);
      if (!built.ok) {
        process.stdout.write(JSON.stringify({halt: built.halt}));
        process.exit(0);
      }
      const states = JSON.parse(process.env.CPS_DAG_STATES || "{}");
      const ready = m.computeReadySet(built.dag, states);
      const batch = m.maximalFirstFitNonOverlap(ready, built.filesIndex);
      process.stdout.write(JSON.stringify({batch, ready, digest: built.digest}));
    })();
  '
}

export CPS_DAG_PLUGIN_ROOT="$PLUGIN_ROOT"

# ── Test 1: linear plan (1 → 2 → 3) ────────────────────────────────────────

cat > "$SMOKE/linear.md" <<'EOF'
## Slice 1: a

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 3: c

**DependsOn:**
- slice-2

**Files:**
- c.js
EOF

echo "[1] linear plan"
out=$(run_dag "$SMOKE/linear.md" "{}")
batch=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify(JSON.parse(s).batch))})")
if [ "$batch" = '["slice-1"]' ]; then
  pass "linear initial → only slice-1 in batch"
else
  fail "linear initial expected [slice-1]; got $batch"
fi

# After slice-1 ships, should be slice-2 only
out=$(run_dag "$SMOKE/linear.md" '{"slice-1":"shipped"}')
batch=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify(JSON.parse(s).batch))})")
if [ "$batch" = '["slice-2"]' ]; then
  pass "linear after slice-1 → slice-2 ready"
else
  fail "expected [slice-2]; got $batch"
fi

# ── Test 2: diamond plan ──────────────────────────────────────────────────

cat > "$SMOKE/diamond.md" <<'EOF'
## Slice 1: root

**Files:**
- root.js

## Slice 2: left

**DependsOn:**
- slice-1

**Files:**
- left.js

## Slice 3: right

**DependsOn:**
- slice-1

**Files:**
- right.js

## Slice 4: join

**DependsOn:**
- slice-2
- slice-3

**Files:**
- join.js
EOF

echo "[2] diamond plan"
out=$(run_dag "$SMOKE/diamond.md" '{"slice-1":"shipped"}')
batch=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const b=JSON.parse(s).batch;console.log(JSON.stringify(b.sort()))})")
if [ "$batch" = '["slice-2","slice-3"]' ]; then
  pass "diamond layer 2 → slice-2 + slice-3 in parallel batch"
else
  fail "expected [slice-2,slice-3]; got $batch"
fi

# After both middle layer ships
out=$(run_dag "$SMOKE/diamond.md" '{"slice-1":"shipped","slice-2":"shipped","slice-3":"shipped"}')
batch=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.stringify(JSON.parse(s).batch))})")
if [ "$batch" = '["slice-4"]' ]; then
  pass "diamond layer 3 → slice-4 ready"
else
  fail "expected [slice-4]; got $batch"
fi

# ── Test 3: fan-out (1 → 2,3,4,5,6) ────────────────────────────────────────

cat > "$SMOKE/fanout.md" <<'EOF'
## Slice 1: root

**Files:**
- root.js

## Slice 2: a

**DependsOn:**
- slice-1

**Files:**
- a.js

## Slice 3: b

**DependsOn:**
- slice-1

**Files:**
- b.js

## Slice 4: c

**DependsOn:**
- slice-1

**Files:**
- c.js

## Slice 5: d

**DependsOn:**
- slice-1

**Files:**
- d.js
EOF

echo "[3] fan-out plan"
out=$(run_dag "$SMOKE/fanout.md" '{"slice-1":"shipped"}')
batch=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.parse(s).batch.length)})")
if [ "$batch" = '4' ]; then
  pass "fan-out → 4 slices in parallel batch"
else
  fail "expected 4 slices; got $batch"
fi

# ── Test 4: cycle detection ───────────────────────────────────────────────

cat > "$SMOKE/cycle.md" <<'EOF'
## Slice 1: a

**DependsOn:**
- slice-2

**Files:**
- a.js

## Slice 2: b

**DependsOn:**
- slice-1

**Files:**
- b.js
EOF

echo "[4] cycle detection"
out=$(run_dag "$SMOKE/cycle.md")
reason=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.parse(s).halt.reason)})")
if [ "$reason" = 'dep-cycle' ]; then
  pass "cycle detected → halt dep-cycle"
else
  fail "expected dep-cycle; got $reason"
fi

# ── Test 5: unknown slice ─────────────────────────────────────────────────

cat > "$SMOKE/unknown.md" <<'EOF'
## Slice 1: a

**DependsOn:**
- slice-99

**Files:**
- a.js
EOF

echo "[5] unknown slice"
out=$(run_dag "$SMOKE/unknown.md")
reason=$(echo "$out" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.parse(s).halt.reason)})")
if [ "$reason" = 'dep-unknown-slice' ]; then
  pass "unknown slice → halt dep-unknown-slice"
else
  fail "expected dep-unknown-slice; got $reason"
fi

# ── Test 6: digest stability ──────────────────────────────────────────────

echo "[6] digest stability across reads"
out1=$(run_dag "$SMOKE/diamond.md" '{}')
out2=$(run_dag "$SMOKE/diamond.md" '{}')
digest1=$(echo "$out1" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.parse(s).digest)})")
digest2=$(echo "$out2" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log(JSON.parse(s).digest)})")
if [ "$digest1" = "$digest2" ] && [ -n "$digest1" ]; then
  pass "digest is deterministic across two reads ($digest1)"
else
  fail "digest mismatch: $digest1 vs $digest2"
fi

# ── Summary ──────────────────────────────────────────────────────────────

echo
echo "================================================================="
echo "$PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ]
