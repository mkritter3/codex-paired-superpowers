// Plan 3 (reviewer naming migration) — reviewer-resolver: resolve a role name
// to a ReviewerIdentity. This is the canonical home for the resolver body that
// previously lived in expert-resolver.js (now a back-compat shim).
//
// Resolution order:
//   1. repo override: <repoRoot>/.codex-paired/experts/<role>.md  (source: "repo-override")
//   2. builtin:       <pluginRoot>/lib/codex-bridge/prompts/reviewer-<role>.md  (source: "builtin")
//   3. throw ReviewerResolverError("reviewer-not-found")
//
// If a candidate file exists but is unreadable, throw
// ReviewerResolverError("reviewer-prompt-unreadable") immediately rather than
// falling through to the next candidate (the override existing-but-broken is
// almost certainly a config error the operator wants surfaced).
//
// The repo-override directory keeps its legacy `.codex-paired/experts/` path for
// the migration window — only the prompt-file naming and identity ids move to
// the reviewer-* convention.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Module lives at <pluginRoot>/lib/codex-bridge/reviewer-resolver.js
const PLUGIN_ROOT = join(__dirname, '..', '..');

// Role-name regex — matches the role-suffix portion of the mailbox recipient
// contract (`reviewer-<role>`). MUST be applied BEFORE constructing filesystem
// paths to prevent path traversal via the **Reviewers:** directive (e.g.,
// role = `../evil` would otherwise resolve outside the experts directory) and
// to prevent returning identity ids like `reviewer-../evil` that fail mailbox
// RECIPIENT_RE validation downstream.
const ROLE_RE = /^[a-z][a-z0-9-]{0,47}$/;

export class ReviewerResolverError extends Error {
  constructor(code, message, paths) {
    super(message);
    this.name = 'ReviewerResolverError';
    this.code = code;
    this.paths = paths;
  }
}

export function resolveIdentity(role, repoRoot) {
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    throw new ReviewerResolverError(
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
    `reviewer-${role}.md`
  );

  const tryPath = (path, source) => {
    if (!existsSync(path)) return null;
    try {
      readFileSync(path, 'utf8'); // verify readable
      return { id: `reviewer-${role}`, role, promptPath: path, source };
    } catch (err) {
      throw new ReviewerResolverError(
        'reviewer-prompt-unreadable',
        `reviewer prompt at ${path} is not readable: ${err.message}`,
        [path]
      );
    }
  };

  const override = tryPath(overridePath, 'repo-override');
  if (override) return override;
  const builtin = tryPath(builtinPath, 'builtin');
  if (builtin) return builtin;

  throw new ReviewerResolverError(
    'reviewer-not-found',
    `no reviewer prompt for role "${role}" (searched repo override: ${overridePath}; builtin: ${builtinPath})`,
    [overridePath, builtinPath]
  );
}
