#!/usr/bin/env bash
# v0.9.0 release gate runner.
#
# Usage:
#   ./scripts/v0.9.0-release-gate.sh [SPEC_PATH]
#
# When SPEC_PATH is omitted, the script uses a small built-in test spec.
# When CPS_INSTALLED_SMOKE=1 and real CLIs are available, the script runs
# the full live sequence (Criteria 1-6). Without live CLIs, it runs the
# unit/integration checks only and marks live criteria as PENDING.
#
# Exit codes:
#   0 — all criteria that were verified PASS
#   1 — at least one criterion FAIL or live criteria skipped as PENDING
#
# The script writes PASS/PENDING/FAIL into docs/verification/v0.9.0-release-gate.md.
# DO NOT git-tag v0.9.0 until this script exits 0.
#
# Dependencies: node (>=20), git; optionally codex, ollama (for Criteria 1-5).
#
# Design: this script intentionally does not auto-tag. Tagging is a
# separate operator step after reviewing the gate document.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE_DOC="${REPO_ROOT}/docs/verification/v0.9.0-release-gate.md"
REPLAY_TEST="${REPO_ROOT}/tests/replay/replay-from-sidecar.test.js"
SMOKE_DIR="${REPO_ROOT}/tests/installed-smoke"
SPEC_ARG="${1:-}"

# ── Colors / output helpers ───────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

pass() { printf "${GREEN}  PASS${NC} — %s\n" "$1"; }
fail() { printf "${RED}  FAIL${NC} — %s\n" "$1"; }
pending() { printf "${YELLOW}  PENDING${NC} — %s\n" "$1"; }
info() { printf "${BLUE}  INFO${NC} — %s\n" "$1"; }
section() { printf "\n${BLUE}=== %s ===${NC}\n" "$1"; }

# ── Criterion tracking ────────────────────────────────────────────────────────

declare -A CRITERION_RESULT
declare -A CRITERION_EVIDENCE
CRITERIA=(1 2 3 4 5 6)

set_criterion() {
  local n="$1" result="$2" evidence="$3"
  CRITERION_RESULT[$n]="$result"
  CRITERION_EVIDENCE[$n]="${evidence}"
}

# Initialize all criteria as PENDING.
for c in "${CRITERIA[@]}"; do
  set_criterion "$c" "PENDING" "Not yet verified."
done

# ── Environment detection ─────────────────────────────────────────────────────

SMOKE_ENABLED="${CPS_INSTALLED_SMOKE:-}"
CODEX_AVAILABLE=false
OLLAMA_AVAILABLE=false

if command -v codex >/dev/null 2>&1; then
  CODEX_AVAILABLE=true
fi
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_AVAILABLE=true
fi

section "Environment"
info "REPO_ROOT: ${REPO_ROOT}"
info "CPS_INSTALLED_SMOKE: ${SMOKE_ENABLED:-<unset>}"
info "codex binary: ${CODEX_AVAILABLE}"
info "ollama binary: ${OLLAMA_AVAILABLE}"

# ── Tier 5 replay tests (always run — no live CLIs required) ─────────────────

section "Tier 5 — Replay Tests (Criterion 6 unit portion)"

REPLAY_PASS=false
REPLAY_OUTPUT=""
if node --test "${REPLAY_TEST}" >/tmp/cps-replay-output.txt 2>&1; then
  REPLAY_PASS=true
  REPLAY_OUTPUT="$(cat /tmp/cps-replay-output.txt)"
  pass "replay-from-sidecar.test.js — all tests green"
else
  REPLAY_OUTPUT="$(cat /tmp/cps-replay-output.txt)"
  fail "replay-from-sidecar.test.js — FAILED"
  echo "${REPLAY_OUTPUT}" | tail -20
fi

if [ "$REPLAY_PASS" = true ]; then
  set_criterion 6 "PASS" "node --test tests/replay/replay-from-sidecar.test.js — all tests green. inputs_hash byte-identity verified. Cross-CLI mismatch warning verified."
else
  set_criterion 6 "FAIL" "node --test tests/replay/replay-from-sidecar.test.js — FAILED. See output above."
fi

# ── Installed-smoke + live run (Criteria 1-5) ─────────────────────────────────

section "Criteria 1–5 (requires CPS_INSTALLED_SMOKE=1 + real CLIs)"

if [ "${SMOKE_ENABLED}" != "1" ]; then
  pending "CPS_INSTALLED_SMOKE not set — Criteria 1–5 remain PENDING"
  info "To run live verification: CPS_INSTALLED_SMOKE=1 ./scripts/v0.9.0-release-gate.sh"
  for c in 1 2 3 4 5; do
    set_criterion "$c" "PENDING" "CPS_INSTALLED_SMOKE not set; live verification not run."
  done
elif [ "$CODEX_AVAILABLE" = false ]; then
  pending "codex binary not found — Criteria 1–5 remain PENDING"
  info "Install codex and run: codex login; then re-run this script with CPS_INSTALLED_SMOKE=1"
  for c in 1 2 3 4 5; do
    set_criterion "$c" "PENDING" "codex binary not found on PATH; install and re-run."
  done
else
  # ── Live run: compose experts + dispatch + sidecar audit ─────────────────

  # Build a tiny spec for the test run.
  TEST_SPEC_PATH="$(mktemp /tmp/cps-gate-spec.XXXXXX.md)"
  cat > "${TEST_SPEC_PATH}" <<'SPEC_EOF'
# Gate Test Spec — v0.9.0 Release Gate

## Feature
A minimal user-authentication endpoint that accepts email + password,
validates credentials against a hashed store, and returns a signed JWT.

## Requirements
- Validate email format before DB lookup
- Hash passwords with bcrypt (cost factor 12)
- Return 401 on invalid credentials (no distinction between bad email / bad pass)
- JWT signed with RS256; expires in 24h
- Rate-limit to 5 attempts per IP per minute

## Out of scope
- OAuth / social login
- Session management
- Password reset flow
SPEC_EOF

  if [ -n "${SPEC_ARG}" ] && [ -f "${SPEC_ARG}" ]; then
    TEST_SPEC_PATH="${SPEC_ARG}"
    info "Using provided spec: ${TEST_SPEC_PATH}"
  else
    info "Using built-in test spec: ${TEST_SPEC_PATH}"
  fi

  # Run installed-smoke tests (covers adapter contract / dispatch shape).
  SMOKE_PASS=true
  section "Installed-smoke tests"
  if CPS_INSTALLED_SMOKE=1 node --test "${SMOKE_DIR}/codex-real.test.js" >/tmp/cps-codex-smoke.txt 2>&1; then
    pass "codex-real.test.js — green"
    CODEX_SMOKE_OUTPUT="$(cat /tmp/cps-codex-smoke.txt)"
  else
    SMOKE_PASS=false
    fail "codex-real.test.js — FAILED"
    cat /tmp/cps-codex-smoke.txt
    CODEX_SMOKE_OUTPUT="FAILED — see above"
  fi

  if [ "$OLLAMA_AVAILABLE" = true ]; then
    if CPS_INSTALLED_SMOKE=1 node --test "${SMOKE_DIR}/ollama-real.test.js" >/tmp/cps-ollama-smoke.txt 2>&1; then
      pass "ollama-real.test.js — green (cross-model verification passed)"
      OLLAMA_SMOKE_OUTPUT="$(cat /tmp/cps-ollama-smoke.txt)"
    else
      SMOKE_PASS=false
      fail "ollama-real.test.js — FAILED"
      cat /tmp/cps-ollama-smoke.txt
      OLLAMA_SMOKE_OUTPUT="FAILED — see above"
    fi
  else
    pending "ollama binary not found — ollama-real.test.js skipped"
    OLLAMA_SMOKE_OUTPUT="PENDING — ollama binary not found"
  fi

  # Run the Node.js gate-check script for Criteria 1-5.
  # This script exercises composeExperts → resolveAdapter → dispatch × 2 CLIs
  # and reads the resulting sidecar to validate audit fields.

  GATE_CHECK_RESULT="$(node --input-type=module <<GATE_CHECK_EOF 2>&1 || echo "GATE_CHECK_FAILED"
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Dynamic imports from the repo root.
const REPO = ${REPO_ROOT@Q};

async function main() {
  let results = {};

  // ── Criterion 1: composeExperts selects >=2 roles ───────────────────────
  try {
    const { composeExperts } = await import('file://' + join(REPO, 'lib/codex-bridge/role-composer.js'));
    const specContent = readFileSync(${TEST_SPEC_PATH@Q}, 'utf8');
    const roles = composeExperts(specContent, { phase: 'spec-review', maxRoles: 4 });
    if (Array.isArray(roles) && roles.length >= 2) {
      results.c1 = { result: 'PASS', evidence: 'composeExperts returned ' + roles.length + ' roles: ' + roles.map(r => r.id || r).join(', ') };
    } else {
      results.c1 = { result: 'FAIL', evidence: 'composeExperts returned only ' + (Array.isArray(roles) ? roles.length : 'non-array') + ' roles' };
    }
  } catch (err) {
    results.c1 = { result: 'FAIL', evidence: 'composeExperts threw: ' + err.message };
  }

  // ── Criterion 2: distinct CLIs route per role ────────────────────────────
  try {
    const { resolveAdapter } = await import('file://' + join(REPO, 'lib/codex-bridge/role-routing/resolver.js'));
    // Probe with two roles that should route to different CLIs.
    const testRoles = ['expert-architecture', 'expert-tdd'];
    const resolved = [];
    for (const role of testRoles) {
      try {
        const r = await resolveAdapter(role, null); // uses defaults
        resolved.push({ role, cli: r.cli });
      } catch (err) {
        resolved.push({ role, cli: null, error: err.message });
      }
    }
    const distinctCLIs = new Set(resolved.filter(r => r.cli).map(r => r.cli));
    if (distinctCLIs.size >= 2) {
      results.c2 = { result: 'PASS', evidence: 'Distinct CLIs: ' + [...distinctCLIs].join(', ') + ' — routing: ' + JSON.stringify(resolved) };
    } else if (distinctCLIs.size === 1) {
      results.c2 = { result: 'PENDING', evidence: 'Only one distinct CLI available (' + [...distinctCLIs].join('') + '). Add a second CLI to PATH for full cross-model verification.' };
    } else {
      results.c2 = { result: 'FAIL', evidence: 'No CLIs resolved. resolveAdapter errors: ' + JSON.stringify(resolved) };
    }
  } catch (err) {
    results.c2 = { result: 'PENDING', evidence: 'role-routing resolver not available or threw: ' + err.message + '. Manual verification required.' };
  }

  // ── Criteria 3, 4, 5: sidecar audit + peer DM + double-SHIP ─────────────
  // These require a live dispatch cycle. Without running a full skill,
  // we verify the structural invariants from the unit tests.
  // A manual run of any skill against the test spec is required for full verification.
  results.c3 = { result: 'PENDING', evidence: 'Requires full skill run. Run: brainstorming or writing-plans on ' + ${TEST_SPEC_PATH@Q} + ' and inspect the sidecar. All required fields: requested_role, resolved_cli, resolution_source, adapter, inputs_hash, response_hash must be present per turn.' };
  results.c4 = { result: 'PENDING', evidence: 'Requires full skill run with peer DM. Run two expert roles and verify at least one turn shows mailbox_message_ids[] non-empty in the sidecar.' };
  results.c5 = { result: 'PENDING', evidence: 'Requires full autopilot or writing-plans run to SHIP convergence. Verify sidecar rounds[].verdict = "SHIP" within 7 rounds.' };

  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => { console.error('GATE_CHECK_FAILED:', err.message); process.exit(1); });
GATE_CHECK_EOF
)"

  if echo "${GATE_CHECK_RESULT}" | grep -q "GATE_CHECK_FAILED"; then
    info "Gate check script failed to run; criteria 1-2 remain PENDING"
    for c in 1 2 3 4 5; do
      set_criterion "$c" "PENDING" "Gate check script error: ${GATE_CHECK_RESULT}"
    done
  else
    # Parse JSON results.
    for c in 1 2; do
      result="$(echo "${GATE_CHECK_RESULT}" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf8');
try { const j=JSON.parse(d); console.log((j['c${c}']||{}).result||'PENDING'); }
catch{console.log('PENDING');}
" 2>/dev/null || echo "PENDING")"
      evidence="$(echo "${GATE_CHECK_RESULT}" | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf8');
try { const j=JSON.parse(d); console.log((j['c${c}']||{}).evidence||''); }
catch{console.log('');}
" 2>/dev/null || echo "")"
      set_criterion "$c" "${result}" "${evidence}"
      case "${result}" in
        PASS) pass "Criterion ${c}: ${evidence}" ;;
        FAIL) fail "Criterion ${c}: ${evidence}" ;;
        *) pending "Criterion ${c}: ${evidence}" ;;
      esac
    done

    # Criteria 3, 4, 5 remain PENDING — need a full live skill run.
    set_criterion 3 "PENDING" "Requires full skill run. Run brainstorming or writing-plans on the spec, then inspect sidecar for required audit fields."
    set_criterion 4 "PENDING" "Requires full skill run with peer DM. Run two expert roles and verify mailbox_message_ids[] in sidecar."
    set_criterion 5 "PENDING" "Requires full autopilot run. Verify sidecar rounds[].verdict = SHIP within 7 rounds."
    pending "Criterion 3 — manual live run required"
    pending "Criterion 4 — manual live run required"
    pending "Criterion 5 — manual live run required"
  fi

  # Clean up temp spec if we created it.
  if [ -z "${SPEC_ARG}" ]; then
    rm -f "${TEST_SPEC_PATH}"
  fi
fi

# ── Write results to the gate document ───────────────────────────────────────

section "Writing results to gate document"

# Build the gate summary table.
GATE_TABLE=""
OVERALL="PASS"
for c in "${CRITERIA[@]}"; do
  result="${CRITERION_RESULT[$c]:-PENDING}"
  evidence="${CRITERION_EVIDENCE[$c]:-}"
  GATE_TABLE="${GATE_TABLE}| ${c} | — | ${result} |\n"
  if [ "${result}" != "PASS" ]; then
    OVERALL="${result}"  # PENDING or FAIL dominates.
  fi
done

TIMESTAMP="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# Write a fresh gate document with current results.
# We use Python for the sed-safe in-place substitution to handle macOS/Linux portably.
node -e "
const fs = require('fs');
const path = require('path');
const doc = fs.readFileSync('${GATE_DOC}', 'utf8');
let updated = doc;

// Update status line.
updated = updated.replace(/^\*\*Status:\*\*.*$/m, '**Status:** ${OVERALL}');
updated = updated.replace(/^\*\*Last run:\*\*.*$/m, '**Last run:** ${TIMESTAMP}');

// Update individual criterion results and evidence.
const criteria = [
$(for c in "${CRITERIA[@]}"; do
  result="${CRITERION_RESULT[$c]:-PENDING}"
  evidence="${CRITERION_EVIDENCE[$c]:-Not yet verified.}"
  # Escape for JS string — single quotes.
  evidence_escaped="${evidence//\'/\\\\\'}"
  echo "  { n: ${c}, result: '${result}', evidence: '${evidence_escaped}' },"
done)
];

for (const { n, result, evidence } of criteria) {
  // Update result annotation in the criterion header.
  // The gate doc has '**Result:** PENDING/PASS/FAIL' under each criterion.
  updated = updated.replace(
    new RegExp('(## Criterion ' + n + '[\\\\s\\\\S]*?\\\\*\\\\*Result:\\\\*\\\\* )\\\\w+'),
    '\$1' + result
  );
  // Update evidence section.
  updated = updated.replace(
    new RegExp('(## Criterion ' + n + '[\\\\s\\\\S]*?\\\\*\\\\*Evidence:\\\\*\\\\*\\\\s*\\\\n)_\\\\(gate-runner writes results here\\\\)_'),
    '\$1' + result + ' — ' + evidence.replace(/\`/g, \"'\").slice(0, 300)
  );
}

// Update summary table.
const tableRows = [
$(for c in "${CRITERIA[@]}"; do
  result="${CRITERION_RESULT[$c]:-PENDING}"
  echo "  '| ${c} | — | ${result} |',"
done)
];
// Replace the summary table rows.
// The table starts after '## Gate summary' and has exactly 6 data rows.
updated = updated.replace(
  /(\| # \| Criterion \| Result \|[\s\S]*?\n)(\| [1-6] \|[\s\S]*?)(\n\n\*\*Overall:\*\*)/,
  '\$1' + tableRows.join('\n') + '\$3'
);
updated = updated.replace(
  /^\*\*Overall:\*\*.*$/m,
  '**Overall:** ${OVERALL} — last run ${TIMESTAMP}'
);

fs.writeFileSync('${GATE_DOC}', updated, 'utf8');
console.log('Gate document updated.');
" 2>/dev/null || info "Could not auto-update gate document (non-fatal); update manually."

# ── Print summary ─────────────────────────────────────────────────────────────

section "Gate Summary"
printf "\n"
printf "%-4s %-55s %s\n" "Crit" "Description" "Result"
printf "%-4s %-55s %s\n" "----" "-------------------------------------------------------" "------"

DESCRIPTIONS=(
  [1]="Composer selects >=2 distinct roles"
  [2]="Distinct CLIs route per role"
  [3]="Sidecar audit fields populated"
  [4]="Peer DM round-tripped across adapters"
  [5]="Double-SHIP convergence <=7 rounds"
  [6]="Replay reconstructs inputs_hash identically"
)

ALL_PASS=true
for c in "${CRITERIA[@]}"; do
  result="${CRITERION_RESULT[$c]:-PENDING}"
  desc="${DESCRIPTIONS[$c]}"
  case "$result" in
    PASS) printf "${GREEN}%-4s${NC} %-55s ${GREEN}%s${NC}\n" "$c" "$desc" "$result" ;;
    FAIL) printf "${RED}%-4s${NC} %-55s ${RED}%s${NC}\n" "$c" "$desc" "$result" ; ALL_PASS=false ;;
    *)    printf "${YELLOW}%-4s${NC} %-55s ${YELLOW}%s${NC}\n" "$c" "$desc" "$result" ; ALL_PASS=false ;;
  esac
done

printf "\n"
printf "Gate document: %s\n" "${GATE_DOC}"
printf "\n"

if [ "$ALL_PASS" = true ]; then
  printf "${GREEN}ALL CRITERIA PASS — ready for git tag v0.9.0${NC}\n"
  exit 0
else
  printf "${YELLOW}Gate INCOMPLETE — PENDING or FAIL criteria above.${NC}\n"
  printf "Run the full live verification steps in the gate document to advance.\n"
  exit 1
fi
