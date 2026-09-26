// /api/metrics.js
// The single data endpoint the dashboard talks to.
//
// POST { filters: {...}, specs: [ { id, entity, kind, groupBy, grain, limit }, ... ] }
//   -> { mode, syncedAt, elapsedMs, results: { <id>: <payload> | { error } } }
//
// Specs are batched so a full dashboard tab is one round trip rather than eight.
// A spec that fails is reported in its own slot; the rest of the tab still
// renders, which matters when one column is unmapped but the others are fine.

const { requireAccess } = require('./_auth.js');
const source = require('./_source.js');
// One validator, shared with /api/ask -- see the header of _specs.js.
const { MAX_SPECS, sanitiseFilters, sanitiseSpec } = require('./_specs.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!requireAccess(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const filters = sanitiseFilters(body.filters);
  const rawSpecs = Array.isArray(body.specs) ? body.specs.slice(0, MAX_SPECS) : [];
  if (!rawSpecs.length) { res.status(400).json({ error: 'No metric specs supplied' }); return; }

  // Resolved once per request, not once per spec: in cached mode the whole tab
  // is answered from a single in-memory dataset.
  const src = await source.resolve();
  const startedAt = Date.now();

  let specs;
  try {
    specs = rawSpecs.map(s => sanitiseSpec(s, filters));
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  const settled = await Promise.all(specs.map(async spec => {
    try {
      return [spec.id, await source.runSpec(src, spec)];
    } catch (e) {
      return [spec.id, { error: e.message || 'Query failed' }];
    }
  }));

  res.status(200).json({
    mode: src.mode,
    syncedAt: src.snapshot?.syncedAt || null,
    elapsedMs: Date.now() - startedAt,
    filters,
    results: Object.fromEntries(settled)
  });
};
