#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USER_FACING_SCRIPTS = [
  'scripts/codex-exec-with-status.sh',
  'scripts/migrate-sidecars-to-hidden-dir.sh',
  'bin/codex-paired-doctor',
];

const INCOMPATIBLE = [
  /\bdeclare\s+-A\b/,
  /\bmapfile\b/,
  /\breadarray\b/,
  /\$\{[^}\n]+,,\}/,
  /\$\{[^}\n]+\^\^\}/,
  /&>>/,
];

const requested = process.argv.slice(2);
const paths = requested.length > 0 ? requested : USER_FACING_SCRIPTS;
const findings = [];

for (const requestedPath of paths) {
  const absolute = isAbsolute(requestedPath) ? requestedPath : join(REPO_ROOT, requestedPath);
  const shown = relative(REPO_ROOT, absolute) || requestedPath;
  const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (INCOMPATIBLE.some((pattern) => pattern.test(lines[index]))) {
      findings.push(`${shown}:${index + 1}`);
    }
  }
}

if (findings.length > 0) {
  process.stdout.write(`${findings.join('\n')}\n`);
  process.exitCode = 1;
}
