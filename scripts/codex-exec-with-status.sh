#!/usr/bin/env bash
# Codex exec wrapper with durable, atomic launch and completion evidence.
#
# Usage:
#   scripts/codex-exec-with-status.sh <status-file> \
#     --model-role implement [--repo-root <repo>] -- codex exec [args...]
#
# Example:
#   scripts/codex-exec-with-status.sh /tmp/cps/slice-3.status.json \
#     --model-role implement -- \
#     codex exec --skip-git-repo-check -s workspace-write -C /repo/.git-worktrees/slice-3 "<prompt>" </dev/null

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: $(basename "$0") <status-file-path> [--model-role <role>] [--repo-root <dir>] -- <codex-cmd> [args...]" >&2
}

if [ "$#" -lt 2 ]; then
  usage
  exit 64
fi

STATUS_FILE="$1"
shift
MODEL_ROLE=""
MODEL=""
EFFORT=""
REPO_ROOT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --model-role)
      if [ "$#" -lt 2 ]; then usage; exit 64; fi
      MODEL_ROLE="$2"
      shift 2
      ;;
    --repo-root)
      if [ "$#" -lt 2 ]; then usage; exit 64; fi
      REPO_ROOT="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

if [ "$#" -eq 0 ]; then
  usage
  exit 64
fi

STATUS_DIR=$(dirname "$STATUS_FILE")
mkdir -p "$STATUS_DIR"

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

STARTED_AT=$(iso_now)

write_status() {
  local state="$1"
  local exit_code="$2"
  local signal="${3:-}"
  local completed_at="${4:-}"
  local error="${5:-}"
  local tmp="$STATUS_FILE.tmp.$$"

  node -e '
    const fs = require("node:fs");
    const [path, state, exitCode, signal, startedAt, completedAt, role, model, effort, error] = process.argv.slice(1);
    const status = {
      state,
      exit_code: exitCode === "null" ? null : Number(exitCode),
      signal: signal === "" ? null : signal,
      started_at: startedAt,
      completed_at: completedAt === "" ? null : completedAt,
    };
    if (role !== "") status.model_role = role;
    if (model !== "") status.model = model;
    if (effort !== "") status.effort = effort;
    if (error !== "") status.error = error;
    fs.writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
  ' "$tmp" "$state" "$exit_code" "$signal" "$STARTED_AT" "$completed_at" "$MODEL_ROLE" "$MODEL" "$EFFORT" "$error"
  mv "$tmp" "$STATUS_FILE"
}

config_error() {
  local error="$1"
  local detail="$2"
  echo "$detail" >&2
  write_status "exited" "78" "" "$(iso_now)" "$error"
  exit 78
}

if [ -n "$MODEL_ROLE" ]; then
  ROLE_ARGS=(model-role --role "$MODEL_ROLE" --format json)
  if [ -n "$REPO_ROOT" ]; then
    ROLE_ARGS+=(--repoRoot "$REPO_ROOT")
  fi
  if ! ROLE_JSON=$(node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" "${ROLE_ARGS[@]}"); then
    config_error "model-role-resolution-failed" "model role resolution failed; fix .codex-paired/project.json models or CODEX_PAIRED_* and retry"
  fi
  if ! SNAPSHOT=$(node -e '
    const value = JSON.parse(process.argv[1]);
    process.stdout.write(value.model + "\t" + value.effort);
  ' "$ROLE_JSON"); then
    config_error "model-role-resolution-failed" "model role resolution returned malformed JSON"
  fi
  IFS=$'\t' read -r MODEL EFFORT <<< "$SNAPSHOT"

  # Only FLAG-SHAPED arguments (and the value that follows -c/--config) are inspected. The
  # implementation prompt is a positional argument that legitimately quotes the plan — which
  # mentions "model_reasoning_effort=" — so scanning every argument produced a false 78
  # (Claude review of slice 2).
  PREV_WAS_CONFIG=0
  for arg in "$@"; do
    if [ "$PREV_WAS_CONFIG" -eq 1 ]; then
      PREV_WAS_CONFIG=0
      case "$arg" in
        model_reasoning_effort=*)
          config_error "model-role-conflicting-args" "wrapped codex exec already supplies model flags; remove -m, --model, and -c model_reasoning_effort overrides"
          ;;
      esac
      continue
    fi
    case "$arg" in
      -m|--model|--model=*|-c=model_reasoning_effort=*|--config=model_reasoning_effort=*)
        config_error "model-role-conflicting-args" "wrapped codex exec already supplies model flags; remove -m, --model, and -c model_reasoning_effort overrides"
        ;;
      -c|--config)
        PREV_WAS_CONFIG=1
        ;;
    esac
  done

  CMD=("$@")
  EXEC_INDEX=-1
  for i in "${!CMD[@]}"; do
    if [ "${CMD[$i]}" = "exec" ]; then
      EXEC_INDEX=$i
      break
    fi
  done
  if [ "$EXEC_INDEX" -lt 0 ]; then
    config_error "model-role-conflicting-args" "wrapped command is not codex exec"
  fi
  CMD=(
    "${CMD[@]:0:$((EXEC_INDEX + 1))}"
    -m "$MODEL"
    -c "model_reasoning_effort=$EFFORT"
    "${CMD[@]:$((EXEC_INDEX + 1))}"
  )
else
  CMD=("$@")
fi

on_signal() {
  local sig="$1"
  local code
  case "$sig" in
    INT) code=130 ;;
    TERM) code=143 ;;
    HUP) code=129 ;;
    *) code=1 ;;
  esac
  if [ -n "${CODEX_PID:-}" ] && kill -0 "$CODEX_PID" 2>/dev/null; then
    kill -TERM "$CODEX_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$CODEX_PID" 2>/dev/null || true
  fi
  write_status "exited" "$code" "SIG$sig" "$(iso_now)"
  exit "$code"
}

trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

# Pre-launch evidence must be durable before the child can execute.
write_status "started" "null" "" ""

"${CMD[@]}" &
CODEX_PID=$!
wait "$CODEX_PID"
EXIT_CODE=$?

write_status "exited" "$EXIT_CODE" "" "$(iso_now)"
exit "$EXIT_CODE"
