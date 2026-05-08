#!/usr/bin/env node
// Bridge CLI for codex-paired-superpowers.
//
// As of v0.2.0, Codex itself is invoked via the bundled MCP server
// (mcp__plugin_codex-paired-superpowers_codex__codex / codex-reply).
// This CLI is responsible only for the per-feature sidecar JSON:
// initializing it after Claude opens the MCP session, appending rounds,
// recording slice reviews, and tracking open contentions.
import {
  initSidecar,
  loadSidecar,
  appendRound,
  setSlice,
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
    // Convenience: print just the threadId so skills can `$(...)` it.
    process.stdout.write(loadSidecar(specPath).codex_session);
  },
  'sidecar-append-round'({ specPath, round }) {
    appendRound(specPath, JSON.parse(round));
  },
  'sidecar-set-slice'({ specPath, sliceId, state }) {
    setSlice(specPath, sliceId, JSON.parse(state));
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
