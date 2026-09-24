// /api/sync.js
// Pulls a fresh snapshot from Databricks into the shared cache.
//
//   GET  /api/sync  -> current snapshot status (any signed-in user)
//   POST /api/sync  -> run a sync (admin, or a scheduler holding CRON_SECRET)
//
// Body (all optional): { days, maxRows }
//
// This is the only endpoint that reads from Databricks during normal operation.
// Everything else serves from the snapshot it writes.

const { requireAccess, requireAdmin, isAdmin, getSession, devBypass } = require('./_auth.js');
const db = require('./_databricks.js');
const store = require('./_store.js');
const { runSync, DEFAULT_DAYS, MAX_ROWS } = require('./_sync.js');

// One sync at a time per instance. A second caller waits on the first rather
// than starting a duplicate scan of the same tables.
let inFlight = null;

function status(meta) {
  return {
    synced: Boolean(meta),
    backend: store.backend(),
    durable: store.isDurable(),
    tokenConfigured: db.isConfigured(),
    defaults: { days: DEFAULT_DAYS, maxRows: MAX_ROWS },
    snapshot: meta || null,
    ageSeconds: meta?.syncedAt
      ? Math.max(0, Math.round((Date.now() - new Date(meta.syncedAt).getTime()) / 1000))
      : null
  };
}

// A scheduler has no session, so it authenticates with a shared secret instead.
function isScheduler(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers?.authorization || '';
  return header === `Bearer ${secret}`;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!requireAccess(req, res)) return;
    res.status(200).json(status(await store.readMeta()));
    return;
  }

  if (req.method === 'DELETE') {
    if (!requireAdmin(req, res)) return;
    await store.clearSnapshot();
    res.status(200).json({ cleared: true, ...status(null) });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'GET, POST or DELETE' }); return; }

  if (!isScheduler(req) && !devBypass()) {
    const session = getSession(req);
    if (!session) { res.status(401).json({ error: 'Not authenticated', login: '/api/auth/login' }); return; }
    if (!isAdmin(session.email)) {
      res.status(403).json({
        error: 'Syncing is limited to admins. Add this address to the ADMIN_EMAILS environment variable.'
      });
      return;
    }
  }

  if (!db.isConfigured()) {
    res.status(400).json({
      error: 'DATABRICKS_TOKEN is not configured, so there is nothing to sync from. The dashboard is serving demo data.'
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const startedAt = Date.now();
  try {
    // Coalesce concurrent callers onto the same run.
    const joined = Boolean(inFlight);
    inFlight = inFlight || runSync({ days: body?.days, maxRows: body?.maxRows });
    const meta = await inFlight;
    res.status(200).json({ ok: true, joinedExistingSync: joined, elapsedMs: Date.now() - startedAt, ...status(meta) });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Sync failed', elapsedMs: Date.now() - startedAt });
  } finally {
    inFlight = null;
  }
};
