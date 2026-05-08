# Codex-Paired Superpowers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Note: the *forked* skills inside this plugin do not yet exist when this plan starts — use upstream `superpowers:*` for the implementation itself; once a forked skill ships, optionally start using it.

**Goal:** Build a standalone Claude Code plugin `codex-paired-superpowers` that forks six superpowers skills and adds a Codex pairing layer (one persistent Codex thread per feature, 7-round revision loop, structured verdict protocol).

**Architecture:** Plugin lives at `/Users/mkr/local-coding/plugins/codex-paired-superpowers/`. Parent dir `plugins/` doubles as a personal Claude Code marketplace. Six forked skills under `skills/` share a Node.js library `lib/codex-bridge/` that wraps `codex exec`/`codex exec resume`, parses `<<<VERDICT>>>` blocks, manages per-feature sidecar JSON, and orchestrates the round loop. Each skill calls the bridge via `node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand>`.

**Tech Stack:** Node.js 24+ (built-in test runner — `node --test`), bash for plugin manifest scaffolding, `codex-cli 0.128.0` as transport. Zero npm dependencies.

**Spec:** `docs/specs/2026-05-07-codex-paired-superpowers-design.md`

---

## File Structure

```
codex-paired-superpowers/
├── .claude-plugin/
│   └── plugin.json                # plugin manifest
├── lib/codex-bridge/
│   ├── cli.js                     # entry: subcommand dispatcher
│   ├── invoke.js                  # spawn codex exec, capture session UUID + final message
│   ├── verdict.js                 # parse <<<VERDICT>>>...<<<END>>> blocks
│   ├── sidecar.js                 # load/save/locate <spec>.codex.json
│   ├── loop.js                    # round-loop orchestration (called by skills)
│   └── prompts/
│       ├── system-rubric.md       # L11 rubric prepended to every codex session
│       ├── verdict-format.md      # the verdict block protocol (sent in every prompt)
│       └── phase-*.md             # phase-specific prompt fragments
├── skills/
│   ├── brainstorming/SKILL.md
│   ├── writing-plans/SKILL.md
│   ├── subagent-driven-development/SKILL.md
│   ├── receiving-code-review/SKILL.md
│   ├── systematic-debugging/SKILL.md
│   └── test-driven-development/SKILL.md
├── tests/codex-bridge/
│   ├── verdict.test.js
│   ├── sidecar.test.js
│   ├── invoke.test.js             # uses a mock `codex` binary on PATH
│   ├── loop.test.js
│   └── fixtures/
├── docs/
│   ├── specs/2026-05-07-codex-paired-superpowers-design.md
│   └── plans/2026-05-07-codex-paired-superpowers.md
├── README.md
├── .gitignore
└── package.json                   # only for `node --test` script + metadata
```

Marketplace manifest (separate, lives outside this plugin):
- `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json` — registers all plugins under `plugins/` for `/plugin` install.

---

## Slicing

Ten slices. Each produces something testable and shippable on its own.

| # | Slice | What ships |
|---|---|---|
| 1 | Repo + manifest scaffolding | Empty plugin installable via `/plugin` |
| 2 | Bridge: invoke + sidecar | Can start/resume codex sessions; sidecar persists |
| 3 | Bridge: verdict + round loop | Full orchestration; double-SHIP detection works |
| 4 | brainstorming (forked) | First end-to-end skill: spec → double-SHIP |
| 5 | writing-plans (forked) | Plan review loop on same codex session |
| 6 | subagent-driven-development (forked) | Per-slice review with scope locking |
| 7 | receiving-code-review (forked) | Anti-yes-man discipline applied to codex verdicts |
| 8 | systematic-debugging (forked) | Hypothesis review loop |
| 9 | test-driven-development (forked) | Test-design review loop |
| 10 | Install + smoke + docs | Plugin installed, end-to-end smoke passes, README done |

---

## Slice 1: Repo + Manifest Scaffolding

**Files:**
- Create: `/Users/mkr/local-coding/plugins/codex-paired-superpowers/.claude-plugin/plugin.json`
- Create: `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json`
- Create: `/Users/mkr/local-coding/plugins/codex-paired-superpowers/README.md`
- Create: `/Users/mkr/local-coding/plugins/codex-paired-superpowers/.gitignore`
- Create: `/Users/mkr/local-coding/plugins/codex-paired-superpowers/package.json`

- [ ] **Step 1: Write `plugin.json`**

```json
{
  "name": "codex-paired-superpowers",
  "description": "Fork of six superpowers skills paired with Codex (GPT-5.5) as an L11 engineering partner. One persistent Codex thread per feature; 7-round revision loop with structured verdict protocol.",
  "version": "0.1.0",
  "author": { "name": "mkr" },
  "license": "MIT",
  "keywords": ["skills", "codex", "pair-programming", "tdd", "code-review"]
}
```

- [ ] **Step 2: Write `package.json` (zero deps, just for `node --test`)**

```json
{
  "name": "codex-paired-superpowers",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.DS_Store
*.log
# sidecar files generated during real runs (not test fixtures)
docs/specs/*.codex.json
```

- [ ] **Step 4: Write minimal `README.md`**

```markdown
# codex-paired-superpowers

Fork of six [superpowers](https://github.com/obra/superpowers) skills paired with Codex (GPT-5.5 high reasoning) as an L11 engineering partner.

## Why
Superpowers gives Claude a discipline. This plugin adds a second pair of eyes — Codex — that drafts specs, critiques plans, reviews per-slice code, and must agree before anything ships. One persistent Codex thread per feature.

## Skills (forked)
- brainstorming
- writing-plans
- subagent-driven-development
- receiving-code-review
- systematic-debugging
- test-driven-development

## Install
See "Install" section below — populated in slice 10.

## Status
v0.1 — under construction.
```

- [ ] **Step 5: Write parent marketplace manifest at `/Users/mkr/local-coding/plugins/.claude-plugin/marketplace.json`**

```json
{
  "name": "mkr-personal",
  "description": "Personal local marketplace for mkr's Claude Code plugins",
  "owner": { "name": "mkr" },
  "plugins": [
    {
      "name": "codex-paired-superpowers",
      "description": "Six superpowers skills paired with Codex as L11 partner",
      "version": "0.1.0",
      "source": "./codex-paired-superpowers"
    }
  ]
}
```

- [ ] **Step 6: Verify manifest validity (no command yet — JSON syntax check)**

Run: `cd /Users/mkr/local-coding/plugins/codex-paired-superpowers && node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json'))" && node -e "JSON.parse(require('fs').readFileSync('package.json'))" && node -e "JSON.parse(require('fs').readFileSync('../.claude-plugin/marketplace.json'))"`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/mkr/local-coding/plugins/codex-paired-superpowers
git add .claude-plugin/plugin.json package.json .gitignore README.md ../.claude-plugin/marketplace.json
git commit -m "scaffold: plugin manifest, marketplace, package.json"
```

---

## Slice 2: Bridge — invoke + sidecar

This slice gives us the persistence layer and the codex spawn primitives. No round-loop logic yet.

**Files:**
- Create: `lib/codex-bridge/sidecar.js`
- Create: `tests/codex-bridge/sidecar.test.js`
- Create: `lib/codex-bridge/invoke.js`
- Create: `tests/codex-bridge/invoke.test.js`
- Create: `tests/codex-bridge/fixtures/mock-codex.js`
- Create: `lib/codex-bridge/cli.js`

### Sidecar module (TDD: red → green → refactor)

- [ ] **Step 1: Write failing test for sidecar create+read**

```js
// tests/codex-bridge/sidecar.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSidecar,
  loadSidecar,
  appendRound,
  setSlice,
  sidecarPathFor,
} from '../../lib/codex-bridge/sidecar.js';

test('sidecarPathFor appends .codex.json to spec path', () => {
  assert.equal(
    sidecarPathFor('/x/y/spec.md'),
    '/x/y/spec.md.codex.json'
  );
});

test('initSidecar writes valid JSON with required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'demo',
    codexSession: 'uuid-1',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.version, 1);
  assert.equal(sc.feature, 'demo');
  assert.equal(sc.codex_session, 'uuid-1');
  assert.equal(sc.model, 'gpt-5.5');
  assert.equal(sc.reasoning_effort, 'high');
  assert.deepEqual(sc.rounds, []);
  assert.deepEqual(sc.open_contentions, []);
  assert.deepEqual(sc.slice_reviews, {});
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound appends to rounds array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  appendRound(spec, { phase: 'spec', round: 1, claude: 'REVISE: x', codex: 'REVISE: y' });
  appendRound(spec, { phase: 'spec', round: 2, claude: 'SHIP', codex: 'SHIP' });
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 2);
  assert.equal(sc.rounds[1].claude, 'SHIP');
  rmSync(dir, { recursive: true, force: true });
});

test('setSlice records slice review state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  setSlice(spec, 'slice-1', { rounds: [{ round: 1, claude: 'SHIP', codex: 'SHIP' }], shipped: true });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].shipped, true);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests — confirm failure**

Run: `cd /Users/mkr/local-coding/plugins/codex-paired-superpowers && node --test tests/codex-bridge/sidecar.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/codex-bridge/sidecar.js`**

```js
// lib/codex-bridge/sidecar.js
import { readFileSync, writeFileSync } from 'node:fs';

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
  writeFileSync(sidecarPathFor(specPath), JSON.stringify(data, null, 2));
  return data;
}

export function loadSidecar(specPath) {
  return JSON.parse(readFileSync(sidecarPathFor(specPath), 'utf8'));
}

function saveSidecar(specPath, data) {
  writeFileSync(sidecarPathFor(specPath), JSON.stringify(data, null, 2));
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

export function addOpenContention(specPath, contention) {
  const sc = loadSidecar(specPath);
  sc.open_contentions.push(contention);
  saveSidecar(specPath, sc);
}
```

- [ ] **Step 4: Re-run tests — confirm pass**

Run: `node --test tests/codex-bridge/sidecar.test.js`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/codex-bridge/sidecar.js tests/codex-bridge/sidecar.test.js
git commit -m "bridge: sidecar persistence with round + slice tracking"
```

### Invoke module

- [ ] **Step 6: Write mock codex binary for tests**

```js
// tests/codex-bridge/fixtures/mock-codex.js
#!/usr/bin/env node
// Behaves like `codex exec` for tests:
//  - prints the standard preamble (with session id)
//  - prints the prompt back as the assistant's reply (or scripted reply via env)
import { argv, env, stdin } from 'node:process';

const args = argv.slice(2);
const sessionId = env.MOCK_CODEX_SESSION || '019e0507-0000-7000-8000-000000000001';
const reply = env.MOCK_CODEX_REPLY || 'mock reply';

let cmd = args[0]; // 'exec' | 'help' | etc.
let isResume = false;
if (cmd === 'exec' && args[1] === 'resume') isResume = true;

const preamble = `OpenAI Codex v0.128.0 (research preview)
--------
workdir: ${process.cwd()}
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write
reasoning effort: high
reasoning summaries: none
session id: ${sessionId}
--------
user
[mock prompt elided]
codex
${reply}
tokens used
1234
${reply}
`;
process.stdout.write(preamble);
process.exit(0);
```

Make executable: `chmod +x tests/codex-bridge/fixtures/mock-codex.js`

- [ ] **Step 7: Write failing tests for invoke**

```js
// tests/codex-bridge/invoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startSession, resumeSession } from '../../lib/codex-bridge/invoke.js';

const here = dirname(fileURLToPath(import.meta.url));
const mockBin = join(here, 'fixtures', 'mock-codex.js');

test('startSession returns session UUID and final reply', async () => {
  const { sessionId, reply } = await startSession({
    prompt: 'hi',
    codexBin: mockBin,
    env: { MOCK_CODEX_SESSION: '019e0507-0000-7000-8000-000000000abc', MOCK_CODEX_REPLY: 'hello' },
  });
  assert.equal(sessionId, '019e0507-0000-7000-8000-000000000abc');
  assert.equal(reply.trim(), 'hello');
});

test('resumeSession returns final reply for an existing session', async () => {
  const { reply } = await resumeSession({
    sessionId: '019e0507-0000-7000-8000-000000000abc',
    prompt: 'follow up',
    codexBin: mockBin,
    env: { MOCK_CODEX_REPLY: 'second reply' },
  });
  assert.equal(reply.trim(), 'second reply');
});
```

- [ ] **Step 8: Run — confirm failure**

Run: `node --test tests/codex-bridge/invoke.test.js`
Expected: FAIL — module not found.

- [ ] **Step 9: Implement `lib/codex-bridge/invoke.js`**

```js
// lib/codex-bridge/invoke.js
import { spawn } from 'node:child_process';

const DEFAULTS = {
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  codexBin: 'codex',
};

const SESSION_RX = /^session id:\s*([0-9a-f-]{36})\s*$/im;

function runCodex(args, { prompt, env = {}, codexBin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited ${code}: ${err.slice(0, 500)}`));
      } else {
        resolve(out);
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseOutput(stdout) {
  // session id line in preamble
  const idMatch = stdout.match(SESSION_RX);
  const sessionId = idMatch ? idMatch[1] : null;

  // The final assistant turn appears after a `codex` heading line and is
  // re-printed at the end after `tokens used` block. Take the trailing
  // re-print: split on "tokens used\n<num>\n" and use the part after.
  const trailMatch = stdout.match(/tokens used\s*\n[0-9,]+\s*\n([\s\S]*)$/);
  const reply = trailMatch ? trailMatch[1].trim() : stdout.trim();

  return { sessionId, reply };
}

export async function startSession({
  prompt,
  model = DEFAULTS.model,
  reasoningEffort = DEFAULTS.reasoningEffort,
  codexBin = DEFAULTS.codexBin,
  env = {},
}) {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-m', model,
    '-c', `model_reasoning_effort=${reasoningEffort}`,
    '-', // read prompt from stdin
  ];
  const out = await runCodex(args, { prompt, env, codexBin });
  return parseOutput(out);
}

export async function resumeSession({
  sessionId,
  prompt,
  model = DEFAULTS.model,
  reasoningEffort = DEFAULTS.reasoningEffort,
  codexBin = DEFAULTS.codexBin,
  env = {},
}) {
  const args = [
    'exec', 'resume', sessionId,
    '-m', model,
    '-c', `model_reasoning_effort=${reasoningEffort}`,
    '-',
  ];
  const out = await runCodex(args, { prompt, env, codexBin });
  return parseOutput(out);
}
```

- [ ] **Step 10: Re-run tests — confirm pass**

Run: `node --test tests/codex-bridge/invoke.test.js`
Expected: 2 tests passing.

- [ ] **Step 11: Verify against real codex (manual smoke)**

Run:
```bash
node -e "
import('./lib/codex-bridge/invoke.js').then(async ({startSession}) => {
  const r = await startSession({ prompt: 'Reply with exactly: PING-OK' });
  console.log('session:', r.sessionId);
  console.log('reply:', r.reply);
});
"
```
Expected: a UUID and a reply containing `PING-OK`.

- [ ] **Step 12: Implement minimal CLI dispatcher `lib/codex-bridge/cli.js`**

```js
#!/usr/bin/env node
// lib/codex-bridge/cli.js
import { startSession, resumeSession } from './invoke.js';
import { initSidecar, loadSidecar, appendRound, setSlice, addOpenContention, sidecarPathFor } from './sidecar.js';

const [, , subcmd, ...rest] = process.argv;

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const subcommands = {
  async 'session-start'({ specPath, feature }) {
    const prompt = await readStdin();
    const { sessionId, reply } = await startSession({ prompt });
    initSidecar(specPath, {
      feature,
      codexSession: sessionId,
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    });
    process.stdout.write(JSON.stringify({ sessionId, reply }, null, 2));
  },
  async 'session-resume'({ specPath }) {
    const sc = loadSidecar(specPath);
    const prompt = await readStdin();
    const { reply } = await resumeSession({ sessionId: sc.codex_session, prompt });
    process.stdout.write(JSON.stringify({ sessionId: sc.codex_session, reply }, null, 2));
  },
  'sidecar-path'({ specPath }) {
    process.stdout.write(sidecarPathFor(specPath));
  },
  'sidecar-show'({ specPath }) {
    process.stdout.write(JSON.stringify(loadSidecar(specPath), null, 2));
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
fn(parseArgs(rest)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

Make executable: `chmod +x lib/codex-bridge/cli.js`

- [ ] **Step 13: Smoke-test the CLI**

Run:
```bash
mkdir -p /tmp/cps-smoke && echo '# test spec' > /tmp/cps-smoke/spec.md
echo "Reply with exactly: HELLO" | node lib/codex-bridge/cli.js session-start --specPath /tmp/cps-smoke/spec.md --feature smoke
cat /tmp/cps-smoke/spec.md.codex.json
```
Expected: JSON with session reply containing HELLO; sidecar JSON file written with codex_session UUID, model gpt-5.5, reasoning_effort high.

- [ ] **Step 14: Commit**

```bash
git add lib/codex-bridge/{invoke.js,cli.js} tests/codex-bridge/{invoke.test.js,fixtures/mock-codex.js}
git commit -m "bridge: codex invoke + cli (session-start, session-resume, sidecar-show)"
```

---

## Slice 3: Bridge — verdict parsing + round loop

**Files:**
- Create: `lib/codex-bridge/verdict.js`
- Create: `tests/codex-bridge/verdict.test.js`
- Create: `lib/codex-bridge/loop.js`
- Create: `tests/codex-bridge/loop.test.js`
- Create: `lib/codex-bridge/prompts/verdict-format.md`
- Create: `lib/codex-bridge/prompts/system-rubric.md`
- Modify: `lib/codex-bridge/cli.js` — add `loop-round`, `loop-status` subcommands

### Verdict parser (TDD)

- [ ] **Step 1: Write failing tests**

```js
// tests/codex-bridge/verdict.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../../lib/codex-bridge/verdict.js';

test('parses SHIP verdict', () => {
  const text = `prose...
<<<VERDICT>>>
status: SHIP
critique: []
rationale: looks good
<<<END>>>`;
  const v = parseVerdict(text);
  assert.equal(v.status, 'SHIP');
  assert.deepEqual(v.critique, []);
  assert.equal(v.rationale, 'looks good');
});

test('parses REVISE verdict with bullet critique', () => {
  const text = `<<<VERDICT>>>
status: REVISE
critique:
  - missing error handling on line 42
  - test for empty input is wrong
rationale: fix above before ship
<<<END>>>`;
  const v = parseVerdict(text);
  assert.equal(v.status, 'REVISE');
  assert.equal(v.critique.length, 2);
  assert.match(v.critique[0], /missing error handling/);
});

test('returns synthetic REVISE on missing block', () => {
  const v = parseVerdict('no verdict here');
  assert.equal(v.status, 'REVISE');
  assert.match(v.critique[0], /verdict block missing/i);
});

test('returns synthetic REVISE on malformed block', () => {
  const v = parseVerdict('<<<VERDICT>>>\nstatus: WAT\n<<<END>>>');
  assert.equal(v.status, 'REVISE');
  assert.match(v.critique[0], /malformed/i);
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `node --test tests/codex-bridge/verdict.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/codex-bridge/verdict.js`**

```js
// lib/codex-bridge/verdict.js

const BLOCK_RX = /<<<VERDICT>>>([\s\S]*?)<<<END>>>/;

export function parseVerdict(text) {
  const m = text.match(BLOCK_RX);
  if (!m) {
    return synthetic('verdict block missing or malformed; please re-emit');
  }
  const body = m[1];
  const status = (body.match(/^\s*status:\s*(SHIP|REVISE)\s*$/im) || [])[1];
  if (!status) {
    return synthetic('malformed verdict: status must be SHIP or REVISE');
  }
  const rationale = (body.match(/^\s*rationale:\s*(.+)$/im) || [, ''])[1].trim();
  const critique = parseCritique(body);
  return { status, critique, rationale };
}

function parseCritique(body) {
  // Two accepted forms:
  //   critique: []
  //   critique:
  //     - point one
  //     - point two
  if (/^\s*critique:\s*\[\s*\]\s*$/im.test(body)) return [];
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\s*critique:\s*$/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const bullet = l.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      out.push(bullet[1].trim());
    } else if (/^\s*[a-z_]+:/i.test(l)) {
      break; // next field
    }
  }
  return out;
}

function synthetic(reason) {
  return { status: 'REVISE', critique: [reason], rationale: 'parser fallback' };
}
```

- [ ] **Step 4: Run — confirm pass**

Run: `node --test tests/codex-bridge/verdict.test.js`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/codex-bridge/verdict.js tests/codex-bridge/verdict.test.js
git commit -m "bridge: verdict parser with synthetic-revise fallback"
```

### Prompt fragments

- [ ] **Step 6: Write `lib/codex-bridge/prompts/verdict-format.md`**

```markdown
## Verdict Format (REQUIRED)

End every response with exactly one verdict block:

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one-sentence summary>
<<<END>>>
```

Rules:
- `status: SHIP` means the artifact is L11-grade as-is. No further changes.
- `status: REVISE` means at least one critique item must be addressed before ship. Each critique must reference specific file/section/line where applicable, and explain WHY it matters (not just what to change).
- If you have nothing to critique but want to keep talking, you must still emit `SHIP`.
- Free-form prose may precede the block. Do not put text after `<<<END>>>`.
```

- [ ] **Step 7: Write `lib/codex-bridge/prompts/system-rubric.md`**

```markdown
## You are an L11 Engineering Partner

You are paired with Claude on the SAME software task. Your job is to push for the best engineering outcome through honest, technically rigorous critique. Claude is not your subordinate; you are co-equal advocates.

### The L11 Rubric — both of you advocate for this
1. **Simple over clever.** If a junior dev can't read it in 30 seconds, defend why.
2. **Small over big.** Files, functions, abstractions — smaller wins ties.
3. **DRY but not premature.** Three similar lines is fine; four call sites is a refactor signal.
4. **Optimal locally.** Solve the task at hand. No "we might need this someday."
5. **Honest about scope.** Out-of-scope improvements go in `## Deferred`, not in this PR.
6. **Tests at the failure boundary.** A test should fail if and only if the bug returns.

### Behavioral rules
- Never rubber-stamp. If you say SHIP, the artifact is genuinely L11-grade.
- Never invent disagreement to look thorough. Vibes are not critique.
- Tie every critique to specifics: file path, line number, function name, scenario.
- When Claude pushes back, evaluate the pushback. If Claude is right, say so and revise. If Claude is wrong, explain why with specifics.
- You and Claude must both emit SHIP in the same round to ship. There is a hard cap of 7 rounds; if not reached, the human user arbitrates.

### Question routing
- **Product/UX/business questions** belong to the human user, not you. Don't answer them. Flag them in `<<<NEEDS_USER>>>...<<<END>>>` blocks.
- **Technical questions** are yours. Answer with rigor.
```

- [ ] **Step 8: Commit prompts**

```bash
git add lib/codex-bridge/prompts/
git commit -m "bridge: verdict-format + L11 system rubric prompts"
```

### Round loop

- [ ] **Step 9: Write failing test for loop termination on double-SHIP**

```js
// tests/codex-bridge/loop.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSidecar, loadSidecar } from '../../lib/codex-bridge/sidecar.js';
import { runRoundLoop } from '../../lib/codex-bridge/loop.js';

function mkSpec() {
  const dir = mkdtempSync(join(tmpdir(), 'cps-loop-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 't', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  return { dir, spec };
}

test('runRoundLoop exits on double-SHIP', async () => {
  const { dir, spec } = mkSpec();
  let n = 0;
  const codexFn = async () => ({ reply: '<<<VERDICT>>>\nstatus: SHIP\ncritique: []\nrationale: ok\n<<<END>>>' });
  const claudeFn = async () => ({ status: 'SHIP', critique: [], rationale: 'ok' });
  const result = await runRoundLoop({
    specPath: spec,
    phase: 'spec',
    initialArtifact: 'draft v0',
    codexFn,
    claudeFn,
  });
  assert.equal(result.outcome, 'shipped');
  assert.equal(result.rounds, 1);
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('runRoundLoop hits 7-round cap and returns deadlock', async () => {
  const { dir, spec } = mkSpec();
  const codexFn = async () => ({ reply: '<<<VERDICT>>>\nstatus: REVISE\ncritique:\n  - thing\nrationale: x\n<<<END>>>' });
  const claudeFn = async () => ({ status: 'REVISE', critique: ['nope'], rationale: 'y' });
  const result = await runRoundLoop({
    specPath: spec,
    phase: 'spec',
    initialArtifact: 'draft',
    codexFn,
    claudeFn,
    maxRounds: 7,
  });
  assert.equal(result.outcome, 'deadlock');
  assert.equal(result.rounds, 7);
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 7);
  rmSync(dir, { recursive: true, force: true });
});

test('runRoundLoop ships when both flip to SHIP mid-loop', async () => {
  const { dir, spec } = mkSpec();
  let i = 0;
  const codexFn = async () => {
    i++;
    return i < 3
      ? { reply: '<<<VERDICT>>>\nstatus: REVISE\ncritique:\n  - a\nrationale: b\n<<<END>>>' }
      : { reply: '<<<VERDICT>>>\nstatus: SHIP\ncritique: []\nrationale: ok\n<<<END>>>' };
  };
  const claudeFn = async (round) => round < 3
    ? { status: 'REVISE', critique: ['x'], rationale: 'y' }
    : { status: 'SHIP', critique: [], rationale: 'ok' };
  const result = await runRoundLoop({ specPath: spec, phase: 'spec', initialArtifact: 'd', codexFn, claudeFn });
  assert.equal(result.outcome, 'shipped');
  assert.equal(result.rounds, 3);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 10: Run — confirm failure**

Run: `node --test tests/codex-bridge/loop.test.js`
Expected: FAIL — module not found.

- [ ] **Step 11: Implement `lib/codex-bridge/loop.js`**

```js
// lib/codex-bridge/loop.js
import { appendRound } from './sidecar.js';
import { parseVerdict } from './verdict.js';

const DEFAULT_MAX_ROUNDS = 7;

/**
 * Run the Claude<->Codex round loop until both ship or maxRounds is hit.
 *
 * @param {object} opts
 * @param {string} opts.specPath - path used to locate sidecar
 * @param {string} opts.phase - 'spec' | 'plan' | 'slice:<id>' | 'debug' | 'tdd'
 * @param {string} opts.initialArtifact - opaque artifact text shown to both
 * @param {(round: number, prevCritique: string[]) => Promise<{reply: string}>} opts.codexFn
 * @param {(round: number, codexVerdict: object) => Promise<{status, critique, rationale}>} opts.claudeFn
 * @param {number} [opts.maxRounds=7]
 */
export async function runRoundLoop({
  specPath,
  phase,
  initialArtifact,
  codexFn,
  claudeFn,
  maxRounds = DEFAULT_MAX_ROUNDS,
}) {
  let prevCritique = [];
  for (let round = 1; round <= maxRounds; round++) {
    const codexResp = await codexFn(round, prevCritique);
    const codexVerdict = parseVerdict(codexResp.reply);
    const claudeVerdict = await claudeFn(round, codexVerdict);

    appendRound(specPath, {
      phase,
      round,
      claude: serialize(claudeVerdict),
      codex: serialize(codexVerdict),
    });

    if (codexVerdict.status === 'SHIP' && claudeVerdict.status === 'SHIP') {
      return { outcome: 'shipped', rounds: round, codex: codexVerdict, claude: claudeVerdict };
    }

    prevCritique = [
      ...codexVerdict.critique.map((c) => `[codex] ${c}`),
      ...claudeVerdict.critique.map((c) => `[claude] ${c}`),
    ];
  }
  return { outcome: 'deadlock', rounds: maxRounds };
}

function serialize(v) {
  if (v.status === 'SHIP') return 'SHIP';
  return `REVISE: ${v.critique.join('; ')}`;
}
```

- [ ] **Step 12: Run — confirm pass**

Run: `node --test tests/codex-bridge/loop.test.js`
Expected: 3 tests passing.

- [ ] **Step 13: Run full test suite**

Run: `npm test`
Expected: all tests across sidecar, verdict, invoke, loop pass.

- [ ] **Step 14: Add CLI subcommand `run-loop` for skill use**

Append to `lib/codex-bridge/cli.js` inside `subcommands`:

```js
async 'run-loop'({ specPath, phase, artifactPath, contextPath }) {
  const { runRoundLoop } = await import('./loop.js');
  const { resumeSession } = await import('./invoke.js');
  const { loadSidecar } = await import('./sidecar.js');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const sc = loadSidecar(specPath);
  const artifact = readFileSync(artifactPath, 'utf8');
  const contextHeader = contextPath ? readFileSync(contextPath, 'utf8') : '';

  // The CLI version of run-loop is interactive: codexFn calls codex
  // for real, claudeFn reads Claude's verdict from a control file
  // written by the calling skill between rounds.
  const claudeVerdictPath = `${specPath}.codex-claude-turn.json`;
  const codexFn = async (round, prev) => {
    const prompt = buildPrompt({ phase, artifact, contextHeader, round, prev });
    return await resumeSession({ sessionId: sc.codex_session, prompt });
  };
  const claudeFn = async (round) => {
    // Skills are responsible for writing this file before each round.
    const v = JSON.parse(readFileSync(claudeVerdictPath, 'utf8'));
    return v;
  };
  const result = await runRoundLoop({ specPath, phase, initialArtifact: artifact, codexFn, claudeFn });
  process.stdout.write(JSON.stringify(result, null, 2));
},
```

And add helper at bottom of cli.js:

```js
function buildPrompt({ phase, artifact, contextHeader, round, prev }) {
  return [
    `# Phase: ${phase}`,
    `# Round: ${round}`,
    contextHeader ? `## Context\n${contextHeader}` : '',
    `## Artifact under review\n${artifact}`,
    prev?.length ? `## Critique from previous round\n${prev.map((c) => `- ${c}`).join('\n')}` : '',
    `## Your job this round`,
    'Read the artifact. Apply the L11 rubric. End with the required verdict block.',
  ].filter(Boolean).join('\n\n');
}
```

(Note: this CLI run-loop is the "single-process" variant. Slices 4–9 will use a simpler synchronous pattern where the skill itself does Claude's reasoning between rounds via direct module calls, not via this CLI subcommand. The CLI subcommand is here for ad-hoc smoke testing.)

- [ ] **Step 15: Commit**

```bash
git add lib/codex-bridge/loop.js tests/codex-bridge/loop.test.js lib/codex-bridge/cli.js
git commit -m "bridge: round-loop orchestration + CLI run-loop subcommand"
```

---

## Slice 4: brainstorming (forked)

This slice ships the first end-to-end skill. It mirrors upstream `superpowers/skills/brainstorming/SKILL.md` with the Codex hooks woven in.

**Files:**
- Create: `skills/brainstorming/SKILL.md`
- Create: `skills/brainstorming/codex-pairing.md` (referenced by SKILL.md for the loop protocol)
- Modify: `lib/codex-bridge/cli.js` — add `verdict-from-claude` helper subcommand

The forked SKILL.md keeps the upstream structure (terminal state = invoke writing-plans, no implementation skills) and changes:
1. Replaces "ask clarifying questions to user, one at a time" with a routing rule: product → user, technical → Codex via `session-start`/`session-resume`.
2. Adds the 7-round revision loop **after** Codex returns a draft spec.
3. Removes the visual-companion offer (Codex doesn't see browser; defer to v2).
4. Sidecar lifecycle: `session-start` after user intent gathered, `session-resume` for every subsequent codex turn.

- [ ] **Step 1: Create `skills/brainstorming/SKILL.md`**

Header (frontmatter):
```yaml
---
name: brainstorming
description: Use when starting any creative work — features, components, behavior changes. Pairs Claude with Codex (GPT-5.5 high) to draft and harden a spec through a 7-round revision loop. Product questions go to the user; technical questions go to Codex.
---
```

Body sections (write in full):

```markdown
# Brainstorming with Codex (paired)

## What this changes vs. upstream
This skill forks `superpowers:brainstorming`. The user-facing question loop is replaced by a Codex-paired drafting loop. The user is consulted only for **product/UX/business** questions. **All technical questions** (libraries, schema, edge cases, idiomaticity) are routed to Codex, who also drafts the spec. Claude and Codex then revise the spec for up to 7 rounds; both must emit `SHIP` to advance.

## Hard gate
Do NOT invoke any implementation skill, write production code, or scaffold a project until the spec is double-SHIP'd and the user has approved it. Trivially small projects still go through this flow; the rounds may resolve in 1.

## Phase 0 — User intent (uncounted)
Ask the **user** a small number of multiple-choice questions to establish: what to build, who it's for, what "done" looks like, scope boundaries. Each question is one message. Never ask the user a technical question.

## Phase 1 — Codebase exploration (uncounted)
Read relevant files. Build a short context note: existing patterns, conventions, file organization, prior art. This becomes context for Codex.

## Phase 2 — Open Codex session (uncounted)
Pick a spec path: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (or user override).

Compose the initial Codex prompt:
- Prepend `lib/codex-bridge/prompts/system-rubric.md`.
- Prepend `lib/codex-bridge/prompts/verdict-format.md`.
- Append: "Phase: spec-draft. Here is the user intent (verbatim) and the codebase context. Draft a complete L11-grade spec. End with the required verdict block."

Run:
```bash
mkdir -p $(dirname "<spec-path>") && touch "<spec-path>"
echo "<prompt>" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-start \
  --specPath "<spec-path>" --feature "<feature-name>"
```

This writes the sidecar at `<spec-path>.codex.json` and returns Codex's first draft (with verdict).

## Phase 3 — Revision loop (counted, max 7 rounds)
Each round:
1. Read the current Codex draft + verdict.
2. Apply the L11 rubric independently. Form your own verdict (SHIP or REVISE).
3. Write your verdict to a control file the bridge can read:
   ```bash
   cat > "<spec-path>.codex-claude-turn.json" <<EOF
   {"status": "REVISE", "critique": ["…"], "rationale": "…"}
   EOF
   ```
4. Send the next round to Codex with both critiques:
   ```bash
   echo "<round-N-prompt>" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-resume \
     --specPath "<spec-path>"
   ```
   Round-N prompt: phase header, round number, the artifact (current draft), `## Critique from previous round` containing both Claude's and Codex's prior critique items, and instruction to revise.

5. Append the round to the sidecar:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-append-round \
     --specPath "<spec-path>" \
     --round '{"phase":"spec","round":N,"claude":"…","codex":"…"}'
   ```
   (See `codex-pairing.md` in this skill folder for full bridge protocol.)

Loop exits when **both** Claude and Codex emit SHIP in the same round, OR after round 7.

### Anti-yes-man rules
- Never accept Codex's revision without independent verification.
- If you disagree, say so explicitly with file/line references.
- Performative agreement is failure. Performative disagreement is also failure.
- See `superpowers:receiving-code-review` (forked version in this plugin once shipped).

### Open contentions
If a critique survives 2 rounds (both sides keep restating opposing views without converging), record it under `## Open Contentions` in the spec AND in the sidecar via `addOpenContention`. Bring it to the user.

## Phase 4 — User sign-off (uncounted)
Show the user the final spec path. Quote the goal + open contentions if any. Wait for explicit "yes" or revisions. If the user requests changes, re-enter the loop at round 1 with the user's input as additional critique.

## Phase 5 — Hand off
Invoke `superpowers:writing-plans` (or this plugin's forked version once shipped). Pass the spec path. The plan-writing skill resumes the same Codex session via the sidecar.

## Failure modes
- **Codex unreachable:** retry once, then surface to user with option to abort or skip the round.
- **Round-7 deadlock:** annotate spec with both positions; user arbitrates; arbitration recorded in sidecar.
- **User overrides Codex:** allowed; recorded under `open_contentions`.
- **Sidecar corruption:** treat as data loss; restart with new session, surface to user.
```

- [ ] **Step 2: Create `skills/brainstorming/codex-pairing.md` (the bridge protocol reference)**

```markdown
# Codex-Pairing Bridge Protocol (reference)

## CLI subcommands available to skills

All commands run via:
```
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js <subcommand> --<flag> <value> ...
```

| Subcommand | Stdin | Effect |
|---|---|---|
| `session-start --specPath <p> --feature <name>` | prompt text | spawns codex, captures session UUID, writes sidecar at `<p>.codex.json`, prints `{sessionId, reply}` JSON |
| `session-resume --specPath <p>` | prompt text | resumes session from sidecar, prints `{sessionId, reply}` JSON |
| `sidecar-show --specPath <p>` | — | prints sidecar JSON |
| `sidecar-append-round --specPath <p> --round <json>` | — | appends a round entry |
| `sidecar-set-slice --specPath <p> --sliceId <id> --state <json>` | — | records slice review state |
| `sidecar-add-contention --specPath <p> --contention <json>` | — | appends open contention |

## Verdict block format

```
<<<VERDICT>>>
status: SHIP | REVISE
critique:
  - point 1
  - point 2
rationale: <one sentence>
<<<END>>>
```

Parser is permissive on whitespace, strict on `status` value (`SHIP` or `REVISE` only). Missing or malformed → synthetic REVISE returned.
```

- [ ] **Step 3: Add the missing CLI subcommands `sidecar-append-round`, `sidecar-set-slice`, `sidecar-add-contention`**

Append to `lib/codex-bridge/cli.js`:

```js
'sidecar-append-round'({ specPath, round }) {
  appendRound(specPath, JSON.parse(round));
},
'sidecar-set-slice'({ specPath, sliceId, state }) {
  setSlice(specPath, sliceId, JSON.parse(state));
},
'sidecar-add-contention'({ specPath, contention }) {
  addOpenContention(specPath, JSON.parse(contention));
},
```

- [ ] **Step 4: Smoke-test the brainstorming skill flow with a tiny synthetic project**

Run (manually, as Claude playing the role of executor):
1. Pick toy project: "build a CLI that says hello".
2. Pretend to gather user intent (just fix a few facts).
3. Run `session-start` with a 1-paragraph "draft a spec for hello-cli" prompt.
4. Inspect `.codex.json` — confirm session UUID, model, reasoning.
5. Run one revision round via `session-resume`, append round to sidecar.
6. Confirm sidecar has 1 round entry.

- [ ] **Step 5: Commit**

```bash
git add skills/brainstorming/ lib/codex-bridge/cli.js
git commit -m "skill: brainstorming (forked) with codex-pairing protocol"
```

---

## Slice 5: writing-plans (forked)

The forked plan-writing skill reuses the same Codex session that brainstorming opened. It adds a plan-review loop after Claude drafts the plan.

**Files:**
- Create: `skills/writing-plans/SKILL.md`

- [ ] **Step 1: Create `skills/writing-plans/SKILL.md`**

Frontmatter:
```yaml
---
name: writing-plans
description: Use after a Codex-paired spec is double-SHIP'd. Claude drafts the implementation plan; Codex reviews via the same session in a 7-round revision loop. Plan ships on double-SHIP.
---
```

Body sections (in full):

```markdown
# Writing Plans (Codex-paired)

## What this changes vs. upstream
- Reuses the Codex session opened by `brainstorming` (via the spec's sidecar).
- After Claude drafts the plan, Codex reviews structure: slice boundaries, task granularity, missing tasks, TDD adequacy, file decomposition.
- 7-round loop applies. Both must SHIP.

## Phase 0 — Locate the sidecar
The plan must be born from a double-SHIP'd spec. Read the spec's frontmatter or use the convention `<plan>` → `<spec>` mapping (plans live under `docs/superpowers/plans/`, specs under `docs/superpowers/specs/`, same date prefix and name).

Verify the sidecar exists and the spec is double-SHIP'd:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-show --specPath "<spec-path>" | jq '.rounds[-1]'
```
Expected: most recent spec-phase round shows `claude: SHIP` and `codex: SHIP`. If not, halt — the spec needs to be shipped first.

## Phase 1 — Draft the plan (Claude alone)
Write the plan locally to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Follow the upstream `superpowers:writing-plans` discipline: file structure first, slices, then bite-sized tasks, exact file paths, no placeholders, complete code.

The plan MUST include in its frontmatter the spec path:
```markdown
**Spec:** `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md`
```

## Phase 2 — Codex plan review (counted, max 7 rounds)
Round 1 prompt (resume the same session):

```bash
PROMPT=$(cat <<'EOF'
Phase: plan-review
Round: 1
The spec we shipped together is at <path>. I have drafted the implementation plan at <plan-path>.
Review the plan against this spec. Critique with L11 rigor. Specifically check:
  1. Slice boundaries: does each slice produce something testable on its own?
  2. Task granularity: are steps 2-5 minutes each?
  3. Missing tasks: any spec requirement without a covering task?
  4. TDD adequacy: is the red-green-refactor explicit?
  5. File decomposition: any file growing too large?
  6. Type/name consistency across tasks?

End with the required verdict block.
<<<PLAN>>>
$(cat <plan-path>)
<<<END_PLAN>>>
EOF
)
echo "$PROMPT" | node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js session-resume --specPath "<spec-path>"
```

Subsequent rounds: send the revised plan + both prior critiques. Same anti-yes-man rules as brainstorming. Same sidecar round logging (phase: `plan`).

## Phase 3 — User sign-off (uncounted)
After double-SHIP, show the user the plan path and quote the slice list. Get a "yes" before handing off to implementation.

## Phase 4 — Hand off
Offer execution choice (matches upstream):
1. Subagent-driven (recommended) → `superpowers:subagent-driven-development` (forked when available)
2. Inline → `superpowers:executing-plans`
```

- [ ] **Step 2: Smoke-test plan-review loop on this very plan**

Read the spec sidecar from slice 4. Resume the session with a small "review this plan" prompt for the current implementation plan. Verify a verdict block comes back. Append a round entry. Confirm sidecar has 1 plan-phase round.

- [ ] **Step 3: Commit**

```bash
git add skills/writing-plans/
git commit -m "skill: writing-plans (forked) with codex review loop"
```

---

## Slice 6: subagent-driven-development (forked) — per-slice review

This is the highest-value forked skill: each slice's diff goes through a scoped Codex review.

**Files:**
- Create: `skills/subagent-driven-development/SKILL.md`
- Create: `skills/subagent-driven-development/slice-review-prompt.md`

- [ ] **Step 1: Create `skills/subagent-driven-development/SKILL.md`**

Frontmatter:
```yaml
---
name: subagent-driven-development
description: Use when executing a Codex-paired plan. After each slice's subagent reports done, runs a scoped Codex review on that slice's diff (max 7 rounds). Codex must respect slice boundaries — out-of-slice issues go to a Deferred list, not blockers.
---
```

Body (in full):

```markdown
# Subagent-Driven Development (Codex-paired)

## What this changes vs. upstream
After each slice's implementing subagent reports completion, Claude runs a **scoped Codex review** before moving to the next slice. The review is locked to the slice's tasks; out-of-scope issues are noted but cannot block.

## Per-slice flow

### Step A: dispatch implementing subagent
Same as upstream — dispatch a subagent for slice N with the slice's tasks. Wait for completion + tests passing.

### Step B: capture slice artifacts
Collect:
- Slice scope: the exact task list from the plan for slice N (literal markdown, the bullet list).
- Diff: `git diff <slice-start-sha>..HEAD -- <files-this-slice-was-meant-to-touch>`
- Test output: pasted verbatim from the subagent's last test run.

### Step C: open Codex slice review
Resume the session. Send the slice-review prompt (see `slice-review-prompt.md` in this skill).

The prompt explicitly states:
> Review only what is in this slice's scope. Out-of-slice issues = note for later in `## Deferred`, do not block on them. If you find an out-of-slice critical bug, name it in `## Deferred` with severity, but ship the slice.

### Step D: 7-round loop
Same as brainstorming. Both must SHIP. Sidecar phase is `slice:<slice-id>` (e.g., `slice:2`). On double-SHIP, mark slice shipped:
```bash
node ${CLAUDE_PLUGIN_ROOT}/lib/codex-bridge/cli.js sidecar-set-slice \
  --specPath "<spec-path>" \
  --sliceId "<slice-id>" \
  --state '{"rounds":[…],"shipped":true,"deferred":[…]}'
```

### Step E: surface deferred items
If the slice review produced any `## Deferred` items, show them to the user before starting the next slice. They might warrant a new task in a future slice or a separate plan.

### Step F: proceed to next slice
Only after slice N is shipped and any user-arbitrated deferreds are decided.

## Anti-scope-creep enforcement
If Codex emits a critique that targets code outside the slice's scope, Claude pushes back: "this is out of slice; either move to Deferred or justify why it must be fixed inside this slice." This is a structural disagreement Codex must justify with concrete reasoning (e.g., "the slice introduces a public API I'm critiquing", which is in-scope).

## Stalled-slice escape
If a slice can't reach double-SHIP in 7 rounds, halt the implementation. Surface the deadlock to the user with both positions. Don't silently downgrade or skip.
```

- [ ] **Step 2: Write `skills/subagent-driven-development/slice-review-prompt.md`** (the templated prompt)

```markdown
Phase: slice-review
Slice ID: {{SLICE_ID}}
Round: {{ROUND}}

## Slice scope (you must respect this boundary)
{{SLICE_TASKS}}

## Diff to review
```diff
{{SLICE_DIFF}}
```

## Test output
```
{{TEST_OUTPUT}}
```

{{#PRIOR_CRITIQUES}}
## Critique from previous round
{{PRIOR_CRITIQUES}}
{{/PRIOR_CRITIQUES}}

## Your job
1. Review the diff against the slice scope only.
2. Apply the L11 rubric: simple, optimal, DRY, honest about scope.
3. If you find issues OUTSIDE this slice's scope, list them under `## Deferred` in your prose — do NOT include them in the verdict critique. Out-of-slice issues never block a slice from shipping.
4. End with the required verdict block.
```

- [ ] **Step 3: Smoke-test on slice 1's diff**

After slice 1 was committed earlier in this implementation, run the slice-review flow against slice 1 itself: build the prompt from the plan's slice 1 tasks + `git diff` for the slice 1 commits + a fake test output. Verify Codex returns a verdict and an L11 critique scoped to manifest files.

- [ ] **Step 4: Commit**

```bash
git add skills/subagent-driven-development/
git commit -m "skill: subagent-driven-development (forked) with scoped slice review"
```

---

## Slice 7: receiving-code-review (forked)

Codifies the anti-yes-man discipline. Smaller slice — content-heavy, no new code.

**Files:**
- Create: `skills/receiving-code-review/SKILL.md`

- [ ] **Step 1: Create `skills/receiving-code-review/SKILL.md`**

Frontmatter:
```yaml
---
name: receiving-code-review
description: Use whenever Codex (or a human) returns a review verdict. Required to prevent Claude from rubber-stamping or performative-disagreeing. Verify before accepting; articulate disagreement with file/line specifics.
---
```

Body (in full):

```markdown
# Receiving Code Review (Codex-paired)

## What this changes vs. upstream
Adds explicit anti-rubber-stamp rules for handling Codex's `<<<VERDICT>>>` blocks. The discipline applies to all reviewers, but the bar is highest for Codex because Codex is paired with you — agreement matters structurally.

## The four rules

### 1. Read slowly
Read every critique item once for what it says, then once more for what it implies about the code. If you don't fully understand a critique, ask Codex to clarify before responding.

### 2. Verify against actual code
Before accepting any critique, open the cited file/line and confirm the claim. Critiques can be wrong:
- Wrong file or line.
- Misreading control flow.
- Out-of-date assumption about the codebase.
If the critique is factually wrong, say so with the actual code excerpt. Do not silently accept.

### 3. Articulate disagreement, don't paper over it
If you disagree:
- Quote the specific critique item.
- Cite the file/line and the actual behavior.
- Explain why the critique is wrong OR why the trade-off Codex objects to is correct in context.
- Say what would change your mind.

If Codex's reply doesn't engage with your reasoning and just restates the original critique, push back again. Two such back-and-forths and the disagreement is "open contention" — record it.

### 4. No performative anything
- "Good catch, fixing now" without reading the critique = rubber stamp = failure.
- "I disagree" with no specifics = posturing = failure.
- "Let me think about it" with no follow-up = avoidance = failure.

The only acceptable shapes: agree-with-evidence, disagree-with-evidence, request-clarification.

## When to escalate
- Same critique survives 3 rounds with neither side conceding → record as open contention, surface to user.
- Codex's verdict block is malformed twice in a row → surface to user with raw output (might be a model regression).
- A critique would change spec scope → push back: "this is a spec change; let's record as open contention and bring to user."

## Sidecar logging
Both your verdict and Codex's must be recorded each round (the bridge does this automatically via `appendRound`). Don't skip rounds. Don't summarize multiple rounds into one.
```

- [ ] **Step 2: Commit**

```bash
git add skills/receiving-code-review/
git commit -m "skill: receiving-code-review (forked) with anti-yes-man discipline"
```

---

## Slice 8: systematic-debugging (forked)

**Files:**
- Create: `skills/systematic-debugging/SKILL.md`

- [ ] **Step 1: Create `skills/systematic-debugging/SKILL.md`**

Frontmatter:
```yaml
---
name: systematic-debugging
description: Use when a bug is non-trivial. Claude forms hypothesis → Codex critiques → 7-round loop on root cause → fix → slice review on the fix.
---
```

Body (in full):

```markdown
# Systematic Debugging (Codex-paired)

## What this changes vs. upstream
After Claude forms a root-cause hypothesis, Codex reviews the hypothesis (not just the fix). The hypothesis itself is the artifact under the 7-round loop. Once the hypothesis is double-SHIP'd, the fix follows the standard slice-review flow.

## When to invoke
Trivial bugs (typos, obvious off-by-one) skip this — just fix. Use this for: intermittent failures, multi-system interactions, behavior that contradicts your mental model, "shouldn't be possible" bugs.

## Phase 0 — Reproduce
Standard upstream discipline: minimal reproduction, deterministic, captured as a failing test if possible. Don't move on until you can reproduce on demand.

## Phase 1 — Form hypothesis (Claude)
Write a 1-paragraph hypothesis: WHAT is wrong, WHERE in the code, WHY this manifests as the symptom. Cite specific files/lines. Predict an experiment that would falsify it.

## Phase 2 — Codex hypothesis review (counted, max 7 rounds)
Open or resume a session for this feature/bug. Send:

```
Phase: debug-hypothesis
Round: N

## Symptom
{{SYMPTOM}}

## Reproduction
{{REPRO_STEPS}}

## My hypothesis
{{HYPOTHESIS}}

## Falsification experiment
{{EXPERIMENT}}

## Your job
- Is this the simplest explanation?
- What did I miss? Other plausible root causes I should rule out first?
- Does the falsification experiment actually rule it out?
- End with the required verdict block.
```

Codex's critiques are typically: "you're assuming X but Y could also cause this", "your experiment doesn't actually falsify", "simpler explanation is Z".

Round loop runs as before. Sidecar phase is `debug:<short-bug-id>`.

## Phase 3 — Run the falsification experiment
Only after the hypothesis is double-SHIP'd. The experiment confirms or kills the hypothesis. If killed, restart at Phase 1 with new hypothesis (new round count).

## Phase 4 — Implement the fix
Standard TDD: write the failing regression test that the hypothesis predicts, implement the minimal fix, verify the test passes and the symptom is gone.

## Phase 5 — Slice-review the fix
The fix is a slice (even a one-task slice). Run it through `subagent-driven-development`'s per-slice review.

## Failure modes
- **Multiple hypotheses double-SHIP'd, all falsified:** the bug is in your reproduction, not your hypothesis. Go back to Phase 0.
- **7-round deadlock on hypothesis:** halt; bring to user with both positions and the symptom.
```

- [ ] **Step 2: Commit**

```bash
git add skills/systematic-debugging/
git commit -m "skill: systematic-debugging (forked) with hypothesis review loop"
```

---

## Slice 9: test-driven-development (forked)

**Files:**
- Create: `skills/test-driven-development/SKILL.md`

- [ ] **Step 1: Create `skills/test-driven-development/SKILL.md`**

Frontmatter:
```yaml
---
name: test-driven-development
description: Use before writing any non-trivial test suite. Claude drafts the test list; Codex reviews coverage, edge cases, and mock/integration trade-offs in a 7-round loop. Then standard red-green-refactor proceeds.
---
```

Body (in full):

```markdown
# Test-Driven Development (Codex-paired)

## What this changes vs. upstream
Before red-green-refactor, the **test list** itself is reviewed by Codex. Catches: missing edge cases, redundant tests, wrong test boundaries, mock-vs-integration mistakes — before any test code is written.

## When to invoke
Any slice with non-trivial test design. Skip for one-test-one-function slices where the design is obvious.

## Phase 0 — Draft the test list (Claude)
Write a numbered list of test cases. Each entry:
1. What invariant or behavior it pins.
2. Inputs / preconditions.
3. Expected outcome.
4. Mocks/integration choice + justification.

## Phase 1 — Codex test-list review (counted, max 7 rounds)
Resume the session for this feature. Send:

```
Phase: tdd-review
Round: N

## Slice context
{{SLICE_NAME}} — {{SLICE_GOAL}}

## Test list under review
{{TEST_LIST}}

## Your job
- Missing edge cases? (zero, negative, null, off-by-one, concurrent, large input, …)
- Redundant tests testing the same path?
- Wrong boundary? (testing implementation when behavior is what matters, or vice versa)
- Mock/integration: are mocks hiding real failure modes?
- Pinning the right invariants?
- End with the required verdict block.
```

Sidecar phase is `tdd:<slice-id>`.

## Phase 2 — Implement red-green-refactor
After double-SHIP, write the failing tests in the agreed order. Standard TDD discipline applies — see upstream `superpowers:test-driven-development` for the red/green/refactor cadence; this fork adds only the up-front review.

## Phase 3 — Slice-review the test suite + implementation
At slice review time, the test suite is part of the diff. Codex's slice review will catch any divergence from the agreed test list (and may push for more, which is in-scope critique).
```

- [ ] **Step 2: Commit**

```bash
git add skills/test-driven-development/
git commit -m "skill: test-driven-development (forked) with test-list review loop"
```

---

## Slice 10: Install + smoke + docs

**Files:**
- Modify: `README.md` — full install + usage section
- Create: `docs/install.md` — detailed install reference
- Modify: `lib/codex-bridge/cli.js` — final pass (any subcommands missed)

- [ ] **Step 1: Update `README.md` with install instructions**

Append:

```markdown
## Install

This plugin lives at `/Users/mkr/local-coding/plugins/codex-paired-superpowers`. Install via the personal local marketplace:

```bash
# 1) Add the local marketplace (one-time)
claude plugin marketplace add /Users/mkr/local-coding/plugins

# 2) Install this plugin
claude plugin install codex-paired-superpowers@mkr-personal

# 3) Reload
claude plugin reload
```

If you don't have the `claude plugin` subcommand from your terminal, you can also use the `/plugin` slash command inside Claude Code.

## Prerequisites
- `codex` CLI v0.128.0+ on PATH, authenticated against an account with GPT-5.5 access.
- Node.js v20+ (built-in test runner used; v24+ tested).

## Usage

In any project, the six skills auto-trigger via Claude's normal skill dispatching:

- Starting creative work? → `brainstorming` (forked) opens a Codex session, drafts the spec, runs the 7-round loop.
- Plan ready to write? → `writing-plans` (forked) runs the plan through the same Codex session.
- Implementing? → `subagent-driven-development` (forked) reviews each slice's diff scoped to that slice.
- Receiving review? → `receiving-code-review` (forked) governs how Claude evaluates Codex's verdicts.
- Tough bug? → `systematic-debugging` (forked) runs hypothesis review.
- Designing tests? → `test-driven-development` (forked) reviews the test list.

Per-feature state lives in `<spec-path>.codex.json` next to the spec. Don't commit it (already in `.gitignore`).

## Configuration

Defaults (no config needed):
- Model: `gpt-5.5`
- Reasoning: `high`
- Max rounds: 7

Overrides (env var, per-invocation):
```bash
CODEX_PAIRED_MODEL=gpt-5.5 CODEX_PAIRED_REASONING=high claude
```
```

- [ ] **Step 2: Run the full test suite one more time**

Run: `cd /Users/mkr/local-coding/plugins/codex-paired-superpowers && npm test`
Expected: all tests pass (sidecar, verdict, invoke, loop).

- [ ] **Step 3: Install the plugin locally**

Run:
```bash
claude plugin marketplace add /Users/mkr/local-coding/plugins
claude plugin install codex-paired-superpowers@mkr-personal
```
Expected: success messages; plugin appears in `claude plugin list`.

(If the `claude plugin` CLI doesn't exist in this version, fall back to using `/plugin` inside Claude Code; document that path in `docs/install.md`.)

- [ ] **Step 4: End-to-end smoke test (real codex)**

Spin up a tiny synthetic project in `/tmp/cps-e2e/`:
1. Create `/tmp/cps-e2e/` and a one-line README "build a CLI that prints hello".
2. From a fresh Claude Code session in that directory, ask Claude to "design and implement a hello CLI".
3. Verify Claude triggers `brainstorming` (forked); a Codex session is opened; sidecar JSON is created at `docs/superpowers/specs/<date>-hello-cli-design.md.codex.json`.
4. Verify the spec gets a double-SHIP within 7 rounds.
5. Verify `writing-plans` runs and produces a plan with double-SHIP.
6. Verify slice review fires after the first slice's subagent finishes.
7. Inspect the sidecar — should contain rounds for `spec`, `plan`, and `slice:1`.

- [ ] **Step 5: Document any quirks discovered during smoke test**

Append a "Known issues" section to README.md and `docs/install.md` for anything found.

- [ ] **Step 6: Final commit + tag**

```bash
git add README.md docs/install.md lib/codex-bridge/cli.js
git commit -m "docs: install + usage; v0.1.0 ready"
git tag v0.1.0
```

---

## Self-Review (post-write)

Spec coverage:
- Question routing → covered in slice 4 brainstorming SKILL.md (Phase 0/1) and system-rubric prompt.
- 7-round loop → slice 3 implementation, slices 4–9 wiring.
- Both must SHIP → slice 3 `runRoundLoop` + tests.
- One Codex thread per feature → sidecar persistence (slice 2) + resume in slices 4–9.
- Sidecar schema → slice 2 implementation + tests match spec exactly.
- Direct codex exec transport → slice 2 invoke.js with `-m gpt-5.5 -c model_reasoning_effort=high`.
- Verdict protocol → slice 3 verdict.js + verdict-format.md prompt.
- Six v1 plug-ins → slices 4–9 (one each).
- Anti-yes-man → slice 7 + woven into slices 4, 5, 6, 8, 9.
- Failure modes (codex unreachable, deadlock, sidecar corruption, user override) → addressed in slice 4 SKILL.md and across other forked skills.
- Per-slice scope locking → slice 6 explicit anti-scope-creep section + slice-review-prompt.md.
- Plugin install path → slice 1 + slice 10.
- Sidecar discovery from plan/code → slice 5 (frontmatter convention).

Placeholder scan: no TBDs, all code blocks are complete, all file paths absolute or clearly relative.

Type consistency: `sidecarPathFor`, `initSidecar`, `loadSidecar`, `appendRound`, `setSlice`, `addOpenContention` used consistently across slices. CLI subcommand names consistent (`session-start`, `session-resume`, `sidecar-show`, `sidecar-append-round`, `sidecar-set-slice`, `sidecar-add-contention`, `run-loop`).

No spec gaps detected.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-07-codex-paired-superpowers.md`.

**Two execution options:**

1. **Subagent-driven** (recommended) — `superpowers:subagent-driven-development` dispatches a fresh subagent per task, review between tasks, fast iteration. Note: the *forked* version of this skill doesn't exist yet; use upstream until slice 6 ships, then optionally switch to the forked version for remaining slices.

2. **Inline execution** — `superpowers:executing-plans` runs tasks in this session with checkpoints.

**Which approach?**
