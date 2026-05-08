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
