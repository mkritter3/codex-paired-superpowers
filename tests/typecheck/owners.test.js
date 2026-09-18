import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const OWNER_PATHS = [
  'lib/codex-bridge/availability/doctor-report.js',
  'lib/codex-bridge/cli-harness/adapters/agy.js',
  'lib/codex-bridge/cli-harness/adapters/codex.js',
  'lib/codex-bridge/cli-harness/process-lifecycle.js',
  'lib/codex-bridge/cli.js',
  'lib/codex-bridge/dispatch-status.js',
  'lib/codex-bridge/implementer/codex-cli-dispatch.js',
  'lib/codex-bridge/implementer/types.js',
  'lib/codex-bridge/models.js',
  'lib/codex-bridge/project-config.js',
  'lib/codex-bridge/reviewer-thread.js',
  'lib/codex-bridge/sidecar.js',
  'lib/codex-bridge/thread-recovery.js',
  'lib/codex-bridge/types.js',
  'lib/codex-bridge/worktree.js',
];

test('every public-surface owner is allowlisted and carries the required pragma', async () => {
  const allowlist = JSON.parse(await readFile(resolve('typecheck.allowlist.json'), 'utf8'));

  for (const ownerPath of OWNER_PATHS) {
    assert.ok(allowlist.files.includes(ownerPath), `${ownerPath} is missing from the allowlist`);

    const source = await readFile(resolve(ownerPath), 'utf8');
    const lines = source.split(/\r?\n/);
    const pragmaLine = lines[0].startsWith('#!') ? lines[1] : lines[0];
    assert.equal(pragmaLine, '// @ts-check', `${ownerPath} is missing the required pragma`);
  }
});
