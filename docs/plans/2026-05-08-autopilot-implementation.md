# Autopilot v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` until slice 5 ships; afterward, you can use `codex-paired-superpowers:subagent-driven-development` (the forked version) for the remaining slices to dogfood. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Implement the v0.3.0 autopilot — a multi-tier loop that runs an entire implementation plan slice-by-slice unattended, with crash-safe cross-session resume via ralph-loop.

**Architecture:** Per slice, four phases (`plan-slice + test-list review`, `implement`, `review-slice`, `docs-update`), each with its own 7-round Claude↔Codex budget. State persists in the sidecar's nested `slice_reviews[slice-N].phases[*]` blocks plus an `autopilot` block. A `.codex-paired/active.json` anchor at the repo root tells the provenance hook which sidecar to consult. All autopilot-owned commits follow the Commit Conventions (`<type>(slice:N):` subject + `Co-Authored-By: Claude` trailer). Cross-session recovery walks `last_commit_sha..HEAD` and verifies every commit against those conventions.

**Tech Stack:** Node.js 20+ (existing bridge code; zero npm deps), bash (provenance hook), Markdown (skills, command, system rubric). No new runtime dependencies.

**Spec:** `docs/specs/2026-05-08-autopilot-design.md` (double-SHIP'd in 6 rounds, sidecar at `docs/specs/2026-05-08-autopilot-design.md.codex.json`).

---

## File Structure

```
codex-paired-superpowers/
├── lib/codex-bridge/
│   ├── sidecar.js                    # MODIFY: nested phases + autopilot block + atomic writes
│   ├── cli.js                        # MODIFY: + sidecar-set-phase, sidecar-set-autopilot, anchor-* subcommands
│   ├── active-anchor.js              # CREATE: write/read/clear .codex-paired/active.json
│   └── prompts/
│       └── system-rubric.md          # MODIFY: append pre-SHIP checklist
├── skills/
│   └── autopilot/
│       ├── SKILL.md                  # CREATE: orchestrator instructions
│       └── codex-via-subagent-prompt.md  # CREATE: background subagent template
├── hooks/
│   ├── hooks.json                    # CREATE: hook registration
│   └── check-commit-provenance.sh    # CREATE: provenance hook script
├── commands/
│   └── autopilot.md                  # CREATE: /autopilot slash command (optional convenience)
├── tests/codex-bridge/
│   ├── sidecar.test.js               # MODIFY: add nested-phase + autopilot-block tests
│   ├── active-anchor.test.js         # CREATE
│   └── fixtures/                     # CREATE if missing: git fixture for hook tests
├── tests/hooks/
│   └── check-commit-provenance.test.sh   # CREATE: bash test harness
├── README.md                         # MODIFY: autopilot section + changelog
├── package.json                      # MODIFY: bump 0.2.0 → 0.3.0
└── .claude-plugin/
    └── plugin.json                   # MODIFY: bump 0.2.0 → 0.3.0
```

Plus marketplace bump: `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json`.

---

## Slicing

Seven slices. Dependencies sequential (later slices reference earlier code).

| # | Slice | What ships |
|---|---|---|
| 1 | Sidecar enrichments + system rubric pre-SHIP checklist | Sidecar can hold nested phase state + autopilot block; atomic writes; rubric forces Codex to apply pre-SHIP checklist |
| 2 | Active anchor module | `.codex-paired/active.json` write/read/clear with CLI subcommands |
| 3 | Provenance hook | Hook + tests with mocked git; rejects non-conforming commits during active autopilot |
| 4 | Codex-via-subagent prompt template | Template + smoke test (background MCP call returns parsed verdict) |
| 5 | Autopilot SKILL.md | Orchestrator instructions; manual smoke against a synthetic 1-slice plan |
| 6 | `/autopilot` slash command | Convenience wrapper to launch autopilot from anywhere |
| 7 | Release: README + CHANGELOG + v0.3.0 tag | Plugin shipped |

Each slice is independently testable. Slice 5's "manual smoke" is the integration gate.

---

## Slice 1: Sidecar enrichments + pre-SHIP checklist

Bundles three small additions: rubric edit, sidecar phase nesting, and CLI subcommands for the new sidecar fields. They share the new data structure.

**Files:**
- Modify: `lib/codex-bridge/prompts/system-rubric.md`
- Modify: `lib/codex-bridge/sidecar.js`
- Modify: `lib/codex-bridge/cli.js`
- Modify: `tests/codex-bridge/sidecar.test.js`

### Step 1: Append pre-SHIP checklist to system-rubric.md

- [ ] **Step 1a: Edit `lib/codex-bridge/prompts/system-rubric.md`** — append at the end of the file (after the existing "Question routing" section):

```markdown

### Pre-SHIP checklist (do this every time before emitting status: SHIP)
Internally answer all three. If you cannot answer any with specifics, you are not at SHIP — emit REVISE.

1. **Strongest critique a senior engineer could make of this artifact?** (If your answer is "none", look harder.)
2. **What edge case or failure mode did this artifact gloss over?** (Empty input. Concurrent access. Failure of a dependency. Adversarial input. Scale.)
3. **What test, if it existed, would actually fail because of an assumption being made?** (If no test could fail, the artifact has no testable claims — that's a problem.)

In your verdict's `rationale` line, even on SHIP, briefly note your strongest residual concern. SHIP doesn't mean "perfect"; it means "no required changes before progress." Residual concerns belong in `rationale`, not in `critique`.
```

### Step 2: Write failing tests for sidecar phase nesting + autopilot block

- [ ] **Step 2a: Append to `tests/codex-bridge/sidecar.test.js`** — add at the end of the file:

```js
import { setPhase, setAutopilot, getAutopilot } from '../../lib/codex-bridge/sidecar.js';

test('setPhase records nested phase state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setPhase(spec, 'slice-1', 'plan-slice', { rounds: [{ round: 1, claude: 'SHIP', codex: 'SHIP' }], shipped: true });
  setPhase(spec, 'slice-1', 'implement', { subagent_status: 'DONE', commits: ['abc'] });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].phases['plan-slice'].shipped, true);
  assert.equal(sc.slice_reviews['slice-1'].phases.implement.subagent_status, 'DONE');
  rmSync(dir, { recursive: true, force: true });
});

test('setAutopilot writes the autopilot block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setAutopilot(spec, {
    started_at: '2026-05-08T00:00:00Z',
    last_tick_at: '2026-05-08T00:01:00Z',
    current_slice: '3',
    current_phase: 'review-slice',
    phase_attempt: 1,
    phase_started_at: '2026-05-08T00:00:30Z',
    slice_start_sha: 'abc123',
    phase_start_sha: 'def456',
    last_commit_sha: 'def456',
    inflight_subagent_id: null,
    halt_reason: null,
  });
  const ap = getAutopilot(spec);
  assert.equal(ap.current_slice, '3');
  assert.equal(ap.phase_start_sha, 'def456');
  rmSync(dir, { recursive: true, force: true });
});

test('getAutopilot returns null when block missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  assert.equal(getAutopilot(spec), null);
  rmSync(dir, { recursive: true, force: true });
});

test('sliceIdToNumber converts slice-N to N', async () => {
  const { sliceIdToNumber } = await import('../../lib/codex-bridge/sidecar.js');
  assert.equal(sliceIdToNumber('slice-3'), '3');
  assert.equal(sliceIdToNumber('slice-10'), '10');
  assert.equal(sliceIdToNumber('slice-0'), '0');
});

test('sliceIdToNumber throws on invalid input', async () => {
  const { sliceIdToNumber } = await import('../../lib/codex-bridge/sidecar.js');
  assert.throws(() => sliceIdToNumber('slice'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('slice-'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('slice-abc'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('3'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber(''), /invalid slice key/);
});

test('sliceIdToDisplayName converts N to slice-N', async () => {
  const { sliceIdToDisplayName } = await import('../../lib/codex-bridge/sidecar.js');
  assert.equal(sliceIdToDisplayName('3'), 'slice-3');
  assert.equal(sliceIdToDisplayName('10'), 'slice-10');
  assert.equal(sliceIdToDisplayName(7), 'slice-7'); // accepts numbers via String()
});

test('sliceIdToDisplayName throws on non-numeric input', async () => {
  const { sliceIdToDisplayName } = await import('../../lib/codex-bridge/sidecar.js');
  assert.throws(() => sliceIdToDisplayName('abc'), /invalid slice number/);
  assert.throws(() => sliceIdToDisplayName('slice-3'), /invalid slice number/);
  assert.throws(() => sliceIdToDisplayName(''), /invalid slice number/);
});

test('setAutopilot is atomic (temp file + rename)', () => {
  // Verify by writing repeatedly under load — the file should never be observed empty/partial.
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  for (let i = 0; i < 50; i++) {
    setAutopilot(spec, { current_slice: String(i), current_phase: 'implement' });
    const sc = loadSidecar(spec);
    assert.equal(sc.autopilot.current_slice, String(i));
  }
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2b: Run tests — confirm fail**

Run: `cd /Users/mkr/local-coding/plugins/codex-paired-superpowers && npm test 2>&1 | tail -10`
Expected: the new tests fail with "is not a function" or "Cannot find module" (functions don't exist yet). The exact failure count is the number of new tests you added in step 2a — count those, not a hard-coded number.

### Step 3: Implement sidecar additions

- [ ] **Step 3a: Edit `lib/codex-bridge/sidecar.js`** — add the new exports and switch all writers to atomic temp-file + rename. Replace the existing `saveSidecar` function and add three new exports. The full new content of the file should be:

```js
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

export function sidecarPathFor(specPath) {
  return `${specPath}.codex.json`;
}

export function initSidecar(specPath, { feature, codexSession, model, reasoningEffort }) {
  const data = {
    version: 1,
    feature,
    codex_session: codexSession,
    model,
    reasoning_effort: reasoningEffort,
    created_at: new Date().toISOString(),
    rounds: [],
    open_contentions: [],
    slice_reviews: {},
  };
  saveSidecar(specPath, data);
  return data;
}

export function loadSidecar(specPath) {
  return JSON.parse(readFileSync(sidecarPathFor(specPath), 'utf8'));
}

function saveSidecar(specPath, data) {
  // Atomic write: write to temp file, then rename (POSIX rename is atomic within same filesystem).
  const target = sidecarPathFor(specPath);
  const tmp = join(dirname(target), `.${basename(target)}.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, target);
}

export function appendRound(specPath, round) {
  const sc = loadSidecar(specPath);
  sc.rounds.push(round);
  saveSidecar(specPath, sc);
}

export function setSlice(specPath, sliceId, sliceState) {
  const sc = loadSidecar(specPath);
  sc.slice_reviews[sliceId] = sliceState;
  saveSidecar(specPath, sc);
}

export function setPhase(specPath, sliceId, phaseName, phaseState) {
  const sc = loadSidecar(specPath);
  if (!sc.slice_reviews[sliceId]) sc.slice_reviews[sliceId] = { phases: {} };
  if (!sc.slice_reviews[sliceId].phases) sc.slice_reviews[sliceId].phases = {};
  sc.slice_reviews[sliceId].phases[phaseName] = phaseState;
  saveSidecar(specPath, sc);
}

export function setAutopilot(specPath, autopilotBlock) {
  const sc = loadSidecar(specPath);
  sc.autopilot = autopilotBlock;
  saveSidecar(specPath, sc);
}

export function getAutopilot(specPath) {
  const sc = loadSidecar(specPath);
  return sc.autopilot ?? null;
}

export function addOpenContention(specPath, contention) {
  const sc = loadSidecar(specPath);
  sc.open_contentions.push(contention);
  saveSidecar(specPath, sc);
}

// Slice-id converters. The sidecar stores slice keys in the human-readable form
// (`slice-3`) while commits and the autopilot block use the numeric form (`3`).
// These helpers keep the conversion in one place — the spec mandates them.
export function sliceIdToNumber(sliceKey) {
  // "slice-3" → "3"
  const m = String(sliceKey).match(/^slice-(\d+)$/);
  if (!m) throw new Error(`invalid slice key: ${sliceKey}`);
  return m[1];
}

export function sliceIdToDisplayName(sliceNumber) {
  // "3" → "slice-3"
  const n = String(sliceNumber);
  if (!/^\d+$/.test(n)) throw new Error(`invalid slice number: ${sliceNumber}`);
  return `slice-${n}`;
}
```

- [ ] **Step 3b: Run tests — confirm all 10 sidecar tests pass**

Run: `npm test 2>&1 | tail -10`
Expected: all tests pass — every previously-passing test still passes, plus all new sidecar tests added in step 2 (the four phase/autopilot tests plus the five slice-id converter tests). Don't rely on a specific pass count; the count drifts as the plan evolves. Read the test runner's "fail 0" line as the gate.

### Step 4: Add CLI subcommands for new sidecar fields

- [ ] **Step 4a: Edit `lib/codex-bridge/cli.js`** — add to the `import` line and to the `subcommands` object. The full updated content:

```js
#!/usr/bin/env node
// Bridge CLI for codex-paired-superpowers.
// As of v0.2.0, Codex itself is invoked via the bundled MCP server
// (mcp__plugin_codex-paired-superpowers_codex__codex / codex-reply).
// This CLI is responsible only for the per-feature sidecar JSON and
// (as of v0.3.0) for the active-run anchor file used by the provenance hook.
import {
  initSidecar,
  loadSidecar,
  appendRound,
  setSlice,
  setPhase,
  setAutopilot,
  getAutopilot,
  addOpenContention,
  sidecarPathFor,
} from './sidecar.js';

const [, , subcmd, ...rest] = process.argv;

const subcommands = {
  'sidecar-init'({ specPath, feature, threadId, model, reasoning }) {
    const sc = initSidecar(specPath, {
      feature,
      codexSession: threadId,
      model: model || 'gpt-5.5',
      reasoningEffort: reasoning || 'high',
    });
    process.stdout.write(JSON.stringify(sc, null, 2));
  },
  'sidecar-path'({ specPath }) {
    process.stdout.write(sidecarPathFor(specPath));
  },
  'sidecar-show'({ specPath }) {
    process.stdout.write(JSON.stringify(loadSidecar(specPath), null, 2));
  },
  'sidecar-thread-id'({ specPath }) {
    process.stdout.write(loadSidecar(specPath).codex_session);
  },
  'sidecar-append-round'({ specPath, round }) {
    appendRound(specPath, JSON.parse(round));
  },
  'sidecar-set-slice'({ specPath, sliceId, state }) {
    setSlice(specPath, sliceId, JSON.parse(state));
  },
  'sidecar-set-phase'({ specPath, sliceId, phase, state }) {
    setPhase(specPath, sliceId, phase, JSON.parse(state));
  },
  'sidecar-set-autopilot'({ specPath, block }) {
    setAutopilot(specPath, JSON.parse(block));
  },
  'sidecar-get-autopilot'({ specPath }) {
    const ap = getAutopilot(specPath);
    process.stdout.write(ap ? JSON.stringify(ap, null, 2) : '');
  },
  'sidecar-add-contention'({ specPath, contention }) {
    addOpenContention(specPath, JSON.parse(contention));
  },
};

function parseArgs(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i += 2) {
    out[rest[i].replace(/^--/, '')] = rest[i + 1];
  }
  return out;
}

const fn = subcommands[subcmd];
if (!fn) {
  console.error(`unknown subcommand: ${subcmd}`);
  console.error(`available: ${Object.keys(subcommands).join(', ')}`);
  process.exit(2);
}
Promise.resolve(fn(parseArgs(rest))).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

- [ ] **Step 4b: Smoke-test new CLI subcommands**

Run:
```bash
mkdir -p /tmp/cps-s1-smoke && echo '# spec' > /tmp/cps-s1-smoke/spec.md
PLUGIN=/Users/mkr/local-coding/plugins/codex-paired-superpowers
node $PLUGIN/lib/codex-bridge/cli.js sidecar-init --specPath /tmp/cps-s1-smoke/spec.md --feature smoke --threadId tid-1
node $PLUGIN/lib/codex-bridge/cli.js sidecar-set-phase --specPath /tmp/cps-s1-smoke/spec.md --sliceId slice-1 --phase plan-slice --state '{"shipped":true,"rounds":[]}'
node $PLUGIN/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath /tmp/cps-s1-smoke/spec.md --block '{"current_slice":"1","current_phase":"plan-slice","halt_reason":null}'
node $PLUGIN/lib/codex-bridge/cli.js sidecar-get-autopilot --specPath /tmp/cps-s1-smoke/spec.md
node $PLUGIN/lib/codex-bridge/cli.js sidecar-show --specPath /tmp/cps-s1-smoke/spec.md
```

Expected: each command succeeds; final `sidecar-show` reflects all three additions.

### Step 5: Commit

- [ ] **Step 5a: Commit**

```bash
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
git add lib/codex-bridge/{sidecar.js,cli.js} lib/codex-bridge/prompts/system-rubric.md tests/codex-bridge/sidecar.test.js
git commit -m "feat(slice:1): pre-SHIP checklist + sidecar nested phases + autopilot block

- system-rubric.md: append pre-SHIP checklist (3-question gate before SHIP)
- sidecar.js: setPhase, setAutopilot, getAutopilot exports; atomic writes
  via temp-file + rename
- cli.js: sidecar-set-phase, sidecar-set-autopilot, sidecar-get-autopilot
  subcommands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 2: Active anchor module

Provides the `<repo-root>/.codex-paired/active.json` lifecycle: write on autopilot start, read by hook, clear on halt/completion.

**Files:**
- Create: `lib/codex-bridge/active-anchor.js`
- Create: `tests/codex-bridge/active-anchor.test.js`
- Modify: `lib/codex-bridge/cli.js` (add `anchor-write`, `anchor-read`, `anchor-clear` subcommands)

### Step 1: Write failing tests

- [ ] **Step 1a: Create `tests/codex-bridge/active-anchor.test.js`** with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAnchor, readAnchor, clearAnchor, anchorPathFor } from '../../lib/codex-bridge/active-anchor.js';

test('writeAnchor creates .codex-paired/active.json with specPath', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  writeAnchor(repo, '/abs/path/to/spec.md');
  const data = readAnchor(repo);
  assert.equal(data.specPath, '/abs/path/to/spec.md');
  rmSync(repo, { recursive: true, force: true });
});

test('readAnchor returns null when anchor absent', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  assert.equal(readAnchor(repo), null);
  rmSync(repo, { recursive: true, force: true });
});

test('clearAnchor removes the anchor file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  writeAnchor(repo, '/x/y.md');
  clearAnchor(repo);
  assert.equal(readAnchor(repo), null);
  assert.equal(existsSync(anchorPathFor(repo)), false);
  rmSync(repo, { recursive: true, force: true });
});

test('clearAnchor is idempotent (no error if absent)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-anchor-'));
  clearAnchor(repo); // anchor never existed
  rmSync(repo, { recursive: true, force: true });
});

test('anchorPathFor returns repo-root/.codex-paired/active.json', () => {
  assert.equal(anchorPathFor('/repo'), '/repo/.codex-paired/active.json');
});
```

- [ ] **Step 1b: Run tests — confirm fail**

Run: `npm test 2>&1 | tail -15`
Expected: the new active-anchor tests fail with "Cannot find module".

### Step 2: Implement the module

- [ ] **Step 2a: Create `lib/codex-bridge/active-anchor.js`**:

```js
// Manages the active-autopilot-run anchor at <repo-root>/.codex-paired/active.json.
// The autopilot writes this file when starting a run (containing the spec path),
// removes it on halt/completion. The provenance hook reads it to know which
// sidecar to consult.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function anchorPathFor(repoRoot) {
  return join(repoRoot, '.codex-paired', 'active.json');
}

export function writeAnchor(repoRoot, specPath) {
  const target = anchorPathFor(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ specPath }, null, 2));
}

export function readAnchor(repoRoot) {
  const target = anchorPathFor(repoRoot);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, 'utf8'));
}

export function clearAnchor(repoRoot) {
  const target = anchorPathFor(repoRoot);
  if (existsSync(target)) rmSync(target);
}
```

- [ ] **Step 2b: Run tests — confirm pass**

Run: `npm test 2>&1 | tail -10`
Expected: all active-anchor tests pass; the runner shows `fail 0`.

### Step 3: Add CLI subcommands

- [ ] **Step 3a: Modify `lib/codex-bridge/cli.js`** — add the import and three subcommands. Update the import block:

```js
import { writeAnchor, readAnchor, clearAnchor } from './active-anchor.js';
```

Add inside the `subcommands` object:

```js
'anchor-write'({ repoRoot, specPath }) {
  writeAnchor(repoRoot, specPath);
},
'anchor-read'({ repoRoot }) {
  const a = readAnchor(repoRoot);
  process.stdout.write(a ? JSON.stringify(a) : '');
},
'anchor-clear'({ repoRoot }) {
  clearAnchor(repoRoot);
},
```

- [ ] **Step 3b: Smoke-test the CLI subcommands**

```bash
PLUGIN=/Users/mkr/local-coding/plugins/codex-paired-superpowers
TMPREPO=$(mktemp -d)
node $PLUGIN/lib/codex-bridge/cli.js anchor-write --repoRoot "$TMPREPO" --specPath /x/y.md
node $PLUGIN/lib/codex-bridge/cli.js anchor-read --repoRoot "$TMPREPO"
node $PLUGIN/lib/codex-bridge/cli.js anchor-clear --repoRoot "$TMPREPO"
node $PLUGIN/lib/codex-bridge/cli.js anchor-read --repoRoot "$TMPREPO"
rm -rf "$TMPREPO"
```

Expected: write succeeds (no output), read prints `{"specPath":"/x/y.md"}`, clear succeeds, second read prints empty.

### Step 4: Add `.codex-paired/` to .gitignore

- [ ] **Step 4a: Edit `.gitignore`** — append:

```
# autopilot active-run anchor (transient)
.codex-paired/
```

### Step 5: Commit

- [ ] **Step 5a: Commit**

```bash
git add lib/codex-bridge/active-anchor.js lib/codex-bridge/cli.js tests/codex-bridge/active-anchor.test.js .gitignore
git commit -m "feat(slice:2): active-run anchor module + CLI subcommands

- active-anchor.js: writeAnchor / readAnchor / clearAnchor for
  <repo-root>/.codex-paired/active.json lifecycle
- cli.js: anchor-write / anchor-read / anchor-clear subcommands
- .gitignore: ignore .codex-paired/ (transient state)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 3: Provenance hook

The hook runs on `Bash(git commit:*)` PostToolUse, reads the anchor + sidecar, and rejects commits during an active autopilot run that don't follow the Commit Conventions.

**Files:**
- Create: `hooks/check-commit-provenance.sh`
- Create: `hooks/hooks.json`
- Create: `tests/hooks/check-commit-provenance.test.sh`

### Step 1: Write the hook tests first

- [ ] **Step 1a: Create `tests/hooks/check-commit-provenance.test.sh`**:

```bash
#!/usr/bin/env bash
# Test harness for hooks/check-commit-provenance.sh.
# Builds throwaway git repos, simulates the hook env, asserts exit codes.
set -euo pipefail
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="$PLUGIN_ROOT/hooks/check-commit-provenance.sh"

pass=0
fail=0

run_case() {
  local name="$1"
  local setup="$2"
  local expected="$3"  # 0 = allow, 1 = block

  local repo
  repo=$(mktemp -d)
  (
    cd "$repo"
    git init -q -b main
    git config user.email t@t.test
    git config user.name t
    eval "$setup"
  )
  set +e
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$HOOK"
  local rc=$?
  set -e
  rm -rf "$repo"
  if [ "$rc" -eq "$expected" ]; then
    pass=$((pass+1))
    echo "PASS: $name"
  else
    fail=$((fail+1))
    echo "FAIL: $name (got rc=$rc, expected $expected)"
  fi
}

# --- cases ---

run_case "no anchor file: allow everything" '
  echo "x" > a && git add a
  git commit -qm "anything goes"
' 0

run_case "anchor + conforming commit (correct slice + trailer): allow" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): add a

Co-Authored-By: Claude <noreply@anthropic.com>"
' 0

run_case "anchor + non-conforming subject (wrong slice number): block" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:9): wrong slice

Co-Authored-By: Claude <noreply@anthropic.com>"
' 1

run_case "anchor + missing trailer: block" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): no trailer here"
' 1

run_case "anchor + arbitrary external subject: block" '
  mkdir -p .codex-paired docs/specs
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  echo "x" > a && git add a
  git commit -qm "manual hand-commit

Co-Authored-By: Claude <noreply@anthropic.com>"
' 1

run_case "anchor + non-conforming commit from subdirectory: signal nonzero" '
  mkdir -p .codex-paired docs/specs sub/dir
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  cd sub/dir
  echo "x" > a && git add a
  # Hook MUST resolve repo root to the parent (where the anchor lives), not cwd.
  git commit -qm "external from subdir"
' 1

run_case "anchor + conforming commit from subdirectory: pass" '
  mkdir -p .codex-paired docs/specs sub/dir
  echo "# s" > docs/specs/spec.md
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-init --specPath "$PWD/docs/specs/spec.md" --feature t --threadId tid-1 >/dev/null
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js sidecar-set-autopilot --specPath "$PWD/docs/specs/spec.md" --block "{\"current_slice\":\"3\",\"current_phase\":\"implement\"}"
  node '"$PLUGIN_ROOT"'/lib/codex-bridge/cli.js anchor-write --repoRoot "$PWD" --specPath "$PWD/docs/specs/spec.md"
  cd sub/dir
  echo "x" > a && git add a
  git commit -qm "feat(slice:3): add a from subdir

Co-Authored-By: Claude <noreply@anthropic.com>"
' 0

echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
```

Make executable: `chmod +x tests/hooks/check-commit-provenance.test.sh`

- [ ] **Step 1b: Run — confirm fail**

Run: `bash tests/hooks/check-commit-provenance.test.sh 2>&1 | tail -10`
Expected: all hook test cases fail because the hook script doesn't exist yet (or runs but does nothing). The harness prints `N passed, M failed` at the end — read those numbers.

### Step 2: Implement the hook

- [ ] **Step 2a: Create `hooks/check-commit-provenance.sh`**:

```bash
#!/usr/bin/env bash
# Provenance hook: PostToolUse on `git commit`. Fires AFTER the commit lands;
# does NOT un-do it. Exits non-zero to signal the orchestrator that the
# commit was non-conforming so autopilot can halt and the user can decide
# (e.g., `git reset`).
# Reads <repo-root>/.codex-paired/active.json. If autopilot is running,
# verifies the most recent commit conforms to Commit Conventions §:
#   subject:  (feat|test|fix|docs|refactor|chore)\(slice:<current_slice>\):
#   trailer:  Co-Authored-By: Claude
# Both must be present. If either is missing, exit 1 (signal non-conforming).
# If no anchor exists (autopilot not running), exit 0 (no-op).
set -euo pipefail

# Resolve repo root. Priority:
#   1. CLAUDE_PROJECT_DIR (set by Claude Code; the authoritative project root)
#   2. `git rev-parse --show-toplevel` from cwd (handles subdirectory commits)
#   3. $PWD as last fallback
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
fi
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"

# CLAUDE_PLUGIN_ROOT must be set for us to call the bridge CLI.
if [ -z "$PLUGIN_ROOT" ]; then
  # Try to locate it relative to this script.
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

ANCHOR_PATH="$REPO_ROOT/.codex-paired/active.json"
if [ ! -f "$ANCHOR_PATH" ]; then
  exit 0  # autopilot not running, allow everything
fi

# Read the spec path from the anchor.
SPEC_PATH=$(node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" anchor-read --repoRoot "$REPO_ROOT" 2>/dev/null \
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ if(!d) process.exit(0); console.log(JSON.parse(d).specPath); })")

if [ -z "$SPEC_PATH" ]; then
  exit 0  # anchor empty/malformed → don't block
fi

# Read the autopilot block from the sidecar.
AP=$(node "$PLUGIN_ROOT/lib/codex-bridge/cli.js" sidecar-get-autopilot --specPath "$SPEC_PATH" 2>/dev/null)
if [ -z "$AP" ]; then
  exit 0  # no autopilot block → not actually running
fi

CURRENT_SLICE=$(echo "$AP" | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ const o=JSON.parse(d); console.log(o.current_slice ?? ''); })")

if [ -z "$CURRENT_SLICE" ]; then
  exit 0  # autopilot block has no current_slice → not actually running
fi

# Read the most recent commit.
cd "$REPO_ROOT"
SUBJECT=$(git log -1 --format=%s)
BODY=$(git log -1 --format=%B)

# Check subject pattern.
SUBJECT_RX="^(feat|test|fix|docs|refactor|chore)\\(slice:${CURRENT_SLICE}\\):"
if ! echo "$SUBJECT" | grep -Eq "$SUBJECT_RX"; then
  echo "[provenance hook] NON-CONFORMING: most recent commit subject doesn't match expected slice:$CURRENT_SLICE prefix (commit already landed; signaling autopilot to halt)" >&2
  echo "  subject: $SUBJECT" >&2
  echo "  expected pattern: $SUBJECT_RX" >&2
  exit 1
fi

# Check Co-Authored-By trailer.
if ! echo "$BODY" | grep -Eq '^Co-Authored-By: Claude'; then
  echo "[provenance hook] NON-CONFORMING: commit missing 'Co-Authored-By: Claude' trailer (commit already landed; signaling autopilot to halt)" >&2
  echo "  subject: $SUBJECT" >&2
  exit 1
fi

exit 0
```

Make executable: `chmod +x hooks/check-commit-provenance.sh`

- [ ] **Step 2b: Run tests — confirm 0 failures**

Run: `bash tests/hooks/check-commit-provenance.test.sh 2>&1 | tail -10`
Expected: harness reports `0 failed`.

### Step 3: Register the hook in hooks.json

- [ ] **Step 3a: Create `hooks/hooks.json`**:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "command": "${CLAUDE_PLUGIN_ROOT}/hooks/check-commit-provenance.sh",
        "matcher_args": {
          "command": ".*git\\s+commit.*"
        }
      }
    ]
  }
}
```

(If the matcher_args shape differs in the user's Claude Code version, adapt — the goal is "fire on `git commit` invocations only.")

### Step 4: Validate the hook actually fires from Claude Code

The script-level tests prove the script's logic. They do NOT prove `hooks.json` registration is correct (the matcher could be wrong, the path could resolve incorrectly via `${CLAUDE_PLUGIN_ROOT}`, etc.). Add a manual end-to-end smoke:

- [ ] **Step 4a: Reload the plugin** (`/reload-plugins`) and verify the `/plugins` output shows the new hook (the reload summary should now mention 5 plugin hooks instead of 4).

- [ ] **Step 4b: Note on PostToolUse semantics.** The hook fires AFTER `git commit` succeeds — the commit lands in git history regardless. What we're validating is that the hook FIRES, INSPECTS, and SIGNALS via non-zero exit (which Claude Code surfaces as a system reminder). The hook does NOT un-do the commit. The autopilot orchestrator reads the signal and halts; the user can then `git reset` if needed.

- [ ] **Step 4c: In a fresh test repo with an active autopilot anchor (write one manually for this test), run `git commit -m "manual external commit"`** via the Bash tool. The commit will succeed (PostToolUse can't prevent that). Verify Claude Code surfaces the hook's non-zero exit and stderr message ("[provenance hook] NON-CONFORMING: ...").

- [ ] **Step 4d: Then run a conforming commit** (`feat(slice:3): test` + `Co-Authored-By: Claude` trailer). Hook should exit 0 silently — no system reminder.

- [ ] **Step 4e: Clear the test anchor** and verify subsequent commits don't trigger the hook (or trigger it but it exits 0 because no autopilot is active).

If any of these fail, the registration in `hooks.json` is wrong — debug and fix before committing.

### Step 5: Commit

- [ ] **Step 5a: Commit**

```bash
git add hooks/ tests/hooks/
git commit -m "feat(slice:3): provenance hook + tests

- hooks/check-commit-provenance.sh: PostToolUse on git commit; reads
  <repo>/.codex-paired/active.json; if autopilot is running, verifies
  most recent commit follows Commit Conventions (correct slice prefix
  AND Co-Authored-By: Claude trailer). Allows everything when not
  running.
- hooks/hooks.json: registers the hook.
- tests/hooks/check-commit-provenance.test.sh: cases covering allow
  (no anchor), allow (conforming commit), block (wrong slice), block
  (missing trailer), block (arbitrary subject).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 4: Codex-via-subagent prompt template

A small but real component: the standardized prompt the autopilot uses when it dispatches background subagents to call codex MCP.

**Files:**
- Create: `skills/autopilot/codex-via-subagent-prompt.md`

### Step 1: Create the prompt

- [ ] **Step 1a: Create `skills/autopilot/codex-via-subagent-prompt.md`**:

```markdown
# Codex-via-Subagent Prompt Template

Use this template when the autopilot dispatches a background subagent (`run_in_background: true`) to make a non-blocking Codex MCP call. The subagent's only job is to invoke Codex and return the parsed result.

## Subagent prompt template

```
You are a one-shot Codex caller. Do exactly this:

1. Invoke `mcp__plugin_codex-paired-superpowers_codex__codex-reply` with:
   {
     "threadId": "{{THREAD_ID}}",
     "prompt": "{{PROMPT_TEXT}}"
   }

2. Capture the response's `content` field verbatim.

3. Report back ONLY:
   - The full content (between <<<CONTENT>>> and <<<END_CONTENT>>> markers).
   - Nothing else. Do not summarize, do not interpret, do not add commentary.

Format:
<<<CONTENT>>>
<verbatim content>
<<<END_CONTENT>>>
```

## Substitution variables
- `{{THREAD_ID}}` — the persistent Codex thread id from the sidecar (`codex_session` field).
- `{{PROMPT_TEXT}}` — the round/phase prompt the autopilot is sending. Must be JSON-string-escaped if embedded in a JSON literal.

## Why a subagent?
Calling the Codex MCP tool directly from the orchestrator blocks the orchestrator. Dispatching a background subagent (with `run_in_background: true`) lets the orchestrator continue with unrelated prep work (file reads, draft prep, evaluation of the same artifact for its own verdict) while Codex thinks. The orchestrator awaits the subagent's completion notification before integrating the verdict.

## Single-writer mutex (do NOT violate)
Only ONE codex-reply call may be in flight against a given threadId at any time. The orchestrator must not dispatch a second background subagent for the same thread until the previous one has returned. The bridge does NOT enforce this — the orchestrator does. See SKILL.md "Non-blocking Codex" for the discipline.
```

### Step 2: Smoke-test by dispatching a real background subagent

- [ ] **Step 2a: Manual smoke test (one-time verification, not committed)**

In a Claude Code session with this plugin loaded:
1. Pick or create a sidecar with a known threadId (e.g., the autopilot spec's sidecar has thread `019e0611-0f2c-7821-a338-87e8e336768b`).
2. Dispatch a background subagent using the prompt template, passing a trivial prompt like `"Reply with PING-OK and end with a SHIP verdict block."`
3. While the subagent runs, do unrelated work (read a file, run a test).
4. When the subagent completes, verify its output is wrapped in `<<<CONTENT>>>...<<<END_CONTENT>>>` markers and contains a parseable verdict.

This validates the full background-subagent + MCP path. If it works, the autopilot's foundation is sound. If the subagent's output isn't formatted as expected, refine the template before slice 5.

### Step 3: Commit

- [ ] **Step 3a: Commit**

```bash
git add skills/autopilot/codex-via-subagent-prompt.md
git commit -m "feat(slice:4): codex-via-subagent prompt template

Standardized prompt for dispatching background subagents that wrap
single-shot codex-reply MCP calls. Used by autopilot to keep the
orchestrator non-blocking while Codex thinks. Documents the
single-writer-mutex discipline (orchestrator must not double-dispatch
against the same threadId).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 5: Autopilot SKILL.md (orchestrator)

The brain. Largest markdown file in the plugin. References every prior slice.

**Files:**
- Create: `skills/autopilot/SKILL.md`

### Step 1: Draft the SKILL.md

- [ ] **Step 1a: Create `skills/autopilot/SKILL.md`** with the following structure (frontmatter + sections). Write the complete file verbatim:

```markdown
---
name: autopilot
description: Use to run a written, double-SHIP'd implementation plan slice-by-slice unattended. Drives 4 phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with own 7-round Claude↔Codex budget. Wraps via ralph-loop for cross-session continuity.
---

# Autopilot

## What this is
Given a plan that's already double-SHIP'd in `writing-plans`, run it slice-by-slice with full Claude↔Codex review at every phase, until all slices ship or the loop halts on a real blocker. Designed to be wrapped by `ralph-loop` so it survives Claude session boundaries.

## Required inputs
- A double-SHIP'd plan at `docs/superpowers/plans/<plan>.md`.
- The plan's parent spec at `docs/superpowers/specs/<spec>.md` with a sidecar (`<spec>.codex.json`) containing the persistent Codex threadId.
- The plan's frontmatter must reference the spec path explicitly (`**Spec:** docs/superpowers/specs/...`).

If any of these are missing, halt with a clear error message. Do NOT try to brainstorm or write a plan from inside autopilot.

## Lifecycle

### On run start (called once per autopilot session, NOT once per ralph tick)
1. Resolve `<repo-root>` (the directory containing the plan; usually `git rev-parse --show-toplevel`).
2. Write the active anchor:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js anchor-write \
     --repoRoot <repo-root> --specPath <spec-path>
   ```
3. If the sidecar's `autopilot` block is null, initialize it:
   ```json
   {
     "started_at": "<now>",
     "last_tick_at": "<now>",
     "current_slice": "<first unfinished slice number>",
     "current_phase": "plan-slice",
     "phase_attempt": 1,
     "phase_started_at": "<now>",
     "slice_start_sha": "<HEAD>",
     "phase_start_sha": "<HEAD>",
     "last_commit_sha": "<HEAD>",
     "inflight_subagent_id": null,
     "halt_reason": null
   }
   ```
   Atomic write via `sidecar-set-autopilot`.
4. Proceed to the main loop.

### Main loop (one tick = one phase progression)
Read the current `autopilot` block. Dispatch on `current_phase`:

- **plan-slice + test-list review** → run Phase A.
- **implement** → run Phase B.
- **review-slice** → run Phase C.
- **docs-update** → run Phase D.
- **shipped** → mark the slice shipped (`slice_reviews[slice-N].shipped = true`), advance `current_slice` to the next unfinished slice, set `current_phase = "plan-slice"`, reset `phase_start_sha = HEAD`.
- **all_done** → write a final autopilot block with `halt_reason: "completed"`, clear the anchor, return success.

After each phase ships (double-SHIP), advance `current_phase` to the next phase in the sequence and update `phase_start_sha = HEAD` and `last_commit_sha = HEAD` atomically.

### On halt (any reason)
1. Set `autopilot.halt_reason` in the sidecar (atomic).
2. Print a summary to the user: which slice, which phase, what blocked.
3. **Clear the active anchor** (`anchor-clear --repoRoot <repo>`). This is critical: while halted, the user must be able to make manual recovery commits without the provenance hook blocking them. The sidecar's `autopilot` block (with `halt_reason` set) remains and is the source of truth for resumption.
4. On the next `/autopilot` invocation (manually or via ralph), the autopilot reads the sidecar, sees `halt_reason` set, and either re-writes the anchor and resumes (if the halt cause has been addressed) or exits with the same halt reason.

### On ralph tick (cross-session resume or post-halt continuation)
Ralph re-invokes `/autopilot <plan-path>` on each tick. The plan path is the authoritative entrypoint — autopilot uses it to rediscover the spec and sidecar regardless of whether the active anchor is present.

1. Resolve the spec path from the plan's `**Spec:** ...` frontmatter line.
2. Load the sidecar via the spec path.
3. Inspect `sidecar.autopilot.halt_reason`:
   - `null` (and anchor present): normal in-session resume — re-write anchor if missing, run cross-session reconciliation (step 5 below), continue current phase.
   - `"completed"`: exit success. Ralph's completion-promise is now satisfied.
   - any other value (a real halt): the user has either resolved the cause and is asking to continue, or the cause persists. Either way, autopilot rewrites the active anchor (so the hook re-engages) and runs cross-session reconciliation. If reconciliation now succeeds (e.g., dirty tree was cleaned), clear `halt_reason` to null and continue. If reconciliation produces a NEW halt reason (e.g., previously halted on `subagent-blocked`, now halts on `dirty-tree-on-phase-retry` because the user left edits behind), write the NEW reason — do NOT preserve the stale one. The current halt reason must always reflect the current blocker.
4. If `sidecar.autopilot` is null entirely: this is the very first tick. Initialize the autopilot block, write the anchor, start at the first unfinished slice's plan-slice phase.
5. Cross-session reconciliation (used by step 3 paths above):
   - **Dirty-tree check first.** Run `git status --porcelain`. If output is non-empty, the working tree has uncommitted changes from a prior crash or external edit. Halt with `halt_reason: "dirty-tree-on-phase-retry"`, list the affected files, ping user.
   - **HEAD divergence check.** If HEAD does NOT descend from `phase_start_sha` (history rewrite/force-push/branch switch), halt with `halt_reason: "history-divergence"`.
   - **Range walk.** Walk every commit in `last_commit_sha..HEAD`. Each must conform to Commit Conventions (subject prefix matching the slice, plus `Co-Authored-By: Claude` trailer). If any commit doesn't conform, halt with `halt_reason: "external-commit-detected"` citing the offending SHA.
   - If all three checks pass: update `last_commit_sha = HEAD` (atomic) and continue from the current phase.

**The active anchor is the HOOK's discovery mechanism, not autopilot's.** Autopilot uses the plan path. The anchor exists during active runs so the hook can find the right sidecar. It's cleared on halt/completion to keep the hook out of the way during user-driven recovery.

## Per-phase procedures

### Phase A: plan-slice + test-list review
Two artifacts reviewed in one phase:

1. **Task list extraction.** Parse the plan's slice-N section. Extract the bullet list of tasks. Format as markdown.
2. **Test list extraction.** From the same slice section, extract every `Write the failing test` or test-creation step. Format as a numbered list with: invariant pinned, inputs, expected outcome, mock/integration choice.
3. Send both to Codex in one prompt via `codex-reply`:
   ```
   Phase: plan-slice + test-list review
   Round: <N>
   Slice: <slice-N>
   ## Task list
   <task list>
   ## Test list
   <test list>
   Critique with L11 rigor. SHIP only if both lists are L11-grade.
   ```
4. Run the standard 7-round loop. Append rounds to sidecar via `sidecar-append-round` with phase `plan-slice:<slice-N>`. On double-SHIP, set the phase state via `sidecar-set-phase` and advance to Phase B.

### Phase B: implement
1. Dispatch implementing subagent (NOT in background — autopilot waits). Subagent prompt MUST include the Commit Conventions: every commit uses `(feat|test|fix|docs|refactor|chore)(slice:<N>):` subject + `Co-Authored-By: Claude` trailer.
2. Subagent reports DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT.
3. **Reconcile sidecar with git after subagent returns.** Walk every commit in `last_commit_sha..HEAD`:
   - Verify each commit's subject matches `(feat|test|fix|docs|refactor|chore)(slice:<N>):` AND has the `Co-Authored-By: Claude` trailer.
   - If all conform: update `last_commit_sha = HEAD` in the autopilot block (atomic write via `sidecar-set-autopilot`). Move on.
   - If any commit doesn't conform (subagent violated conventions): halt with `halt_reason: "subagent-broke-commit-conventions"`, cite the offending SHA, ping user. Don't try to auto-fix.
4. On DONE / DONE_WITH_CONCERNS (post-reconciliation): write phase state via `sidecar-set-phase`, advance to Phase C.
5. On BLOCKED / NEEDS_CONTEXT: halt per Spec § failure modes (and still reconcile any commits the subagent did make before bailing).

This reconciliation step matters because if a Claude session crashes mid-subagent, the subagent may have committed several tasks. Without this step, `last_commit_sha` would stay at `phase_start_sha` and the recovery range walk on next tick would have the same effect — but doing it eagerly here keeps the sidecar honest.

### Phase C: review-slice
1. Compute the diff: `git diff <slice_start_sha>..HEAD`.
2. Send to Codex via `codex-reply` (or via background subagent if the orchestrator has unrelated prep to do):
   ```
   Phase: review-slice
   Round: <N>
   Slice: <slice-N>
   ## Slice scope
   <task list from Phase A>
   ## Diff
   <diff>
   ## Test output
   <last test run>
   Review only what is in this slice's scope. Out-of-slice issues = `## Deferred`. End with verdict.
   ```
3. **On Codex REVISE:**
   a. Apply anti-yes-man discipline: verify each critique against actual code before accepting. If a critique is wrong, push back via the next round; don't act on it.
   b. For accepted critiques, dispatch a fix-subagent (foreground) with: the slice's task list, the slice scope, the accepted critiques, and the Commit Conventions. The subagent makes the fixes, runs the tests, and commits using `fix(slice:<N>):` subjects (one commit per logical fix).
   c. After the fix-subagent returns, reconcile sidecar with git per the same rules as Phase B step 3 (walk `last_commit_sha..HEAD`, verify all conform, update `last_commit_sha = HEAD`).
   d. Recompute the slice diff (it now includes the fixes) and send to Codex with the next round's prompt.
4. On double-SHIP, write phase state via `sidecar-set-phase`, advance to Phase D.

### Phase D: docs-update
1. Compute the slice's diff again: `git diff <slice_start_sha>..HEAD`.
2. Ask Codex via `codex-reply` (round 1 prompt):
   ```
   Phase: docs-update
   Round: 1
   Slice: <slice-N>
   Given this diff, what doc files require updates?
   - Plan checkbox (always required).
   - README.md (only if public surface changed: new commands, flags, MCP tools, file structure).
   - CHANGELOG.md (one-line entry under the in-progress version).
   - AGENTS.md / CLAUDE.md (only if conventions for agents changed).
   - Auto-memory in ~/.claude/projects/<project>/memory (only if a non-obvious decision was locked in).
   ## Diff
   <diff>
   List required updates. End with verdict.
   ```
3. Claude drafts the doc changes per Codex's required-updates list AND independently judges whether anything Codex missed should also be updated.
4. **Apply the doc edits to the working tree but do NOT commit yet.** Send the uncommitted draft to Codex for review:
   ```
   Phase: docs-update
   Round: <N+1>
   ## Working-tree diff (uncommitted docs draft)
   <git diff -- README.md CHANGELOG.md docs/plans/...md AGENTS.md CLAUDE.md (only files touched)>
   Are these accurate? Complete? Are they referencing files/symbols that don't exist? Anything missing? End with verdict.
   ```
5. 7-round loop. On Codex REVISE, edit the working tree (still no commit) and send the next round.
6. **Only on double-SHIP:** commit the docs as a single commit with `docs(slice:<N>): <summary>` subject + `Co-Authored-By: Claude` trailer. Then reconcile sidecar (`last_commit_sha = HEAD`), mark phase shipped via `sidecar-set-phase`, and advance the autopilot to next-slice or all-done.

This deferred-commit pattern matters: if Codex finds doc errors across 3 rounds, we end up with ONE clean docs commit, not 3 commit-then-fix-it commits cluttering history.

## Non-blocking Codex (UI sense, not concurrency sense)
- Background subagent calls let the orchestrator continue prep work while Codex thinks.
- BUT: only ONE codex-reply may be in flight against the feature's threadId at any time. Single-writer mutex enforced by the orchestrator.
- See `skills/autopilot/codex-via-subagent-prompt.md` for the subagent prompt template.

## Failure modes
See Spec § "Failure modes" — implement every row of that table. Each halt sets `autopilot.halt_reason` to a specific string the user can search for, and prints a human-readable summary.

## Anti-yes-man discipline
Same as upstream `codex-paired-superpowers:receiving-code-review`. Never accept a Codex critique without verifying against actual code. Never accept a SHIP without applying the pre-SHIP checklist (which is now in `system-rubric.md` and Codex sees it on every prompt).

## Integration with ralph-loop
Run autopilot under ralph for cross-session continuity:
```
/ralph-loop /autopilot <plan-path> --completion-promise "all slices in <plan-path> shipped"
```
Each ralph tick re-invokes `/autopilot <plan-path>`. Autopilot uses the plan path to resolve the spec via the plan's frontmatter and reads the sidecar's `autopilot` block to determine state — the active anchor is the HOOK's discovery mechanism, not the autopilot's. Ralph's completion-promise is met only when `sidecar.autopilot.halt_reason == "completed"`.
```

### Step 2: Manual smoke test against a synthetic plan

- [ ] **Step 2a: Create a tiny synthetic plan** at `/tmp/cps-autopilot-smoke/docs/superpowers/plans/2026-05-08-hello.md` with one trivial slice (e.g., "create hello.txt with content 'hello'"). Spec at `/tmp/cps-autopilot-smoke/docs/superpowers/specs/2026-05-08-hello-design.md` (already double-SHIP'd via a manual sidecar-init + manual rounds).

- [ ] **Step 2b: Invoke `codex-paired-superpowers:autopilot` with that plan path.** Watch each phase tick:
  - Anchor written.
  - Phase A: 1–2 round loop, Codex SHIPs the trivial task list.
  - Phase B: subagent creates hello.txt + commits.
  - Phase C: Codex reviews the trivial diff, SHIPs.
  - Phase D: Codex says "only the plan checkbox needs updating," Claude flips it, Codex SHIPs.
  - Slice marked shipped, no more slices, autopilot completes, anchor cleared.

- [ ] **Step 2c: Inspect the final sidecar.** Verify `slice_reviews[slice-1]` has all 4 phases shipped and `autopilot.halt_reason: "completed"`. Verify the active anchor at `<repo>/.codex-paired/active.json` has been removed (autopilot cleared it on completion).

- [ ] **Step 2d: Crash/resume smoke — conforming-commits-in-range case.** From a fresh state on the same synthetic plan:
  1. Run autopilot to the start of Phase B (let Phase A double-SHIP).
  2. Manually invoke the implementing subagent (don't go through autopilot) so it commits one task with `feat(slice:1): ...` + `Co-Authored-By: Claude`. Then KILL Claude before autopilot reconciles.
  3. Re-invoke `/autopilot` for the same plan. Expected: cross-session resume's range-walk verifies the new commit conforms, updates `last_commit_sha = HEAD`, and continues Phase B without re-running the task.
  4. Verify the sidecar reflects the resumed state and the slice eventually ships.

- [ ] **Step 2e: Crash/resume smoke — non-conforming commit case.** From a fresh state:
  1. Run autopilot to the start of Phase B.
  2. Make a manual commit with subject `random external commit` (no slice prefix, no trailer). Then re-invoke `/autopilot`.
  3. Expected: range walk detects the non-conforming commit, autopilot halts with `halt_reason: "external-commit-detected"` and the offending SHA. Active anchor is cleared (so user can recover). Verify both via the sidecar.

- [ ] **Step 2f: Dirty-tree retry smoke.** From a fresh state:
  1. Run autopilot to the middle of Phase C with a Codex REVISE in flight.
  2. Make a working-tree edit but DON'T commit. KILL Claude.
  3. Re-invoke `/autopilot`. Expected: dirty-tree detection halts with `halt_reason: "dirty-tree-on-phase-retry"`, anchor cleared, user prompted to resolve.

If any of these three resume smokes fail, the recovery algorithm is broken — debug + iterate before committing the SKILL.md.

### Step 3: Commit

- [ ] **Step 3a: Commit**

```bash
git add skills/autopilot/SKILL.md
git commit -m "feat(slice:5): autopilot SKILL.md (orchestrator)

The orchestrator that drives the 4 per-slice phases (plan-slice + test-list,
implement, review-slice, docs-update). Each phase has its own 7-round
Claude<->Codex budget. State persists in sidecar's autopilot block.
Cross-session resume via ralph-loop using the active anchor.

Manual smoke test against synthetic 1-slice plan: all 4 phases shipped
in 1-2 rounds each; final sidecar shows shipped: true and halt_reason:
completed.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 6: `/autopilot` slash command

**Files:**
- Create: `commands/autopilot.md`

### Step 1: Create the slash command

- [ ] **Step 1a: Create `commands/autopilot.md`**:

```markdown
---
description: "Run an implementation plan slice-by-slice unattended via codex-paired autopilot"
argument-hint: "<plan-path>"
---

# /autopilot

Run the codex-paired-superpowers:autopilot skill against the given plan.

## Usage
`/autopilot <plan-path>`

The plan must:
1. Live at the given path (typically `docs/superpowers/plans/...`).
2. Have a frontmatter line `**Spec:** <spec-path>` pointing at a sibling spec.
3. The spec must have a sidecar at `<spec-path>.codex.json` with a `codex_session` threadId (i.e., it must have been brainstormed via `codex-paired-superpowers:brainstorming` and plan-reviewed via `codex-paired-superpowers:writing-plans`).

## What happens
Invokes the `codex-paired-superpowers:autopilot` skill with the plan path. The skill takes over from there — see its SKILL.md for full lifecycle. To get cross-session continuity, wrap this command in `/ralph-loop`.

## Example
```
/ralph-loop /autopilot docs/superpowers/plans/2026-05-08-myfeature.md --completion-promise "autopilot completed"
```

The plan: $ARGUMENTS
```

### Step 2: Reload + smoke

- [ ] **Step 2a: After committing slice 6, run `/reload-plugins` and verify `/autopilot` is listed.**

- [ ] **Step 2b: Invoke `/autopilot <plan-path>` against the synthetic plan from slice 5 to confirm the command properly delegates to the skill.**

### Step 3: Commit

- [ ] **Step 3a: Commit**

```bash
git add commands/autopilot.md
git commit -m "feat(slice:6): /autopilot slash command

Convenience wrapper that invokes codex-paired-superpowers:autopilot
against the given plan path. Wrap in /ralph-loop for cross-session
continuity.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Slice 7: Release v0.3.0

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`
- Modify: `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json`

### Step 1: Update README

- [ ] **Step 1a: Append an "Autopilot" section to README.md** — between the existing "Codex transport" and "Bridge CLI" sections:

```markdown
## Autopilot (v0.3.0+)

Run a double-SHIP'd implementation plan to completion unattended. The autopilot drives four phases per slice (plan-slice + test-list review, implement, review-slice, docs-update), each with its own 7-round Claude↔Codex budget. State persists in the sidecar; `ralph-loop` provides cross-session continuity.

### Usage

```bash
# One-shot in current session:
/autopilot docs/superpowers/plans/<plan>.md

# Or wrapped in ralph-loop for cross-session continuity:
/ralph-loop /autopilot docs/superpowers/plans/<plan>.md --completion-promise "autopilot completed"
```

### Prerequisites
- A double-SHIP'd plan (run through `codex-paired-superpowers:writing-plans` first).
- The plan's frontmatter references the spec path.
- The spec has a sidecar with a `codex_session` threadId.

### Provenance hook
While autopilot is running, a PostToolUse hook on `git commit` checks the Commit Conventions: subject must match `(feat|test|fix|docs|refactor|chore)(slice:N):` and include `Co-Authored-By: Claude`. The hook fires AFTER the commit (PostToolUse can't prevent it) — non-conforming commits land but the hook exits non-zero, signaling the autopilot to halt with `external-commit-detected`. The user can then `git reset` to remove the offending commit. The hook is silent when autopilot isn't running.

### Active anchor file
`<repo>/.codex-paired/active.json` (auto-gitignored) tells the hook which sidecar to consult. Created on autopilot start, removed on halt/completion.
```

### Step 2: Append v0.3.0 to changelog

- [ ] **Step 2a: Update the "Status" / "Changelog" section of README.md** — add at the top of the changelog list:

```markdown
- **v0.3.0** — autopilot. Multi-tier loop drives plans slice-by-slice unattended; per-slice phases (plan-slice + test-list review, implement, review-slice, docs-update); cross-session continuity via ralph-loop; provenance hook enforces Commit Conventions during active runs; sidecar gains nested phase state + autopilot block + atomic writes. Spec hardened across 6 Codex review rounds.
```

### Step 3: Bump versions

- [ ] **Step 3a: Edit `.claude-plugin/plugin.json`** — change `"version": "0.2.0"` to `"0.3.0"`.

- [ ] **Step 3b: Edit `package.json`** — change `"version": "0.2.0"` to `"0.3.0"`.

- [ ] **Step 3c: Edit `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json`** — change the plugin's `"version"` to `"0.3.0"`.

### Step 4: Final test pass

- [ ] **Step 4a: Run all tests**

```bash
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
npm test
bash tests/hooks/check-commit-provenance.test.sh
```

Expected: node tests show `fail 0`; hook test harness reports `0 failed`.

### Step 5: Commit + tag

- [ ] **Step 5a: Commit**

```bash
git add README.md .claude-plugin/plugin.json package.json /Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json
git commit -m "chore(slice:7): release v0.3.0 — autopilot

- README: autopilot section + v0.3.0 changelog entry
- bumps: plugin.json + package.json + marketplace.json to 0.3.0

Co-Authored-By: Claude <noreply@anthropic.com>"
git tag v0.3.0
```

### Step 6: Reload + verify

- [ ] **Step 6a: User runs `/reload-plugins`** and verifies the plugin shows v0.3.0.

- [ ] **Step 6b: Verify all tools are still loaded** (codex MCP, autopilot SKILL, /autopilot command).

---

## Self-Review

**Spec coverage:**
- Operating shape (4-tier loop) → slice 5 SKILL.md
- Per-slice phases (A/B/C/D) → slice 5 SKILL.md (one section each)
- Non-blocking Codex (UI sense, not concurrency) → slice 4 prompt template + slice 5 mutex discipline
- Codex thread ownership / single-writer mutex → slice 5 SKILL.md
- Sidecar nested phase state + autopilot block + atomic writes → slice 1
- State invariants (phase_start_sha, last_commit_sha init) → slice 1 implementation + slice 5 SKILL.md "On run start" + "Main loop"
- Cross-session resume algorithm → slice 5 SKILL.md "On ralph tick"
- Commit conventions → slice 1 (rubric), slice 3 (hook enforces), slice 5 (SKILL.md instructs subagent)
- Provenance hook → slice 3
- Active anchor → slice 2
- Pre-SHIP checklist → slice 1
- Failure modes (NEEDS_CONTEXT, MCP unreachable, dirty tree, history divergence) → slice 5 SKILL.md (references spec § failure modes)
- /autopilot slash command → slice 6
- README + version bump → slice 7

**Placeholder scan:** no `TBD`, no `<add later>`, all code blocks complete. The "Manual smoke test" steps in slices 4 and 5 ARE concrete (specific files, specific assertions) — not placeholders.

**Type / name consistency:**
- Sidecar functions: `setPhase`, `setAutopilot`, `getAutopilot`, `setSlice`, `appendRound` consistent across slices 1, 5.
- Anchor functions: `writeAnchor`, `readAnchor`, `clearAnchor`, `anchorPathFor` consistent across slices 2, 5.
- CLI subcommands: `sidecar-set-phase`, `sidecar-set-autopilot`, `sidecar-get-autopilot`, `anchor-write`, `anchor-read`, `anchor-clear` consistent across slices 1, 2, 5.
- Phase names: `plan-slice`, `implement`, `review-slice`, `docs-update` consistent across slice 5 + spec.
- Commit prefixes: `feat|test|fix|docs|refactor|chore(slice:N):` consistent across slices 1 (rubric), 3 (hook), 5 (SKILL.md).

No spec gaps detected.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-08-autopilot-implementation.md`.

**Two execution options:**
1. **Subagent-driven** (recommended) — `superpowers:subagent-driven-development` (use until slice 5 ships; afterward, you can dogfood `codex-paired-superpowers:subagent-driven-development` for slices 6–7).
2. **Inline execution** — `superpowers:executing-plans`.

**Which approach?**
