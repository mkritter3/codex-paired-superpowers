#!/usr/bin/env node
// v0.9.0 slice 5a — generate lib/codex-bridge/role-prompts.lock.json
//
// Walks lib/codex-bridge/prompts/, hashes each file's FULL contents (including
// frontmatter) with SHA-256, and emits a deterministic lock file the
// dispatcher can audit at run time against `role_prompt_hash`.
//
// Run:
//   node scripts/generate-role-prompts-lock.mjs
//
// Output shape (sorted keys for stable diffs):
// {
//   "generated_at": "<iso>",
//   "prompts": {
//     "expert-architecture": { "path": "lib/codex-bridge/prompts/...", "sha256": "..." },
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
const LOCK_FILE = join(REPO_ROOT, 'lib', 'codex-bridge', 'role-prompts.lock.json');

// Filename → role id. system-rubric.md is the paired-reviewer base prompt;
// expert-*.md files are 1:1 with their role id.
function filenameToRoleId(filename) {
  if (filename === 'system-rubric.md') return 'paired-reviewer';
  if (filename.startsWith('expert-') && filename.endsWith('.md')) {
    return filename.slice(0, -'.md'.length);
  }
  return null; // skip non-role files (validation-rubric.md, verdict-format.md, …)
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function main() {
  const entries = readdirSync(PROMPTS_DIR).sort();
  const prompts = {};
  for (const filename of entries) {
    const roleId = filenameToRoleId(filename);
    if (!roleId) continue;
    const fullPath = join(PROMPTS_DIR, filename);
    const content = readFileSync(fullPath);
    prompts[roleId] = {
      path: relative(REPO_ROOT, fullPath).split('\\').join('/'),
      sha256: sha256Hex(content),
    };
  }
  const out = {
    generated_at: new Date().toISOString(),
    prompts,
  };
  writeFileSync(LOCK_FILE, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(
    `wrote ${relative(REPO_ROOT, LOCK_FILE)} with ${Object.keys(prompts).length} roles\n`
  );
}

main();
