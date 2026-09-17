#!/usr/bin/env bash
# v0.16.0 Slice 5 — model catalog and Codex transport doctor checks (spec §8).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
BASE_PATH="$PATH"
trap 'rm -rf "$TEST_ROOT"' EXIT

unset CODEX_PAIRED_MODEL CODEX_PAIRED_REASONING
unset CODEX_PAIRED_MODEL_PLANNING CODEX_PAIRED_REASONING_PLANNING
unset CODEX_PAIRED_MODEL_REVIEW CODEX_PAIRED_REASONING_REVIEW
unset CODEX_PAIRED_MODEL_IMPLEMENT CODEX_PAIRED_REASONING_IMPLEMENT
unset CODEX_PAIRED_MODEL_IMPLEMENT_FALLBACK CODEX_PAIRED_REASONING_IMPLEMENT_FALLBACK

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
apply_fake_codex() {
  local target="$FAKE_BIN/codex"
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "${1-}" in' \
    '  --version) printf "codex-cli %s\\n" "${FAKE_CODEX_VERSION:-0.153.4}" ;;' \
    '  mcp-server) [ "${2-}" = "--help" ] && exit "${FAKE_MCP_HELP_EXIT:-0}" ;;' \
    '  *) exit 0 ;;' \
    'esac' > "$target"
  chmod +x "$target"
}
apply_fake_codex

new_case() {
  CASE_ROOT="$TEST_ROOT/$1"
  mkdir -p "$CASE_ROOT/home" "$CASE_ROOT/codex" "$CASE_ROOT/repo"
}

write_catalog() {
  local mode="${1:-good}"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const mode = process.argv[1];
    const catalog = {
      fetched_at: new Date(Date.now() - (mode === "stale" ? 10 * 86400000 : 0)).toISOString(),
      client_version: "0.153.4",
      models: [
        {
          slug: "gpt-6-astra",
          supported_reasoning_levels: [
            { effort: "medium" }, { effort: "high" }, { effort: "xhigh" },
            { effort: "max" }, { effort: "ultra" },
          ],
          upgrade: mode === "retiring" ? { retirement_at: "2026-10-14" } : null,
        },
        {
          slug: "gpt-5.6-sol",
          supported_reasoning_levels: mode === "unsupported"
            ? [{ effort: "medium" }]
            : [{ effort: "high" }],
          upgrade: null,
        },
      ],
    };
    if (mode === "missing") catalog.models = catalog.models.filter((model) => model.slug !== "gpt-5.6-sol");
    const target = path.join(process.argv[2], "models_cache.json");
    fs.writeFileSync(target, JSON.stringify(catalog));
  ' "$mode" "$CASE_ROOT/codex"
}

run_doctor() {
  local output="$CASE_ROOT/doctor.json"
  (
    cd "$CASE_ROOT/repo"
    HOME="$CASE_ROOT/home" \
      CODEX_HOME="$CASE_ROOT/codex" \
      CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      PATH="$FAKE_BIN:$BASE_PATH" \
      "$PLUGIN_ROOT/bin/codex-paired-doctor" --json
  ) > "$output"
  printf '%s' "$output"
}

run_doctor_allow_failure() {
  local output="$CASE_ROOT/doctor.json"
  (
    cd "$CASE_ROOT/repo"
    HOME="$CASE_ROOT/home" \
      CODEX_HOME="$CASE_ROOT/codex" \
      CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      PATH="$FAKE_BIN:$BASE_PATH" \
      CODEX_PAIRED_REASONING_IMPLEMENT=impossible \
      "$PLUGIN_ROOT/bin/codex-paired-doctor" --json
  ) > "$output" || true
  printf '%s' "$output"
}

assert_check() {
  local output="$1" name="$2" status="$3" detail_fragment="$4" label="$5"
  node -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const check = report.checks.find((candidate) => candidate.name === process.argv[2]);
    if (!check) throw new Error(`missing ${process.argv[2]} check`);
    if (check.status !== process.argv[3]) {
      throw new Error(`${process.argv[2]} status: expected ${process.argv[3]}, got ${check.status}: ${check.detail}`);
    }
    if (!check.detail.includes(process.argv[4])) {
      throw new Error(`${process.argv[2]} detail does not include ${JSON.stringify(process.argv[4])}: ${check.detail}`);
    }
  ' "$output" "$name" "$status" "$detail_fragment"
  echo "  PASS: $label"
}

echo "Doctor model/catalog and transport checks"

new_case fresh
write_catalog good
fresh_output=$(CODEX_PAIRED_MODEL_IMPLEMENT=gpt-6-astra run_doctor)
assert_check "$fresh_output" models pass "implement: gpt-6-astra high (env" \
  "fresh compatible catalog passes and reports env source"

new_case missing
write_catalog missing
assert_check "$(run_doctor)" models warn "gpt-5.6-sol is missing" \
  "missing configured model warns"

new_case retiring
write_catalog retiring
assert_check "$(run_doctor)" models warn "2026-10-14" \
  "retirement date warns with the date"

new_case unsupported
write_catalog unsupported
assert_check "$(run_doctor)" models warn "does not support effort high" \
  "unsupported effort warns"

new_case absent
assert_check "$(run_doctor)" models pass "catalog not cached" \
  "absent cache passes with a skipped detail"

new_case unparsable
printf '{not-json' > "$CASE_ROOT/codex/models_cache.json"
assert_check "$(run_doctor)" models warn "catalog unreadable" \
  "unparsable cache warns"

new_case stale
write_catalog stale
assert_check "$(run_doctor)" models warn "10 days" \
  "ten-day-old cache warns with its age"

new_case config_error
assert_check "$(run_doctor_allow_failure)" models fail "impossible" \
  "invalid resolved role configuration fails"

new_case old_cli
write_catalog good
assert_check "$(FAKE_CODEX_VERSION=0.140.0 run_doctor)" codex-transport warn \
  "older than the version v0.16.0 was validated against" \
  "older Codex CLI warns"

new_case validated_cli
write_catalog good
assert_check "$(FAKE_CODEX_VERSION=0.153.4 run_doctor)" codex-transport pass "0.153.4" \
  "validated Codex CLI passes"

new_case newer_cli
write_catalog good
assert_check "$(FAKE_CODEX_VERSION=0.160.0 run_doctor)" codex-transport pass "0.160.0" \
  "newer Codex CLI passes"

new_case missing_transport
write_catalog good
assert_check "$(FAKE_MCP_HELP_EXIT=1 run_doctor)" codex-transport warn \
  "does not offer the MCP server transport" \
  "missing MCP server transport warns"

echo "All 12 doctor model/catalog and transport checks passed."
