#!/usr/bin/env node
// Live Verification Fixture Server
// Tiny Node HTTP server used by Phase E autopilot smoke.
// INTENTIONAL BUG in POST /save: writes to 'name' instead of 'displayName',
// so the displayed name never updates after a save.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '34567', 10);
const STORE_PATH = path.join(__dirname, 'store.json');
const INDEX_PATH = path.join(__dirname, 'index.html');

const SESSION_COOKIE = 'fixture_session';
const SESSION_TOKEN = 'authenticated';

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { saves: [], displayName: '' };
  }
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    cookies[k.trim()] = v.join('=').trim();
  }
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers['cookie'] ?? '');
  return cookies[SESSION_COOKIE] === SESSION_TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const { pathname } = url;

  // Health check — no auth required
  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Login form
  if (req.method === 'GET' && pathname === '/login') {
    const html = `<!DOCTYPE html>
<html><head><title>Login</title></head>
<body>
<h1>Sign in</h1>
<form method="POST" action="/login">
  <label>Email <input name="username" type="text" /></label><br/>
  <label>Password <input name="password" type="password" /></label><br/>
  <button type="submit">Sign in</button>
</form>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Login submit
  if (req.method === 'POST' && pathname === '/login') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const password = params.get('password') ?? '';
    const expectedPassword = process.env.SMOKE_TEST_PASSWORD ?? '';
    if (password === expectedPassword && expectedPassword !== '') {
      res.writeHead(302, {
        'Set-Cookie': `${SESSION_COOKIE}=${SESSION_TOKEN}; Path=/; HttpOnly`,
        'Location': '/'
      });
      res.end();
    } else {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
    }
    return;
  }

  // All routes below require auth
  if (!isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/login' });
    res.end();
    return;
  }

  // Home — serves index.html
  if (req.method === 'GET' && pathname === '/') {
    try {
      const html = fs.readFileSync(INDEX_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Could not read index.html');
    }
    return;
  }

  // GET /saves — return recent saves list
  if (req.method === 'GET' && pathname === '/saves') {
    const store = readStore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saves: store.saves }));
    return;
  }

  // GET /display-name — return the stored displayName field
  // BUG manifestation: because POST /save writes to 'name' not 'displayName',
  // this always returns the initial empty value after a save.
  if (req.method === 'GET' && pathname === '/display-name') {
    const store = readStore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ displayName: store.displayName ?? '' }));
    return;
  }

  // POST /save — INTENTIONAL BUG: writes to 'name' instead of 'displayName'
  if (req.method === 'POST' && pathname === '/save') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!body.displayName) {
      // Diagnostic log line — captured by error_patterns in project.json
      console.log("ERROR: missing field 'displayName'");
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "missing field 'displayName'" }));
      return;
    }

    const store = readStore();
    // INTENTIONAL BUG: writes to 'name' instead of 'displayName'
    // The frontend reads back 'displayName', finds it empty, so the label never updates.
    store.name = body.displayName;          // BUG: should be store.displayName
    store.saves.push({
      timestamp: new Date().toISOString(),
      value: body.displayName
    });
    writeStore(store);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Live Verification Fixture listening on http://127.0.0.1:${PORT}`);
});
