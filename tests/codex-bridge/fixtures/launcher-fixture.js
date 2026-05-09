#!/usr/bin/env node
/**
 * launcher-fixture.js
 *
 * Multi-mode fixture script for app-launcher tests.
 * Mode is selected by the first argv:
 *
 *   http-ready <port>    — starts an HTTP server on <port>, replies 200 on /healthz
 *   stdout-ready         — prints "ready" after 50ms then sleeps
 *   log-ready <path>     — writes "Ready in 1ms" to <path> after 50ms then sleeps
 *   exits-early          — exits immediately with code 1
 *   sleeps-forever       — loops forever (used for timeout test)
 *   spawn-child          — spawns a child process (used to test pgid capture)
 *
 * All modes except exits-early keep the process alive until killed.
 */

import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [mode, arg1] = process.argv.slice(2);

switch (mode) {
  case 'http-ready': {
    const port = Number(arg1);
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200);
        res.end('ok');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, '127.0.0.1', () => {
      // Server is up — ready immediately
    });
    // Keep alive
    break;
  }

  case 'stdout-ready': {
    setTimeout(() => {
      process.stdout.write('ready\n');
    }, 50);
    // Sleep forever after printing
    setInterval(() => {}, 100000);
    break;
  }

  case 'log-ready': {
    const logPath = arg1;
    setTimeout(() => {
      writeFileSync(logPath, 'Ready in 1ms\n');
    }, 50);
    setInterval(() => {}, 100000);
    break;
  }

  case 'exits-early': {
    process.exit(1);
    break;
  }

  case 'sleeps-forever': {
    // Never prints "ready", never exits
    setInterval(() => {}, 100000);
    break;
  }

  case 'spawn-child': {
    // Spawn a child process and then sleep. Lets us verify pgid covers child tree.
    // The child just sleeps.
    const child = spawnSync('node', ['-e', 'setInterval(()=>{},100000)'], {
      detached: true,
      stdio: 'ignore',
    });
    process.stdout.write('ready\n');
    setInterval(() => {}, 100000);
    break;
  }

  default: {
    process.stderr.write(`launcher-fixture: unknown mode "${mode}"\n`);
    process.exit(2);
  }
}
