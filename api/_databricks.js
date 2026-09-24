// /api/_databricks.js
// Thin client for the Databricks SQL Statement Execution API (2.0).
//
// Docs: POST /api/2.0/sql/statements  -> { statement_id, status, manifest, result }
//       GET  /api/2.0/sql/statements/{id}  (poll while PENDING/RUNNING)
//
// Env vars (set in Vercel -> Project -> Settings -> Environment Variables):
//   DATABRICKS_HOST              dbc-a52503fa-6486.cloud.databricks.com
//   DATABRICKS_WAREHOUSE_ID      123f8c6553d1967b  (last segment of the HTTP path)
//   DATABRICKS_TOKEN             dapi...           (personal access token — optional)
//   DATABRICKS_CLIENT_ID         service-principal OAuth client id (optional)
//   DATABRICKS_CLIENT_SECRET     service-principal OAuth secret (optional)
//
// Auth: either DATABRICKS_TOKEN, or CLIENT_ID + CLIENT_SECRET (OAuth M2M).
// Values are ALWAYS passed as named parameters (:p0, :p1 ...) so nothing the
// browser sends is ever concatenated into SQL.

const DEFAULT_HOST = 'dbc-a52503fa-6486.cloud.databricks.com';
const DEFAULT_WAREHOUSE = '123f8c6553d1967b';
const MAX_POLL_MS = 55000;      // stay inside the Vercel function timeout
const POLL_INTERVAL_MS = 900;
const TOKEN_REFRESH_SKEW_MS = 60_000;

let oauthCache = { accessToken: null, expiresAt: 0 };

function config() {
  const host = (process.env.DATABRICKS_HOST || DEFAULT_HOST).replace(/^https?:\/\//, '').replace(/\/$/, '');
  // Accept either a bare id or the full HTTP path from the Databricks UI.
  const rawWh = process.env.DATABRICKS_WAREHOUSE_ID || process.env.DATABRICKS_HTTP_PATH || DEFAULT_WAREHOUSE;
  const warehouseId = String(rawWh).split('/').filter(Boolean).pop();
  const token = process.env.DATABRICKS_TOKEN || '';
  const clientId = process.env.DATABRICKS_CLIENT_ID || '';
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET || '';
  return { host, warehouseId, token, clientId, clientSecret };
}

function isConfigured() {
  const { token, clientId, clientSecret } = config();
  return Boolean(token || (clientId && clientSecret));
}

// Demo mode: explicit opt-in, or automatic when there is no token to query with.
function isDemoMode() {
  if (String(process.env.MA_DEMO_MODE || '').toLowerCase() === 'true') return true;
  if (String(process.env.MA_DEMO_MODE || '') === '1') return true;
  if (String(process.env.MA_DEMO_MODE || '').toLowerCase() === 'false') return false;
  return !isConfigured();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOAuthToken({ host, clientId, clientSecret }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`https://${host}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=all-apis'
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Databricks OAuth ${res.status}: ${json?.error_description || json?.error || JSON.stringify(json).slice(0, 400)}`
    );
  }
  if (!json.access_token) {
    throw new Error('Databricks OAuth response did not include an access_token');
  }
  const expiresInSec = Number(json.expires_in) || 3600;
  oauthCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresInSec * 1000
  };
  return oauthCache.accessToken;
}

async function getAccessToken() {
  const { host, token, clientId, clientSecret } = config();
  if (token) return token;
  if (!clientId || !clientSecret) {
    throw new Error('Databricks credentials are not configured (set DATABRICKS_TOKEN or CLIENT_ID + CLIENT_SECRET)');
  }
  if (oauthCache.accessToken && Date.now() < oauthCache.expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return oauthCache.accessToken;
  }
  return fetchOAuthToken({ host, clientId, clientSecret });
}

// Databricks types we care about mapping back to JS.
function coerce(value, typeName) {
  if (value === null || value === undefined) return null;
  const t = String(typeName || '').toUpperCase();
  if (['INT', 'LONG', 'SHORT', 'BYTE', 'FLOAT', 'DOUBLE', 'DECIMAL'].includes(t)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'BOOLEAN') return value === true || value === 'true';
  return value;
}

// Runs one statement and returns { columns: [...], rows: [{col: value}], rowCount }.
async function query(sql, parameters = [], opts = {}) {
  const { host, warehouseId } = config();
  if (!isConfigured()) {
    throw new Error('Databricks credentials are not configured (set DATABRICKS_TOKEN or CLIENT_ID + CLIENT_SECRET)');
  }

  const accessToken = await getAccessToken();

  const body = {
    statement: sql,
    warehouse_id: warehouseId,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
    format: 'JSON_ARRAY',
    // INLINE silently truncates large result sets (~25MB). EXTERNAL_LINKS
    // returns downloadable chunks so sync can pull the full window.
    disposition: opts.disposition || (opts.rowLimit && opts.rowLimit > 5000 ? 'EXTERNAL_LINKS' : 'INLINE'),
    row_limit: opts.rowLimit || 50000
  };
  if (parameters.length) {
    body.parameters = parameters.map(p => ({
      name: p.name,
      value: p.value === null || p.value === undefined ? null : String(p.value),
      type: p.type || 'STRING'
    }));
  }

  const base = `https://${host}/api/2.0/sql/statements`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  let res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Databricks ${res.status}: ${json?.message || JSON.stringify(json).slice(0, 400)}`);
  }

  const startedAt = Date.now();
  while (['PENDING', 'RUNNING'].includes(json?.status?.state)) {
    if (Date.now() - startedAt > MAX_POLL_MS) {
      throw new Error('Databricks query timed out. Narrow the date range or add a filter.');
    }
    await sleep(POLL_INTERVAL_MS);
    res = await fetch(`${base}/${json.statement_id}`, { headers });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Databricks poll ${res.status}: ${json?.message || 'unknown error'}`);
  }

  const state = json?.status?.state;
  if (state !== 'SUCCEEDED') {
    const msg = json?.status?.error?.message || `statement ended in state ${state}`;
    throw new Error(`Databricks: ${msg}`);
  }

  if (json?.manifest?.truncated) {
    throw new Error(
      'Databricks result was truncated. Raise MA_SYNC_MAX_ROWS is not enough — ' +
      'the INLINE/byte limit was hit. Re-run sync (EXTERNAL_LINKS disposition is used for large pulls).'
    );
  }

  const cols = json?.manifest?.schema?.columns || [];
  let data = json?.result?.data_array || [];

  // EXTERNAL_LINKS: download each chunk; INLINE leaves data_array on the response.
  // Chunk URLs are pre-signed — do not attach the Bearer token.
  const links = json?.result?.external_links || [];
  if (links.length) {
    data = [];
    for (const link of links) {
      const url = link.external_link || link.chunk_internal_link;
      if (!url) continue;
      const chunkRes = await fetch(url);
      if (!chunkRes.ok) {
        const body = await chunkRes.text().catch(() => '');
        throw new Error(`Databricks chunk download ${chunkRes.status}: ${body.slice(0, 200)}`);
      }
      const chunkJson = await chunkRes.json().catch(() => null);
      const rows = chunkJson?.data_array || chunkJson?.result?.data_array ||
        (Array.isArray(chunkJson) ? chunkJson : null);
      if (!rows) {
        throw new Error('Databricks chunk response did not include data_array');
      }
      for (const row of rows) data.push(row);
    }
  }

  const rows = data.map(arr => {
    const o = {};
    cols.forEach((c, i) => { o[c.name] = coerce(arr[i], c.type_name); });
    return o;
  });

  return { columns: cols.map(c => ({ name: c.name, type: c.type_name })), rows, rowCount: rows.length };
}

module.exports = { query, isConfigured, isDemoMode, config, getAccessToken };
