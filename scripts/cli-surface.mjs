#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENTRY = 'lib/codex-bridge/cli.js';
const DEFAULT_EXPANSIONS = [{
  site: 'lib/codex-bridge/cli-harness/adapters/registry.js',
  call: 'import(pathToFileURL(modulePath).href)',
  roots: 'lib/codex-bridge/cli-harness/adapters/*.js',
  inputs: 'lib/codex-bridge/cli-clients/*.json',
}];
const DIGEST_KEYS = ['closure', 'module_digest', 'input_digest'];
const PUBLIC_API_SECTIONS = new Set(['skills', 'cli-verbs', 'wrapper', 'doctor', 'project-config', 'sidecar', 'semver']);
const SECTION_RE = /```json public-api:([^\n]+)\n([\s\S]*?)\n```/g;

function posix(path) {
  return path.split(sep).join('/');
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && (ts.isStringLiteral(node.expression) || ts.isNumericLiteral(node.expression))) {
    return node.expression.text;
  }
  return null;
}

function handlerParts(member) {
  if (ts.isMethodDeclaration(member)) return { params: member.parameters, body: member.body };
  if (!ts.isPropertyAssignment(member)) return null;
  const value = member.initializer;
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return null;
  return { params: value.parameters, body: value.body };
}

function isAccess(node, root, member) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === root
    && node.name.text === member;
}

function isProcessCall(node, objectName, methodName) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression;
  return method.name.text === methodName
    && ts.isPropertyAccessExpression(method.expression)
    && isAccess(method.expression, 'process', objectName);
}

function collectBindingFlags(name, flags, unsupported) {
  if (!ts.isObjectBindingPattern(name)) return;
  for (const element of name.elements) {
    if (element.dotDotDotToken) {
      unsupported.add('args-spread');
      continue;
    }
    const key = propertyName(element.propertyName || element.name);
    if (key === null) unsupported.add('computed-key');
    else flags.add(key);
  }
}

function extractHandler(member) {
  const parts = handlerParts(member);
  const flags = new Set();
  const exits = new Set();
  const stdoutKeys = new Set();
  const unsupported = new Set();
  if (!parts) return { flags: [], exits: [], stdoutKeys: [], unsupported: ['unsupported-handler'] };

  const first = parts.params[0];
  let argsName = null;
  if (first) {
    collectBindingFlags(first.name, flags, unsupported);
    if (ts.isIdentifier(first.name)) argsName = first.name.text;
  }

  function visit(node) {
    if (argsName && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
      && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === argsName) {
      collectBindingFlags(node.name, flags, unsupported);
    }
    if (argsName && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === argsName) {
      flags.add(node.name.text);
    }
    if (argsName && ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === argsName) {
      if (node.argumentExpression && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) {
        flags.add(node.argumentExpression.text);
      } else {
        unsupported.add('computed-key');
      }
    }
    if (argsName && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword
      && ts.isStringLiteralLike(node.left) && ts.isIdentifier(node.right) && node.right.text === argsName) {
      flags.add(node.left.text);
    }
    if (argsName && ts.isCallExpression(node)) {
      if (node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === argsName)) unsupported.add('args-pass-through');
    }
    if (argsName && ts.isIdentifier(node) && node.text === argsName) {
      const parent = node.parent;
      const supported = (ts.isPropertyAccessExpression(parent) && parent.expression === node)
        || (ts.isElementAccessExpression(parent) && parent.expression === node)
        || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.right === node)
        || (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name) && parent.initializer === node);
      if (!supported) {
        if ((ts.isSpreadAssignment(parent) && parent.expression === node)
          || (ts.isSpreadElement(parent) && parent.expression === node)) unsupported.add('args-spread');
        else if (ts.isCallExpression(parent) && parent.arguments.includes(node)) unsupported.add('args-pass-through');
        else if (ts.isVariableDeclaration(parent) && parent.initializer === node) unsupported.add('args-alias');
        else unsupported.add('args-opaque-use');
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && isAccess(node.expression, 'process', 'exit')) {
      const arg = node.arguments[0];
      if (arg && ts.isNumericLiteral(arg) && Number.isInteger(Number(arg.text))) exits.add(Number(arg.text));
    }
    if (isProcessCall(node, 'stdout', 'write')) {
      const writeArg = node.arguments[0];
      if (writeArg && ts.isCallExpression(writeArg) && ts.isPropertyAccessExpression(writeArg.expression)
        && ts.isIdentifier(writeArg.expression.expression) && writeArg.expression.expression.text === 'JSON'
        && writeArg.expression.name.text === 'stringify') {
        const value = writeArg.arguments[0];
        if (value && ts.isObjectLiteralExpression(value)) {
          for (const prop of value.properties) {
            if (ts.isSpreadAssignment(prop)) unsupported.add('stdout-spread');
            else {
              const key = propertyName(prop.name);
              if (key === null) unsupported.add('stdout-computed-key');
              else stdoutKeys.add(key);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  if (parts.body) visit(parts.body);
  return {
    flags: sorted(flags),
    exits: [...exits].sort((a, b) => a - b),
    stdoutKeys: sorted(stdoutKeys),
    unsupported: sorted(unsupported),
  };
}

/**
 * Extract dispatcher flags, literal exits, stdout keys, and opacity markers.
 * Implements robustness spec §2 "Independent discovery".
 * @param {string} filePath
 */
export function extractVerbSurface(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let table = null;
  function find(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'subcommands'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) table = node.initializer;
    if (!table) ts.forEachChild(node, find);
  }
  find(sourceFile);
  if (!table) return { verbs: {} };
  const verbs = {};
  for (const member of table.properties) {
    const name = propertyName(member.name);
    if (name !== null) verbs[name] = extractHandler(member);
  }
  return { verbs: Object.fromEntries(Object.entries(verbs).sort(([a], [b]) => a.localeCompare(b))) };
}

/**
 * Digest each dispatcher handler as a normalized opaque source region.
 * Implements robustness spec §2 manual extraction exemptions.
 * @param {string} filePath
 */
export function digestVerbRegions(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const regions = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'subcommands'
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const member of node.initializer.properties) {
        const name = propertyName(member.name);
        if (name === null) continue;
        const normalized = printer.printNode(ts.EmitHint.Unspecified, member, sourceFile);
        regions[name] = `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return Object.fromEntries(Object.entries(regions).sort(([a], [b]) => a.localeCompare(b)));
}

function parseModule(filePath) {
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}

function repoPath(root, absolute) {
  return posix(relative(root, absolute));
}

function resolveLocalModule(fromFile, specifier, root) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const candidate = isAbsolute(specifier) ? specifier : resolve(dirname(fromFile), specifier);
  for (const path of [candidate, `${candidate}.js`, `${candidate}.mjs`, join(candidate, 'index.js')]) {
    if (existsSync(path) && statSync(path).isFile()) {
      const rel = relative(root, path);
      if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
      return path;
    }
  }
  return null;
}

function moduleFacts(filePath, root) {
  const sourceFile = parseModule(filePath);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const imports = [];
  const unresolved = [];
  const createRequireAliases = new Set(['createRequire']);
  const moduleNamespaceAliases = new Set();
  const requireAliases = new Set(['require']);
  const requireResolveAliases = new Set();
  function isModuleBuiltin(value) {
    return value === 'module' || value === 'node:module';
  }
  function unwrapExpression(node) {
    let value = node;
    while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
    return value;
  }
  function dynamicModuleImport(node) {
    const value = unwrapExpression(node);
    return ts.isCallExpression(value)
      && value.expression.kind === ts.SyntaxKind.ImportKeyword
      && value.arguments[0]
      && ts.isStringLiteral(value.arguments[0])
      && isModuleBuiltin(value.arguments[0].text);
  }
  function isCreateRequireCallee(node) {
    return (ts.isIdentifier(node) && createRequireAliases.has(node.text))
      || (ts.isPropertyAccessExpression(node)
        && node.name.text === 'createRequire'
        && ts.isIdentifier(node.expression)
        && moduleNamespaceAliases.has(node.expression.text));
  }
  function normalizedCall(node) {
    return printer.printNode(ts.EmitHint.Expression, node, sourceFile).replace(/\s+/g, ' ').trim();
  }
  function addUnresolved(node, kind) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    unresolved.push({ path: repoPath(root, filePath), line, kind, call: normalizedCall(node) });
  }
  function addSpecifier(node) {
    if (node && ts.isStringLiteralLike(node)) {
      const resolved = resolveLocalModule(filePath, node.text, root);
      if (resolved) imports.push(resolved);
    }
  }
  function collectLoaderAliases(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && isModuleBuiltin(node.moduleSpecifier.text)) {
      if (node.importClause?.name) moduleNamespaceAliases.add(node.importClause.name.text);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName || element.name).text === 'createRequire') createRequireAliases.add(element.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        moduleNamespaceAliases.add(bindings.name.text);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectBindingPattern(node.name) && ts.isCallExpression(initializer)
        && initializer.expression.kind === ts.SyntaxKind.ImportKeyword
        && initializer.arguments[0] && ts.isStringLiteral(initializer.arguments[0])
        && isModuleBuiltin(initializer.arguments[0].text)) {
        for (const element of node.name.elements) {
          if ((element.propertyName || element.name).getText(sourceFile) === 'createRequire'
            && ts.isIdentifier(element.name)) createRequireAliases.add(element.name.text);
          if ((element.propertyName || element.name).getText(sourceFile) === 'default'
            && ts.isIdentifier(element.name)) moduleNamespaceAliases.add(element.name.text);
        }
      }
      if (ts.isIdentifier(node.name) && dynamicModuleImport(node.initializer)) {
        moduleNamespaceAliases.add(node.name.text);
      }
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(initializer)
        && initializer.name.text === 'default' && dynamicModuleImport(initializer.expression)) {
        moduleNamespaceAliases.add(node.name.text);
      }
      if (ts.isIdentifier(node.name) && ts.isCallExpression(initializer)
        && isCreateRequireCallee(initializer.expression)) requireAliases.add(node.name.text);
      if (ts.isIdentifier(node.name) && ts.isIdentifier(initializer) && requireAliases.has(initializer.text)) {
        requireAliases.add(node.name.text);
      }
      if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(initializer)
        && ts.isIdentifier(initializer.expression) && requireAliases.has(initializer.expression.text)
        && initializer.name.text === 'resolve') requireResolveAliases.add(node.name.text);
    }
    ts.forEachChild(node, collectLoaderAliases);
  }
  collectLoaderAliases(sourceFile);

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addSpecifier(node.moduleSpecifier);
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) addSpecifier(arg);
        else addUnresolved(node, 'dynamic-import');
      } else if (isCreateRequireCallee(node.expression)) {
        addUnresolved(node, 'create-require');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
        addUnresolved(node, 'eval');
      } else if (ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text)) {
        addUnresolved(node, 'require-call');
      } else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && requireAliases.has(node.expression.expression.text)
        && node.expression.name.text === 'resolve') {
        addUnresolved(node, 'require-resolve');
      } else if (ts.isIdentifier(node.expression) && requireResolveAliases.has(node.expression.text)) {
        addUnresolved(node, 'require-resolve');
      } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve'
        && ts.isMetaProperty(node.expression.expression)) {
        addUnresolved(node, 'import-meta-resolve');
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      addUnresolved(node, 'new-function');
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { imports, unresolved };
}

function expandGlob(root, pattern) {
  const normalized = posix(pattern);
  const star = normalized.indexOf('*');
  if (star === -1) return existsSync(resolve(root, normalized)) ? [resolve(root, normalized)] : [];
  const dirPart = normalized.slice(0, normalized.lastIndexOf('/', star));
  const basenamePattern = normalized.slice(normalized.lastIndexOf('/', star) + 1);
  const matcher = new RegExp(`^${basenamePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
  const absoluteDir = resolve(root, dirPart);
  if (!existsSync(absoluteDir)) return [];
  return readdirSync(absoluteDir).filter((name) => matcher.test(name)).map((name) => join(absoluteDir, name));
}

function normalizedDigest(filePath) {
  const sourceFile = parseModule(filePath);
  const normalized = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(sourceFile);
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function rawDigest(filePath) {
  return `sha256:${createHash('sha256').update(readFileSync(filePath)).digest('hex')}`;
}

/**
 * Inspect the CLI surface and its expanded repository-local module closure.
 * Implements robustness spec §2 "Backstop: module digests".
 * @param {{root?: string, entry?: string, expansions?: Array<{site:string, call?:string, roots:string, inputs:string}>}} options
 */
export function inspectSurface({ root = SCRIPT_ROOT, entry = DEFAULT_ENTRY, expansions = DEFAULT_EXPANSIONS } = {}) {
  root = resolve(root);
  const entryPath = resolve(root, entry);
  const queue = [entryPath];
  for (const expansion of expansions) queue.push(...expandGlob(root, expansion.roots));
  const visited = new Set();
  const unresolved = [];
  while (queue.length) {
    const filePath = queue.shift();
    if (!filePath || visited.has(filePath)) continue;
    visited.add(filePath);
    const facts = moduleFacts(filePath, root);
    queue.push(...facts.imports);
    unresolved.push(...facts.unresolved);
  }
  const coveredLoads = new Set();
  for (const rule of expansions) {
    const atSite = unresolved.filter((item) => item.path === rule.site);
    const covered = rule.call
      ? atSite.find((item) => item.call === rule.call)
      : (atSite.length === 1 ? atSite[0] : null);
    if (covered) coveredLoads.add(covered);
  }
  const remaining = unresolved
    .filter((item) => !coveredLoads.has(item))
    .map(({ path, line, kind }) => ({ path, line, kind }));
  const closure = [...visited].map((path) => repoPath(root, path)).sort();
  const module_digest = Object.fromEntries(closure.map((path) => [path, normalizedDigest(resolve(root, path))]));
  const inputPaths = sorted(expansions.flatMap((rule) => expandGlob(root, rule.inputs).map((path) => repoPath(root, path))));
  const input_digest = Object.fromEntries(inputPaths.map((path) => [path, rawDigest(resolve(root, path))]));
  const verbs = extractVerbSurface(entryPath).verbs;
  return { verbs, closure, module_digest, input_digest, unresolved: remaining };
}

/**
 * Parse the seven strict public API JSON blocks.
 * Implements robustness spec §2 fenced-block contract.
 * @param {string} markdown
 */
export function parsePublicApiBlocks(markdown) {
  const blocks = new Map();
  for (const match of markdown.matchAll(SECTION_RE)) {
    if (!PUBLIC_API_SECTIONS.has(match[1])) throw new Error(`unknown public-api section: ${match[1]}`);
    if (blocks.has(match[1])) throw new Error(`duplicate public-api section: ${match[1]}`);
    blocks.set(match[1], { value: JSON.parse(match[2]), start: match.index, end: match.index + match[0].length, raw: match[0] });
  }
  return blocks;
}

function projection(documentedVerbs) {
  return Object.fromEntries(Object.entries(documentedVerbs || {}).map(([name, value]) => [name, {
    flags: value.flags || [], exits: value.exits || [], stdoutKeys: value.stdoutKeys || [], unsupported: value.unsupported || [],
  }]));
}

function parseCli(argv) {
  const options = { root: SCRIPT_ROOT, entry: DEFAULT_ENTRY, digest: false, write: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--digest') options.digest = true;
    else if (argv[i] === '--write') options.write = true;
    else if (argv[i] === '--root') options.root = resolve(argv[++i]);
    else if (argv[i] === '--entry') options.entry = argv[++i];
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return options;
}

function main() {
  let options;
  try { options = parseCli(process.argv); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const docPath = join(options.root, 'docs/public-api.md');
  let markdown = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  let block = null;
  if (markdown) block = parsePublicApiBlocks(markdown).get('cli-verbs') || null;
  const expansions = block?.value.expansions || DEFAULT_EXPANSIONS;
  const result = inspectSurface({ root: options.root, entry: options.entry, expansions });
  if (result.unresolved.length) {
    for (const item of result.unresolved) process.stderr.write(`unresolved module load at ${item.path}:${item.line} (${item.kind})\n`);
    process.exitCode = 3;
    return;
  }
  if (options.write) {
    if (!options.digest || !block) {
      process.stderr.write('--write requires --digest and a cli-verbs public API block\n');
      process.exitCode = 1;
      return;
    }
    if (JSON.stringify(projection(block.value.verbs)) !== JSON.stringify(result.verbs)) {
      process.stderr.write('--write refused: extraction would change a non-digest key\n');
      process.exitCode = 1;
      return;
    }
    const updated = { ...block.value };
    for (const key of DIGEST_KEYS) updated[key] = result[key];
    const replacement = `\`\`\`json public-api:cli-verbs\n${JSON.stringify(updated, null, 2)}\n\`\`\``;
    markdown = `${markdown.slice(0, block.start)}${replacement}${markdown.slice(block.end)}`;
    writeFileSync(docPath, markdown);
    return;
  }
  const output = options.digest
    ? Object.fromEntries(DIGEST_KEYS.map((key) => [key, result[key]]))
    : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
