#!/usr/bin/env node
// v0.9.0 slice 8 — collect test files for npm test, excluding Tier 4 + 5.
//
// Usage (called internally by npm scripts):
//   node scripts/collect-test-files.mjs [--all]
//
// Without --all: excludes tests/installed-smoke/ and tests/replay/.
// With --all: includes all .test.js files under tests/.
//
// Outputs a space-separated list of file paths for `node --test`.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');
const TESTS_DIR = join(REPO_ROOT, 'tests');

const ALL = process.argv.includes('--all');

// Directories to exclude from the default `npm test` run (Tier 4 + 5).
const EXCLUDED_DIRS = ALL ? new Set() : new Set(['installed-smoke', 'replay']);

function collectTestFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      results.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = collectTestFiles(TESTS_DIR);
// Output one file per line so the caller can use xargs or command substitution.
process.stdout.write(files.join(' ') + '\n');
