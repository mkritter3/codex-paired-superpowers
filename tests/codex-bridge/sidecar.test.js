import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import {
  initSidecar,
  loadSidecar,
  appendRound,
  setSlice,
  sidecarPathFor,
} from '../../lib/codex-bridge/sidecar.js';

test('sidecarPathFor appends .codex.json to spec path', () => {
  assert.equal(
    sidecarPathFor('/x/y/spec.md'),
    '/x/y/spec.md.codex.json'
  );
});

test('initSidecar writes valid JSON with required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, {
    feature: 'demo',
    codexSession: 'uuid-1',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });
  const sc = loadSidecar(spec);
  assert.equal(sc.version, 1);
  assert.equal(sc.feature, 'demo');
  assert.equal(sc.codex_session, 'uuid-1');
  assert.equal(sc.model, 'gpt-5.5');
  assert.equal(sc.reasoning_effort, 'high');
  assert.deepEqual(sc.rounds, []);
  assert.deepEqual(sc.open_contentions, []);
  assert.deepEqual(sc.slice_reviews, {});
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound appends to rounds array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  appendRound(spec, { phase: 'spec', round: 1, claude: 'REVISE: x', codex: 'REVISE: y' });
  appendRound(spec, { phase: 'spec', round: 2, claude: 'SHIP', codex: 'SHIP' });
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 2);
  assert.equal(sc.rounds[1].claude, 'SHIP');
  rmSync(dir, { recursive: true, force: true });
});

test('setSlice records slice review state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'm', reasoningEffort: 'high' });
  setSlice(spec, 'slice-1', { rounds: [{ round: 1, claude: 'SHIP', codex: 'SHIP' }], shipped: true });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].shipped, true);
  rmSync(dir, { recursive: true, force: true });
});

import { setPhase, setAutopilot, getAutopilot, setLiveVerification, getLiveVerification } from '../../lib/codex-bridge/sidecar.js';

test('setPhase records nested phase state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setPhase(spec, 'slice-1', 'plan-slice', { rounds: [{ round: 1, claude: 'SHIP', codex: 'SHIP' }], shipped: true });
  setPhase(spec, 'slice-1', 'implement', { subagent_status: 'DONE', commits: ['abc'] });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].phases['plan-slice'].shipped, true);
  assert.equal(sc.slice_reviews['slice-1'].phases.implement.subagent_status, 'DONE');
  rmSync(dir, { recursive: true, force: true });
});

test('setAutopilot writes the autopilot block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setAutopilot(spec, {
    started_at: '2026-05-08T00:00:00Z',
    last_tick_at: '2026-05-08T00:01:00Z',
    current_slice: '3',
    current_phase: 'review-slice',
    phase_attempt: 1,
    phase_started_at: '2026-05-08T00:00:30Z',
    slice_start_sha: 'abc123',
    phase_start_sha: 'def456',
    last_commit_sha: 'def456',
    inflight_subagent_id: null,
    halt_reason: null,
  });
  const ap = getAutopilot(spec);
  assert.equal(ap.current_slice, '3');
  assert.equal(ap.phase_start_sha, 'def456');
  rmSync(dir, { recursive: true, force: true });
});

test('getAutopilot returns null when block missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  assert.equal(getAutopilot(spec), null);
  rmSync(dir, { recursive: true, force: true });
});

test('sliceIdToNumber converts slice-N to N', async () => {
  const { sliceIdToNumber } = await import('../../lib/codex-bridge/sidecar.js');
  assert.equal(sliceIdToNumber('slice-3'), '3');
  assert.equal(sliceIdToNumber('slice-10'), '10');
  assert.equal(sliceIdToNumber('slice-0'), '0');
});

test('sliceIdToNumber throws on invalid input', async () => {
  const { sliceIdToNumber } = await import('../../lib/codex-bridge/sidecar.js');
  assert.throws(() => sliceIdToNumber('slice'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('slice-'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('slice-abc'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber('3'), /invalid slice key/);
  assert.throws(() => sliceIdToNumber(''), /invalid slice key/);
});

test('sliceIdToDisplayName converts N to slice-N', async () => {
  const { sliceIdToDisplayName } = await import('../../lib/codex-bridge/sidecar.js');
  assert.equal(sliceIdToDisplayName('3'), 'slice-3');
  assert.equal(sliceIdToDisplayName('10'), 'slice-10');
  assert.equal(sliceIdToDisplayName(7), 'slice-7'); // accepts numbers via String()
});

test('sliceIdToDisplayName throws on non-numeric input', async () => {
  const { sliceIdToDisplayName } = await import('../../lib/codex-bridge/sidecar.js');
  assert.throws(() => sliceIdToDisplayName('abc'), /invalid slice number/);
  assert.throws(() => sliceIdToDisplayName('slice-3'), /invalid slice number/);
  assert.throws(() => sliceIdToDisplayName(''), /invalid slice number/);
});

test('setAutopilot is atomic (temp file + rename)', () => {
  // Verify by writing repeatedly under load — the file should never be observed empty/partial.
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  for (let i = 0; i < 50; i++) {
    setAutopilot(spec, { current_slice: String(i), current_phase: 'implement' });
    const sc = loadSidecar(spec);
    assert.equal(sc.autopilot.current_slice, String(i));
  }
  rmSync(dir, { recursive: true, force: true });
});

// --- malformed-input edge cases ---

test('loadSidecar throws on malformed JSON (loud failure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  writeFileSync(`${spec}.codex.json`, '{not json');
  // The orchestrator must surface this as a halt reason; silent-default is wrong.
  assert.throws(() => loadSidecar(spec), /JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test('loadSidecar throws on empty sidecar file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  writeFileSync(`${spec}.codex.json`, '');
  assert.throws(() => loadSidecar(spec));
  rmSync(dir, { recursive: true, force: true });
});

test('appendRound preserves prior rounds on subsequent appends (no overwrite)', () => {
  // Regression guard: the read-modify-write pattern must not lose history.
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  for (let i = 1; i <= 7; i++) {
    appendRound(spec, { phase: 'spec', round: i, claude: 'REVISE', codex: 'REVISE' });
  }
  const sc = loadSidecar(spec);
  assert.equal(sc.rounds.length, 7);
  assert.equal(sc.rounds[0].round, 1);
  assert.equal(sc.rounds[6].round, 7);
  rmSync(dir, { recursive: true, force: true });
});

test('setPhase preserves other phases when adding a new one', () => {
  // Regression guard: setPhase must not clobber sibling phases.
  const dir = mkdtempSync(join(tmpdir(), 'cps-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setPhase(spec, 'slice-1', 'plan-slice', { shipped: true });
  setPhase(spec, 'slice-1', 'implement', { subagent_status: 'DONE' });
  setPhase(spec, 'slice-1', 'review-slice', { shipped: true });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-1'].phases['plan-slice'].shipped, true);
  assert.equal(sc.slice_reviews['slice-1'].phases.implement.subagent_status, 'DONE');
  assert.equal(sc.slice_reviews['slice-1'].phases['review-slice'].shipped, true);
  rmSync(dir, { recursive: true, force: true });
});

// --- Slice 3: sidecar auto-discovery + hidden-dir layout ---

test('in-git-repo: hidden-dir layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-repo-'));
  const repo = realpathSync(dir);
  execSync('git init -q', { cwd: repo });
  const specDir = join(repo, 'docs', 'specs');
  mkdirSync(specDir, { recursive: true });
  const spec = join(specDir, 'foo.md');
  writeFileSync(spec, '# foo');
  const p = sidecarPathFor(spec);
  assert.match(p, /\.superpowers-codex-paired\/docs\/specs\/foo\.md\.json$/);
  rmSync(repo, { recursive: true, force: true });
});

test('outside-git-repo: legacy fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-nogit-'));
  const repo = realpathSync(dir);
  const spec = join(repo, 'spec.md');
  writeFileSync(spec, '# spec');
  const p = sidecarPathFor(spec);
  assert.equal(p, spec + '.codex.json');
  rmSync(repo, { recursive: true, force: true });
});

test('sibling-prefix safety: /repo vs /repo-old', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cps-sibling-')));
  const repo1 = join(base, 'repo');
  const repo2 = join(base, 'repo-old');
  mkdirSync(repo1, { recursive: true });
  mkdirSync(repo2, { recursive: true });
  execSync('git init -q', { cwd: repo1 });
  execSync('git init -q', { cwd: repo2 });
  const spec1 = join(repo1, 'spec.md');
  const spec2 = join(repo2, 'spec.md');
  writeFileSync(spec1, '# spec1');
  writeFileSync(spec2, '# spec2');
  const path1 = sidecarPathFor(spec1);
  const path2 = sidecarPathFor(spec2);
  assert.ok(path1.startsWith(repo1), `path1 should start with repo1: ${path1}`);
  assert.ok(path2.startsWith(repo2), `path2 should start with repo2: ${path2}`);
  assert.match(path1, /\.superpowers-codex-paired[/\\]spec\.md\.json$/);
  assert.match(path2, /\.superpowers-codex-paired[/\\]spec\.md\.json$/);
  rmSync(base, { recursive: true, force: true });
});

test('first-write nested mkdir: initSidecar creates hidden parent dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-mkdir-'));
  const repo = realpathSync(dir);
  execSync('git init -q', { cwd: repo });
  const specDir = join(repo, 'docs', 'a', 'b', 'c');
  mkdirSync(specDir, { recursive: true });
  const spec = join(specDir, 'spec.md');
  writeFileSync(spec, '# spec');
  // initSidecar must mkdir-p the hidden parent before writing — no pre-mkdir of hidden parent
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  const sidecarPath = sidecarPathFor(spec);
  assert.match(sidecarPath, /\.superpowers-codex-paired[/\\]docs[/\\]a[/\\]b[/\\]c[/\\]spec\.md\.json$/);
  assert.ok(existsSync(sidecarPath), `sidecar should exist at hidden path: ${sidecarPath}`);
  rmSync(repo, { recursive: true, force: true });
});

test('stale-shadow warning: legacy-only emits deprecation to stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-stale-'));
  const repo = realpathSync(dir);
  execSync('git init -q', { cwd: repo });
  const spec = join(repo, 'spec.md');
  writeFileSync(spec, '# spec');
  const legacy = spec + '.codex.json';
  writeFileSync(legacy, JSON.stringify({ version: 1, rounds: [] }));
  // Do NOT create the hidden sidecar — only legacy exists

  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (s) => { captured += s; return true; };
  let p;
  try {
    p = sidecarPathFor(spec);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(p, legacy);
  assert.match(captured, /deprecat/i);
  rmSync(repo, { recursive: true, force: true });
});

test('hidden-wins-over-legacy: when both exist, hidden path is returned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-hidden-wins-'));
  const repo = realpathSync(dir);
  execSync('git init -q', { cwd: repo });
  const spec = join(repo, 'spec.md');
  writeFileSync(spec, '# spec');
  const legacy = spec + '.codex.json';
  writeFileSync(legacy, JSON.stringify({ version: 1, rounds: [] }));
  // Create the hidden sidecar too
  const hiddenDir = join(repo, '.superpowers-codex-paired');
  mkdirSync(hiddenDir, { recursive: true });
  const hidden = join(hiddenDir, 'spec.md.json');
  writeFileSync(hidden, JSON.stringify({ version: 1, rounds: [] }));
  const p = sidecarPathFor(spec);
  assert.equal(p, hidden);
  rmSync(repo, { recursive: true, force: true });
});

test('mkdtemp legacy back-compat: non-repo mkdtemp path uses legacy layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-backcompat-'));
  const repo = realpathSync(dir);
  const spec = join(repo, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  const sidecarPath = sidecarPathFor(spec);
  // In a non-git temp dir, should use legacy .codex.json layout
  assert.equal(sidecarPath, spec + '.codex.json');
  assert.ok(existsSync(sidecarPath), `legacy sidecar should exist: ${sidecarPath}`);
  const sc = loadSidecar(spec);
  assert.equal(sc.version, 1);
  rmSync(repo, { recursive: true, force: true });
});

// ─── Slice 6: setLiveVerification + getLiveVerification ───────────────────────

test('setLiveVerification writes to nested live-verification phase block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lv-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setLiveVerification(spec, 'slice-6', 'shipped', false);
  setLiveVerification(spec, 'slice-6', 'skipped', false);
  setLiveVerification(spec, 'slice-6', 'scenario_generation', { round: 1 });
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-6'].phases['live-verification'].shipped, false);
  assert.equal(sc.slice_reviews['slice-6'].phases['live-verification'].skipped, false);
  assert.deepEqual(sc.slice_reviews['slice-6'].phases['live-verification'].scenario_generation, { round: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test('getLiveVerification returns live-verification block when present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lv-get-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setLiveVerification(spec, 'slice-6', 'shipped', true);
  setLiveVerification(spec, 'slice-6', 'evidence_dir', '.superpowers-codex-paired/evidence/slice-6');
  const lv = getLiveVerification(spec, 'slice-6');
  assert.ok(lv !== null, 'getLiveVerification should return the block, not null');
  assert.equal(lv.shipped, true);
  assert.equal(lv.evidence_dir, '.superpowers-codex-paired/evidence/slice-6');
  rmSync(dir, { recursive: true, force: true });
});

test('getLiveVerification returns null when slice absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lv-null-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  assert.equal(getLiveVerification(spec, 'slice-99'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('getLiveVerification returns null when live-verification phase absent (other phases exist)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lv-absent-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setPhase(spec, 'slice-6', 'implement', { subagent_status: 'DONE' });
  assert.equal(getLiveVerification(spec, 'slice-6'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('setLiveVerification preserves sibling phases (lazy-init does not clobber)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cps-lv-sibling-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# spec');
  initSidecar(spec, { feature: 'd', codexSession: 'u', model: 'gpt-5.5', reasoningEffort: 'high' });
  setPhase(spec, 'slice-6', 'implement', { subagent_status: 'DONE', commits: ['abc'] });
  setLiveVerification(spec, 'slice-6', 'shipped', false);
  const sc = loadSidecar(spec);
  assert.equal(sc.slice_reviews['slice-6'].phases.implement.subagent_status, 'DONE');
  assert.equal(sc.slice_reviews['slice-6'].phases['live-verification'].shipped, false);
  rmSync(dir, { recursive: true, force: true });
});
