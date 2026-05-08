import { spawn } from 'node:child_process';

const DEFAULTS = {
  model: 'gpt-5.5',
  reasoningEffort: 'high',
  codexBin: 'codex',
};

const SESSION_RX = /^session id:\s*([0-9a-f-]{36})\s*$/im;

function runCodex(args, { prompt, env = {}, codexBin }) {
  return new Promise((resolve, reject) => {
    // If the binary is a .js file, spawn via `node` to avoid shebang/ESM issues
    const [cmd, cmdArgs] = codexBin.endsWith('.js')
      ? ['node', [codexBin, ...args]]
      : [codexBin, args];

    const child = spawn(cmd, cmdArgs, {
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
        resolve({ stdout: out, stderr: err });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseOutput({ stdout, stderr }) {
  // codex writes the preamble (incl. session id) and full transcript to stderr;
  // the assistant's reply alone goes to stdout.
  const idMatch = stderr.match(SESSION_RX);
  const sessionId = idMatch ? idMatch[1] : null;
  const reply = stdout.trim();
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
    '-',
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
