#!/usr/bin/env node
// Test Impact Analysis (TIA) — coverage-based affected-test selection for `node --test`.
//
// WHY coverage-based (not static import graph): this repo's tests spawn `node cli.js` via
// execFileSync and read fixtures from disk — dependencies a static import graph cannot see.
// Coverage records what each test ACTUALLY loads/executes (and because NODE_V8_COVERAGE is an env
// var inherited by child processes, spawned `node` children write coverage to the same dir, so
// cross-process deps are captured too).
//
// ROBUSTNESS over speed: when anything shared/global changes, or the map is missing/stale, or a
// changed source file is not covered by any known test, we fall back to running the FULL suite.
// The cardinal rule is "never skip a test that should run" — over-running is acceptable, under-
// running is not.
//
// Usage:
//   node scripts/tia.mjs build [--all]          Build/refresh the full dep map (runs every test
//                                               under coverage; --all includes installed-smoke/replay).
//   node scripts/tia.mjs affected [--base <ref>] Print the selection decision as JSON (no run).
//   node scripts/tia.mjs run [--base <ref>]     Select and run: full suite, the affected subset, or
//                                               nothing. Refreshes map entries for tests it runs.
//
// --base <ref>: compare against a git ref (includes commits since <ref> plus working-tree changes).
//   Default: working-tree changes vs HEAD (staged + unstaged + untracked) — the local-iteration case.
//
// Map limitation: coverage reflects the LAST run of each test. If a test's real deps grow without the
// test file or a known dep changing, the map can go stale. Mitigations: new/changed test files always
// run (and refresh), changed-but-uncovered source forces a full run, and `build` does a clean refresh.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const CACHE_DIR = join(REPO_ROOT, '.tia-cache');
const MAP_PATH = join(CACHE_DIR, 'map.json');
const MAP_VERSION = 1;

// Changing any of these invalidates ALL selection assumptions → run the full suite.
// (Tracked source under lib/ and bin/ is handled per-test via coverage; these are the shared roots.)
const GLOBAL_TRIGGER_RES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^scripts\//,            // the runner, collect-test-files, release gates
  /^tests\/fixtures\//,    // shared test fixtures
  /^\.claude-plugin\//,    // manifest/config consumed broadly
];

// A repo-relative path is a "tracked source" dependency if it lives under these roots.
const SOURCE_ROOT_RES = [/^lib\//, /^bin\//];

const isTestFile = (p) => /(^|\/)tests\/.*\.test\.js$/.test(p);

// ── pure helpers (exported for unit tests) ─────────────────────────────────

export function fileHash(absPath) {
  try {
    return createHash('sha1').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null; // missing/deleted
  }
}

export function isGlobalTrigger(relPath) {
  return GLOBAL_TRIGGER_RES.some((re) => re.test(relPath));
}

export function isTrackedSource(relPath) {
  return SOURCE_ROOT_RES.some((re) => re.test(relPath));
}

/**
 * Pure selection decision.
 * @param {object} args
 * @param {string[]} args.changed         repo-relative changed paths
 * @param {object|null} args.map          loaded map.json (or null if missing/invalid)
 * @param {string[]} args.allTestFiles    repo-relative current test files (from collect-test-files)
 * @param {(rel:string)=>string|null} args.hashOf  current hash of a repo-relative file
 * @param {string} args.nodeVersion       process.version
 * @returns {{mode:'all'|'selected'|'none', tests:string[], reason:string}}
 */
export function selectTests({ changed, map, allTestFiles, hashOf, nodeVersion }) {
  if (!map || !map.tests || map.version !== MAP_VERSION) {
    return { mode: 'all', tests: allTestFiles, reason: 'no-map (run `tia build` to enable selection)' };
  }
  if (map.node && nodeVersion && map.node !== nodeVersion) {
    return { mode: 'all', tests: allTestFiles, reason: `node-version-changed (${map.node} → ${nodeVersion})` };
  }
  const globalHit = changed.find((c) => isGlobalTrigger(c));
  if (globalHit) {
    return { mode: 'all', tests: allTestFiles, reason: `global-trigger changed: ${globalHit}` };
  }

  const changedSet = new Set(changed);
  const impacted = new Set();

  // 1) test files that are new or whose content changed
  for (const t of allTestFiles) {
    if (!map.tests[t]) { impacted.add(t); continue; }            // new test → run it (refreshes map)
    if (changedSet.has(t) && map.tests[t].hash !== hashOf(t)) impacted.add(t);
  }
  // 2) test files whose recorded deps intersect the change set
  for (const [t, entry] of Object.entries(map.tests)) {
    if (!allTestFiles.includes(t)) continue;                     // deleted/renamed test, skip
    if ((entry.deps || []).some((d) => changedSet.has(d))) impacted.add(t);
  }
  // 3) ROBUSTNESS: a changed tracked-source file that NO test is known to cover might be
  //    dynamically loaded (or newly added) — fall back to full rather than risk skipping.
  const coveredDeps = new Set();
  for (const entry of Object.values(map.tests)) for (const d of entry.deps || []) coveredDeps.add(d);
  const uncovered = changed.filter((c) => isTrackedSource(c) && !coveredDeps.has(c) && !isTestFile(c));
  if (uncovered.length > 0) {
    return { mode: 'all', tests: allTestFiles, reason: `changed source not covered by map: ${uncovered.join(', ')}` };
  }

  if (impacted.size === 0) return { mode: 'none', tests: [], reason: 'no affected tests' };
  return { mode: 'selected', tests: [...impacted].sort(), reason: `${impacted.size} affected test file(s)` };
}

// ── git + fs (impure) ──────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function getChangedFiles(base) {
  const out = new Set();
  const add = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean).forEach((f) => out.add(f));
  try {
    if (base) {
      // commits since <base> (merge-base ... HEAD) plus working tree
      add(git(['diff', '--name-only', `${base}...HEAD`]));
    }
    add(git(['diff', '--name-only', 'HEAD']));               // staged + unstaged vs HEAD
    add(git(['ls-files', '--others', '--exclude-standard'])); // untracked
  } catch (e) {
    // If git fails (e.g. bad base ref), be conservative: signal "unknown" via a global trigger path.
    return { files: ['package.json'], gitError: e.message };
  }
  return { files: [...out], gitError: null };
}

function listAllTestFiles(all = false) {
  const args = ['scripts/collect-test-files.mjs'];
  if (all) args.push('--all');
  const out = execFileSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  return out.split(/\s+/).filter(Boolean).map((p) => relative(REPO_ROOT, resolve(REPO_ROOT, p)));
}

function loadMap() {
  try {
    return JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveMap(map) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
}

// Run ONE test file under isolated V8 coverage; return the set of repo-relative tracked-source deps
// it loaded (including those loaded by spawned child `node` processes that inherit NODE_V8_COVERAGE).
function depsForTest(testFile) {
  const covDir = mkdtempSync(join(tmpdir(), 'tia-cov-'));
  try {
    try {
      execFileSync('node', ['--test', testFile], {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
        stdio: 'ignore',
        timeout: 180_000,
      });
    } catch {
      // A failing/flaky test still produces coverage; we record its deps regardless of pass/fail.
    }
    const deps = new Set();
    for (const f of readdirSync(covDir)) {
      if (!f.endsWith('.json')) continue;
      let cov;
      try { cov = JSON.parse(readFileSync(join(covDir, f), 'utf8')); } catch { continue; }
      for (const script of cov.result || []) {
        if (typeof script.url !== 'string' || !script.url.startsWith('file://')) continue;
        let abs;
        try { abs = fileURLToPath(script.url); } catch { continue; }
        if (!abs.startsWith(REPO_ROOT + '/')) continue;
        const rel = relative(REPO_ROOT, abs);
        if (rel.includes('node_modules/')) continue;
        if (isTrackedSource(rel)) deps.add(rel); // loaded a tracked source file → dependency
      }
    }
    return [...deps].sort();
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

function buildMapFor(testFiles, existing) {
  const map = existing && existing.version === MAP_VERSION
    ? existing
    : { version: MAP_VERSION, node: process.version, builtAt: null, tests: {} };
  map.node = process.version;
  let i = 0;
  for (const t of testFiles) {
    i += 1;
    process.stderr.write(`[tia] mapping (${i}/${testFiles.length}) ${t}\n`);
    map.tests[t] = { hash: fileHash(join(REPO_ROOT, t)), deps: depsForTest(t) };
  }
  map.builtAt = new Date().toISOString();
  saveMap(map);
  return map;
}

function runTests(testFiles) {
  if (testFiles.length === 0) return 0;
  try {
    execFileSync('node', ['--test', ...testFiles], { cwd: REPO_ROOT, stdio: 'inherit' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : 1;
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = { all: false, base: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') flags.all = true;
    else if (argv[i] === '--base') flags.base = argv[++i];
  }
  return flags;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (cmd === 'build') {
    const tests = listAllTestFiles(flags.all);
    buildMapFor(tests, loadMap());
    process.stderr.write(`[tia] map written to ${relative(REPO_ROOT, MAP_PATH)} (${tests.length} tests)\n`);
    return 0;
  }

  const allTestFiles = listAllTestFiles(false);
  const { files: changed, gitError } = getChangedFiles(flags.base);
  if (gitError) process.stderr.write(`[tia] git diff failed (${gitError}); falling back to full run\n`);
  const decision = selectTests({
    changed, map: loadMap(), allTestFiles,
    hashOf: (rel) => fileHash(join(REPO_ROOT, rel)),
    nodeVersion: process.version,
  });

  if (cmd === 'affected') {
    process.stdout.write(JSON.stringify({ ...decision, changed }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'run') {
    process.stderr.write(`[tia] ${decision.mode}: ${decision.reason}\n`);
    if (decision.mode === 'none') return 0;
    if (decision.mode === 'all') return runTests(allTestFiles);
    // selected: run the subset, then refresh those entries so the map stays warm
    const status = runTests(decision.tests);
    try { buildMapFor(decision.tests, loadMap()); } catch (e) {
      process.stderr.write(`[tia] map refresh skipped: ${e.message}\n`);
    }
    return status;
  }

  process.stderr.write('usage: tia.mjs <build|affected|run> [--base <ref>] [--all]\n');
  return 2;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
