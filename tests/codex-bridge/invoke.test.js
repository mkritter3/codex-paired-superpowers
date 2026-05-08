import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startSession, resumeSession } from '../../lib/codex-bridge/invoke.js';

const here = dirname(fileURLToPath(import.meta.url));
const mockBin = join(here, 'fixtures', 'mock-codex.js');

test('startSession returns session UUID and final reply', async () => {
  const { sessionId, reply } = await startSession({
    prompt: 'hi',
    codexBin: mockBin,
    env: { MOCK_CODEX_SESSION: '019e0507-0000-7000-8000-000000000abc', MOCK_CODEX_REPLY: 'hello' },
  });
  assert.equal(sessionId, '019e0507-0000-7000-8000-000000000abc');
  assert.equal(reply.trim(), 'hello');
});

test('resumeSession returns final reply for an existing session', async () => {
  const { reply } = await resumeSession({
    sessionId: '019e0507-0000-7000-8000-000000000abc',
    prompt: 'follow up',
    codexBin: mockBin,
    env: { MOCK_CODEX_REPLY: 'second reply' },
  });
  assert.equal(reply.trim(), 'second reply');
});
