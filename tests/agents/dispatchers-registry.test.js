// Tests for v0.7.2 dispatchers.json registry + lib/codex-bridge/dispatchers.js loader.
// Validates: schema correctness (transport-aware), agent file consistency,
// contract file consistency, getDispatcher lookup, enforceDomainPolicy lookup,
// and drift detection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  loadRegistry,
  getDispatcher,
  enforceDomainPolicy,
  _resetCache,
  DispatcherRegistryError,
  ALLOWED_DOMAINS,
  ALLOWED_POLICIES
} from '../../lib/codex-bridge/dispatchers.js';

function makeFixturePlugin({ registryContent, agentFiles, contractFiles }) {
  const root = mkdtempSync(join(tmpdir(), 'cps-dispatchers-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  if (registryContent !== null && registryContent !== undefined) {
    writeFileSync(join(root, 'agents', 'dispatchers.json'), registryContent);
  }
  for (const [name, content] of Object.entries(agentFiles ?? {})) {
    writeFileSync(join(root, 'agents', `${name}.md`), content);
  }
  for (const [relPath, content] of Object.entries(contractFiles ?? {})) {
    const fullPath = join(root, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const VALID_SONNET_AGENT = `---
name: slice-implementer-sonnet
description: sonnet test
tools: Read, Edit, Write, Bash
model: sonnet
---

body
`;

const VALID_CONTRACT = `# Codex Implementer Contract

Test fixture content.
`;

// v0.7.2 registry: transport-aware schema. codex uses contract field;
// sonnet uses agent field.
const VALID_REGISTRY = JSON.stringify({
  codex: {
    transport: 'codex-background-bash',
    contract: 'docs/codex-implementer-contract.md',
    tools: ['Bash'],
    domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
  },
  sonnet: {
    transport: 'claude-subagent',
    agent: 'slice-implementer-sonnet',
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    domains: { ui: 'preferred', 'ai-harness': 'preferred', backend: 'allowed', general: 'preferred' }
  }
}, null, 2);

const STANDARD_FIXTURE = {
  registryContent: VALID_REGISTRY,
  agentFiles: { 'slice-implementer-sonnet': VALID_SONNET_AGENT },
  contractFiles: { 'docs/codex-implementer-contract.md': VALID_CONTRACT },
};

test('loadRegistry: valid v0.7.2 registry loads cleanly', () => {
  _resetCache();
  const root = makeFixturePlugin(STANDARD_FIXTURE);
  const registry = loadRegistry(root);
  assert.equal(registry.codex.transport, 'codex-background-bash');
  assert.equal(registry.codex.contract, 'docs/codex-implementer-contract.md');
  assert.equal(registry.sonnet.transport, 'claude-subagent');
  assert.equal(registry.sonnet.agent, 'slice-implementer-sonnet');
  cleanup(root);
});

test('getDispatcher returns entry for known implementer', () => {
  _resetCache();
  const root = makeFixturePlugin(STANDARD_FIXTURE);
  const codexEntry = getDispatcher('codex', root);
  assert.equal(codexEntry.transport, 'codex-background-bash');
  assert.deepEqual(codexEntry.tools, ['Bash']);
  const sonnetEntry = getDispatcher('sonnet', root);
  assert.equal(sonnetEntry.transport, 'claude-subagent');
  cleanup(root);
});

test('getDispatcher throws implementer-directive-malformed for unknown implementer', () => {
  _resetCache();
  const root = makeFixturePlugin(STANDARD_FIXTURE);
  assert.throws(
    () => getDispatcher('opus', root),
    err => err instanceof DispatcherRegistryError && err.code === 'implementer-directive-malformed'
  );
  cleanup(root);
});

test('enforceDomainPolicy returns policy string for valid pair', () => {
  _resetCache();
  const root = makeFixturePlugin(STANDARD_FIXTURE);
  assert.equal(enforceDomainPolicy('codex', 'ui', root), 'forbidden');
  assert.equal(enforceDomainPolicy('codex', 'backend', root), 'preferred');
  assert.equal(enforceDomainPolicy('sonnet', 'ui', root), 'preferred');
  assert.equal(enforceDomainPolicy('sonnet', 'backend', root), 'allowed');
  cleanup(root);
});

test('enforceDomainPolicy throws domain-directive-malformed for unknown domain', () => {
  _resetCache();
  const root = makeFixturePlugin(STANDARD_FIXTURE);
  assert.throws(
    () => enforceDomainPolicy('codex', 'gpu', root),
    err => err instanceof DispatcherRegistryError && err.code === 'domain-directive-malformed'
  );
  cleanup(root);
});

test('drift: subagent tools mismatch between registry and frontmatter throws', () => {
  _resetCache();
  const driftedAgent = VALID_SONNET_AGENT.replace('Read, Edit, Write, Bash', 'Read, Edit, Write, Bash, WebFetch');
  const root = makeFixturePlugin({
    ...STANDARD_FIXTURE,
    agentFiles: { 'slice-implementer-sonnet': driftedAgent },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('tools')
  );
  cleanup(root);
});

test('drift: subagent name mismatch between registry and frontmatter throws', () => {
  _resetCache();
  const wrongNameAgent = VALID_SONNET_AGENT.replace('name: slice-implementer-sonnet', 'name: slice-implementer-sonnet-renamed');
  const root = makeFixturePlugin({
    ...STANDARD_FIXTURE,
    agentFiles: { 'slice-implementer-sonnet': wrongNameAgent },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('name')
  );
  cleanup(root);
});

test('drift: missing subagent file throws at load', () => {
  _resetCache();
  const root = makeFixturePlugin({
    ...STANDARD_FIXTURE,
    agentFiles: {}, // omit slice-implementer-sonnet
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('missing agent file')
  );
  cleanup(root);
});

test('drift: missing contract file for codex-background-bash throws at load (v0.7.2)', () => {
  _resetCache();
  const root = makeFixturePlugin({
    ...STANDARD_FIXTURE,
    contractFiles: {}, // omit the contract doc
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('missing contract file')
  );
  cleanup(root);
});

test('schema: transport=claude-subagent must NOT have contract field', () => {
  _resetCache();
  const malformed = JSON.stringify({
    sonnet: {
      transport: 'claude-subagent',
      agent: 'slice-implementer-sonnet',
      contract: 'docs/spurious-contract.md',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      domains: { ui: 'preferred', 'ai-harness': 'preferred', backend: 'allowed', general: 'preferred' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: malformed,
    agentFiles: { 'slice-implementer-sonnet': VALID_SONNET_AGENT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('must NOT have a \'contract\'')
  );
  cleanup(root);
});

test('schema: transport=codex-background-bash must NOT have agent field', () => {
  _resetCache();
  const malformed = JSON.stringify({
    codex: {
      transport: 'codex-background-bash',
      contract: 'docs/codex-implementer-contract.md',
      agent: 'slice-implementer-codex',
      tools: ['Bash'],
      domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: malformed,
    contractFiles: { 'docs/codex-implementer-contract.md': VALID_CONTRACT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('must NOT have an \'agent\'')
  );
  cleanup(root);
});

test('schema: invalid transport value throws', () => {
  _resetCache();
  const malformed = JSON.stringify({
    codex: {
      transport: 'mcp-server',  // not in v0.7.2 allowed list
      contract: 'docs/codex-implementer-contract.md',
      tools: ['Bash'],
      domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: malformed,
    contractFiles: { 'docs/codex-implementer-contract.md': VALID_CONTRACT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('invalid transport')
  );
  cleanup(root);
});

test('schema: registry pointing at deprecated slice-implementer-codex agent throws (v0.7.2)', () => {
  _resetCache();
  // A registry that ATTEMPTS to keep codex as a subagent (regression test).
  const deprecatedRegistry = JSON.stringify({
    codex: {
      transport: 'claude-subagent',
      agent: 'slice-implementer-codex',
      tools: ['Read', 'Bash'],
      domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
    }
  });
  const oldStyleAgent = `---
name: slice-implementer-codex
description: deprecated
tools: Read, Bash
model: sonnet
---
body
`;
  const root = makeFixturePlugin({
    registryContent: deprecatedRegistry,
    agentFiles: { 'slice-implementer-codex': oldStyleAgent },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('deprecated')
  );
  cleanup(root);
});

test('schema: missing required common field throws', () => {
  _resetCache();
  const incomplete = JSON.stringify({
    sonnet: {
      transport: 'claude-subagent',
      agent: 'slice-implementer-sonnet',
      tools: ['Read', 'Edit', 'Write', 'Bash']
      // missing: domains
    }
  });
  const root = makeFixturePlugin({
    registryContent: incomplete,
    agentFiles: { 'slice-implementer-sonnet': VALID_SONNET_AGENT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('domains')
  );
  cleanup(root);
});

test('schema: domains missing a required key throws', () => {
  _resetCache();
  const partialDomains = JSON.stringify({
    sonnet: {
      transport: 'claude-subagent',
      agent: 'slice-implementer-sonnet',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      domains: { ui: 'preferred', backend: 'allowed', general: 'preferred' }
      // missing: ai-harness
    }
  });
  const root = makeFixturePlugin({
    registryContent: partialDomains,
    agentFiles: { 'slice-implementer-sonnet': VALID_SONNET_AGENT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('ai-harness')
  );
  cleanup(root);
});

test('schema: invalid policy value throws', () => {
  _resetCache();
  const badPolicy = JSON.stringify({
    sonnet: {
      transport: 'claude-subagent',
      agent: 'slice-implementer-sonnet',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      domains: { ui: 'banned', 'ai-harness': 'preferred', backend: 'allowed', general: 'preferred' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: badPolicy,
    agentFiles: { 'slice-implementer-sonnet': VALID_SONNET_AGENT },
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('banned')
  );
  cleanup(root);
});

test('schema: invalid JSON throws', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: '{not json',
    agentFiles: {},
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('not valid JSON')
  );
  cleanup(root);
});

test('schema: missing registry file throws', () => {
  _resetCache();
  const root = makeFixturePlugin({ registryContent: null, agentFiles: {} });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('not found')
  );
  cleanup(root);
});

test('production registry (real plugin root) loads + validates clean (v0.7.2)', () => {
  _resetCache();
  // No rootOverride: uses the actual plugin's agents/dispatchers.json + frontmatter + contract doc.
  const registry = loadRegistry();
  assert.ok(registry.codex);
  assert.ok(registry.sonnet);
  assert.equal(registry.codex.transport, 'codex-background-bash');
  assert.equal(registry.codex.contract, 'docs/codex-implementer-contract.md');
  assert.equal(registry.sonnet.transport, 'claude-subagent');
  assert.deepEqual([...registry.codex.tools].sort(), ['Bash']);
  assert.deepEqual([...registry.sonnet.tools].sort(), ['Bash', 'Edit', 'Read', 'Write'].sort());
});

test('exports: ALLOWED_DOMAINS and ALLOWED_POLICIES are accessible', () => {
  assert.deepEqual(ALLOWED_DOMAINS, ['ui', 'ai-harness', 'backend', 'general']);
  assert.deepEqual(ALLOWED_POLICIES, ['forbidden', 'allowed', 'preferred']);
});
