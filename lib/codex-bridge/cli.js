#!/usr/bin/env node
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
Promise.resolve(fn(parseArgs(rest))).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
