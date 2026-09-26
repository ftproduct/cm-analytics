// /api/_specs.js
// The one place that decides what a valid metric spec is.
//
// Both /api/metrics (the dashboard) and /api/ask (the chat) put every spec
// through sanitiseSpec before it reaches an engine. The chat's specs come from
// a language model, so this is the boundary that matters: whatever the model
// writes, only a kind in KINDS, a dimension the schema maps and a filter value
// under the size cap survives. Two validators would mean two answers to "is
// this safe", so there is one, and scripts/selftest.js asserts metrics.js does
// not grow its own copy back.

// Every metric the engines implement. A kind missing here is rejected before it
// reaches them, so the panel renders "Unsupported metric" even though the code
// behind it exists -- scripts/selftest.js asserts this list stays in step.
const KINDS = new Set([
  'summary', 'group', 'timeseries', 'reasons', 'funnel', 'aging', 'heatmap',
  'movers', 'leakage', 'imbalance', 'officeHours', 'rows',
  'invMatch', 'invMatchGroup', 'invMatchDemandRows'
]);

const GRAINS = new Set(['day', 'week', 'month']);

const FILTER_KEYS = [
  'lane', 'superClusterLane', 'origin', 'destination', 'region', 'psa', 'lsp', 'shipper',
  'vehicleType', 'materialType', 'reason', 'laneType',
  'originSuperCluster', 'destinationSuperCluster', 'matchType'
];

const MAX_SPECS = 16;

// Filter values arrive from the browser. They are only ever used as bind
// parameters, but we still bound their size and shape so a malformed request
// cannot turn into a 10,000-term IN list.
function sanitiseFilters(raw = {}) {
  const out = {};
  const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  out.from = date(raw.from);
  out.to = date(raw.to);
  for (const key of FILTER_KEYS) {
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

// The chat plans its own date window, so unlike the dashboard it must be able
// to set `from`/`to` per spec rather than inheriting the tab's. Same validator,
// the base window simply comes from the spec itself.
function sanitiseSpecWithOwnWindow(raw = {}, fallbackFilters = {}) {
  const perSpec = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const base = {
    ...fallbackFilters,
    ...perSpec,
    from: perSpec.from || fallbackFilters.from || null,
    to: perSpec.to || fallbackFilters.to || null
  };
  return sanitiseSpec({ ...raw, filters: {} }, sanitiseFilters(base));
}

module.exports = {
  KINDS, GRAINS, FILTER_KEYS, MAX_SPECS,
  sanitiseFilters, sanitiseSpec, sanitiseSpecWithOwnWindow
};
