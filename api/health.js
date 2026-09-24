// /api/health.js — liveness plus a real round trip to Databricks when a token
// is configured, so "is it actually connected?" has a one-click answer.
const db = require('./_databricks.js');
const S = require('./_schema.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = {
    ok: true,
    mode: db.isDemoMode() ? 'demo' : 'live',
    tokenConfigured: db.isConfigured(),
    time: new Date().toISOString()
  };
  try {
    S.getSchema();
    out.schemaValid = true;
  } catch (e) {
    out.schemaValid = false;
    out.schemaError = e.message;
  }
  if (db.isConfigured()) {
    const startedAt = Date.now();
    try {
      await db.query('SELECT 1 AS ping');
      out.databricks = { reachable: true, elapsedMs: Date.now() - startedAt };
    } catch (e) {
      out.ok = false;
      out.databricks = { reachable: false, error: e.message, elapsedMs: Date.now() - startedAt };
    }
  }
  res.status(out.ok ? 200 : 503).json(out);
};
