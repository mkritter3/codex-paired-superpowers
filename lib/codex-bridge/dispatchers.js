// v0.7.1 dispatcher registry loader.
//
// Pure config validation + lookup. NO domain inference, NO implementer selection,
// NO dispatch logic. The orchestrator (Claude in SKILL.md) owns those decisions;
// this module only validates the registry schema and answers two questions:
//
//   getDispatcher(implementer)       -> registry entry, or throws
//   enforceDomainPolicy(impl, domain) -> "forbidden" | "allowed" | "preferred"
//
// Per spec §6.5, the registry lives at <plugin>/agents/dispatchers.json and is
// validated against agent frontmatter at load time (drift throws).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_DOMAINS = ['ui', 'ai-harness', 'backend', 'general'];
const ALLOWED_POLICIES = ['forbidden', 'allowed', 'preferred'];
const REQUIRED_ENTRY_KEYS = ['agent', 'transport', 'tools', 'domains'];
const DEPRECATED_AGENT_NAME = 'slice-implementer';

class DispatcherRegistryError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'DispatcherRegistryError';
    this.code = code;
    this.detail = detail;
  }
}

function pluginRoot() {
  // dispatchers.js lives at <plugin>/lib/codex-bridge/dispatchers.js
  // walk up two levels.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

function parseFrontmatter(markdown) {
  // Minimal YAML frontmatter parser. The agent files use a small fixed schema:
  // a leading "---" delimited block with simple "key: value" lines.
  // We only need `name` and `tools`; anything more would import a yaml dep.
  if (!markdown.startsWith('---')) {
    throw new DispatcherRegistryError(
      'agent-frontmatter-missing',
      'agent file missing leading --- frontmatter delimiter'
    );
  }
  const end = markdown.indexOf('\n---', 3);
  if (end < 0) {
    throw new DispatcherRegistryError(
      'agent-frontmatter-unterminated',
      'agent file frontmatter delimiter not closed'
    );
  }
  const body = markdown.slice(3, end);
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
  const fm = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fm[key] = value;
  }
  return fm;
}

function parseToolsField(toolsRaw) {
  // The agent frontmatter writes tools as a comma-separated list:
  //   tools: Read, Edit, Write, Bash
  // We compare against the registry's array form, so split + trim.
  if (!toolsRaw) return [];
  return toolsRaw.split(',').map(t => t.trim()).filter(Boolean);
}

function arraysEqualIgnoreOrder(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function validateEntry(implementer, entry) {
  for (const key of REQUIRED_ENTRY_KEYS) {
    if (!(key in entry)) {
      throw new DispatcherRegistryError(
        'dispatcher-registry-malformed',
        `implementer "${implementer}" missing required field: ${key}`
      );
    }
  }
  if (typeof entry.agent !== 'string' || entry.agent.length === 0) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" has invalid agent field`
    );
  }
  if (entry.agent === DEPRECATED_AGENT_NAME) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" points at deprecated unified ${DEPRECATED_AGENT_NAME} agent; use a per-implementer agent file instead`
    );
  }
  if (typeof entry.transport !== 'string' || entry.transport.length === 0) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" has invalid transport field`
    );
  }
  if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" tools must be a non-empty array`
    );
  }
  for (const t of entry.tools) {
    if (typeof t !== 'string') {
      throw new DispatcherRegistryError(
        'dispatcher-registry-malformed',
        `implementer "${implementer}" tools array contains non-string entry`
      );
    }
  }
  if (typeof entry.domains !== 'object' || entry.domains === null || Array.isArray(entry.domains)) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" domains must be an object`
    );
  }
  for (const d of ALLOWED_DOMAINS) {
    if (!(d in entry.domains)) {
      throw new DispatcherRegistryError(
        'dispatcher-registry-malformed',
        `implementer "${implementer}" domains missing required domain: ${d}`
      );
    }
    if (!ALLOWED_POLICIES.includes(entry.domains[d])) {
      throw new DispatcherRegistryError(
        'dispatcher-registry-malformed',
        `implementer "${implementer}" domain "${d}" has invalid policy "${entry.domains[d]}"; expected one of ${ALLOWED_POLICIES.join(', ')}`
      );
    }
  }
  for (const d of Object.keys(entry.domains)) {
    if (!ALLOWED_DOMAINS.includes(d)) {
      throw new DispatcherRegistryError(
        'dispatcher-registry-malformed',
        `implementer "${implementer}" has unknown domain key: ${d}`
      );
    }
  }
}

function validateAgentConsistency(implementer, entry, agentsDir) {
  const agentPath = join(agentsDir, `${entry.agent}.md`);
  if (!existsSync(agentPath)) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" registry entry references missing agent file: ${agentPath}`
    );
  }
  const markdown = readFileSync(agentPath, 'utf8');
  const fm = parseFrontmatter(markdown);
  if (fm.name !== entry.agent) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" registry agent="${entry.agent}" does not match frontmatter name="${fm.name}" in ${agentPath}`
    );
  }
  const fmTools = parseToolsField(fm.tools);
  if (!arraysEqualIgnoreOrder(fmTools, entry.tools)) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `implementer "${implementer}" registry tools=${JSON.stringify(entry.tools)} do not match frontmatter tools=${JSON.stringify(fmTools)} in ${agentPath}`
    );
  }
}

let cachedRegistry = null;
let cachedRegistryRoot = null;

export function loadRegistry(rootOverride) {
  const root = rootOverride ?? pluginRoot();
  if (cachedRegistry && cachedRegistryRoot === root) return cachedRegistry;
  const registryPath = join(root, 'agents', 'dispatchers.json');
  if (!existsSync(registryPath)) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `dispatcher registry not found at ${registryPath}`
    );
  }
  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (e) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `failed to read dispatcher registry: ${e.message}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      `dispatcher registry is not valid JSON: ${e.message}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      'dispatcher registry top-level value must be an object keyed by implementer name'
    );
  }
  const implementers = Object.keys(parsed);
  if (implementers.length === 0) {
    throw new DispatcherRegistryError(
      'dispatcher-registry-malformed',
      'dispatcher registry must contain at least one implementer'
    );
  }
  const agentsDir = join(root, 'agents');
  for (const impl of implementers) {
    validateEntry(impl, parsed[impl]);
    validateAgentConsistency(impl, parsed[impl], agentsDir);
  }
  cachedRegistry = parsed;
  cachedRegistryRoot = root;
  return parsed;
}

export function getDispatcher(implementer, rootOverride) {
  const registry = loadRegistry(rootOverride);
  const entry = registry[implementer];
  if (!entry) {
    throw new DispatcherRegistryError(
      'implementer-directive-malformed',
      `unknown implementer: "${implementer}"; registry has [${Object.keys(registry).join(', ')}]`
    );
  }
  return entry;
}

export function enforceDomainPolicy(implementer, domain, rootOverride) {
  const entry = getDispatcher(implementer, rootOverride);
  if (!ALLOWED_DOMAINS.includes(domain)) {
    throw new DispatcherRegistryError(
      'domain-directive-malformed',
      `unknown domain: "${domain}"; allowed values: ${ALLOWED_DOMAINS.join(', ')}`
    );
  }
  return entry.domains[domain];
}

// Test helper. Allows tests to clear the load cache between fixtures.
export function _resetCache() {
  cachedRegistry = null;
  cachedRegistryRoot = null;
}

export { DispatcherRegistryError, ALLOWED_DOMAINS, ALLOWED_POLICIES };
