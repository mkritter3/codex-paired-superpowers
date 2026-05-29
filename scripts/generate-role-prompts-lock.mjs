#!/usr/bin/env node
// v0.9.0 slice 5a — generate lib/codex-bridge/role-prompts.lock.json
//
// Walks lib/codex-bridge/prompts/, hashes each file's FULL contents (including
// frontmatter) with SHA-256, and emits a deterministic lock file the
// dispatcher can audit at run time against `role_prompt_hash`.
//
// Run:
//   node scripts/generate-role-prompts-lock.mjs            # (re)write the lock
//   node scripts/generate-role-prompts-lock.mjs --check    # verify, exit 1 on drift
//
// Plan 3 (reviewer naming migration): the 7 role prompts were renamed
// reviewer-<x>.md (role_id reviewer-<x>); expert-template.md stays as authoring
// scaffolding. `--check` recomputes the prompts map and compares it to the
// committed lock, IGNORING `generated_at`, exiting non-zero on drift.
//
// Output shape (sorted keys for stable diffs):
// {
//   "generated_at": "<iso>",
//   "prompts": {
//     "reviewer-architecture": { "path": "lib/codex-bridge/prompts/...", "sha256": "..." },
//     ...
//   }
// }

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROMPTS_DIR = join(REPO_ROOT, 'lib', 'codex-bridge', 'prompts');
// Env overrides exist for the --check integration test (point at a temp lock
// without disturbing the committed one). Production runs use the defaults.
const LOCK_FILE =
  process.env.RP_LOCK_FILE_OVERRIDE ||
  join(REPO_ROOT, 'lib', 'codex-bridge', 'role-prompts.lock.json');

// Filename → role id. system-rubric.md is the paired-reviewer base prompt;
// reviewer-<x>.md files are 1:1 with their role id; expert-template.md is
// authoring scaffolding (kept under its legacy key, not a reviewer role).
function filenameToRoleId(filename) {
  if (filename === 'system-rubric.md') return 'paired-reviewer';
  if (filename === 'expert-template.md') return 'expert-template';
  if (filename.startsWith('reviewer-') && filename.endsWith('.md')) {
    return filename.slice(0, -'.md'.length);
  }
  return null; // skip non-role files (validation-rubric.md, verdict-format.md, …)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recompute the prompts map from disk (path + sha256 per role).
 * Pure: reads files, returns the map, writes nothing.
 */
export function computePromptsMap(promptsDir = PROMPTS_DIR) {
  const entries = readdirSync(promptsDir).sort();
  const prompts = {};
  for (const filename of entries) {
    const roleId = filenameToRoleId(filename);
    if (!roleId) continue;
    const fullPath = join(promptsDir, filename);
    const content = readFileSync(fullPath);
    prompts[roleId] = {
      path: relative(REPO_ROOT, fullPath).split('\\').join('/'),
      sha256: sha256Hex(content),
    };
  }
  return prompts;
}

function promptsEqual(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => a[k].sha256 === b[k].sha256 && a[k].path === b[k].path);
}

/**
 * Compare a committed lock to the freshly-computed prompts map, ignoring
 * `generated_at`. Returns { ok, reason?, computed, existing }.
 */
export function checkLock(lockFile = LOCK_FILE, promptsDir = PROMPTS_DIR) {
  const computed = computePromptsMap(promptsDir);
  let existing;
  try {
    existing = JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `cannot read lock: ${err.message}`, computed };
  }
  if (!existing || typeof existing !== 'object' || !existing.prompts) {
    return { ok: false, reason: 'lock missing "prompts" object', computed };
  }
  return { ok: promptsEqual(existing.prompts, computed), computed, existing: existing.prompts };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const { ok, reason } = checkLock(LOCK_FILE, PROMPTS_DIR);
    if (ok) {
      process.stdout.write('lock up to date\n');
      process.exit(0);
    }
    process.stderr.write(
      `role-prompts.lock.json drift detected${reason ? `: ${reason}` : ''} — ` +
        `regenerate with: node scripts/generate-role-prompts-lock.mjs\n`
    );
    process.exit(1);
  }
  const prompts = computePromptsMap(PROMPTS_DIR);
  const out = {
    generated_at: new Date().toISOString(),
    prompts,
  };
  writeFileSync(LOCK_FILE, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(
    `wrote ${relative(REPO_ROOT, LOCK_FILE)} with ${Object.keys(prompts).length} roles\n`
  );
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main();
