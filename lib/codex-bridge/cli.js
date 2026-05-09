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
  setLiveVerification,
} from './sidecar.js';
import { writeAnchor, readAnchor, clearAnchor } from './active-anchor.js';
import { parseValidationCoverage } from './validation-coverage.js';
import { parseLiveValidationCoverage } from './live-validation-coverage.js';
import { parseScenarioList } from './scenario-validator.js';
import { parseSkipFrontmatter } from './skip-frontmatter.js';
import { parseImplementerDirective, parseFilesBlock } from './plan-parsers.js';
import { readFileSync } from 'node:fs';

const [, , subcmd, ...rest] = process.argv;

/**
 * Extract the body of a `## Slice N: ...` section from a plan markdown.
 * Returns the text between the matching `## Slice N:` header (exclusive) and
 * the next `## Slice <M>:` header (exclusive). If no matching header exists,
 * returns null.
 *
 * @param {string} planText
 * @param {number} sliceNum
 * @returns {string | null}
 */
function extractSliceSection(planText, sliceNum) {
  // Match `## Slice N: ...` heading. Whitespace-tolerant on the spaces around
  // `Slice N:`. Case-sensitive on the literal `Slice`.
  const startRe = new RegExp(
    `^##\\s+Slice\\s+${sliceNum}\\s*:\\s*.*$`,
    'm',
  );
  const startMatch = planText.match(startRe);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }
  const afterHeader = planText.slice(startMatch.index + startMatch[0].length);
  // Find the next `## Slice <M>:` header (any number).
  const nextRe = /^##\s+Slice\s+\d+\s*:/m;
  const nextMatch = afterHeader.match(nextRe);
  if (!nextMatch || nextMatch.index === undefined) {
    return afterHeader;
  }
  return afterHeader.slice(0, nextMatch.index);
}

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
  /**
   * Set one or more keys in the live-verification phase block for a slice.
   * Accepts --sliceId and --block (JSON object whose keys are merged into the live-verification block).
   * Example: cli sidecar-set-live-verification --specPath ... --sliceId slice-1 --block '{"shipped":true}'
   */
  'sidecar-set-live-verification'({ specPath, sliceId, block }) {
    const updates = JSON.parse(block);
    for (const [key, value] of Object.entries(updates)) {
      setLiveVerification(specPath, sliceId, key, value);
    }
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
  'parse-implementer-directive'({ planPath, sliceId }) {
    if (!planPath) {
      process.stderr.write('parse-implementer-directive: --planPath is required\n');
      process.exit(1);
    }
    if (sliceId === undefined || sliceId === null || sliceId === '') {
      process.stderr.write('parse-implementer-directive: --sliceId is required (numeric, e.g. 3)\n');
      process.exit(1);
    }
    // Accept either bare number ("3") or "slice-3" form; normalize to integer.
    const m = String(sliceId).match(/^(?:slice-)?(\d+)$/);
    if (!m) {
      process.stderr.write(`parse-implementer-directive: invalid --sliceId "${sliceId}"; expected numeric or slice-N\n`);
      process.exit(1);
    }
    const sliceNum = parseInt(m[1], 10);
    let planText;
    try {
      planText = readFileSync(planPath, 'utf8');
    } catch (e) {
      process.stderr.write(`parse-implementer-directive: failed to read ${planPath}: ${e.message}\n`);
      process.exit(1);
    }
    const section = extractSliceSection(planText, sliceNum);
    if (section === null) {
      process.stderr.write(JSON.stringify({
        defect: 'slice-section-missing',
        detail: `could not find "## Slice ${sliceNum}: ..." header in ${planPath}`,
      }));
      process.exit(2);
    }
    const result = parseImplementerDirective(section);
    if ('defect' in result) {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail }));
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({ implementer: result.implementer }));
    process.exit(0);
  },
  'parse-files-block'({ planPath, sliceId }) {
    if (!planPath) {
      process.stderr.write('parse-files-block: --planPath is required\n');
      process.exit(1);
    }
    if (sliceId === undefined || sliceId === null || sliceId === '') {
      process.stderr.write('parse-files-block: --sliceId is required (numeric, e.g. 3)\n');
      process.exit(1);
    }
    // Accept either bare number ("3") or "slice-3" form; normalize to integer.
    let sliceNum;
    const m = String(sliceId).match(/^(?:slice-)?(\d+)$/);
    if (!m) {
      process.stderr.write(`parse-files-block: invalid --sliceId "${sliceId}"; expected numeric or slice-N\n`);
      process.exit(1);
    }
    sliceNum = parseInt(m[1], 10);
    let planText;
    try {
      planText = readFileSync(planPath, 'utf8');
    } catch (e) {
      process.stderr.write(`parse-files-block: failed to read ${planPath}: ${e.message}\n`);
      process.exit(1);
    }
    const section = extractSliceSection(planText, sliceNum);
    if (section === null) {
      process.stderr.write(JSON.stringify({
        defect: 'slice-section-missing',
        detail: `could not find "## Slice ${sliceNum}: ..." header in ${planPath}`,
      }));
      process.exit(2);
    }
    const result = parseFilesBlock(section);
    if ('defect' in result) {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail }));
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({ files: result.files }));
    process.exit(0);
  },
  async 'parse-skip-frontmatter'() {
    const sliceMarkdown = await readStdin();
    const result = parseSkipFrontmatter(sliceMarkdown);
    if (result.error) {
      process.stderr.write(JSON.stringify({ defect: result.error.code, detail: result.error.detail }));
      process.exit(2);
    } else {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
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
