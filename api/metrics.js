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

const KINDS = new Set([
  'summary', 'group', 'timeseries', 'reasons', 'funnel', 'aging', 'heatmap',
  'movers', 'leakage', 'imbalance', 'rows', 'invMatch', 'invMatchGroup', 'invMatchDemandRows'
]);
const GRAINS = new Set(['day', 'week', 'month']);
const MAX_SPECS = 16;

// Filter values arrive from the browser. They are only ever used as bind
// parameters, but we still bound their size and shape so a malformed request
// cannot turn into a 10,000-term IN list.
function sanitiseFilters(raw = {}) {
  const out = {};
  const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  out.from = date(raw.from);
  out.to = date(raw.to);
  for (const key of [
    'lane', 'superClusterLane', 'origin', 'destination', 'region', 'psa', 'lsp', 'shipper',
    'vehicleType', 'materialType', 'reason', 'laneType',
    'originSuperCluster', 'destinationSuperCluster', 'matchType'
  ]) {
    const v = raw[key];
    if (!Array.isArray(v) || !v.length) continue;
    out[key] = v.filter(x => typeof x === 'string' && x.length <= 200).slice(0, 300);
  }
  out.outcome = ['success', 'fail'].includes(raw.outcome) ? raw.outcome : 'all';
  return out;
}

function sanitiseSpec(raw = {}, baseFilters = {}) {
  if (!KINDS.has(raw.kind)) throw new Error(`Unsupported metric "${raw.kind}"`);
  const perSpec = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  // Per-spec filters (e.g. matchType: Exact) merge on top of the tab filters.
  const filters = sanitiseFilters({ ...baseFilters, ...perSpec, from: baseFilters.from, to: baseFilters.to });
  return {
    id: String(raw.id || raw.kind).slice(0, 64),
    entity: raw.entity === 'inventory' ? 'inventory' : (raw.entity === 'bids' ? 'bids' : 'demand'),
    kind: raw.kind,
    groupBy: typeof raw.groupBy === 'string' ? raw.groupBy.slice(0, 32) : undefined,
    grain: GRAINS.has(raw.grain) ? raw.grain : undefined,
    limit: Number.isFinite(Number(raw.limit)) ? Math.min(Math.max(Number(raw.limit), 0), 2000) : undefined,
    matchType: typeof raw.matchType === 'string' ? raw.matchType.slice(0, 32) : undefined,
    filters
  };
}

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
