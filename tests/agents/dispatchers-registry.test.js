// Tests for v0.7.1 dispatchers.json registry + lib/codex-bridge/dispatchers.js loader.
// Validates: schema correctness, agent file consistency, getDispatcher lookup,
// enforceDomainPolicy lookup, and drift detection (registry vs frontmatter).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadRegistry,
  getDispatcher,
  enforceDomainPolicy,
  _resetCache,
  DispatcherRegistryError,
  ALLOWED_DOMAINS,
  ALLOWED_POLICIES
} from '../../lib/codex-bridge/dispatchers.js';

function makeFixturePlugin({ registryContent, agentFiles }) {
  const root = mkdtempSync(join(tmpdir(), 'cps-dispatchers-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  if (registryContent !== null) {
    writeFileSync(join(root, 'agents', 'dispatchers.json'), registryContent);
  }
  for (const [name, content] of Object.entries(agentFiles)) {
    writeFileSync(join(root, 'agents', `${name}.md`), content);
  }
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

const VALID_CODEX_AGENT = `---
name: slice-implementer-codex
description: codex test
tools: Read, Bash
model: sonnet
---

body
`;

const VALID_SONNET_AGENT = `---
name: slice-implementer-sonnet
description: sonnet test
tools: Read, Edit, Write, Bash
model: sonnet
---

body
`;

const VALID_REGISTRY = JSON.stringify({
  codex: {
    agent: 'slice-implementer-codex',
    transport: 'codex-exec',
    tools: ['Read', 'Bash'],
    domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
  },
  sonnet: {
    agent: 'slice-implementer-sonnet',
    transport: 'claude-subagent',
    tools: ['Read', 'Edit', 'Write', 'Bash'],
    domains: { ui: 'preferred', 'ai-harness': 'preferred', backend: 'allowed', general: 'preferred' }
  }
}, null, 2);

test('loadRegistry: valid registry + agents loads cleanly', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': VALID_CODEX_AGENT,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  const registry = loadRegistry(root);
  assert.equal(registry.codex.agent, 'slice-implementer-codex');
  assert.equal(registry.sonnet.transport, 'claude-subagent');
  cleanup(root);
});

test('getDispatcher returns entry for known implementer', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': VALID_CODEX_AGENT,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  const entry = getDispatcher('codex', root);
  assert.equal(entry.transport, 'codex-exec');
  assert.deepEqual(entry.tools, ['Read', 'Bash']);
  cleanup(root);
});

test('getDispatcher throws implementer-directive-malformed for unknown implementer', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': VALID_CODEX_AGENT,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.throws(
    () => getDispatcher('opus', root),
    err => err instanceof DispatcherRegistryError && err.code === 'implementer-directive-malformed'
  );
  cleanup(root);
});

test('enforceDomainPolicy returns policy string for valid pair', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': VALID_CODEX_AGENT,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.equal(enforceDomainPolicy('codex', 'ui', root), 'forbidden');
  assert.equal(enforceDomainPolicy('codex', 'backend', root), 'preferred');
  assert.equal(enforceDomainPolicy('sonnet', 'ui', root), 'preferred');
  assert.equal(enforceDomainPolicy('sonnet', 'backend', root), 'allowed');
  cleanup(root);
});

test('enforceDomainPolicy throws domain-directive-malformed for unknown domain', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': VALID_CODEX_AGENT,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.throws(
    () => enforceDomainPolicy('codex', 'gpu', root),
    err => err instanceof DispatcherRegistryError && err.code === 'domain-directive-malformed'
  );
  cleanup(root);
});

test('drift: tools mismatch between registry and frontmatter throws at load', () => {
  _resetCache();
  const driftedAgent = VALID_CODEX_AGENT.replace('Read, Bash', 'Read, Bash, WebFetch');
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': driftedAgent,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('tools')
  );
  cleanup(root);
});

test('drift: name mismatch between registry and frontmatter throws at load', () => {
  _resetCache();
  const wrongNameAgent = VALID_CODEX_AGENT.replace('name: slice-implementer-codex', 'name: slice-implementer-codex-renamed');
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      'slice-implementer-codex': wrongNameAgent,
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('name')
  );
  cleanup(root);
});

test('drift: missing agent file throws at load', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: VALID_REGISTRY,
    agentFiles: {
      // intentionally omit slice-implementer-codex
      'slice-implementer-sonnet': VALID_SONNET_AGENT
    }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('missing agent file')
  );
  cleanup(root);
});

test('schema: registry pointing at deprecated unified slice-implementer agent throws', () => {
  _resetCache();
  const deprecatedRegistry = JSON.stringify({
    legacy: {
      agent: 'slice-implementer',
      transport: 'codex-exec',
      tools: ['Read', 'Bash'],
      domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: deprecatedRegistry,
    agentFiles: { 'slice-implementer': VALID_CODEX_AGENT }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('deprecated')
  );
  cleanup(root);
});

test('schema: missing required field in entry throws', () => {
  _resetCache();
  const incomplete = JSON.stringify({
    codex: {
      agent: 'slice-implementer-codex',
      tools: ['Read', 'Bash'],
      domains: { ui: 'forbidden', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
      // missing: transport
    }
  });
  const root = makeFixturePlugin({
    registryContent: incomplete,
    agentFiles: { 'slice-implementer-codex': VALID_CODEX_AGENT }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('transport')
  );
  cleanup(root);
});

test('schema: domains missing a required key throws', () => {
  _resetCache();
  const partialDomains = JSON.stringify({
    codex: {
      agent: 'slice-implementer-codex',
      transport: 'codex-exec',
      tools: ['Read', 'Bash'],
      domains: { ui: 'forbidden', backend: 'preferred', general: 'allowed' }
      // missing: ai-harness
    }
  });
  const root = makeFixturePlugin({
    registryContent: partialDomains,
    agentFiles: { 'slice-implementer-codex': VALID_CODEX_AGENT }
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
    codex: {
      agent: 'slice-implementer-codex',
      transport: 'codex-exec',
      tools: ['Read', 'Bash'],
      domains: { ui: 'banned', 'ai-harness': 'forbidden', backend: 'preferred', general: 'allowed' }
    }
  });
  const root = makeFixturePlugin({
    registryContent: badPolicy,
    agentFiles: { 'slice-implementer-codex': VALID_CODEX_AGENT }
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed' && err.message.includes('banned')
  );
  cleanup(root);
});

test('schema: top-level value is not an object throws', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: '[]',
    agentFiles: {}
  });
  assert.throws(
    () => loadRegistry(root),
    err => err.code === 'dispatcher-registry-malformed'
  );
  cleanup(root);
});

test('schema: invalid JSON throws', () => {
  _resetCache();
  const root = makeFixturePlugin({
    registryContent: '{not json',
    agentFiles: {}
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

test('production registry (real plugin root) loads + validates clean', () => {
  _resetCache();
  // No rootOverride: uses the actual plugin's agents/dispatchers.json + frontmatter.
  const registry = loadRegistry();
  assert.ok(registry.codex);
  assert.ok(registry.sonnet);
  assert.equal(registry.codex.transport, 'codex-exec');
  assert.equal(registry.sonnet.transport, 'claude-subagent');
  // Tools must match what we shipped in agents/slice-implementer-*.md
  assert.deepEqual([...registry.codex.tools].sort(), ['Bash', 'Read'].sort());
  assert.deepEqual([...registry.sonnet.tools].sort(), ['Bash', 'Edit', 'Read', 'Write'].sort());
});

test('exports: ALLOWED_DOMAINS and ALLOWED_POLICIES are accessible', () => {
  assert.deepEqual(ALLOWED_DOMAINS, ['ui', 'ai-harness', 'backend', 'general']);
  assert.deepEqual(ALLOWED_POLICIES, ['forbidden', 'allowed', 'preferred']);
});
