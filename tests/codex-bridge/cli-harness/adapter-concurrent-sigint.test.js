import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch as codexDispatch } from '../../../lib/codex-bridge/cli-harness/adapters/codex.js';

const TEST_TIMEOUT_MS = 12_000;

function makeSignalAware(name) {
  const dir = mkdtempSync(join(tmpdir(), `cps-concurrent-sigint-${name}-`));
  const script = join(dir, 'codex');
  const sigintMarker = join(dir, '.got-sigint');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `MARKER='${sigintMarker}'`,
      `trap 'touch "$MARKER"; exit 130' INT`,
      'cat > /dev/null &',
      'sleep 5',
    ].join('\n'),
    'utf8',
  );
  chmodSync(script, 0o755);
  return { dir, script, sigintMarker };
}

function resultShowsInterrupted(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings.join(' ') : '';
  const meta = result?.adapterMeta ? JSON.stringify(result.adapterMeta) : '';
  return (
    (typeof result?.exit === 'number' && result.exit !== 0) ||
    /SIGINT|INT|abort|aborted|kill|killed|nonzero/i.test(warnings) ||
    /SIGINT|INT|abort|aborted|kill|killed/i.test(meta)
  );
}

test('codex adapter: concurrent SIGINT forwarders all clean up after 3 active dispatches', {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const fixtures = ['a', 'b', 'c'].map(makeSignalAware);
  const listenersBefore = process.listenerCount('SIGINT');
  try {
    const dispatches = fixtures.map(({ script }) =>
      codexDispatch('system', 'user', {
        command: script,
        args: [],
        timeout_ms: 8000,
      }),
    );

    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      process.listenerCount('SIGINT') >= listenersBefore + 3,
      'each active dispatch should install its own SIGINT forwarder',
    );

    const swallow = () => {};
    process.on('SIGINT', swallow);
    try {
      process.kill(process.pid, 'SIGINT');
    } finally {
      process.removeListener('SIGINT', swallow);
    }

    const results = await Promise.all(dispatches);
    assert.equal(results.length, 3);

    assert.equal(
      process.listenerCount('SIGINT'),
      listenersBefore,
      'SIGINT listener count must return to baseline after concurrent dispatch cleanup',
    );

    const markerCount = fixtures.filter((f) => existsSync(f.sigintMarker)).length;
    const interruptedCount = results.filter(resultShowsInterrupted).length;
    assert.ok(
      markerCount === 3 || interruptedCount === 3,
      `expected all markers or all interrupted results; markers=${markerCount}, ` +
        `interrupted=${interruptedCount}, results=${JSON.stringify(results, null, 2)}`,
    );
  } finally {
    for (const { dir } of fixtures) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
