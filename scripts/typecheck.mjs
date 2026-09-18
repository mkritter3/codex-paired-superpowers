#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    allowlist: 'typecheck.allowlist.json',
    tsconfig: 'tsconfig.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--root', '--allowlist', '--tsconfig'].includes(flag) || index + 1 >= argv.length) {
      throw new Error(`usage: typecheck.mjs [--root <dir>] [--allowlist <path>] [--tsconfig <path>]`);
    }
    options[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  options.root = resolve(options.root);
  options.allowlist = isAbsolute(options.allowlist) ? options.allowlist : resolve(options.root, options.allowlist);
  options.tsconfig = isAbsolute(options.tsconfig) ? options.tsconfig : resolve(options.root, options.tsconfig);
  return options;
}

function hasPragma(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/, 3);
  const index = lines[0]?.startsWith('#!') ? 1 : 0;
  return lines[index]?.trim() === '// @ts-check';
}

function isCheckJsEnabled(sourceFile) {
  return sourceFile.checkJsDirective?.enabled === true;
}

function normalized(path) {
  return resolve(path);
}

function shownPath(path, root) {
  const rel = relative(root, path);
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' ? rel.split(sep).join('/') : path;
}

function walkMarkedFiles(root) {
  const marked = [];
  for (const directory of ['lib', 'scripts', 'bin']) {
    const start = join(root, directory);
    if (!existsSync(start)) continue;
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
          const sourceFile = ts.createSourceFile(
            path,
            readFileSync(path, 'utf8'),
            ts.ScriptTarget.Latest,
            false,
          );
          if (isCheckJsEnabled(sourceFile)) marked.push(path);
        }
      }
    }
  }
  return marked;
}

function formatDiagnostic(diagnostic, root, fallbackPath = null) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${shownPath(diagnostic.file.fileName, root)}:${position.line + 1}:${position.character + 1} TS${diagnostic.code} ${message}`;
  }
  const path = fallbackPath ? shownPath(fallbackPath, root) : '<config>';
  return `${path}:1:1 TS${diagnostic.code} ${message}`;
}

function readAllowlist(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || value.version !== 1 || !Array.isArray(value.files) || value.files.some((file) => typeof file !== 'string')) {
    throw new Error(`${path} must have shape { "version": 1, "files": string[] }`);
  }
  const sorted = [...value.files].sort();
  if (new Set(value.files).size !== value.files.length || sorted.some((file, index) => file !== value.files[index])) {
    throw new Error(`${path} files must be unique and sorted`);
  }
  if (value.files.some((file) => isAbsolute(file) || file.split(/[\\/]/).includes('..'))) {
    throw new Error(`${path} files must be repo-relative paths within --root`);
  }
  return value.files;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const files = readAllowlist(options.allowlist);
  const absoluteFiles = files.map((file) => join(options.root, file));
  for (const path of absoluteFiles) {
    if (!existsSync(path)) throw new Error(`allowlisted file does not exist: ${shownPath(path, options.root)}`);
    if (!hasPragma(path)) throw new Error(`allowlisted file is missing required @ts-check pragma: ${shownPath(path, options.root)}`);
    // Placement alone is not enough: a later `// @ts-nocheck` (or any directive TypeScript honours)
    // can disable checking of a listed owner while the first line still reads `// @ts-check`.
    const listed = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    if (!isCheckJsEnabled(listed)) {
      throw new Error(`allowlisted file has checking disabled (a later @ts-nocheck overrides its @ts-check): ${shownPath(path, options.root)}`);
    }
  }

  const config = ts.readConfigFile(options.tsconfig, ts.sys.readFile);
  if (config.error) {
    fail(formatDiagnostic(config.error, options.root, options.tsconfig));
  } else {
    const raw = { ...config.config, files: absoluteFiles };
    const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, dirname(options.tsconfig), undefined, options.tsconfig);
    if (parsed.errors.length > 0) {
      process.stderr.write(`${parsed.errors.map((item) => formatDiagnostic(item, options.root, options.tsconfig)).join('\n')}\n`);
      process.exitCode = 2;
    } else {
      const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
      const allowed = new Set(absoluteFiles.map(normalized));
      const marked = new Set(walkMarkedFiles(options.root).map(normalized));
      for (const source of program.getSourceFiles()) {
        if (source.isDeclarationFile || source.fileName.includes(`${sep}node_modules${sep}`)) continue;
        if (/\.(?:c|m)?js$/.test(source.fileName) && isCheckJsEnabled(source)) marked.add(normalized(source.fileName));
      }
      const unlisted = [...marked].filter((path) => !allowed.has(path)).sort();
      if (unlisted.length > 0) {
        for (const path of unlisted) fail(`unlisted @ts-check file: ${shownPath(path, options.root)}`);
      } else {
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.length > 0) {
          process.stdout.write(`${diagnostics.map((item) => formatDiagnostic(item, options.root)).join('\n')}\n`);
          process.exitCode = 1;
        }
      }
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
