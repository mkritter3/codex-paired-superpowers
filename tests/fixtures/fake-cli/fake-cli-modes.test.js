import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CODEX = join(ROOT, 'tests', 'fixtures', 'fake-cli', 'codex.sh');
const AGY = join(ROOT, 'tests', 'fixtures', 'fake-cli', 'agy.sh');

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cps-fake-mode-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fake@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fake CLI'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

test('FAKE_CODEX_COMMIT creates a commit and preserves existing output', () => {
  const repo = makeRepo();
  try {
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const result = spawnSync('bash', [CODEX], {
      cwd: realpathSync(repo),
      encoding: 'utf8',
      input: 'implement this',
      env: { ...process.env, FAKE_CODEX_COMMIT: '1', FAKE_CLI_OUTPUT: 'existing-output' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'existing-output');
    assert.equal(readFileSync(join(repo, 'impl.txt'), 'utf8'), 'implemented\n');
    assert.notEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), before);
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim(), 'fake: implement');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('FAKE_AGY_RECORD writes checkout evidence and preserves existing output', () => {
  const repo = makeRepo();
  const record = join(repo, 'agy-record.json');
  try {
    writeFileSync(join(repo, 'impl.txt'), 'present\n');
    execFileSync('git', ['add', 'impl.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'implementation'], { cwd: repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const result = spawnSync('bash', [AGY], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, FAKE_AGY_RECORD: record, FAKE_CLI_OUTPUT: 'existing-output' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'existing-output');
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), {
      cwd: realpathSync(repo),
      head,
      impl_txt_present: true,
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('unset fixture modes preserve prior behavior without side effects', () => {
  const repo = makeRepo();
  const record = join(repo, 'agy-record.json');
  try {
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const codex = spawnSync('bash', [CODEX], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, FAKE_CLI_OUTPUT: 'codex-output' },
    });
    const agy = spawnSync('bash', [AGY], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, FAKE_CLI_OUTPUT: 'agy-output' },
    });
    assert.equal(codex.status, 0);
    assert.equal(codex.stdout, 'codex-output');
    assert.equal(agy.status, 0);
    assert.equal(agy.stdout, 'agy-output');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), before);
    assert.equal(existsSync(join(repo, 'impl.txt')), false);
    assert.equal(existsSync(record), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
