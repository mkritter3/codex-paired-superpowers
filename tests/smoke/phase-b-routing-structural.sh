#!/usr/bin/env bash
# Structural smoke for the v0.7.0 Phase B routing-dispatch orchestrator.
#
# Phase B is no longer a hard-coded Sonnet subagent. It is a routing
# dispatch over two plugin subagents (slice-implementer-codex /
# slice-implementer-sonnet) with worktree isolation, optional parallel
# batching, and reconciler-as-truth. The orchestrator decisions live in
# skills/autopilot/SKILL.md prose. The mechanics live in lib/codex-bridge/.
#
# This smoke does NOT invoke real subagents. It exercises the orchestrator
# decision logic by:
#   - feeding in fixture slice sections (markdown);
#   - feeding in canned reconciler outcomes (JSON);
#   - feeding in canned bootstrap states;
#   - asserting the orchestrator's decision (dispatch which agent / halt
#     with which reason / fallback) matches what SKILL.md Phase B prose
#     specifies.
#
# Mocked aspects (not exercised end-to-end here):
#   - The reconciler module (slice 4): exercised by reconciler.test.js.
#     Here we synthesize its return value as canned JSON.
#   - The worktree primitives (slice 2): exercised by worktree.test.js.
#     Here we synthesize bootstrap state via simple flags.
#   - The integrate module (slice 6): exercised by worktree-integrate.test.js.
#     Here we synthesize its halt reason as canned JSON.
#   - Real subagent dispatch: not invoked.
#
# What this smoke proves:
#   - Pre-dispatch checklist (Implementer directive + Files block
#     validation) halts before any worktree setup with the correct
#     reason on every malformed input.
#   - Files-set conflict comparison forces serial when paths overlap.
#   - Files-set non-overlap dispatches in parallel; the smoke verifies
#     this by asserting the orchestrator's decision plan emits two
#     `Agent` invocations bound to a single batch (i.e., a single-turn
#     parallel dispatch).
#   - Two-tier bootstrap gate halts with worktree-bootstrap-failed
#     (Tier 1: sidecar marker missing) or worktree-bootstrap-stale
#     (Tier 2: symlink reality check failed) before dispatch.
#   - Reconciler-driven fallback fires on zero-commits and on non-
#     conforming commits; both record failed-fallback-pending and the
#     orchestrator schedules the alternate implementer.
#   - BLOCKED / NEEDS_CONTEXT halts without fallback.
#   - Cherry-pick conflict halts with worktree-merge-conflict.
#   - Resume-ambiguous halts with worktree-resume-ambiguous.
#
# Usage: bash tests/smoke/phase-b-routing-structural.sh
# Exits 0 on success, nonzero on first failed assertion.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE=$(mktemp -d -t cps-phase-b-routing-XXXXXX)
trap 'rm -rf "$SMOKE"' EXIT

# ---------------------------------------------------------------------------
# Decision module: a small, self-contained orchestrator decision evaluator
# that mirrors the rules in skills/autopilot/SKILL.md Phase B sections B.1
# through B.6. It accepts a JSON fixture on stdin describing the candidate
# window + canned dispatch outcomes and emits a JSON decision plan on
# stdout. The smoke then asserts on that plan.
#
# Inputs (stdin JSON):
#   {
#     "candidates": [
#       {
#         "slice_id": "slice-3",
#         "section": "<slice section markdown>",
#         "parallel_candidate": true|false,        // is this slice in a multi-slice candidate window?
#         "bootstrap": {                          // optional, required for dispatch paths
#           "tier1_marker_present": true|false,   // sidecar phases.implement.bootstrap.completed_at present
#           "tier2_verify_ok": true|false         // verifyBootstrap returned ok
#         },
#         "preferred_outcome": {                  // canned reconciler/dispatch outcome for the preferred implementer
#           "kind": "shipped|zero-commits|non-conforming|missing-json|blocked|needs-context|dispatch-error",
#           "non_conforming_subjects": [...],   // when kind=non-conforming
#           "head_sha": "...", "commit_count": N
#         },
#         "fallback_outcome": { ... },             // canned outcome for the fallback (used only on fallback trigger)
#         "integrate_outcome": {                   // canned integrate() outcome (slice 6 module)
#           "kind": "ok|merge-conflict|resume-ambiguous|integration-empty",
#           "detail": {...}
#         }
#       }
#     ]
#   }
#
# Output (stdout JSON):
#   {
#     "halt": { "reason": "...", "slice_id": "...", "detail": "..." }   // present on halt
#     OR
#     "batch": {
#       "kind": "parallel|serial-forced|single",
#       "dispatches": [
#         { "slice_id": "...", "agent": "slice-implementer-codex|slice-implementer-sonnet", "tier":"preferred|fallback" }
#       ]
#     }
#   }
# ---------------------------------------------------------------------------

DECISION_JS="$SMOKE/decision.mjs"
cat > "$DECISION_JS" <<'JSEOF'
// Phase B routing decision evaluator. Mirrors SKILL.md Phase B prose B.1-B.6
// + B.8 (integration halt reasons). Pure: no fs, no exec; reads stdin JSON,
// writes stdout JSON.

const ALLOWED_DIRECTIVES = new Set(['codex', 'sonnet']);

function parseImplementerDirective(section) {
  // Spec §5: literal `**Implementer:** codex` or `**Implementer:** sonnet`
  // exactly (lower-case). `auto`, empty, mixed-case, anything else → malformed.
  // Absent → defaults to codex.
  const lines = section.split('\n');
  let line = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('**Implementer:**')) {
      if (line !== null) {
        // Multiple directives → treat as malformed.
        return { malformed: true, reason: 'multiple-implementer-directives' };
      }
      line = trimmed;
    }
  }
  if (line === null) return { directive: 'codex', present: false };
  const value = line.slice('**Implementer:**'.length).trim();
  if (value === '') return { malformed: true, reason: 'empty-value' };
  if (!ALLOWED_DIRECTIVES.has(value)) {
    return { malformed: true, reason: 'unknown-or-mixed-case', value };
  }
  return { directive: value, present: true };
}

function parseFilesBlock(section) {
  // Spec §13: block starts at a line equal to `**Files:**` after trimming,
  // continues through consecutive `- <path>` bullets, ends at blank line,
  // heading, or other bold directive. Inline form `**Files:** lib/foo.js`
  // is malformed.
  const lines = section.split('\n');
  let inBlock = false;
  let foundHeader = false;
  let inlineForm = false;
  const paths = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!inBlock) {
      if (t === '**Files:**') {
        inBlock = true;
        foundHeader = true;
        continue;
      }
      // Inline form like `**Files:** lib/foo.js` (header line has trailing content)
      if (t.startsWith('**Files:**') && t !== '**Files:**') {
        inlineForm = true;
        foundHeader = true;
        continue;
      }
    } else {
      if (t === '') break;
      if (t.startsWith('#')) break;
      if (t.startsWith('**') && t.endsWith(':**') && t !== '**Files:**') break;
      if (t.startsWith('- ')) {
        paths.push(t.slice(2).trim());
        continue;
      }
      // Any non-bullet, non-blank → end of block.
      break;
    }
  }
  return { foundHeader, inlineForm, paths };
}

function validateFilesPaths(paths) {
  // Spec §5 + §13 path rules.
  const seen = new Set();
  for (const p of paths) {
    if (p === '') return { malformed: true, reason: 'empty-path' };
    if (/[*?\[]/.test(p)) return { malformed: true, reason: 'glob', path: p };
    if (p.startsWith('/')) return { malformed: true, reason: 'absolute', path: p };
    if (p.includes('\\')) return { malformed: true, reason: 'backslash', path: p };
    if (p.endsWith('/')) return { malformed: true, reason: 'trailing-slash', path: p };
    // Traversal: any segment that is exactly `.` or `..`.
    const segs = p.split('/');
    for (const s of segs) {
      if (s === '.' || s === '..') {
        return { malformed: true, reason: 'traversal', path: p };
      }
    }
    if (seen.has(p)) return { malformed: true, reason: 'duplicate', path: p };
    seen.add(p);
  }
  return { ok: true };
}

function checklist(candidate) {
  // Returns either {halt:{reason,detail}} or {ok, directive, files: paths|null}.
  const dir = parseImplementerDirective(candidate.section);
  if (dir.malformed) {
    return {
      halt: {
        reason: 'implementer-directive-malformed',
        slice_id: candidate.slice_id,
        detail: dir,
      },
    };
  }

  // Files block is only required for parallel candidates (B.1).
  if (candidate.parallel_candidate) {
    const fb = parseFilesBlock(candidate.section);
    if (!fb.foundHeader) {
      return {
        halt: {
          reason: 'parallel-files-missing',
          slice_id: candidate.slice_id,
          detail: 'no `**Files:**` header in slice section',
        },
      };
    }
    if (fb.inlineForm) {
      return {
        halt: {
          reason: 'parallel-files-malformed',
          slice_id: candidate.slice_id,
          detail: 'inline form like `**Files:** path` is not allowed; use a bullet list',
        },
      };
    }
    if (fb.paths.length === 0) {
      return {
        halt: {
          reason: 'parallel-files-malformed',
          slice_id: candidate.slice_id,
          detail: 'empty Files block (no bullets found)',
        },
      };
    }
    const v = validateFilesPaths(fb.paths);
    if (v.malformed) {
      return {
        halt: {
          reason: 'parallel-files-malformed',
          slice_id: candidate.slice_id,
          detail: v,
        },
      };
    }
    return { ok: true, directive: dir.directive, files: fb.paths };
  }

  return { ok: true, directive: dir.directive, files: null };
}

function detectOverlap(candidates) {
  // Spec §10: "Claude compares exact normalized repo-relative paths across
  // consecutive candidate slices. Any overlap forces serial execution."
  const sets = candidates.map((c) => new Set(c.files || []));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const p of sets[i]) {
        if (sets[j].has(p)) return { overlap: true, path: p, between: [candidates[i].slice_id, candidates[j].slice_id] };
      }
    }
  }
  return { overlap: false };
}

function bootstrapGate(candidate) {
  // Two-tier gate (B.3).
  const b = candidate.bootstrap || {};
  if (!b.tier1_marker_present) {
    return { halt: { reason: 'worktree-bootstrap-failed', slice_id: candidate.slice_id, detail: 'sidecar phases.implement.bootstrap.completed_at missing' } };
  }
  if (!b.tier2_verify_ok) {
    return { halt: { reason: 'worktree-bootstrap-stale', slice_id: candidate.slice_id, detail: 'verifyBootstrap symlink reality check failed' } };
  }
  return { ok: true };
}

function classifyOutcome(outcome) {
  // Map a canned outcome to one of: shipped | fallback-trigger | blocker-halt.
  switch (outcome.kind) {
    case 'shipped':
      return { kind: 'shipped' };
    case 'zero-commits':
      return { kind: 'fallback', reason: 'zero-commits' };
    case 'non-conforming':
      return { kind: 'fallback', reason: 'non-conforming-commits' };
    case 'missing-json':
      return { kind: 'fallback', reason: 'missing-or-malformed-json' };
    case 'dispatch-error':
      return { kind: 'fallback', reason: 'dispatch-error' };
    case 'mcp-error':
      return { kind: 'fallback', reason: 'mcp-error' };
    case 'timeout':
      return { kind: 'fallback', reason: 'timeout' };
    case 'blocked':
      return { kind: 'blocker-halt', status: 'BLOCKED' };
    case 'needs-context':
      return { kind: 'blocker-halt', status: 'NEEDS_CONTEXT' };
    default:
      return { kind: 'shipped' };
  }
}

function blockerHaltReason(implementer, status) {
  if (implementer === 'codex') {
    return status === 'BLOCKED' ? 'codex-blocked' : 'codex-needs-context';
  }
  return status === 'BLOCKED' ? 'subagent-blocked' : 'subagent-needs-context';
}

function agentNameFor(implementer) {
  return implementer === 'codex' ? 'slice-implementer-codex' : 'slice-implementer-sonnet';
}

function fallbackImplementerOf(preferred) {
  return preferred === 'codex' ? 'sonnet' : 'codex';
}

function decideForSlice(candidate) {
  const cl = checklist(candidate);
  if (cl.halt) return { halt: cl.halt };

  // Bootstrap gate before dispatch.
  const bg = bootstrapGate(candidate);
  if (bg.halt) return { halt: bg.halt };

  const preferred = cl.directive;
  const dispatches = [{ slice_id: candidate.slice_id, agent: agentNameFor(preferred), tier: 'preferred' }];

  // Apply preferred outcome.
  const c1 = classifyOutcome(candidate.preferred_outcome || { kind: 'shipped' });
  if (c1.kind === 'blocker-halt') {
    return { halt: { reason: blockerHaltReason(preferred, c1.status), slice_id: candidate.slice_id, detail: `${preferred} reported ${c1.status}` }, dispatches };
  }

  if (c1.kind === 'fallback') {
    const fallback = fallbackImplementerOf(preferred);
    dispatches.push({ slice_id: candidate.slice_id, agent: agentNameFor(fallback), tier: 'fallback', triggered_by: c1.reason });

    // Apply fallback outcome.
    const c2 = classifyOutcome(candidate.fallback_outcome || { kind: 'shipped' });
    if (c2.kind === 'blocker-halt') {
      return { halt: { reason: blockerHaltReason(fallback, c2.status), slice_id: candidate.slice_id, detail: `${fallback} reported ${c2.status}` }, dispatches };
    }
    if (c2.kind === 'fallback') {
      return { halt: { reason: 'implementer-unavailable', slice_id: candidate.slice_id, detail: 'preferred and fallback both failed' }, dispatches };
    }
    // Fallback shipped → continue to integration.
  }

  return { dispatches };
}

function decideIntegration(candidate) {
  // Spec §12 + B.8.
  const io = candidate.integrate_outcome || { kind: 'ok' };
  if (io.kind === 'ok') return { ok: true };
  if (io.kind === 'merge-conflict') return { halt: { reason: 'worktree-merge-conflict', slice_id: candidate.slice_id, detail: io.detail || {} } };
  if (io.kind === 'resume-ambiguous') return { halt: { reason: 'worktree-resume-ambiguous', slice_id: candidate.slice_id, detail: io.detail || {} } };
  if (io.kind === 'integration-empty') return { halt: { reason: 'worktree-integration-empty', slice_id: candidate.slice_id, detail: io.detail || {} } };
  return { ok: true };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    const fixture = JSON.parse(raw);
    const candidates = fixture.candidates || [];

    // 1. Pre-dispatch checklist on every candidate. Any halt in the
    //    candidate window halts before any worktree setup.
    const validated = [];
    for (const cand of candidates) {
      const cl = checklist(cand);
      if (cl.halt) {
        process.stdout.write(JSON.stringify({ halt: cl.halt }, null, 2));
        return;
      }
      validated.push({ ...cand, directive: cl.directive, files: cl.files });
    }

    // 2. Conflict comparison (only meaningful for ≥2 parallel candidates).
    const isMultiParallel = validated.length > 1 && validated.every((c) => c.parallel_candidate);
    let batchKind;
    if (isMultiParallel) {
      const o = detectOverlap(validated);
      batchKind = o.overlap ? 'serial-forced' : 'parallel';
    } else if (validated.length === 1) {
      batchKind = 'single';
    } else {
      // Multiple candidates but at least one is not flagged as parallel —
      // treat as serial-forced (defensive).
      batchKind = 'serial-forced';
    }

    // 3. Bootstrap gate + dispatch + reconcile + routing for each slice in
    //    the batch. For parallel batches, all dispatches go in one logical
    //    "turn" — represented in the output as the dispatches array.
    const allDispatches = [];
    for (const cand of validated) {
      const dec = decideForSlice(cand);
      if (dec.dispatches) allDispatches.push(...dec.dispatches);
      if (dec.halt) {
        process.stdout.write(JSON.stringify({ halt: dec.halt, batch: { kind: batchKind, dispatches: allDispatches } }, null, 2));
        return;
      }
    }

    // 4. Integration step (post-reconcile). Halts surface here.
    for (const cand of validated) {
      const idec = decideIntegration(cand);
      if (idec.halt) {
        process.stdout.write(JSON.stringify({ halt: idec.halt, batch: { kind: batchKind, dispatches: allDispatches } }, null, 2));
        return;
      }
    }

    process.stdout.write(JSON.stringify({ batch: { kind: batchKind, dispatches: allDispatches } }, null, 2));
  });
}

main();
JSEOF

# Helpers ───────────────────────────────────────────────────────────────────
decide() {
  # Pipe a JSON fixture in; returns the decision JSON on stdout.
  node "$DECISION_JS"
}

read_field() {
  # $1 = JSON, $2 = node expression on `d` (parsed JSON).
  echo "$1" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=JSON.parse(s);try{const v=$2;process.stdout.write(typeof v==='undefined'?'':String(v));}catch(e){process.stderr.write(e.message);process.exit(1)}})"
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    echo "  PASS: $3"
    return 0
  fi
  echo "  FAIL ($3): expected '$2', got '$1'" >&2
  exit 1
}

# Common slice section helpers ─────────────────────────────────────────────
SLICE_NO_DIRECTIVE=$'## Slice 3\n- [ ] do work'
SLICE_CODEX=$'## Slice 3\n**Implementer:** codex\n\n- [ ] do work'
SLICE_SONNET=$'## Slice 3\n**Implementer:** sonnet\n\n- [ ] do work'
SLICE_AUTO=$'## Slice 3\n**Implementer:** auto\n\n- [ ] do work'
SLICE_MIXED=$'## Slice 3\n**Implementer:** Codex\n\n- [ ] do work'
SLICE_EMPTY=$'## Slice 3\n**Implementer:**\n\n- [ ] do work'

SLICE_PARALLEL_3=$'## Slice 3\n**Implementer:** codex\n\n**Files:**\n- lib/codex-bridge/foo.js\n- tests/codex-bridge/foo.test.js\n\n- [ ] do work'
SLICE_PARALLEL_4=$'## Slice 4\n**Implementer:** sonnet\n\n**Files:**\n- lib/codex-bridge/bar.js\n- tests/codex-bridge/bar.test.js\n\n- [ ] do work'
SLICE_PARALLEL_4_OVERLAP=$'## Slice 4\n**Implementer:** sonnet\n\n**Files:**\n- lib/codex-bridge/foo.js\n- tests/codex-bridge/bar.test.js\n\n- [ ] do work'
SLICE_PARALLEL_NO_FILES=$'## Slice 4\n**Implementer:** codex\n\n- [ ] do work'
SLICE_PARALLEL_INLINE_FILES=$'## Slice 4\n**Implementer:** codex\n\n**Files:** lib/foo.js\n\n- [ ] do work'

OK_BOOTSTRAP='{"tier1_marker_present":true,"tier2_verify_ok":true}'

# ---------------------------------------------------------------------------
# Path 1: default-codex (no directive) → invokes slice-implementer-codex
# ---------------------------------------------------------------------------
echo "[path 1] default-codex (no directive)"
FIX=$(jq -n --arg s "$SLICE_NO_DIRECTIVE" --argjson b "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$b,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[0].agent')" "slice-implementer-codex" "default-codex routes to codex implementer"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[0].tier')" "preferred" "default-codex uses preferred tier"
assert_eq "$(read_field "$OUT" 'd.batch.kind')" "single" "default-codex uses single-slice batch"
assert_eq "$(read_field "$OUT" 'd.halt||""')" "" "default-codex does not halt"

# ---------------------------------------------------------------------------
# Path 2: explicit sonnet → invokes slice-implementer-sonnet
# ---------------------------------------------------------------------------
echo "[path 2] explicit sonnet"
FIX=$(jq -n --arg s "$SLICE_SONNET" --argjson b "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$b,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[0].agent')" "slice-implementer-sonnet" "explicit sonnet routes to sonnet implementer"

# ---------------------------------------------------------------------------
# Path 3: malformed `auto` → halts implementer-directive-malformed BEFORE worktree
# ---------------------------------------------------------------------------
echo "[path 3] malformed auto"
FIX=$(jq -n --arg s "$SLICE_AUTO" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false},preferred_outcome:{kind:"shipped"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "implementer-directive-malformed" "auto halts directive-malformed"
assert_eq "$(read_field "$OUT" 'd.batch||""')" "" "auto halt before any dispatch (no batch in output)"

# ---------------------------------------------------------------------------
# Path 4: mixed-case `Codex` → halts implementer-directive-malformed
# ---------------------------------------------------------------------------
echo "[path 4] mixed-case Codex"
FIX=$(jq -n --arg s "$SLICE_MIXED" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false},preferred_outcome:{kind:"shipped"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "implementer-directive-malformed" "mixed-case Codex halts directive-malformed"

# ---------------------------------------------------------------------------
# Path 5: empty value → halts implementer-directive-malformed
# ---------------------------------------------------------------------------
echo "[path 5] empty implementer value"
FIX=$(jq -n --arg s "$SLICE_EMPTY" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false},preferred_outcome:{kind:"shipped"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "implementer-directive-malformed" "empty implementer halts directive-malformed"

# ---------------------------------------------------------------------------
# Path 6: parallel candidate missing Files block → halts parallel-files-missing
# ---------------------------------------------------------------------------
echo "[path 6] parallel candidate missing Files"
FIX=$(jq -n --arg a "$SLICE_PARALLEL_3" --arg b "$SLICE_PARALLEL_NO_FILES" '{
  candidates:[
    {slice_id:"slice-3",section:$a,parallel_candidate:true,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false}},
    {slice_id:"slice-4",section:$b,parallel_candidate:true,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false}}
  ]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "parallel-files-missing" "parallel missing Files halts"
assert_eq "$(read_field "$OUT" 'd.halt.slice_id')" "slice-4" "parallel-files-missing cites the offending slice"
assert_eq "$(read_field "$OUT" 'd.batch||""')" "" "parallel-files-missing halt before any worktree setup"

# ---------------------------------------------------------------------------
# Path 7: parallel candidate inline-form Files → halts parallel-files-malformed
# ---------------------------------------------------------------------------
echo "[path 7] parallel candidate inline Files form"
FIX=$(jq -n --arg a "$SLICE_PARALLEL_3" --arg b "$SLICE_PARALLEL_INLINE_FILES" '{
  candidates:[
    {slice_id:"slice-3",section:$a,parallel_candidate:true,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false}},
    {slice_id:"slice-4",section:$b,parallel_candidate:true,bootstrap:{"tier1_marker_present":false,"tier2_verify_ok":false}}
  ]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "parallel-files-malformed" "parallel inline Files halts malformed"
assert_eq "$(read_field "$OUT" 'd.halt.slice_id')" "slice-4" "parallel-files-malformed cites the offending slice"

# ---------------------------------------------------------------------------
# Path 8: Files overlap → forces serial dispatch
# ---------------------------------------------------------------------------
echo "[path 8] Files overlap forces serial"
FIX=$(jq -n --arg a "$SLICE_PARALLEL_3" --arg b "$SLICE_PARALLEL_4_OVERLAP" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[
    {slice_id:"slice-3",section:$a,parallel_candidate:true,bootstrap:$bs,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}},
    {slice_id:"slice-4",section:$b,parallel_candidate:true,bootstrap:$bs,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}}
  ]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.kind')" "serial-forced" "overlapping Files forces serial-forced"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "2" "serial-forced still produces 2 dispatches (one per slice)"

# ---------------------------------------------------------------------------
# Path 9: Files non-overlap → parallel batch with both dispatches in one turn
# ---------------------------------------------------------------------------
echo "[path 9] Files non-overlap dispatches in parallel (single turn)"
FIX=$(jq -n --arg a "$SLICE_PARALLEL_3" --arg b "$SLICE_PARALLEL_4" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[
    {slice_id:"slice-3",section:$a,parallel_candidate:true,bootstrap:$bs,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}},
    {slice_id:"slice-4",section:$b,parallel_candidate:true,bootstrap:$bs,preferred_outcome:{kind:"shipped"},integrate_outcome:{kind:"ok"}}
  ]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.kind')" "parallel" "non-overlap forms a parallel batch"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "2" "parallel batch contains 2 dispatches"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[0].agent')" "slice-implementer-codex" "slice-3 dispatched as codex"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[1].agent')" "slice-implementer-sonnet" "slice-4 dispatched as sonnet (mixed parallel batch allowed)"

# ---------------------------------------------------------------------------
# Path 10: zero-commits fallback (mock reconciler returns commit_count:0)
# ---------------------------------------------------------------------------
echo "[path 10] zero-commits triggers fallback"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"zero-commits",commit_count:0,head_sha:"abc",non_conforming_subjects:[]},
    fallback_outcome:{kind:"shipped"},
    integrate_outcome:{kind:"ok"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "2" "zero-commits triggers a second (fallback) dispatch"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[0].tier')" "preferred" "zero-commits: first dispatch is preferred"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[1].tier')" "fallback" "zero-commits: second dispatch is fallback"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[1].agent')" "slice-implementer-sonnet" "zero-commits: codex preferred → sonnet fallback"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[1].triggered_by')" "zero-commits" "zero-commits trigger surfaces in dispatch record"
assert_eq "$(read_field "$OUT" 'd.halt||""')" "" "zero-commits fallback ships → no halt"

# ---------------------------------------------------------------------------
# Path 11: non-conforming-commit fallback
# ---------------------------------------------------------------------------
echo "[path 11] non-conforming-commit triggers fallback"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"non-conforming",commit_count:1,head_sha:"abc",
      non_conforming_subjects:[{sha:"abc",subject:"random subject",reason:"wrong-format"}]},
    fallback_outcome:{kind:"shipped"},
    integrate_outcome:{kind:"ok"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "2" "non-conforming triggers fallback dispatch"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches[1].triggered_by')" "non-conforming-commits" "non-conforming-commits trigger recorded"

# ---------------------------------------------------------------------------
# Path 12: BLOCKED halts without fallback (codex preferred → codex-blocked)
# ---------------------------------------------------------------------------
echo "[path 12] BLOCKED halts without fallback (codex)"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"blocked"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "codex-blocked" "BLOCKED from codex → codex-blocked"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "1" "BLOCKED halt records only the one (preferred) dispatch — no fallback"

# Path 12b: NEEDS_CONTEXT halts without fallback (sonnet preferred → subagent-needs-context)
echo "[path 12b] NEEDS_CONTEXT halts without fallback (sonnet)"
FIX=$(jq -n --arg s "$SLICE_SONNET" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"needs-context"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "subagent-needs-context" "NEEDS_CONTEXT from sonnet → subagent-needs-context"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "1" "NEEDS_CONTEXT halt no fallback dispatch"

# ---------------------------------------------------------------------------
# Path 13: bootstrap missing (Tier 1 fails) → halts worktree-bootstrap-failed
# ---------------------------------------------------------------------------
echo "[path 13] Tier 1 bootstrap missing"
FIX=$(jq -n --arg s "$SLICE_CODEX" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,
    bootstrap:{tier1_marker_present:false,tier2_verify_ok:true},
    preferred_outcome:{kind:"shipped"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "worktree-bootstrap-failed" "Tier 1 missing → worktree-bootstrap-failed"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "0" "bootstrap-failed: no dispatch occurred"

# ---------------------------------------------------------------------------
# Path 14: bootstrap stale (Tier 2 fails) → halts worktree-bootstrap-stale
# ---------------------------------------------------------------------------
echo "[path 14] Tier 2 verifyBootstrap fails"
FIX=$(jq -n --arg s "$SLICE_CODEX" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,
    bootstrap:{tier1_marker_present:true,tier2_verify_ok:false},
    preferred_outcome:{kind:"shipped"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "worktree-bootstrap-stale" "Tier 2 fail → worktree-bootstrap-stale"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "0" "bootstrap-stale: no dispatch occurred"

# ---------------------------------------------------------------------------
# Path 15: cherry-pick conflict halts worktree-merge-conflict
# ---------------------------------------------------------------------------
echo "[path 15] cherry-pick conflict halts"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"shipped",commit_count:2,head_sha:"def",non_conforming_subjects:[]},
    integrate_outcome:{kind:"merge-conflict",detail:{conflicting_paths:["lib/foo.js"]}}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "worktree-merge-conflict" "cherry-pick conflict → worktree-merge-conflict"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "1" "merge-conflict surfaces post-dispatch (1 dispatch happened first)"

# ---------------------------------------------------------------------------
# Path 16: resume-ambiguous halts worktree-resume-ambiguous
# ---------------------------------------------------------------------------
echo "[path 16] resume-ambiguous halts"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"shipped",commit_count:2,head_sha:"def",non_conforming_subjects:[]},
    integrate_outcome:{kind:"resume-ambiguous",detail:{integrated_subjects:["foo"],missing_subjects:["bar"]}}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "worktree-resume-ambiguous" "resume-ambiguous → worktree-resume-ambiguous"

# ---------------------------------------------------------------------------
# Path 17: implementer-unavailable when both preferred and fallback fail
# ---------------------------------------------------------------------------
echo "[path 17] both implementers fail → implementer-unavailable"
FIX=$(jq -n --arg s "$SLICE_CODEX" --argjson bs "$OK_BOOTSTRAP" '{
  candidates:[{slice_id:"slice-3",section:$s,parallel_candidate:false,bootstrap:$bs,
    preferred_outcome:{kind:"zero-commits"},
    fallback_outcome:{kind:"dispatch-error"}}]
}')
OUT=$(echo "$FIX" | decide)
assert_eq "$(read_field "$OUT" 'd.halt.reason')" "implementer-unavailable" "both fail → implementer-unavailable"
assert_eq "$(read_field "$OUT" 'd.batch.dispatches.length')" "2" "implementer-unavailable records both attempts"

# ---------------------------------------------------------------------------
# Real-fixture sanity: verify reconciler module agrees with our canned
# zero-commits / non-conforming outcomes when fed an actual git repo. This
# pins the "reconciler is truth" contract end-to-end on a tiny fixture.
# ---------------------------------------------------------------------------
echo "[real-fixture] reconciler returns canned-shape outcomes against real git"
FIXREPO="$SMOKE/fixrepo"
mkdir -p "$FIXREPO"
cd "$FIXREPO"
git init -q -b main
git config user.email smoke@t
git config user.name smoke
echo seed > seed.txt
git add seed.txt
git commit -qm "chore(slice:1): seed"
START_SHA=$(git rev-parse HEAD)

# Zero-commits case: reconcileWorktree on HEAD == sliceStartSha returns commit_count=0.
ZERO=$(node -e "
import('$PLUGIN_ROOT/lib/codex-bridge/reconciler.js').then(m=>{
  const r=m.reconcileWorktree({worktreePath:'$FIXREPO',sliceStartSha:'$START_SHA',sliceId:'slice-3'});
  process.stdout.write(JSON.stringify(r));
});
")
assert_eq "$(echo "$ZERO" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=JSON.parse(s);process.stdout.write(String(d.commit_count))})")" "0" "reconciler agrees: empty range → commit_count=0 (zero-commits trigger source)"

# Non-conforming case: add a commit with a wrong-slice subject; reconciler must mark it non-conforming.
echo bad > bad.txt
git add bad.txt
git commit -qm "feat(slice:9): wrong slice number"
NONCONF=$(node -e "
import('$PLUGIN_ROOT/lib/codex-bridge/reconciler.js').then(m=>{
  const r=m.reconcileWorktree({worktreePath:'$FIXREPO',sliceStartSha:'$START_SHA',sliceId:'slice-3'});
  process.stdout.write(JSON.stringify(r));
});
")
NC_LEN=$(echo "$NONCONF" | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=JSON.parse(s);process.stdout.write(String(d.non_conforming_subjects.length))})")
assert_eq "$NC_LEN" "1" "reconciler agrees: wrong-slice-number → 1 non-conforming subject (non-conforming-commits trigger source)"

cd "$SMOKE"
echo
echo "PASS: phase-b-routing-structural.sh — 17 paths green (12+12b separately, plus reconciler-truth fixture)"
