#!/usr/bin/env bash
# Codex/Agy exec wrapper with durable, atomic launch and completion evidence.
# Spec: docs/specs/2026-09-17-v0.17.0-antigravity-transport-design.md Section 2 (Wrapper: CLI-aware --model-role)
#
# Usage:
#   scripts/codex-exec-with-status.sh <status-file> \
#     [--model-role <role>] [--repo-root <repo>] [--cwd <dir>] -- <cmd> [args...]
#
# Example (Codex):
#   scripts/codex-exec-with-status.sh /tmp/cps/slice-3.status.json \
#     --model-role implement -- \
#     codex exec --skip-git-repo-check -s workspace-write -C /repo/.git-worktrees/slice-3 "<prompt>" </dev/null
#
# Example (Agy):
#   scripts/codex-exec-with-status.sh /tmp/cps/slice-3.status.json \
#     --model-role implement --cwd /repo/.git-worktrees/slice-3 -- \
#     agy -p "<prompt>" --sandbox --output-format json </dev/null

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: $(basename "$0") <status-file-path> [--model-role <role>] [--repo-root <dir>] [--cwd <dir>] -- <cmd> [args...]" >&2
}

if [ "$#" -lt 2 ]; then
  usage
  exit 64
fi

STATUS_FILE="$1"
case "$STATUS_FILE" in
  /*) ;;
  *) STATUS_FILE="$PWD/$STATUS_FILE" ;;
esac
shift
MODEL_ROLE=""
MODEL=""
EFFORT=""
REPO_ROOT=""
CWD=""
CLI=""

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
    --cwd)
      if [ "$#" -lt 2 ]; then usage; exit 64; fi
      CWD="$2"
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
if ! mkdir -p "$STATUS_DIR"; then
  echo "failed to create status directory for $STATUS_FILE; child not launched" >&2
  exit 74
fi

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

  if ! node -e '
    const fs = require("node:fs");
    const [path, state, exitCode, signal, startedAt, completedAt, role, model, effort, error, cli, cwd] = process.argv.slice(1);
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
    if (cli !== "") status.cli = cli;
    if (cwd !== "") status.cwd = cwd;
    fs.writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
  ' "$tmp" "$state" "$exit_code" "$signal" "$STARTED_AT" "$completed_at" "$MODEL_ROLE" "$MODEL" "$EFFORT" "$error" "${CLI:-}" "${CWD:-}"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! mv "$tmp" "$STATUS_FILE"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

config_error() {
  local error="$1"
  local detail="$2"
  echo "$detail" >&2
  if ! write_status "exited" "78" "" "$(iso_now)" "$error"; then
    echo "failed to publish configuration-error status to $STATUS_FILE; child not launched" >&2
    exit 74
  fi
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

  PARSED=()
  while IFS= read -r -d '' item; do
    PARSED+=("$item")
  done < <(node -e '
    const value = JSON.parse(process.argv[1]);
    if (typeof value.model !== "string" || value.model.length === 0 ||
        typeof value.effort !== "string" || value.effort.length === 0 ||
        typeof value.cli !== "string" || value.cli.length === 0 ||
        typeof value.command !== "string" || value.command.length === 0 ||
        !Array.isArray(value.args) ||
        (value.insertAfter !== null && typeof value.insertAfter !== "string")) {
      process.exit(1);
    }
    const insertAfter = value.insertAfter === null ? "" : value.insertAfter;
    process.stdout.write(value.model + "\0" + value.effort + "\0" + value.cli + "\0" + value.command + "\0" + insertAfter + "\0");
    for (const a of value.args) {
      process.stdout.write(String(a) + "\0");
    }
  ' "$ROLE_JSON" 2>/dev/null)

  if [ "${#PARSED[@]}" -lt 5 ]; then
    config_error "model-role-resolution-failed" "model role resolution returned malformed JSON"
  fi

  MODEL="${PARSED[0]}"
  EFFORT="${PARSED[1]}"
  CLI="${PARSED[2]}"
  EXPECTED_COMMAND="${PARSED[3]}"
  INSERT_AFTER="${PARSED[4]}"
  EXTRA_ARGS=("${PARSED[@]:5}")

  # Find the command token (skip leading env, nohup, VAR=value tokens)
  CMD=("$@")
  CMD_INDEX=-1
  for i in "${!CMD[@]}"; do
    token="${CMD[$i]}"
    case "$(basename "$token")" in
      env|nohup)
        continue
        ;;
    esac
    case "$token" in
      [a-zA-Z_][a-zA-Z0-9_]*=*)
        continue
        ;;
    esac
    CMD_INDEX=$i
    break
  done

  if [ "$CMD_INDEX" -lt 0 ]; then
    config_error "model-role-conflicting-args" "wrapped command is missing"
  fi

  CMD_TOKEN="${CMD[$CMD_INDEX]}"
  CMD_BASENAME="$(basename "$CMD_TOKEN")"

  if [ "$CMD_BASENAME" != "$EXPECTED_COMMAND" ]; then
    config_error "model-role-conflicting-args" "config says $CLI, command runs $CMD_BASENAME"
  fi

  # Per-CLI conflict scanning
  if [ "$CLI" = "codex" ]; then
    # Only FLAG-SHAPED arguments (and the value that follows -c/--config) are inspected. The
    # implementation prompt is a positional argument that legitimately quotes the plan — which
    # mentions "model_reasoning_effort=" — so scanning every argument produced a false 78
    # (Claude review of slice 2).
    PREV_WAS_CONFIG=0
    for arg in "$@"; do
      if [ "$arg" = "--" ]; then
        break
      fi
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
        -m|-m?*|--model|--model=*|-cmodel_reasoning_effort=*|-c=model_reasoning_effort=*|--config=model_reasoning_effort=*)
          config_error "model-role-conflicting-args" "wrapped codex exec already supplies model flags; remove -m, --model, and -c model_reasoning_effort overrides"
          ;;
        -c|--config)
          PREV_WAS_CONFIG=1
          ;;
      esac
    done
  elif [ "$CLI" = "agy" ]; then
    PREV_WAS_PROMPT=0
    for arg in "$@"; do
      if [ "$arg" = "--" ]; then
        break
      fi
      if [ "$PREV_WAS_PROMPT" -eq 1 ]; then
        PREV_WAS_PROMPT=0
        continue
      fi
      case "$arg" in
        -p|--prompt)
          PREV_WAS_PROMPT=1
          ;;
        --model|--model=*|--effort|--effort=*)
          config_error "model-role-conflicting-args" "wrapped agy already supplies model flags; remove --model and --effort overrides"
          ;;
      esac
    done
  fi

  # Insertion per insertAfter
  if [ -n "$INSERT_AFTER" ]; then
    INSERT_INDEX=-1
    for ((i = CMD_INDEX + 1; i < ${#CMD[@]}; i++)); do
      if [ "${CMD[$i]}" = "$INSERT_AFTER" ]; then
        INSERT_INDEX=$i
        break
      fi
    done
    if [ "$INSERT_INDEX" -lt 0 ]; then
      config_error "model-role-conflicting-args" "wrapped command is not $EXPECTED_COMMAND $INSERT_AFTER"
    fi
    TARGET_INDEX=$INSERT_INDEX
  else
    TARGET_INDEX=$CMD_INDEX
  fi

  CMD=(
    "${CMD[@]:0:$((TARGET_INDEX + 1))}"
    "${EXTRA_ARGS[@]}"
    "${CMD[@]:$((TARGET_INDEX + 1))}"
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
  if ! write_status "exited" "$code" "SIG$sig" "$(iso_now)"; then
    echo "failed to publish terminal status to $STATUS_FILE (child exit code: $code)" >&2
    exit 74
  fi
  exit "$code"
}

trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

if [ -n "$CWD" ]; then
  if ! cd "$CWD"; then
    echo "failed to change directory to $CWD; child not launched" >&2
    exit 74
  fi
fi

# Pre-launch evidence must be durable before the child can execute.
if ! write_status "started" "null" "" ""; then
  echo "failed to publish pre-launch status to $STATUS_FILE; child not launched" >&2
  exit 74
fi

"${CMD[@]}" &
CODEX_PID=$!
wait "$CODEX_PID"
EXIT_CODE=$?

if ! write_status "exited" "$EXIT_CODE" "" "$(iso_now)"; then
  echo "failed to publish terminal status to $STATUS_FILE (child exit code: $EXIT_CODE)" >&2
  exit 74
fi
exit "$EXIT_CODE"
