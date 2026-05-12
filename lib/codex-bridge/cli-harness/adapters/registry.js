// v0.9.0 slice 1 — adapter registry.
//
// Resolves a CLI adapter by name. Each cli-clients/<name>.json declares
// metadata (command, permission flag map, etc.) for an adapter that the
// harness dispatches through. For v0.9.0 only `codex` ships a working
// adapter; other configs (`claude`, `ollama`, `gemini`) are placeholders
// that subsequent slices/versions fill in.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_CLIENTS_DIR = join(__dirname, '..', '..', 'cli-clients');
const ADAPTERS_DIR = __dirname;

export class RegistryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'RegistryError';
    if (code) this.code = code;
  }
}

let configCache = null;

function loadAllConfigs() {
  if (configCache) return configCache;
  const out = new Map();
  let entries;
  try {
    entries = readdirSync(CLI_CLIENTS_DIR);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      configCache = out;
      return out;
    }
    throw err;
  }
  for (const file of entries) {
    if (extname(file) !== '.json') continue;
    const name = basename(file, '.json');
    const raw = readFileSync(join(CLI_CLIENTS_DIR, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new RegistryError(
        `cli-clients/${file} is not valid JSON: ${err.message}`,
        { code: 'CONFIG_INVALID_JSON' },
      );
    }
    out.set(name, parsed);
  }
  configCache = out;
  return out;
}

// Test hook: drop the in-process cache so a freshly added config file is
// picked up. Not part of the public contract.
export function _resetRegistryCache() {
  configCache = null;
}

export function getAdapterConfig(name) {
  const configs = loadAllConfigs();
  if (!configs.has(name)) {
    throw new RegistryError(`Unknown CLI adapter: ${name}`, {
      code: 'UNKNOWN_ADAPTER',
    });
  }
  return configs.get(name);
}

export async function getAdapter(name) {
  // First confirm the config exists — placeholders without a working
  // adapter still throw a clear UNKNOWN_ADAPTER_MODULE error.
  const config = getAdapterConfig(name);

  // Config-only entries (e.g. claude with runtime_kind: claude-task) are
  // not dispatched by the cli-harness; reject explicitly.
  if (config.runtime_kind && config.runtime_kind !== 'cli-harness') {
    throw new RegistryError(
      `Adapter '${name}' is config-only (runtime_kind=${config.runtime_kind}); not dispatchable by cli-harness`,
      { code: 'NOT_CLI_HARNESS' },
    );
  }

  const modulePath = join(ADAPTERS_DIR, `${name}.js`);
  let mod;
  try {
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND')) {
      throw new RegistryError(
        `No adapter module implemented for '${name}' yet`,
        { code: 'UNKNOWN_ADAPTER_MODULE' },
      );
    }
    throw err;
  }
  if (!mod || typeof mod.dispatch !== 'function') {
    throw new RegistryError(
      `Adapter module '${name}' does not export a dispatch() function`,
      { code: 'INVALID_ADAPTER_MODULE' },
    );
  }
  return { dispatch: mod.dispatch, config };
}
