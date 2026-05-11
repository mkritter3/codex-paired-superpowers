// v0.8.0 expert-resolver — resolve a role name to an ExpertIdentity.
//
// Resolution order:
//   1. repo override: <repoRoot>/.codex-paired/experts/<role>.md  (source: "repo-override")
//   2. builtin:       <pluginRoot>/lib/codex-bridge/prompts/expert-<role>.md  (source: "builtin")
//   3. throw ExpertResolverError("expert-not-found")
//
// If a candidate file exists but is unreadable, throw
// ExpertResolverError("expert-prompt-unreadable") immediately rather than
// falling through to the next candidate (the override existing-but-broken is
// almost certainly a config error the operator wants surfaced).

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Module lives at <pluginRoot>/lib/codex-bridge/expert-resolver.js
const PLUGIN_ROOT = join(__dirname, '..', '..');

// Role-name regex — matches the role-suffix portion of the v0.8.0 mailbox
// recipient contract (`expert-<role>`). MUST be applied BEFORE constructing
// filesystem paths to prevent path traversal via the **Experts:** directive
// (e.g., role = `../evil` would otherwise resolve `join(repoRoot,
// '.codex-paired', 'experts', '../evil.md')` outside the experts directory).
// Also prevents returning identity ids like `expert-../evil` that fail
// mailbox RECIPIENT_RE validation downstream.
const ROLE_RE = /^[a-z][a-z0-9-]{0,47}$/;

export class ExpertResolverError extends Error {
  constructor(code, message, paths) {
    super(message);
    this.name = 'ExpertResolverError';
    this.code = code;
    this.paths = paths;
  }
}

export function resolveIdentity(role, repoRoot) {
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    throw new ExpertResolverError(
      'invalid-role-name',
      `role "${role}" does not match required format /^[a-z][a-z0-9-]{0,47}$/ (lowercase alphanumeric + hyphen, leading letter, max 48 chars)`,
      []
    );
  }
  const overridePath = join(
    repoRoot,
    '.codex-paired',
    'experts',
    `${role}.md`
  );
  const builtinPath = join(
    PLUGIN_ROOT,
    'lib',
    'codex-bridge',
    'prompts',
    `expert-${role}.md`
  );

  const tryPath = (path, source) => {
    if (!existsSync(path)) return null;
    try {
      readFileSync(path, 'utf8'); // verify readable
      return { id: `expert-${role}`, role, promptPath: path, source };
    } catch (err) {
      throw new ExpertResolverError(
        'expert-prompt-unreadable',
        `expert prompt at ${path} is not readable: ${err.message}`,
        [path]
      );
    }
  };

  const override = tryPath(overridePath, 'repo-override');
  if (override) return override;
  const builtin = tryPath(builtinPath, 'builtin');
  if (builtin) return builtin;

  throw new ExpertResolverError(
    'expert-not-found',
    `no expert prompt for role "${role}" (searched repo override: ${overridePath}; builtin: ${builtinPath})`,
    [overridePath, builtinPath]
  );
}
