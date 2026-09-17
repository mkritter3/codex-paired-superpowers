// v0.17.0 — opt-in installed smoke for the Antigravity (agy) transport.
//
// Runs ONLY when AGY_SMOKE=1 and `agy` is on PATH (and signed in). Mirrors the manual probes of
// 2026-09-17: (a) a reviewer-thread open + reply via the CLI verbs (agy --conversation), (b) a real implementer commit in a
// temp git repo through the status-file wrapper with a project config that puts `implement` on agy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPER = join(PLUGIN_ROOT, 'scripts', 'codex-exec-with-status.sh');
const CLI = join(PLUGIN_ROOT, 'lib', 'codex-bridge', 'cli.js');
const MODEL = process.env.AGY_SMOKE_MODEL || 'gemini-3.8-flash-high';

function agyOnPath() {
  try { execFileSync('which', ['agy'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const READY = process.env.AGY_SMOKE === '1' && agyOnPath();

function runAgy(args, cwd) {
  const out = execFileSync('agy', ['-p', ...args, '--model', MODEL, '--output-format', 'json', '--sandbox', '--dangerously-skip-permissions', '--print-timeout', '10m'],
    { cwd, encoding: 'utf8', timeout: 11 * 60 * 1000 });
  const i = out.indexOf('{"conversation_id"');
  return JSON.parse(out.slice(i));
}

test('agy smoke: skips unless AGY_SMOKE=1 and agy is on PATH', { skip: READY ? false : 'AGY_SMOKE!=1 or agy not on PATH' }, () => {
  assert.ok(READY);
});

test('agy smoke: reviewer thread open + reply through the CLI verbs (review role on agy)', { timeout: 25 * 60 * 1000, skip: READY ? false : 'disabled' }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-agy-smoke-thread-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    mkdirSync(join(repo, '.codex-paired'), { recursive: true });
    writeFileSync(join(repo, '.codex-paired', 'project.json'), JSON.stringify({
      version: 1, app: { type: 'library' }, live_verification: { default: 'skip', skip_reason: 'smoke' },
      validation: { tiers: { default: 'standard' } },
      models: { review: { cli: 'agy', model: MODEL } },
    }));
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'spec.md'), '# Smoke spec\n\nThe code word is HERON-77.\n');
    writeFileSync(join(repo, 'README.md'), '# smoke\n');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    const spec = join(repo, 'docs', 'spec.md');
    execFileSync(process.execPath, [CLI, 'sidecar-init', '--specPath', spec, '--feature', 'smoke', '--threadId', 'seed', '--model', 'gpt-6-astra', '--reasoning', 'high'], { cwd: repo });
    const verb = (name, prompt) => {
      const r = spawnSync(process.execPath, [CLI, name, '--role', 'review', '--specPath', spec, '--repoRoot', repo, '--prompt-stdin'],
        { cwd: repo, input: prompt, encoding: 'utf8', timeout: 11 * 60 * 1000 });
      let out = null; try { out = JSON.parse(r.stdout); } catch { /* surfaced through status/err below */ }
      return { status: r.status, out, err: `${r.stderr}\nstdout=${r.stdout}` };
    };
    const first = verb('reviewer-thread-open', 'Read docs/spec.md in your current directory and reply with exactly: STORED');
    assert.equal(first.status, 0, first.err);
    assert.equal(first.out.ok, true);
    assert.ok(first.out.threadId);
    const second = verb('reviewer-thread-reply', 'What was the code word in the spec you read? Reply with just the code word.');
    assert.equal(second.status, 0, second.err);
    assert.equal(second.out.threadId, first.out.threadId);
    assert.match(second.out.content, /HERON-77/);
    // the reviewer ran in a throwaway checkout: the user tree is untouched
    assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'docs', 'README.md'], { cwd: repo, encoding: 'utf8' }), '');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('agy smoke: implementer commit through the wrapper with implement on agy', { timeout: 25 * 60 * 1000, skip: READY ? false : 'disabled' }, () => {
  const repo = mkdtempSync(join(tmpdir(), 'cps-agy-impl-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
    writeFileSync(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
    mkdirSync(join(repo, '.codex-paired'), { recursive: true });
    writeFileSync(join(repo, '.codex-paired', 'project.json'), JSON.stringify({
      version: 1, app: { type: 'library' }, live_verification: { default: 'skip', skip_reason: 'smoke' },
      models: { implement: { cli: 'agy', model: MODEL } },
    }));
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
    const status = join(repo, '.codex-paired', 'smoke.status.json');
    const prompt = "In this git repo, add a function 'sub' (subtraction) to math.js, then run: git add -A && git commit -m 'feat(slice:9): add sub'. Reply with exactly DONE when committed.";
    const r = spawnSync('bash', [WRAPPER, status, '--model-role', 'implement', '--repo-root', repo, '--cwd', repo, '--',
      'agy', '-p', prompt, '--sandbox', '--dangerously-skip-permissions', '--output-format', 'json', '--print-timeout', '15m'],
      { cwd: repo, encoding: 'utf8', timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(r.status, 0, `wrapper exit ${r.status}: ${r.stderr}`);
    const st = JSON.parse(readFileSync(status, 'utf8'));
    assert.equal(st.exit_code, 0);
    assert.equal(st.cli, 'agy');
    assert.equal(st.model, MODEL);
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' });
    assert.match(log, /feat\(slice:9\): add sub/);
    assert.match(readFileSync(join(repo, 'math.js'), 'utf8'), /sub/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
