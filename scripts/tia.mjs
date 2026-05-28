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
// v2: entries carry an `ok` trust bit (v1 maps had none, so a v1 entry from a failed run would be
// wrongly trusted). Bumping the version rejects pre-v2 maps → forces a clean rebuild.
const MAP_VERSION = 2;

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
  const full = (reason, uncovered = []) => ({ mode: 'all', tests: allTestFiles, reason, fullyCovered: false, uncovered });

  if (!map || !map.tests || map.version !== MAP_VERSION) {
    return full('no-map (run `tia build` to enable selection)');
  }
  if (map.node && nodeVersion && map.node !== nodeVersion) {
    return full(`node-version-changed (${map.node} → ${nodeVersion})`);
  }

  // Named shared inputs get a clear reason; everything else non-module is caught below.
  const globalHit = changed.find((c) => isGlobalTrigger(c));
  if (globalHit) return full(`global-trigger changed: ${globalHit}`);

  // CARDINAL RULE: coverage only attributes *module* dependencies (lib/, bin/). Any changed file that
  // is neither a test file nor a tracked module source — skills/, docs/, hooks/, agents/, commands/,
  // *.json config, vendored node_modules/, etc. — is read/consumed in ways V8 coverage cannot record,
  // so a change there could affect any test. Force a full run rather than risk under-selection.
  const unselectable = changed.filter((c) => !isTestFile(c) && !isTrackedSource(c));
  if (unselectable.length > 0) {
    return full(`non-module change(s) not coverage-attributable: ${unselectable.join(', ')}`);
  }

  const allSet = new Set(allTestFiles);
  const changedSet = new Set(changed);

  // Trusted coverage = entries for CURRENT test files whose last mapping run PASSED. Deleted/renamed
  // test entries (not in allSet) and untrusted entries (ok === false) do NOT contribute coverage —
  // otherwise a stale or incomplete entry could mask the uncovered-source fallback.
  const coveredDeps = new Set();
  for (const [t, entry] of Object.entries(map.tests)) {
    if (!allSet.has(t) || entry.ok === false) continue;
    for (const d of entry.deps || []) coveredDeps.add(d);
  }
  const uncovered = changed.filter((c) => isTrackedSource(c) && !coveredDeps.has(c));
  if (uncovered.length > 0) {
    return full(`changed source not covered by trusted map: ${uncovered.join(', ')}`, uncovered);
  }

  const impacted = new Set();
  for (const t of allTestFiles) {
    const e = map.tests[t];
    if (!e) { impacted.add(t); continue; }                       // new test → run (refreshes map)
    if (e.ok === false) { impacted.add(t); continue; }           // untrusted last run → always run
    if (changedSet.has(t) && e.hash !== hashOf(t)) impacted.add(t); // test content changed
  }
  for (const [t, entry] of Object.entries(map.tests)) {
    if (!allSet.has(t)) continue;                                // skip deleted/renamed tests
    if ((entry.deps || []).some((d) => changedSet.has(d))) impacted.add(t); // dep intersects change
  }

  if (impacted.size === 0) return { mode: 'none', tests: [], reason: 'no affected tests', fullyCovered: true, uncovered: [] };
  return { mode: 'selected', tests: [...impacted].sort(), reason: `${impacted.size} affected test file(s)`, fullyCovered: true, uncovered: [] };
}

// ── git + fs (impure) ──────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function getChangedFiles(base) {
  const out = new Set();
  const add = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean).forEach((f) => out.add(f));
  // --no-renames so a rename surfaces as delete(old)+add(new) — both paths enter the change set.
  // Without it, `git diff` reports only the new path and a test mapped to the old path could be skipped.
  try {
    if (base) {
      // commits since <base> (merge-base ... HEAD) plus working tree
      add(git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]));
    }
    add(git(['diff', '--name-only', '--no-renames', 'HEAD'])); // staged + unstaged vs HEAD
    add(git(['ls-files', '--others', '--exclude-standard']));  // untracked
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
  let ok = true;
  try {
    try {
      execFileSync('node', ['--test', testFile], {
        cwd: REPO_ROOT,
        env: { ...process.env, NODE_V8_COVERAGE: covDir },
        stdio: 'ignore',
        timeout: 180_000,
      });
    } catch {
      // A failing/flaky test may produce only PARTIAL coverage (it can error before loading some of
      // its real deps). We still collect what we got, but mark the entry untrusted (ok:false) so
      // selectTests always re-runs it and never counts its deps as "covered". A later passing run
      // refreshes it to ok:true.
      ok = false;
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
    return { deps: [...deps].sort(), ok };
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
    const { deps, ok } = depsForTest(t);
    map.tests[t] = { hash: fileHash(join(REPO_ROOT, t)), deps, ok };
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

  if (cmd === 'flaky') {
    // The quarantine list: test files that failed/errored when last mapped in isolation (ok:false).
    // These are the cross-agent flake candidates — they always run, and a SHIP resting on them should
    // be challenged. Emitted as JSON for the workflow to consume.
    const m = loadMap();
    if (!m || !m.tests) { process.stdout.write(JSON.stringify({ mapPresent: false, flaky: [] }, null, 2) + '\n'); return 0; }
    const flaky = Object.entries(m.tests).filter(([, v]) => v.ok === false).map(([t]) => t).sort();
    process.stdout.write(JSON.stringify({ mapPresent: true, mapBuiltAt: m.builtAt, count: flaky.length, flaky }, null, 2) + '\n');
    return 0;
  }

  const allTestFiles = listAllTestFiles(false);
  const map = loadMap();
  const { files: changed, gitError } = getChangedFiles(flags.base);
  if (gitError) process.stderr.write(`[tia] git diff failed (${gitError}); falling back to full run\n`);
  const decision = selectTests({
    changed, map, allTestFiles,
    hashOf: (rel) => fileHash(join(REPO_ROOT, rel)),
    nodeVersion: process.version,
  });

  // Shared provenance for review (Codex review (A) item 3): everything needed to judge sufficiency.
  const wouldRun = decision.mode === 'all' ? allTestFiles.length : decision.tests.length;
  const provenance = {
    reason: decision.reason,
    base: flags.base || 'HEAD (working tree)',
    changed,
    allTestCount: allTestFiles.length,
    tests: decision.tests,
    mapVersion: map ? map.version : null,
    mapBuiltAt: map ? map.builtAt : null,
    node: process.version,
    gitError,
  };

  if (cmd === 'affected') {
    // DRY RUN — executes nothing. Deliberately NO gate-ready `selection`/`ran` (which would imply
    // "did run"). `selectedCount` = how many WOULD run; `executed: false` makes that explicit.
    process.stdout.write(JSON.stringify({
      mode: decision.mode, executed: false, selectedCount: wouldRun,
      fullyCovered: decision.fullyCovered, uncovered: decision.uncovered || [], ...provenance,
    }, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'run') {
    process.stderr.write(`[tia] ${decision.mode}: ${decision.reason}\n`);
    let exit = 0;
    if (decision.mode === 'all') exit = runTests(allTestFiles);
    else if (decision.mode === 'selected') {
      exit = runTests(decision.tests);
      try { buildMapFor(decision.tests, loadMap()); } catch (e) {
        process.stderr.write(`[tia] map refresh skipped: ${e.message}\n`);
      }
    }
    // The gate-embeddable, review-grade selection record. `ran` here means tests that ACTUALLY ran.
    const selection = {
      mode: decision.mode, ran: wouldRun, fullyCovered: decision.fullyCovered,
      uncovered: decision.uncovered || [], exit, ranAt: new Date().toISOString(),
      base: provenance.base, mapVersion: provenance.mapVersion, mapBuiltAt: provenance.mapBuiltAt,
      node: provenance.node, tests: decision.tests, changed,
    };
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(join(CACHE_DIR, 'last-run.json'), JSON.stringify(selection, null, 2)); } catch { /* best-effort */ }
    process.stderr.write(`[tia] verification selection → ${JSON.stringify({ mode: selection.mode, ran: selection.ran, fullyCovered: selection.fullyCovered, exit })}\n`);
    process.stderr.write('[tia] full record at .tia-cache/last-run.json — embed it as the verification command\'s "selection"\n');
    return exit;
  }

  if (cmd === 'refresh') {
    // Slice-boundary refresh: re-map ONLY the tests impacted by the change set, so the map reflects
    // dependencies introduced by the slice (a new import a covering test now loads). Prevents drift
    // from accumulating across a feature without the cost of a full `build`.
    const toRefresh = decision.mode === 'all' ? allTestFiles : decision.tests;
    if (toRefresh.length === 0) {
      process.stderr.write(`[tia] refresh: nothing to re-map (${decision.reason})\n`);
      return 0;
    }
    process.stderr.write(`[tia] refresh: re-mapping ${toRefresh.length} impacted test(s) (${decision.reason})\n`);
    buildMapFor(toRefresh, loadMap());
    return 0;
  }

  process.stderr.write('usage: tia.mjs <build|affected|run|refresh|flaky> [--base <ref>] [--all]\n');
  return 2;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
