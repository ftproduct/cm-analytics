// /api/_store.js
// Where the synced snapshot lives.
//
// Three backends, chosen automatically:
//
//   upstash -- KV_REST_API_URL + KV_REST_API_TOKEN. Durable, shared across every
//              serverless instance and every user. This is the one you want.
//   file    -- MA_SNAPSHOT_FILE points at a writable path. Used by the local dev
//              server so a snapshot survives a restart. Not usable on Vercel,
//              whose filesystem is read-only and per-instance.
//   memory  -- neither configured. The snapshot lives in the warm function
//              instance only: it survives between requests on the same lambda,
//              disappears on a cold start, and is not shared between instances.
//
// Snapshots are gzipped and split into chunks so a large dataset does not hit
// the per-request body limit on the KV REST API. A small meta key records what
// is stored; the chunks are only read when the data is actually needed.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const META_KEY = 'ma:snapshot:meta';
const CHUNK_KEY = i => `ma:snapshot:chunk:${i}`;

// Base64 characters per chunk. Kept well under the 1 MB request limit that the
// smaller Upstash plans enforce.
const CHUNK_CHARS = Number(process.env.MA_SNAPSHOT_CHUNK_CHARS) || 480_000;

// Warm-instance cache of the decoded dataset, so repeated requests on the same
// lambda do not re-fetch and re-parse several megabytes of JSON.
let hot = { syncedAt: null, dataset: null };

// The memory backend's storage. Module scope, so it shares the lambda lifetime.
const mem = { meta: null, chunks: [] };

function upstash() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

function snapshotFile() {
  return process.env.MA_SNAPSHOT_FILE || null;
}

function backend() {
  if (upstash()) return 'upstash';
  if (snapshotFile()) return 'file';
  return 'memory';
}

// Durable means "survives a cold start and is shared between instances".
function isDurable() {
  return backend() === 'upstash';
}

// ---------------------------------------------------------------------------
// Upstash REST primitives
// ---------------------------------------------------------------------------

async function kvSet(key, value) {
  const { url, token } = upstash();
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: value
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Snapshot store write failed (${res.status}) ${detail.slice(0, 200)}`);
  }
}

async function kvGet(key) {
  const { url, token } = upstash();
  const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Snapshot store read failed (${res.status})`);
  const json = await res.json();
  return json.result ?? null;
}

async function kvDel(keys) {
  const { url, token } = upstash();
  if (!keys.length) return;
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(keys.map(k => ['DEL', k]))
  });
}

// ---------------------------------------------------------------------------
// Snapshot API
// ---------------------------------------------------------------------------

// Metadata only -- cheap enough to call on every request.
async function readMeta() {
  if (backend() === 'memory') return mem.meta;
  if (backend() === 'file') {
    try {
      const raw = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8'));
      return raw.meta || null;
    } catch { return null; }
  }
  try {
    const raw = await kvGet(META_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;                              // a missing cache is not an error
  }
}

async function writeSnapshot(dataset, info = {}) {
  const payload = JSON.stringify(dataset);
  const encoded = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 6 }).toString('base64');

  const chunks = [];
  for (let i = 0; i < encoded.length; i += CHUNK_CHARS) {
    chunks.push(encoded.slice(i, i + CHUNK_CHARS));
  }

  const meta = {
    ...info,
    syncedAt: new Date().toISOString(),
    chunks: chunks.length,
    rawBytes: Buffer.byteLength(payload),
    storedBytes: encoded.length,
    backend: backend()
  };

  if (backend() === 'memory') {
    mem.chunks = chunks;
    mem.meta = meta;
  } else if (backend() === 'file') {
    const file = snapshotFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename, so a reader never sees a half-written snapshot.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ meta, encoded }));
    fs.renameSync(tmp, file);
  } else {
    // Chunks first, meta last: a reader that sees the new meta is guaranteed the
    // chunks behind it already exist.
    const previous = await readMeta();
    for (let i = 0; i < chunks.length; i++) await kvSet(CHUNK_KEY(i), chunks[i]);
    await kvSet(META_KEY, JSON.stringify(meta));
    // Drop any chunks left over from a larger previous snapshot.
    const stale = [];
    for (let i = chunks.length; i < (previous?.chunks || 0); i++) stale.push(CHUNK_KEY(i));
    if (stale.length) await kvDel(stale).catch(() => {});
  }

  hot = { syncedAt: meta.syncedAt, dataset };
  return meta;
}

// Returns { dataset, meta } or null when nothing has been synced.
async function readSnapshot() {
  const meta = await readMeta();
  if (!meta || !meta.chunks) return null;

  if (hot.dataset && hot.syncedAt === meta.syncedAt) {
    return { dataset: hot.dataset, meta };
  }

  let encoded;
  if (backend() === 'memory') {
    if (mem.chunks.length !== meta.chunks) return null;
    encoded = mem.chunks.join('');
  } else if (backend() === 'file') {
    try {
      encoded = JSON.parse(fs.readFileSync(snapshotFile(), 'utf8')).encoded;
    } catch { return null; }
    if (!encoded) return null;
  } else {
    const parts = await Promise.all(
      Array.from({ length: meta.chunks }, (_, i) => kvGet(CHUNK_KEY(i)))
    );
    if (parts.some(p => p === null)) {
      // A partially expired or evicted snapshot is worse than none -- callers
      // fall back to querying Databricks directly.
      return null;
    }
    encoded = parts.join('');
  }

  let dataset;
  try {
    dataset = JSON.parse(zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
  } catch {
    return null;
  }

  hot = { syncedAt: meta.syncedAt, dataset };
  return { dataset, meta };
}

async function clearSnapshot() {
  const meta = await readMeta();
  if (backend() === 'memory') {
    mem.meta = null;
    mem.chunks = [];
  } else if (backend() === 'file') {
    try { fs.unlinkSync(snapshotFile()); } catch { /* already gone */ }
  } else if (meta) {
    await kvDel([META_KEY, ...Array.from({ length: meta.chunks || 0 }, (_, i) => CHUNK_KEY(i))]);
  }
  hot = { syncedAt: null, dataset: null };
}

module.exports = { readMeta, readSnapshot, writeSnapshot, clearSnapshot, backend, isDurable };
