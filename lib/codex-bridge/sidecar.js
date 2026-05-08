import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, basename, join, relative, sep, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Module-scoped Set for one-time-per-process deprecation warning deduplication.
const warnedPaths = new Set();

/**
 * Find the git repo root starting from startDir.
 * Returns the realpath'd root string, or null if not in a git repo or on error.
 */
function findRepoRoot(startDir) {
  try {
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return realpathSync(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Check whether `child` is contained under `parent`.
 * Both paths must already be realpath'd. Uses sep-anchored prefix match to
 * prevent /repo-old from matching /repo.
 */
function isContained(child, parent) {
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  const childWithSep = child.endsWith(sep) ? child : child + sep;
  return childWithSep.startsWith(parentWithSep);
}

export function sidecarPathFor(specPath) {
  // 1. Resolve to absolute path.
  const absSpec = isAbsolute(specPath) ? specPath : resolve(specPath);

  // 2. Try realpath (file may not exist yet on first-write; fall back to absSpec).
  let realSpec;
  try {
    realSpec = realpathSync(absSpec);
  } catch {
    realSpec = absSpec;
  }

  // 3. Legacy path (used as fallback and during transition).
  const legacy = absSpec + '.codex.json';

  // 4. Find the repo root from the spec's directory.
  const repoRoot = findRepoRoot(dirname(realSpec));

  // 5. Fall back to legacy if not in a repo or spec is not contained in it.
  if (!repoRoot || !isContained(realSpec, repoRoot)) {
    return legacy;
  }

  // 6. Compute the hidden-dir path.
  const hidden = join(repoRoot, '.superpowers-codex-paired', relative(repoRoot, realSpec) + '.json');

  // 7. Discovery rule: hidden wins; legacy-only emits a one-time deprecation warning.
  if (existsSync(hidden)) {
    return hidden;
  } else if (existsSync(legacy)) {
    if (!warnedPaths.has(legacy)) {
      process.stderr.write(
        `[codex-paired-superpowers] DEPRECATION WARNING: sidecar at legacy path ${legacy}; ` +
        `move to ${hidden} via scripts/migrate-sidecars-to-hidden-dir.sh\n`
      );
      warnedPaths.add(legacy);
    }
    return legacy;
  } else {
    // First write: target is the hidden-dir path.
    return hidden;
  }
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
  // Atomic write: mkdir-p the parent, write to temp file, then rename.
  // mkdir-p is required for nested hidden paths (e.g. .superpowers-codex-paired/docs/a/b/c/).
  const target = sidecarPathFor(specPath);
  mkdirSync(dirname(target), { recursive: true });
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
