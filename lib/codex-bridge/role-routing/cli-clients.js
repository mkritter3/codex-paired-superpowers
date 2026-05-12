// v0.9.0 slice 3 — bundled cli-client config loader.
//
// Reads every `cli-clients/<name>.json` shipped with the plugin and
// returns a Map<name, configObject>. Used by recommendations validation
// and by config-loader's merge step. Separated from the cli-harness
// registry's loader to avoid cross-slice coupling (cli-harness owns
// adapter resolution; role-routing only needs static config shape).

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RoleRoutingError } from './errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUNDLED_CLI_CLIENTS_DIR = join(__dirname, '..', 'cli-clients');

let bundledCache = null;

export function loadBundledCliClients() {
  if (bundledCache) return bundledCache;
  bundledCache = readCliClientsDir(BUNDLED_CLI_CLIENTS_DIR);
  return bundledCache;
}

// Test seam: drop the in-process cache so a fresh on-disk JSON is
// re-read. Not part of the public contract.
export function _resetBundledCliClientsCache() {
  bundledCache = null;
}

export function readCliClientsDir(dirPath) {
  const out = new Map();
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return out;
    throw err;
  }
  for (const file of entries) {
    if (extname(file) !== '.json') continue;
    const name = basename(file, '.json');
    const raw = readFileSync(join(dirPath, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new RoleRoutingError(
        `cli-clients/${file} is not valid JSON: ${err.message}`,
        { code: 'CLI_CLIENT_INVALID_JSON' },
      );
    }
    out.set(name, parsed);
  }
  return out;
}
