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
    expected.set(location, entry.version);
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
    };
    for (const dependency of Object.keys(dependencies)) queue.push([location, dependency]);
  }
  return expected;
}

function packageRoot(path) {
  return path.match(/^node_modules\/(?:@[^/]+\/[^/]+|[^/]+)(?:\/node_modules\/(?:@[^/]+\/[^/]+|[^/]+))*/)?.[0] ?? null;
}

function packageNameFromLocation(location) {
  const nested = location.lastIndexOf('/node_modules/');
  return location.slice(nested === -1 ? 'node_modules/'.length : nested + '/node_modules/'.length);
}

function findingLabel(location, packageName = packageNameFromLocation(location)) {
  return parentPackageLocation(location) ? location : packageName;
}

function trackedPackages() {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'node_modules'], {
    cwd: root,
    encoding: 'utf8',
  });
  const paths = output.split('\0').filter(Boolean);
  const trackedPaths = new Set(paths);
  const tracked = new Map();
  const untrackedManifests = new Set();
  const roots = new Set(paths.map(packageRoot).filter(Boolean));
  for (const location of [...roots].sort()) {
    const manifestPath = `${location}/package.json`;
    if (!trackedPaths.has(manifestPath)) {
      untrackedManifests.add(location);
      continue;
    }
    const manifest = readJson(join(root, manifestPath));
    if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
      throw new Error(`${manifestPath} must contain string name and version fields`);
    }
    tracked.set(location, { name: manifest.name, version: manifest.version });
  }
  return { tracked, untrackedManifests };
}

try {
  const expected = runtimeClosure(readJson(join(root, 'package-lock.json')));
  const { tracked, untrackedManifests } = trackedPackages();
  const findings = [];

  for (const location of [...untrackedManifests].sort()) {
    findings.push(`extra ${findingLabel(location)}@untracked-manifest`);
  }
  for (const location of [...tracked.keys()].sort()) {
    const pkg = tracked.get(location);
    if (!expected.has(location)) findings.push(`extra ${findingLabel(location, pkg.name)}@${pkg.version}`);
  }
  for (const location of [...expected.keys()].sort()) {
    const label = findingLabel(location);
    if (!tracked.has(location)) {
      findings.push(`missing ${label}@${expected.get(location)}`);
    } else if (tracked.get(location).version !== expected.get(location)) {
      findings.push(`version ${findingLabel(location, tracked.get(location).name)} tracked=${tracked.get(location).version} lock=${expected.get(location)}`);
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
