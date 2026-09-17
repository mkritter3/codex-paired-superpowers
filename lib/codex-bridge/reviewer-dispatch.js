import { dispatch as dispatchHarness } from './cli-harness/harness.js';
import { readUnreadMessages } from './mailbox.js';
import { harnessModelOptions } from './models.js';
import { assembleSpawnPrompt } from './reviewer-turn.js';

const ALLOWED_HARNESS_OPTIONS = new Set(['timeout_ms', 'maxBufferBytes', 'command', 'env']);
const HARNESS_OPTIONS_ERROR =
  'reviewer-dispatch: harnessOptions may only set timeout_ms|maxBufferBytes|command|env';

/**
 * Dispatch one real reviewer request through the CLI harness.
 * Implements spec §1 role selection for cli-harness reviewer turns.
 */
export async function dispatchReviewerViaHarness(request, {
  cli,
  variant = 'read-only',
  repoRoot,
  timeout_ms = 15 * 60 * 1000,
  env,
  harnessOptions = {},
  deps = {},
} = {}) {
  for (const key of Object.keys(harnessOptions)) {
    if (!ALLOWED_HARNESS_OPTIONS.has(key)) throw new Error(HARNESS_OPTIONS_ERROR);
  }

  const effectiveRoot = repoRoot ?? request.repoRoot;
  const readMessages = deps.readUnreadMessages ?? readUnreadMessages;
  const unreadMessages = await readMessages(effectiveRoot, request.identity.id);
  const prompt = assembleSpawnPrompt({ ...request, unreadMessages });
  const resolved = harnessModelOptions(request.phase, { repoRoot: effectiveRoot, env });

  const options = {
    timeout_ms,
    ...harnessOptions,
  };
  if (cli === 'codex') {
    options.modelRole = resolved.modelRole;
    options.model = resolved.model;
    options.reasoningEffort = resolved.reasoningEffort;
  }
  const result = await dispatchHarness(
    { cli, variant },
    '',
    prompt,
    options,
    deps.adapters instanceof Map ? { adapters: deps.adapters } : {},
  );
  const requestForTurn = {
    ...request,
    adapter: `cli-harness:${cli}`,
    modelRole: resolved.modelRole,
    modelRoleWarning: resolved.warning,
  };
  return {
    responseText: result.responseText,
    result,
    ...resolved,
    requestForTurn,
  };
}
