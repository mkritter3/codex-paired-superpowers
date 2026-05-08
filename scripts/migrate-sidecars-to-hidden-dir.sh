#!/usr/bin/env bash
# migrate-sidecars-to-hidden-dir.sh
#
# One-shot migration: move all legacy <spec>.codex.json sidecars to
# .superpowers-codex-paired/<relative-spec-path>.json.
#
# Usage:
#   bash scripts/migrate-sidecars-to-hidden-dir.sh [--dry-run]
#
# Two-phase design:
#   Phase 1 (preflight): classifies every candidate without mutating anything.
#   Phase 2 (execute):   only runs if Phase 1 finds no ambiguous state.
#
# State machine per candidate:
#   legacy=exists,tracked + hidden=absent  → migrate-tracked  (git mv; preserves history)
#   legacy=exists,untracked + hidden=absent → migrate-untracked (plain mv; stays untracked)
#   legacy=absent + hidden=exists           → already-migrated  (no-op)
#   legacy=exists + hidden=exists           → ambiguous         (abort; user must resolve)
#
# Recovery from partial Phase 2 failure:
#   Phase 2 is NOT transactional. If a single git mv / mv fails partway through
#   (e.g., disk full, permission denied on a specific path), prior moves in that
#   run are already committed. Recovery: re-run the script. The state machine is
#   idempotent for completed cases — they become already-migrated on re-run and
#   are skipped. The failed case will re-attempt. If user manually intervened
#   mid-failure to produce an ambiguous state, the next preflight will halt and
#   surface the conflict for manual resolution.
#
# --dry-run:
#   Runs Phase 1 (prints all classifications) without executing any moves.
#   Exits 0.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  fi
done

# Anchor to repo root.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Discover all legacy sidecar candidates.
CANDIDATES=()
while IFS= read -r line; do
  CANDIDATES+=("$line")
done < <(
  find . -name '*.codex.json' \
    -not -path './node_modules/*' \
    -not -path './.superpowers-codex-paired/*' \
    -type f \
    2>/dev/null | sort
)

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "no legacy sidecars found; nothing to migrate"
  exit 0
fi

# --- Phase 1: preflight (classify without mutating) ---
declare -a CLASS_ACTION=()
declare -a CLASS_LEGACY=()
declare -a CLASS_HIDDEN=()
declare -a AMBIGUOUS_LEGACY=()
declare -a AMBIGUOUS_HIDDEN=()

for legacy in "${CANDIDATES[@]}"; do
  # Strip leading './'
  legacy="${legacy#./}"
  # Compute the spec path (strip .codex.json suffix).
  spec="${legacy%.codex.json}"
  # Compute the hidden destination.
  hidden=".superpowers-codex-paired/${spec}.json"

  legacy_exists=0
  hidden_exists=0
  [ -f "$legacy" ] && legacy_exists=1
  [ -f "$hidden" ] && hidden_exists=1

  if [ "$legacy_exists" -eq 1 ] && [ "$hidden_exists" -eq 1 ]; then
    CLASS_ACTION+=("ambiguous")
    CLASS_LEGACY+=("$legacy")
    CLASS_HIDDEN+=("$hidden")
    AMBIGUOUS_LEGACY+=("$legacy")
    AMBIGUOUS_HIDDEN+=("$hidden")
  elif [ "$legacy_exists" -eq 1 ] && [ "$hidden_exists" -eq 0 ]; then
    # Determine if legacy is git-tracked.
    if git ls-files --error-unmatch "$legacy" >/dev/null 2>&1; then
      CLASS_ACTION+=("migrate-tracked")
    else
      CLASS_ACTION+=("migrate-untracked")
    fi
    CLASS_LEGACY+=("$legacy")
    CLASS_HIDDEN+=("$hidden")
  else
    # legacy absent, hidden present — already migrated (find wouldn't return this, but guard anyway)
    CLASS_ACTION+=("already-migrated")
    CLASS_LEGACY+=("$legacy")
    CLASS_HIDDEN+=("$hidden")
  fi
done

# Print preflight classifications.
for i in "${!CLASS_ACTION[@]}"; do
  echo "[preflight] ${CLASS_ACTION[$i]}: ${CLASS_LEGACY[$i]}"
done

# If any ambiguous, abort before Phase 2.
if [ "${#AMBIGUOUS_LEGACY[@]}" -gt 0 ]; then
  echo ""
  echo "ERROR: ambiguous state detected for ${#AMBIGUOUS_LEGACY[@]} candidate(s):"
  for i in "${!AMBIGUOUS_LEGACY[@]}"; do
    echo "  legacy:  ${AMBIGUOUS_LEGACY[$i]}"
    echo "  hidden:  ${AMBIGUOUS_HIDDEN[$i]}"
    echo "  remediation: remove one of the two files, then re-run."
  done
  echo ""
  echo "ambiguous state; 0 mutated; resolve manually before re-running."
  exit 1
fi

# If --dry-run, exit without mutating.
if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "dry-run: no files were moved."
  exit 0
fi

# --- Phase 2: execute ---
processed=0
errors=0

for i in "${!CLASS_ACTION[@]}"; do
  action="${CLASS_ACTION[$i]}"
  legacy="${CLASS_LEGACY[$i]}"
  hidden="${CLASS_HIDDEN[$i]}"

  case "$action" in
    migrate-tracked)
      mkdir -p "$(dirname "$hidden")"
      if git mv "$legacy" "$hidden"; then
        echo "[exec] git mv $legacy → $hidden"
        processed=$((processed + 1))
      else
        echo "[error] git mv failed: $legacy → $hidden"
        errors=$((errors + 1))
      fi
      ;;
    migrate-untracked)
      mkdir -p "$(dirname "$hidden")"
      if mv "$legacy" "$hidden"; then
        echo "[exec] mv $legacy → $hidden"
        processed=$((processed + 1))
      else
        echo "[error] mv failed: $legacy → $hidden"
        errors=$((errors + 1))
      fi
      ;;
    already-migrated)
      # No-op; idempotent.
      echo "[skip] already-migrated: $legacy"
      ;;
  esac
done

echo ""
echo "summary: processed=$processed errors=$errors"

if [ "$errors" -gt 0 ]; then
  exit 1
fi
exit 0
