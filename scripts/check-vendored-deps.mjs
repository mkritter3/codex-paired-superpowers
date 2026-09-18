#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root' || !args[1])) {
  process.stderr.write('usage: check-vendored-deps.mjs [--root <dir>]\n');
  process.exit(1);
}
const requestedRoot = args.length === 0 ? REPO_ROOT : args[1];
const root = isAbsolute(requestedRoot) ? requestedRoot : resolve(process.cwd(), requestedRoot);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parentPackageLocation(location) {
  const nested = location.lastIndexOf('/node_modules/');
  return nested === -1 ? '' : location.slice(0, nested);
}

function resolveDependency(packages, parentLocation, name) {
  let location = parentLocation;
  for (;;) {
    const candidate = location
      ? `${location}/node_modules/${name}`
      : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!location) return null;
    location = parentPackageLocation(location);
  }
}

function runtimeClosure(lock) {
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object' || !packages['']) {
    throw new Error('package-lock.json must contain a lockfileVersion 3 packages map');
  }

  const expected = new Map();
  const queue = Object.keys(packages[''].dependencies ?? {}).map((name) => ['', name]);
  const visited = new Set();
  while (queue.length > 0) {
    const [parent, name] = queue.shift();
    const location = resolveDependency(packages, parent, name);
    if (!location) throw new Error(`package-lock.json cannot resolve runtime dependency ${name} from ${parent || '<root>'}`);
    if (visited.has(location)) continue;
    visited.add(location);
    const entry = packages[location];
    if (entry.dev === true) continue;
    if (typeof entry.version !== 'string') throw new Error(`package-lock.json entry ${location} has no version`);
    expected.set(name, entry.version);
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) queue.push([location, dependency]);
  }
  return expected;
}

function trackedPackages() {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'node_modules'], {
    cwd: root,
    encoding: 'utf8',
  });
  const tracked = new Map();
  for (const path of output.split('\0').filter(Boolean)) {
    if (!/^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))*\/package\.json$/.test(path)) continue;
    const manifest = readJson(join(root, path));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${path} must contain string name and version fields`);
    }
    tracked.set(manifest.name, manifest.version);
  }
  return tracked;
}

try {
  const expected = runtimeClosure(readJson(join(root, 'package-lock.json')));
  const tracked = trackedPackages();
  const findings = [];

  for (const name of [...tracked.keys()].sort()) {
    if (!expected.has(name)) findings.push(`extra ${name}@${tracked.get(name)}`);
  }
  for (const name of [...expected.keys()].sort()) {
    if (!tracked.has(name)) {
      findings.push(`missing ${name}@${expected.get(name)}`);
    } else if (tracked.get(name) !== expected.get(name)) {
      findings.push(`version ${name} tracked=${tracked.get(name)} lock=${expected.get(name)}`);
    }
  }

  if (findings.length > 0) {
    process.stdout.write(`${findings.join('\n')}\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
