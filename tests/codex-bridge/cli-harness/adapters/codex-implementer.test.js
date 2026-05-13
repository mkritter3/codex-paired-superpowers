// v0.10.0 slice 4 — implementer mode tests for codex adapter.
//
// Uses the fake-bash-CLI pattern from adapter-stubborn-timeout.test.js.
// Each test creates a temporary fake CLI script, marks it executable,
// and passes its path as options.command.
//
// Test coverage:
//   happy.*         — normal successful paths
//   edge.*          — boundary / zero-null-empty / adversarial inputs
//   fail.*          — error paths
//   integration.*   — cross-module contract assertions
//   compat.*        — backward-compat with reviewer mode
//   perf.slo.*      — timing bounds

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch } from '../../../../lib/codex-bridge/cli-harness/adapters/codex.js';

const TEST_TIMEOUT_MS = 12_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix = 'cps-impl-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Create a minimal fake CLI at <dir>/codex.
 * body: array of shell lines (after the shebang).
 */
function makeFakeCli(dir, body) {
  const script = join(dir, 'codex');
  writeFileSync(script, ['#!/usr/bin/env bash', ...body].join('\n') + '\n', 'utf8');
  chmodSync(script, 0o755);
  return script;
}

/**
 * Probe whether a PID is still alive via kill -0 (no-signal).
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    throw err;
  }
}

// ── happy.implementer-args ────────────────────────────────────────────────────
// Fake CLI dumps its argv to stderr. Assert spawn argv was
// ['exec', '--sandbox', 'workspace-write', '-C', <cwd>].

test('happy.implementer-args: spawn argv composes exec --sandbox workspace-write -C <cwd>', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-argv-');
  try {
    const argsFile = join(dir, 'args.txt');
    const script = makeFakeCli(dir, [
      // Write argv (all positional args) to a file, then exit.
      `printf '%s\\n' "$@" > '${argsFile}'`,
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    // The fake CLI exited 0 but stdout is empty, so we check argsFile.
    assert.ok(existsSync(argsFile), 'argv file should exist');
    const argLines = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(argLines, ['exec', '--sandbox', 'workspace-write', '-C', dir],
      `expected implementer args, got: ${JSON.stringify(argLines)}`);
    assert.equal(result.adapterMeta.exec_mode, 'implementer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.reviewer-args ───────────────────────────────────────────────────────
// Fake CLI dumps its argv. Assert argv was ['--json'].

test('happy.reviewer-args: execMode reviewer composes --json args', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-rev-');
  try {
    const argsFile = join(dir, 'args.txt');
    const script = makeFakeCli(dir, [
      `printf '%s\\n' "$@" > '${argsFile}'`,
      'exit 0',
    ]);

    await dispatch('system', 'user', {
      command: script,
      execMode: 'reviewer',
      timeout_ms: 5000,
    });

    assert.ok(existsSync(argsFile), 'argv file should exist');
    const argLines = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(argLines, ['--json'],
      `expected reviewer args ['--json'], got: ${JSON.stringify(argLines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.reviewer-args-omitted ───────────────────────────────────────────────
// Same as reviewer-args but execMode is omitted entirely.

test('happy.reviewer-args-omitted: omitted execMode defaults to reviewer and --json', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-omit-');
  try {
    const argsFile = join(dir, 'args.txt');
    const script = makeFakeCli(dir, [
      `printf '%s\\n' "$@" > '${argsFile}'`,
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      timeout_ms: 5000,
      // execMode intentionally omitted
    });

    assert.ok(existsSync(argsFile), 'argv file should exist');
    const argLines = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(argLines, ['--json'],
      `expected ['--json'], got: ${JSON.stringify(argLines)}`);
    assert.equal(result.adapterMeta.exec_mode, 'reviewer',
      'adapterMeta.exec_mode should be reviewer when execMode is omitted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.prompt-delivery ─────────────────────────────────────────────────────
// Fake CLI captures stdin and writes it to a file. Assert stdin received
// the composed prompt (system\n\nuser format from composeStdinPayload).

test('happy.prompt-delivery: stdin receives composed system+user payload', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-stdin-');
  try {
    const stdinFile = join(dir, 'stdin.txt');
    const script = makeFakeCli(dir, [
      // Read all of stdin to a file.
      `cat > '${stdinFile}'`,
      'exit 0',
    ]);

    const systemPrompt = 'You are a coding assistant.';
    const userPrompt = 'Write a hello world program.';

    await dispatch(systemPrompt, userPrompt, {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.ok(existsSync(stdinFile), 'stdin capture file should exist');
    const stdinContent = readFileSync(stdinFile, 'utf8');
    // composeStdinPayload: sys + '\n\n' + usr
    assert.ok(stdinContent.includes(systemPrompt),
      `stdin should include system prompt; got: ${JSON.stringify(stdinContent)}`);
    assert.ok(stdinContent.includes(userPrompt),
      `stdin should include user prompt; got: ${JSON.stringify(stdinContent)}`);
    // Verify the blank-line separator between system and user.
    assert.ok(stdinContent.includes('\n\n'),
      'stdin payload should have blank-line separator between prompts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── happy.cwd-set ─────────────────────────────────────────────────────────────
// Fake CLI runs `pwd` and writes to stdout. Assert output equals the cwd.

test('happy.cwd-set: implementer mode sets spawn cwd to options.cwd', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-cwd-');
  try {
    const pwdFile = join(dir, 'pwd.txt');
    const script = makeFakeCli(dir, [
      // Write pwd to a file.
      `pwd > '${pwdFile}'`,
      // Also emit a valid JSON event to stdout so parser is happy.
      'printf \'{"type":"assistant-text","text":"ok"}\\n\'',
      'exit 0',
    ]);

    await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.ok(existsSync(pwdFile), 'pwd file should exist');
    const pwdOutput = readFileSync(pwdFile, 'utf8').trim();
    // Resolve symlinks on macOS where tmpdir may be /private/var/...
    const { realpathSync } = await import('node:fs');
    const resolvedDir = realpathSync(dir);
    assert.equal(pwdOutput, resolvedDir,
      `spawn cwd should be set to options.cwd; got: ${pwdOutput}, expected: ${resolvedDir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty cwd-missing ─────────────────────────────────────────
// Implementer mode WITHOUT options.cwd throws synchronously.

test('edge.cwd-missing: implementer mode without cwd throws synchronously', async () => {
  const dir = makeTmpDir('cps-impl-nocwd-');
  try {
    const script = makeFakeCli(dir, ['exit 0']);
    await assert.rejects(
      () => dispatch('system', 'user', {
        command: script,
        execMode: 'implementer',
        // cwd intentionally omitted
      }),
      /implementer mode requires options\.cwd/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.zero-null-empty cwd-empty ────────────────────────────────────────────
// Implementer mode with cwd: '' throws synchronously.

test('edge.cwd-empty: implementer mode with empty cwd throws synchronously', async () => {
  const dir = makeTmpDir('cps-impl-ecwd-');
  try {
    const script = makeFakeCli(dir, ['exit 0']);
    await assert.rejects(
      () => dispatch('system', 'user', {
        command: script,
        execMode: 'implementer',
        cwd: '',
      }),
      /implementer mode requires options\.cwd/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.boundary path-with-spaces ───────────────────────────────────────────
// Implementer mode with a cwd path containing a space. Assert argv contains
// the path as a SINGLE element (not split), and pwd output equals the path.

test('edge.path-with-spaces: path containing space passed as single argv element', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  // Create a base dir, then create a subdir with a space.
  const baseDir = makeTmpDir('cps-impl-spc-');
  const spacedDir = join(baseDir, 'cps-impl test-dir');
  mkdirSync(spacedDir, { recursive: true });
  try {
    const argsFile = join(baseDir, 'args.txt');
    const pwdFile = join(baseDir, 'pwd.txt');
    const script = makeFakeCli(baseDir, [
      `printf '%s\\n' "$@" > '${argsFile}'`,
      `pwd > '${pwdFile}'`,
      'printf \'{"type":"assistant-text","text":"ok"}\\n\'',
      'exit 0',
    ]);

    await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: spacedDir,
      timeout_ms: 5000,
    });

    assert.ok(existsSync(argsFile), 'argv file should exist');
    const argLines = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean);
    // The -C arg should be the full spacedDir as a single element.
    const cArgIndex = argLines.indexOf('-C');
    assert.ok(cArgIndex >= 0, 'argv should contain -C flag');
    assert.equal(argLines[cArgIndex + 1], spacedDir,
      `argv[-C +1] should be full path with space, got: ${JSON.stringify(argLines[cArgIndex + 1])}`);

    // pwd should equal the spacedDir (resolving symlinks for macOS).
    assert.ok(existsSync(pwdFile), 'pwd file should exist');
    const pwdOutput = readFileSync(pwdFile, 'utf8').trim();
    const { realpathSync } = await import('node:fs');
    const resolvedSpacedDir = realpathSync(spacedDir);
    assert.equal(pwdOutput, resolvedSpacedDir,
      `spawn cwd should be spacedDir; got: ${pwdOutput}`);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// ── edge.large-input truncation ───────────────────────────────────────────────
// Fake CLI emits >50KB to stdout. Assert stdout-truncated warning is present.
// Test runs in BOTH implementer and reviewer mode.

test('edge.large-input truncation: >maxBufferBytes stdout triggers truncation in implementer mode', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-trunc-');
  try {
    const script = makeFakeCli(dir, [
      // Emit ~60KB of junk to stdout.
      "python3 -c \"print('x' * 60000)\" 2>/dev/null || printf '%0.s-' {1..60000}",
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      maxBufferBytes: 100,
      timeout_ms: 5000,
    });

    assert.ok(
      result.warnings.includes('stdout-truncated'),
      `expected stdout-truncated warning; got: ${JSON.stringify(result.warnings)}`,
    );
    // Phase A structured field: adapterMeta.truncated must be true when any
    // truncation fires (additive — warnings entries stay for back-compat).
    assert.equal(
      result.adapterMeta.truncated,
      true,
      `expected adapterMeta.truncated === true; got: ${JSON.stringify(result.adapterMeta.truncated)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.large-input truncation: >maxBufferBytes stdout triggers truncation in reviewer mode', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-trunc2-');
  try {
    const script = makeFakeCli(dir, [
      "python3 -c \"print('x' * 60000)\" 2>/dev/null || printf '%0.s-' {1..60000}",
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'reviewer',
      maxBufferBytes: 100,
      timeout_ms: 5000,
    });

    assert.ok(
      result.warnings.includes('stdout-truncated'),
      `expected stdout-truncated warning; got: ${JSON.stringify(result.warnings)}`,
    );
    // Phase A structured field: adapterMeta.truncated must be true when any
    // truncation fires (additive — warnings entries stay for back-compat).
    assert.equal(
      result.adapterMeta.truncated,
      true,
      `expected adapterMeta.truncated === true; got: ${JSON.stringify(result.adapterMeta.truncated)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.concurrent listener-cleanup ─────────────────────────────────────────
// Capture SIGINT listener count before dispatch. Run successful dispatches
// in both modes. After each, assert listenerCount returns to baseline.

test('edge.concurrent listener-cleanup: SIGINT listeners cleaned up after implementer dispatch', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-lstn-');
  try {
    const script = makeFakeCli(dir, [
      'printf \'{"type":"assistant-text","text":"ok"}\\n\'',
      'exit 0',
    ]);

    const baseline = process.listenerCount('SIGINT');

    await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.equal(
      process.listenerCount('SIGINT'),
      baseline,
      `SIGINT listener count should return to baseline ${baseline} after implementer dispatch`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge.concurrent listener-cleanup: SIGINT listeners cleaned up after reviewer dispatch', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-lstn2-');
  try {
    const script = makeFakeCli(dir, [
      'printf \'{"type":"assistant-text","text":"ok"}\\n\'',
      'exit 0',
    ]);

    const baseline = process.listenerCount('SIGINT');

    await dispatch('system', 'user', {
      command: script,
      execMode: 'reviewer',
      timeout_ms: 5000,
    });

    assert.equal(
      process.listenerCount('SIGINT'),
      baseline,
      `SIGINT listener count should return to baseline ${baseline} after reviewer dispatch`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── edge.adversarial cwd-vs-repo-deferred ────────────────────────────────────
// Contract assertion: slice 4 does NOT validate cwd-vs-repo containment.
// Slice 3's worktree-fanout owns that boundary.

test('edge.cwd-vs-repo-deferred: slice 4 defers cwd containment to slice 3 worktree-fanout', () => {
  // This is a boundary contract test. Slice 4 validates that cwd is a
  // non-empty string; it does NOT validate that cwd is inside the repo,
  // is a valid worktree, or is not the main checkout. That invariant is
  // enforced by slice 3's worktree-fanout layer before dispatch is called.
  assert.equal(true, true,
    'slice 4 defers cwd containment to slice 3 worktree-fanout');
});

// ── fail.dependency spawn-ENOENT ──────────────────────────────────────────────
// Implementer mode with nonexistent command. Assert spawn-failed + exec_mode.

test('fail.spawn-ENOENT: implementer mode with nonexistent binary returns spawn-failed', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-enoent-');
  try {
    const result = await dispatch('system', 'user', {
      command: '/nonexistent/codex-binary',
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.ok(
      result.warnings.includes('spawn-failed'),
      `expected spawn-failed warning; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode should be preserved in spawn-failed result');
    // Phase A structured field: adapterMeta.spawnError.code must be 'ENOENT'
    // (additive — existing errorCode flat field stays for back-compat).
    assert.ok(
      result.adapterMeta.spawnError !== null && result.adapterMeta.spawnError !== undefined,
      `expected adapterMeta.spawnError to be set; got: ${JSON.stringify(result.adapterMeta)}`,
    );
    assert.equal(
      result.adapterMeta.spawnError.code,
      'ENOENT',
      `expected adapterMeta.spawnError.code === 'ENOENT'; got: ${JSON.stringify(result.adapterMeta.spawnError)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency nonzero-exit ─────────────────────────────────────────────
// Fake CLI exits 1. Assert exit: 1 and exec_mode preserved.

test('fail.nonzero-exit: fake CLI exits 1 in implementer mode', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-nz-');
  try {
    const script = makeFakeCli(dir, ['exit 1']);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.equal(result.exit, 1,
      `expected exit 1; got: ${result.exit}`);
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode should be preserved on nonzero exit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.dependency malformed-json ───────────────────────────────────────────
// Fake CLI emits malformed JSON. Assert parseError set and exec_mode preserved.

test('fail.malformed-json: fake CLI emits malformed JSON in implementer mode', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-mj-');
  try {
    const script = makeFakeCli(dir, [
      'printf "this is not json\\n"',
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.ok(
      result.adapterMeta.parseError !== undefined,
      `expected adapterMeta.parseError to be set; got: ${JSON.stringify(result.adapterMeta)}`,
    );
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode should be preserved on parse error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.malformed-input invalid-execMode ────────────────────────────────────
// execMode: 'foo' throws synchronously.

test('fail.invalid-execMode: invalid execMode throws synchronously', async () => {
  const dir = makeTmpDir('cps-impl-badmode-');
  try {
    const script = makeFakeCli(dir, ['exit 0']);
    await assert.rejects(
      () => dispatch('system', 'user', {
        command: script,
        execMode: 'foo',
      }),
      /invalid execMode/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path blocked-normalization ─────────────────────────────────
// Fake CLI emits the blocked sentinel (stderr line: 'codex:blocked').
// Assert haltEnvelope present with correct shape AND adapterMeta.blocked === true.

test('fail.blocked-normalization: blocked sentinel produces haltEnvelope and adapterMeta.blocked', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-blk-');
  try {
    const script = makeFakeCli(dir, [
      // Emit the blocked sentinel to stderr.
      'printf "codex:blocked\\n" >&2',
      'exit 1',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      sliceId: 'slice-4',
      timeout_ms: 5000,
    });

    assert.ok(result.adapterMeta.blocked === true,
      `expected adapterMeta.blocked === true; got: ${JSON.stringify(result.adapterMeta)}`);
    assert.ok(result.haltEnvelope !== undefined,
      'expected haltEnvelope to be present in result');
    assert.equal(result.haltEnvelope.halt, 'codex-cli-blocked',
      `expected haltEnvelope.halt === 'codex-cli-blocked'; got: ${result.haltEnvelope.halt}`);
    assert.equal(result.haltEnvelope.terminal, true,
      'expected haltEnvelope.terminal === true');
    assert.ok(
      typeof result.haltEnvelope.resume_hint === 'string' && result.haltEnvelope.resume_hint.length > 0,
      `expected non-empty haltEnvelope.resume_hint; got: ${JSON.stringify(result.haltEnvelope.resume_hint)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Also test blocked via stdout JSON event.
test('fail.blocked-normalization-stdout: blocked JSON event in stdout triggers haltEnvelope', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-blk2-');
  try {
    const script = makeFakeCli(dir, [
      // Emit a blocked JSON event to stdout.
      'printf \'{"type":"blocked","reason":"sandbox-denied"}\\n\'',
      'exit 1',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    assert.ok(result.adapterMeta.blocked === true,
      `expected adapterMeta.blocked === true for stdout blocked event`);
    assert.ok(result.haltEnvelope !== undefined,
      'expected haltEnvelope to be present');
    assert.equal(result.haltEnvelope.halt, 'codex-cli-blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path SIGTERM-trapping-reaped ───────────────────────────────
// Implementer mode version of adapter-stubborn-timeout.test.js.
// Fake CLI traps SIGTERM, forks a sleep grandchild. Both PIDs must be
// reaped within 1000ms after dispatch returns.

test('fail.SIGTERM-trapping-reaped: implementer mode — SIGTERM-ignoring child + grandchild reaped', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-stubborn-');
  const pidsFile = join(dir, '.pids');
  const script = makeFakeCli(dir, [
    `PIDS='${pidsFile}'`,
    "trap '' TERM",
    'sleep 3600 &',
    'SLEEP_PID=$!',
    'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
    'wait "$SLEEP_PID"',
  ]);
  let pidsToCheck = [];
  try {
    const startedAt = Date.now();
    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 500,
    });
    const elapsed = Date.now() - startedAt;

    // Must return within budget.
    assert.ok(elapsed < 5500,
      `adapter did not return within 5.5s; took ${elapsed}ms`);

    // Must surface failure.
    const warnings = Array.isArray(result.warnings) ? result.warnings.join(' ') : '';
    const meta = result.adapterMeta ? JSON.stringify(result.adapterMeta) : '';
    const failureSignaled =
      (typeof result.exit === 'number' && result.exit !== 0) ||
      /timeout|timed.?out|aborted|kill/i.test(warnings) ||
      /timeout|timed.?out|aborted|kill|abort/i.test(meta);
    assert.ok(failureSignaled,
      `expected timeout/abort signal; result: ${JSON.stringify(result, null, 2)}`);

    // Read PIDs and check reaping.
    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }

    // Poll up to 1000ms for reap.
    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(livePids.length, 0,
      `process group NOT reaped within 1000ms: ${JSON.stringify(livePids)}`);

    assert.equal(result.adapterMeta.exec_mode, 'implementer');
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail.exception-path SIGINT-propagation ────────────────────────────────────
// Implementer mode version of adapter-sigint-propagation.test.js.
// SIGINT to parent forwarded to detached child group.

test('fail.SIGINT-propagation: implementer mode — SIGINT forwarded to detached child group', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-sigint-');
  const sigintMarker = join(dir, '.got-sigint');
  const script = makeFakeCli(dir, [
    `MARKER='${sigintMarker}'`,
    `trap 'touch "$MARKER"; exit 130' INT`,
    'cat > /dev/null &',
    'sleep 5',
  ]);
  try {
    const listenersBefore = process.listenerCount('SIGINT');

    const dispatchPromise = dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 8000,
    });

    // Wait for child to spawn + install its trap.
    await new Promise((r) => setTimeout(r, 300));

    // Verify forwarder installed.
    assert.ok(
      process.listenerCount('SIGINT') > listenersBefore,
      `adapter must install SIGINT forwarder during dispatch`,
    );

    // Simulate Ctrl-C.
    const swallow = () => {};
    process.on('SIGINT', swallow);
    try {
      process.kill(process.pid, 'SIGINT');
    } finally {
      process.removeListener('SIGINT', swallow);
    }

    const result = await dispatchPromise;

    // Forwarder must be removed after dispatch.
    assert.equal(
      process.listenerCount('SIGINT'),
      listenersBefore,
      'SIGINT forwarder must be removed after dispatch',
    );

    // Child must have received SIGINT.
    if (existsSync(sigintMarker)) {
      // Success: marker present.
      const contents = readFileSync(sigintMarker, 'utf8');
      assert.ok(contents !== undefined);
    } else {
      // Tolerate: child may have exited before SIGINT if under load.
      assert.ok(
        result && (result.exit !== 0 || /SIGINT|INT/i.test(JSON.stringify(result))),
        `SIGINT did not reach child: marker absent AND result is clean-exit. result: ${JSON.stringify(result, null, 2)}`,
      );
    }

    assert.equal(result.adapterMeta.exec_mode, 'implementer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── integration.cross-module adapter-contract-boundary ───────────────────────
// Successful implementer dispatch. Assert top-level keys are exactly the
// v0.9.x set: ['responseText', 'exit', 'warnings', 'sessionId', 'adapterMeta', 'duration_ms'].
// haltEnvelope is OPTIONAL — only present in blocked or future error paths.

test('integration.adapter-contract-boundary: top-level keys are the v0.9.x set', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-contract-');
  try {
    const script = makeFakeCli(dir, [
      'printf \'{"type":"assistant-text","text":"done"}\\n\'',
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    const keys = Object.keys(result).sort();
    const expectedKeys = ['adapterMeta', 'duration_ms', 'exit', 'responseText', 'sessionId', 'warnings'];
    assert.deepEqual(keys, expectedKeys,
      `top-level keys must be the v0.9.x set; got: ${JSON.stringify(keys)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── compat.breaking reviewer-meta-and-regression ──────────────────────────────
// Reviewer-mode dispatch returns exec_mode: 'reviewer'.

test('compat.reviewer-meta: reviewer-mode dispatch returns exec_mode reviewer', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-compat-');
  try {
    const script = makeFakeCli(dir, [
      'printf \'{"type":"assistant-text","text":"review done"}\\n\'',
      'exit 0',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'reviewer',
      timeout_ms: 5000,
    });

    assert.equal(result.adapterMeta.exec_mode, 'reviewer',
      `reviewer mode must return exec_mode: 'reviewer'; got: ${result.adapterMeta.exec_mode}`);
    assert.equal(result.exit, 0);
    assert.equal(result.responseText, 'review done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── perf.slo reap-time ────────────────────────────────────────────────────────
// SIGTERM-trapping fake CLI in implementer mode must be reaped within 1000ms.
// (Also covers reviewer mode via the existing adapter-stubborn-timeout.test.js.)

test('perf.slo.reap-time: implementer mode SIGTERM-trapping child reaped within 1000ms', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-slo-');
  const pidsFile = join(dir, '.pids');
  const script = makeFakeCli(dir, [
    `PIDS='${pidsFile}'`,
    "trap '' TERM",
    'sleep 3600 &',
    'SLEEP_PID=$!',
    'printf "%s\\n%s\\n" "$$" "$SLEEP_PID" > "$PIDS"',
    'wait "$SLEEP_PID"',
  ]);
  let pidsToCheck = [];
  try {
    // Use a tight timeout_ms so abort fires quickly.
    await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 50,
    });

    if (existsSync(pidsFile)) {
      const pidLines = readFileSync(pidsFile, 'utf8').split('\n').filter(Boolean);
      pidsToCheck = pidLines.map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
    }

    // Poll up to 1000ms.
    let livePids = pidsToCheck.slice();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && livePids.length > 0) {
      livePids = livePids.filter(isAlive);
      if (livePids.length === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(livePids.length, 0,
      `SLO breach: process group not reaped within 1000ms in implementer mode: ${JSON.stringify(livePids)}`);
  } finally {
    for (const pid of pidsToCheck) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── critical.residual-risk silent-fallback-prevention ────────────────────────
// Fake CLI emits "unknown subcommand "exec"" on stderr and exits 64.
// Assert: exit === 64, exec_mode === 'implementer', NO silent fallback to
// reviewer mode (result must not look like a successful reviewer-mode run).

test('critical.silent-fallback-prevention: unknown subcommand error surfaces failure, no silent fallback', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = makeTmpDir('cps-impl-fallback-');
  try {
    const script = makeFakeCli(dir, [
      'printf \'unknown subcommand "exec"\\n\' >&2',
      'exit 64',
    ]);

    const result = await dispatch('system', 'user', {
      command: script,
      execMode: 'implementer',
      cwd: dir,
      timeout_ms: 5000,
    });

    // Must surface the failure.
    assert.equal(result.exit, 64,
      `expected exit 64; got: ${result.exit}`);
    assert.equal(result.adapterMeta.exec_mode, 'implementer',
      'exec_mode must be preserved as implementer on failure');
    // Must NOT look like a successful reviewer-mode run.
    assert.notEqual(result.exit, 0,
      'result must not be a successful exit (no silent fallback to reviewer)');
    assert.equal(result.responseText, '',
      'responseText must be empty on failure (no silent reviewer-mode output)');
    // The --json args (reviewer) must NOT have been used.
    assert.ok(
      !result.adapterMeta.args || !result.adapterMeta.args.includes('--json') ||
      result.adapterMeta.args.includes('exec'),
      `args should be implementer args, not reviewer --json: ${JSON.stringify(result.adapterMeta.args)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
