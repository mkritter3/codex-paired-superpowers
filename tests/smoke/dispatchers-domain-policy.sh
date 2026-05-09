#!/usr/bin/env bash
# v0.7.1 — domain policy smoke for the production dispatcher registry.
#
# Proves that lib/codex-bridge/dispatchers.js + agents/dispatchers.json
# enforce the user-stated policy:
#   - UI / UX work → Claude (Codex forbidden)
#   - AI harness work → Claude (Codex forbidden)
#   - Backend / general → Codex acceptable
#
# This smoke runs against the actual production registry. It is the
# orthogonal acceptance check to the unit tests in
# tests/agents/dispatchers-registry.test.js (those use isolated fixtures).
# If the production policy ever drifts from spec §6.5, this smoke fails.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

run_check() {
  local description="$1"
  local implementer="$2"
  local domain="$3"
  local expected="$4"
  local actual
  actual=$(node -e "
    import('$PLUGIN_ROOT/lib/codex-bridge/dispatchers.js').then(m => {
      try {
        const r = m.enforceDomainPolicy('$implementer', '$domain');
        process.stdout.write(r);
      } catch (e) {
        process.stdout.write('THROWS:' + e.code);
      }
    });
  ")
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $description (got '$actual')"
  else
    echo "  FAIL: $description (expected '$expected', got '$actual')" >&2
    exit 1
  fi
}

echo "Production domain policy smoke (agents/dispatchers.json)"
echo

echo "== UI domain enforcement =="
run_check "codex on ui is forbidden"          "codex"  "ui"          "forbidden"
run_check "sonnet on ui is preferred"          "sonnet" "ui"          "preferred"

echo "== AI-harness domain enforcement =="
run_check "codex on ai-harness is forbidden"   "codex"  "ai-harness"  "forbidden"
run_check "sonnet on ai-harness is preferred"  "sonnet" "ai-harness"  "preferred"

echo "== Backend domain enforcement =="
run_check "codex on backend is preferred"      "codex"  "backend"     "preferred"
run_check "sonnet on backend is allowed"       "sonnet" "backend"     "allowed"

echo "== General domain enforcement =="
run_check "codex on general is allowed"        "codex"  "general"     "allowed"
run_check "sonnet on general is preferred"     "sonnet" "general"     "preferred"

echo "== Error paths =="
run_check "unknown implementer throws"         "opus"   "backend"     "THROWS:implementer-directive-malformed"
run_check "unknown domain throws"              "codex"  "platform"    "THROWS:domain-directive-malformed"

echo
echo "All 10 domain-policy checks passed against the production registry."
