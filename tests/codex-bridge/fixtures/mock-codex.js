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

// Match real `codex exec` behavior: preamble + transcript on stderr,
// assistant reply alone on stdout.
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
`;
process.stderr.write(preamble);
process.stdout.write(reply + '\n');
process.exit(0);
