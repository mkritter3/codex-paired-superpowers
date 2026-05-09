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
import { writeAnchor, readAnchor, clearAnchor } from './active-anchor.js';
import { parseValidationCoverage } from './validation-coverage.js';
import { parseLiveValidationCoverage } from './live-validation-coverage.js';
import { parseScenarioList } from './scenario-validator.js';

const [, , subcmd, ...rest] = process.argv;

/**
 * Read all of stdin as a UTF-8 string. Resolves when stdin closes.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

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
  async 'validation-parse'({ tier }) {
    const raw = await readStdin();
    let critique;
    try {
      critique = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(JSON.stringify({ defect: 'invalid-json-input', detail: e.message }));
      process.exit(2);
    }
    const result = parseValidationCoverage(critique, tier ? { tier } : {});
    if (result.ok) {
      process.stdout.write(JSON.stringify({ tier: result.tier, coverage: result.coverage }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },
  async 'scenario-validate'({ 'require-scenarios': requireScenariosFlag }) {
    const raw = await readStdin();
    const opts = {};
    if (requireScenariosFlag !== undefined) {
      opts.requireScenarios = true;
    }
    const result = parseScenarioList(raw, opts);
    if (result.ok) {
      process.stdout.write(JSON.stringify({ ok: true, scenarios: result.scenarios, deferred: result.deferred }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },
  async 'live-validation-parse'({ tier }) {
    const raw = await readStdin();
    let critique;
    try {
      critique = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(JSON.stringify({ defect: 'invalid-json-input', detail: e.message }));
      process.exit(2);
    }
    const result = parseLiveValidationCoverage(critique, tier ? { tier } : {});
    if (result.ok) {
      process.stdout.write(JSON.stringify({ tier: result.tier, coverage: result.coverage }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },
};

function parseArgs(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    const nextVal = rest[i + 1];
    // If the next element is absent or starts with '--', treat this flag as boolean true.
    if (nextVal === undefined || nextVal.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = nextVal;
      i++; // consume the value
    }
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
