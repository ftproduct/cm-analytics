// dev-server.js — runs the app locally the way Vercel runs it: static files from
// public/, every file under api/ mounted at its own path.
//
//   node dev-server.js          -> http://localhost:3000  (demo data)
//   DATABRICKS_TOKEN=... node dev-server.js   -> live against the warehouse
//
// This exists only for local development. Vercel does not use it.

require('./scripts/_env.js').load();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;

// Locally the snapshot goes to a file so it survives a restart -- and so the
// cached code path is actually exercisable in development. On Vercel the
// filesystem is read-only, so production uses Upstash (or warm memory).
if (!process.env.MA_SNAPSHOT_FILE && !process.env.KV_REST_API_URL) {
  process.env.MA_SNAPSHOT_FILE = path.join(__dirname, '.cache', 'snapshot.json');
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_DIR = path.join(__dirname, 'api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function collectRoutes(dir, prefix = '/api') {
  const out = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [k, v] of collectRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`)) out.set(k, v);
      continue;
    }
    if (!entry.name.endsWith('.js') || entry.name.startsWith('_')) continue;
    out.set(`${prefix}/${entry.name.replace(/\.js$/, '')}`, path.join(dir, entry.name));
  }
  return out;
}

// Minimal shim for the Vercel request/response helpers the handlers use.
function decorate(req, res, url) {
  req.query = Object.fromEntries(url.searchParams.entries());
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = data => { res.end(data); return res; };
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

const { requireBasicAuth, isConfigured: basicAuthConfigured } = require('./api/_basicAuth.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!requireBasicAuth(req, res, url.pathname)) return;

  if (url.pathname.startsWith('/api/')) {
    // Re-collect on every request so edits are picked up without a restart.
    const routes = collectRoutes(API_DIR);
    const file = routes.get(url.pathname);
    if (!file) { res.statusCode = 404; res.end('Not found'); return; }
    delete require.cache[require.resolve(file)];
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(API_DIR)) delete require.cache[key];
    }
    decorate(req, res, url);
    if (req.method === 'POST' || req.method === 'PUT') req.body = await readBody(req);
    try {
      await require(file)(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message, stack: e.stack }));
    }
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

server.listen(PORT, () => {
  console.log(`marketplace-analytics dev server → http://localhost:${PORT}`);
  const db = require('./api/_databricks.js');
  console.log(`data:     ${db.isConfigured() ? 'Databricks (' + db.config().host + ')' : 'generated demo — set DATABRICKS_TOKEN or CLIENT_ID/SECRET in .env for real data'}`);
  console.log(`snapshot: ${process.env.KV_REST_API_URL ? 'Upstash KV' : process.env.MA_SNAPSHOT_FILE}`);
  if (basicAuthConfigured()) {
    console.log('auth:     HTTP Basic Auth enabled (BASIC_AUTH_USER / BASIC_AUTH_PASSWORD)');
  } else if (process.env.MA_DEV_ALLOW_ANONYMOUS === 'true') {
    console.log('auth:     bypassed (MA_DEV_ALLOW_ANONYMOUS) — local only, never honoured on Vercel');
  }
});
