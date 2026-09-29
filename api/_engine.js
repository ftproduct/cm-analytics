// /api/_engine.js
// In-memory aggregation over a row-level dataset.
//
// This is the reference implementation of every metric the app exposes. It runs
// over two different datasets and cannot tell them apart:
//
//   demo mode   -- the generated dataset from _demo.js
//   cached mode -- a snapshot of real rows pulled from Databricks by _sync.js
//
// The SQL builder in _sql.js emits the same aggregates against Databricks and
// returns the same JSON, so the frontend is identical in all three modes -- and
// this file doubles as executable documentation of what each metric means.

const { build, FUNNEL_STAGES } = require('./_demo.js');
const zone = require('./_zone.js');
const { humanizeReason } = require('./_labels.js');

const AGING_BUCKETS = [
  { key: '0-6h',  min: 0,   max: 6 },
  { key: '6-24h', min: 6,   max: 24 },
  { key: '1-3d',  min: 24,  max: 72 },
  { key: '3-7d',  min: 72,  max: 168 },
  { key: '7d+',   min: 168, max: Infinity }
];

// A rate change is only comparable when both windows carry enough volume.
const MOVER_MIN_VOLUME = 12;

const DIM_FIELD = {
  lane: 'lane', superClusterLane: 'superClusterLane',
  origin: 'originCity', destination: 'destinationCity',
  originState: 'originState', lsp: 'lsp', psa: 'psa', shipper: 'shipper',
  vehicleType: 'vehicleType', materialType: 'materialType', region: 'region',
  branch: 'branch', status: 'status', stage: 'stage',
  laneType: 'laneType',
  demandSource: 'demandSource',
  callSource: 'callSource',
  inventoryType: 'inventoryType',
  originSuperCluster: 'originSuperCluster',
  destinationSuperCluster: 'destinationSuperCluster',
  matchType: 'matchType'
};

function reasonField(entity) {
  return entity === 'demand' ? 'unfulfilmentReason' : 'nonConversionReason';
}
function successField(entity) {
  return entity === 'demand' ? 'isFulfilled' : 'isConverted';
}
// cancellation_reason is blank on most misses — use demand status as the
// actionable fallback (same rule as unfulfilmentReasonExpr in _schema.js).
function resolveReason(row, entity) {
  if (entity === 'demand') {
    const raw = row.unfulfilmentReason || row.status || 'Not captured';
    return humanizeReason(raw);
  }
  return row.nonConversionReason || 'Not captured';
}
function fieldFor(entity, dim) {
  if (dim === 'reason') return reasonField(entity);
  return DIM_FIELD[dim] || dim;
}

// Older snapshots may lack superClusterLane / canonical zone; derive them.
function ensureDerivedFields(rows) {
  if (!rows) return;
  for (const r of rows) {
    if (!r.superClusterLane) {
      r.superClusterLane = `${r.originSuperCluster || 'Unknown'} → ${r.destinationSuperCluster || 'Unknown'}`;
    }
    r.region = zone.resolveZone(r);
  }
}

// Demand creation slots in India wall-clock (IST). Databricks timestamps are
// treated as IST wall time when they carry no offset; otherwise converted.
const OFFICE_HOURS_ORDER = ['9am–1pm', '1pm–7pm', 'After office hours'];

function createdHourIst(createdAt) {
  if (createdAt == null || createdAt === '') return null;
  const s = String(createdAt).trim();
  // Naive warehouse timestamps (no Z / offset) → read the hour as IST wall clock.
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const hm = s.match(/(?:T|\s)(\d{1,2}):(\d{2})/);
    if (hm) return Number(hm[1]);
  }
  const d = new Date(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', hourCycle: 'h23'
  }).formatToParts(d);
  const hour = parts.find(p => p.type === 'hour');
  return hour ? Number(hour.value) : null;
}

function officeHoursBucket(createdAt) {
  const h = createdHourIst(createdAt);
  if (h == null) return 'After office hours';
  if (h >= 9 && h < 13) return '9am–1pm';
  if (h >= 13 && h < 19) return '1pm–7pm';
  return 'After office hours';
}

function officeHoursSplit(rows, entity) {
  const ok = successField(entity);
  const buckets = new Map(OFFICE_HOURS_ORDER.map(k => [k, { key: k, total: 0, success: 0, value: 0 }]));
  for (const r of rows) {
    const key = officeHoursBucket(r.createdAt);
    const g = buckets.get(key);
    g.total++;
    if (r[ok]) g.success++;
    if (entity === 'demand') g.value += (r.expectedPrice || 0);
  }
  const grand = rows.length || 1;
  return OFFICE_HOURS_ORDER.map(key => {
    const g = buckets.get(key);
    return {
      key: g.key,
      total: g.total,
      success: g.success,
      failed: g.total - g.success,
      rate: pct(g.success, g.total),
      share: pct(g.total, grand),
      value: Math.round(g.value)
    };
  });
}

function inList(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes(value);
}

function applyFilters(rows, entity, f = {}) {
  const ok = successField(entity);
  const from = f.from || null;
  const to = f.to || null;
  return rows.filter(r => {
    if (from && r.createdDate < from) return false;
    if (to && r.createdDate > to) return false;
    if (!inList(f.lane, r.lane)) return false;
    if (!inList(f.superClusterLane, r.superClusterLane)) return false;
    if (!inList(f.origin, r.originCity)) return false;
    if (!inList(f.destination, r.destinationCity)) return false;
    if (!inList(f.region, r.region)) return false;
    if (!inList(f.psa, r.psa)) return false;
    if (!inList(f.lsp, r.lsp)) return false;
    if (!inList(f.shipper, r.shipper)) return false;
    if (!inList(f.vehicleType, r.vehicleType)) return false;
    if (!inList(f.materialType, r.materialType)) return false;
    if (!inList(f.laneType, r.laneType)) return false;
    if (!inList(f.demandSource, r.demandSource)) return false;
    // Call source belongs to the inventory side only -- a demand row has no
    // call to attribute. _sql.js already resolves this filter to nothing for
    // demand, so scoping it here keeps cached and live answers identical
    // instead of emptying every demand panel the moment the chip is used.
    if (entity !== 'demand' && !inList(f.callSource, r.callSource)) return false;
    if (!inList(f.originSuperCluster, r.originSuperCluster)) return false;
    if (!inList(f.destinationSuperCluster, r.destinationSuperCluster)) return false;
    if (!inList(f.matchType, r.matchType)) return false;
    if (Array.isArray(f.reason) && f.reason.length) {
      const raw = entity === 'demand'
        ? (r.unfulfilmentReason || r.status || 'Not captured')
        : (r.nonConversionReason || 'Not captured');
      const labelled = entity === 'demand' ? humanizeReason(raw) : raw;
      if (!f.reason.includes(raw) && !f.reason.includes(labelled)) return false;
    }
    if (f.outcome === 'success' && !r[ok]) return false;
    if (f.outcome === 'fail' && r[ok]) return false;
    return true;
  });
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function round(n, d = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// ISO period key for a date string at the requested grain.
function periodKey(dateStr, grain) {
  if (grain === 'month') return dateStr.slice(0, 7);
  if (grain === 'week') {
    const d = new Date(dateStr + 'T00:00:00Z');
    const dow = (d.getUTCDay() + 6) % 7;            // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

function shiftWindow(f) {
  // Previous comparable window of the same length, ending the day before `from`.
  if (!f || !f.from || !f.to) return null;
  const from = new Date(f.from + 'T00:00:00Z');
  const to = new Date(f.to + 'T00:00:00Z');
  const span = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const prevTo = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (span - 1) * 86400000);
  return { ...f, from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

function summarise(rows, entity) {
  const ok = successField(entity);
  const total = rows.length;
  const success = rows.filter(r => r[ok]).length;
  const latencies = entity === 'demand'
    ? rows.filter(r => r.ttfHours != null).map(r => r.ttfHours)
    : rows.filter(r => r.ttcHours != null).map(r => r.ttcHours);
  const out = {
    total,
    success,
    failed: total - success,
    rate: pct(success, total),
    medianLatencyHours: round(median(latencies)),
    p90LatencyHours: round(quantile(latencies, 0.9)),
    uniqueLanes: new Set(rows.map(r => r.lane)).size,
    uniqueLsps: new Set(rows.map(r => r.lsp).filter(Boolean)).size
  };
  if (entity === 'demand') {
    out.tons = round(rows.reduce((s, r) => s + (r.weightTons || 0), 0), 0);
    out.bookedValue = rows.reduce((s, r) => s + (r.bookedPrice || 0), 0);
    out.valueAtRisk = rows.filter(r => !r.isFulfilled).reduce((s, r) => s + (r.expectedPrice || 0), 0);
  } else {
    const untouched = rows.filter(r => r.firstActionAt == null).length;
    out.untouched = untouched;
    out.untouchedRate = pct(untouched, total);
    out.medianTouchHours = round(median(rows.filter(r => r.touchHours != null).map(r => Math.max(0, Number(r.touchHours)))));
    out.capacityTons = round(rows.reduce((s, r) => s + (r.capacityTons || 0), 0), 0);
    out.valueAtRisk = rows.filter(r => !r.isConverted).reduce((s, r) => s + (r.askingPrice || 0), 0);
  }
  return out;
}

function groupRows(rows, entity, dim, limit = 15) {
  const field = fieldFor(entity, dim);
  const ok = successField(entity);
  const map = new Map();
  for (const r of rows) {
    const k = dim === 'reason'
      ? resolveReason(r, entity)
      : (r[field] == null || r[field] === '' ? 'Unknown' : String(r[field]));
    let g = map.get(k);
    if (!g) { g = { key: k, total: 0, success: 0, lat: [], value: 0, tons: 0 }; map.set(k, g); }
    g.total++;
    if (r[ok]) g.success++;
    const lat = entity === 'demand' ? r.ttfHours : (entity === 'bids' ? r.touchHours : r.ttcHours);
    if (lat != null) g.lat.push(lat);
    g.value += entity === 'demand' ? (r.bookedPrice || r.expectedPrice || 0) : (r.askingPrice || 0);
    g.tons += entity === 'demand' ? (r.weightTons || 0) : (r.capacityTons || 0);
  }
  const out = [...map.values()].map(g => ({
    key: g.key,
    total: g.total,
    success: g.success,
    failed: g.total - g.success,
    rate: pct(g.success, g.total),
    medianLatencyHours: round(median(g.lat)),
    value: Math.round(g.value),
    tons: round(g.tons, 0)
  }));
  out.sort((a, b) => b.total - a.total);
  return limit ? out.slice(0, limit) : out;
}

function timeseries(rows, entity, grain = 'day') {
  const ok = successField(entity);
  const map = new Map();
  for (const r of rows) {
    const k = periodKey(r.createdDate, grain);
    let g = map.get(k);
    if (!g) { g = { period: k, total: 0, success: 0 }; map.set(k, g); }
    g.total++;
    if (r[ok]) g.success++;
  }
  return [...map.values()]
    .map(g => ({ ...g, failed: g.total - g.success, rate: pct(g.success, g.total) }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
}

// Reason breakdown, ordered by frequency with a running cumulative share.
// Rendered as ranked bars with the cumulative printed as a label -- never as a
// dual-axis Pareto.
function reasons(rows, entity, limit = 12) {
  const ok = successField(entity);
  const failures = rows.filter(r => !r[ok]);
  const map = new Map();
  let valueLost = 0;
  for (const r of failures) {
    const k = resolveReason(r, entity);
    const v = entity === 'demand' ? (r.expectedPrice || 0) : (r.askingPrice || 0);
    valueLost += v;
    const g = map.get(k) || { key: k, count: 0, value: 0 };
    g.count++;
    g.value += v;
    map.set(k, g);
  }
  const list = [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  const totalFail = failures.length;
  let run = 0;
  return {
    totalFailures: totalFail,
    valueLost: Math.round(valueLost),
    rows: list.map(g => {
      run += g.count;
      return {
        key: g.key,
        count: g.count,
        share: pct(g.count, totalFail),
        cumulative: pct(run, totalFail),
        value: Math.round(g.value)
      };
    })
  };
}

function isExactMatch(r) {
  const t = String(r.matchType || '').toLowerCase();
  return t === 'exact' || t === 'lane';
}

function isOriginMatch(r) {
  return String(r.matchType || '').toLowerCase() === 'origin';
}

function demandKey(r) {
  return r.demandId != null ? String(r.demandId)
    : (r.matchedDemandId != null ? String(r.matchedDemandId) : null);
}

// Metabase 1190 overall / city / PSA inventory-match aggregates.
// Placement / lapsed / rate-mismatch are demand-level (MAX); call / available are match-row sums.
function invMatchAggregate(rows) {
  const exact = rows.filter(isExactMatch);
  const origin = rows.filter(isOriginMatch);
  const demandSet = new Set();
  const demandExact = new Set();
  const demandOrigin = new Set();
  const placedExact = new Set();
  const placedOrigin = new Set();
  const lapsedExact = new Set();
  const lapsedOrigin = new Set();
  const rateExact = new Set();
  const rateOrigin = new Set();

  for (const r of rows) {
    const id = demandKey(r);
    if (!id) continue;
    demandSet.add(id);
    const status = String(r.demandStatus || r.status || '').toUpperCase();
    if (isExactMatch(r)) {
      demandExact.add(id);
      if (r.isPlacementAvailable && status === 'VEHICLE_PLACED_BY_FT') placedExact.add(id);
      if (status === 'LAPSED') lapsedExact.add(id);
      if (status === 'VEHICLE_AVAILABLE_RATE_MISMATCH') rateExact.add(id);
    }
    if (isOriginMatch(r)) {
      demandOrigin.add(id);
      if (r.isPlacementAvailable && status === 'VEHICLE_PLACED_BY_FT') placedOrigin.add(id);
      if (status === 'LAPSED') lapsedOrigin.add(id);
      if (status === 'VEHICLE_AVAILABLE_RATE_MISMATCH') rateOrigin.add(id);
    }
  }

  const calledOf = (list) => list.filter(r => r.isCalled).length;
  const directOf = (list) => list.filter(r => r.callType === 'Direct').length;
  const indirectOf = (list) => list.filter(r => r.callType === 'Indirect').length;
  const availOf = (list) => list.filter(r => r.isVehicleAvailable).length;

  return {
    demandMatched: demandSet.size,
    demandExact: demandExact.size,
    demandOrigin: demandOrigin.size,
    exactInventoryMatches: exact.length,
    originInventoryMatches: origin.length,
    exactCalled: calledOf(exact),
    exactCalledDirect: directOf(exact),
    exactCalledIndirect: indirectOf(exact),
    exactVehicleAvailable: availOf(exact),
    demandPlacedExact: placedExact.size,
    exactLapsed: lapsedExact.size,
    exactRateMismatch: rateExact.size,
    originCalled: calledOf(origin),
    originCalledDirect: directOf(origin),
    originCalledIndirect: indirectOf(origin),
    originVehicleAvailable: availOf(origin),
    demandPlacedOrigin: placedOrigin.size,
    originLapsed: lapsedOrigin.size,
    originRateMismatch: rateOrigin.size,
    inventoryMatches: rows.length
  };
}

function invMatchGroup(rows, dim, limit = 20) {
  let scoped = rows;
  if (dim === 'psa') {
    scoped = rows.filter(r => r.psa && String(r.psa).trim() !== '' && String(r.psa) !== 'Demand_Bot_PSA');
  }
  const field = dim === 'city' || dim === 'originSuperCluster'
    ? 'originSuperCluster'
    : (DIM_FIELD[dim] || dim);
  const map = new Map();
  for (const r of scoped) {
    let k = r[field];
    if (k == null || k === '') k = 'Unknown';
    k = String(k);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, group]) => ({
    key,
    ...invMatchAggregate(group)
  }));
  out.sort((a, b) => b.demandMatched - a.demandMatched || b.inventoryMatches - a.inventoryMatches);
  if (limit) out = out.slice(0, limit);
  return out;
}

function invMatchDemandRows(rows, matchType, limit = 200) {
  const wantExact = !matchType || String(matchType).toLowerCase() === 'exact';
  const filtered = rows.filter(r => {
    if (wantExact ? !isExactMatch(r) : !isOriginMatch(r)) return false;
    const psa = String(r.psa || '');
    if (psa === 'Demand_Bot_PSA') return false;
    return true;
  });
  const byDemand = new Map();
  for (const r of filtered) {
    const id = demandKey(r);
    if (!id) continue;
    let g = byDemand.get(id);
    if (!g) {
      g = {
        demandId: id,
        createdAt: r.createdAt,
        createdDate: r.createdDate,
        psa: r.psa || null,
        city: r.originSuperCluster || r.originCity || null,
        status: r.demandStatus || r.status || null,
        isLiquidLane: r.laneType === 'Power lane',
        matchCount: 0,
        inventoryIds: [],
        details: [],
        callNotes: [],
        acted: 0,
        directCalls: 0,
        indirectCalls: 0,
        vehicleAvailable: 0,
        placementAvailable: 0
      };
      byDemand.set(id, g);
    }
    g.matchCount++;
    if (r.inventoryId) g.inventoryIds.push(String(r.inventoryId));
    g.details.push(
      `Inventory: ${r.inventoryId || '-'} | Called: ${r.isCalled ? 'Yes' : 'No'}` +
      ` | Call Type: ${r.callType || 'Not Called'}` +
      ` | Vehicle Available: ${r.isVehicleAvailable ? 'Yes' : 'No'}` +
      ` | Placement Available: ${r.isPlacementAvailable ? 'Yes' : 'No'}`
    );
    if (r.callNotes) g.callNotes.push(`Inventory ${r.inventoryId || '-'}: ${r.callNotes}`);
    if (r.isCalled) g.acted++;
    if (r.callType === 'Direct') g.directCalls++;
    if (r.callType === 'Indirect') g.indirectCalls++;
    if (r.isVehicleAvailable) g.vehicleAvailable++;
    if (r.isPlacementAvailable) g.placementAvailable++;
  }
  const out = [...byDemand.values()].map(g => ({
    ...g,
    matchedInventoryIds: [...new Set(g.inventoryIds)].join(' | '),
    exactInventoryDetails: g.details.join('\n----------------\n'),
    callNotes: g.callNotes.join('\n') || null
  }));
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return limit ? out.slice(0, limit) : out;
}

// Inventory funnel. Stages are monotonic: a row at CONFIRMED also passed QUOTED.
// Unknown stages (e.g. WITHDRAWN) still count as having been posted (index 0).
function funnel(rows, stages = FUNNEL_STAGES) {
  const idx = s => {
    const i = stages.indexOf(s);
    return i < 0 ? 0 : i;
  };
  const counts = stages.map(stage => rows.filter(r => idx(r.stage) >= idx(stage)).length);
  const top = counts[0] || 0;
  return stages.map((stage, i) => ({
    stage,
    count: counts[i],
    dropOff: i === 0 ? 0 : counts[i - 1] - counts[i],
    fromPrev: i === 0 ? 100 : pct(counts[i], counts[i - 1]),
    fromTop: pct(counts[i], top)
  }));
}

// How long inventory sat before a PSA first touched it, and what that did to
// conversion. This is the "which PSA acted on it, and did it matter" view.
// ---------------------------------------------------------------------------
// Supercluster leaderboard
//
// Ranks origin superclusters on the four levers that decide whether inventory
// and bids turn into placements, and cuts bid conversion by time of day.
//
//   botActioned  -- bot-raised demands a PSA has acted on. The bot stamps its own
//                   placeholder PSA (Demand_Bot_PSA) on every demand, so "actioned"
//                   means a real PSA name replaced it.
//   matchedCalled-- unique demands that inventory matched, and the share on which
//                   at least one call was made.
//   bidsCalled   -- FO App bids that were called.
//   callTime     -- 3-hour IST bands: of the bids called in the band, how many
//                   went on to be fulfilled.
//
// A supercluster under MIN_VOLUME in a category is left out of that category's
// ranking (12 mirrors the movers rule) so five loads at 100% never top a board.
// Call time is the demand_supply row's last update on a called bid -- there is
// no dedicated call timestamp -- so read the bands as when the call was logged.
// ---------------------------------------------------------------------------
const BOT_PSA = 'Demand_Bot_PSA';
const BOARD_MIN_VOLUME = 12;
const BOARD_MIN_BAND = 5;
const CALL_BAND_HOURS = 3;

function callBandLabel(i) {
  const h = n => String(n).padStart(2, '0') + ':00';
  return `${h(i * CALL_BAND_HOURS)}–${h((i + 1) * CALL_BAND_HOURS)}`;
}

function boardKey(r) {
  const k = r.originSuperCluster;
  return k == null || String(k).trim() === '' ? null : String(k);
}

function rankBoard(map, hitField) {
  const all = [...map.entries()].map(([key, g]) => ({
    key, total: g.total, hit: g[hitField], rate: pct(g[hitField], g.total)
  }));
  const ranked = all.filter(r => r.total >= BOARD_MIN_VOLUME)
    .sort((a, b) => b.rate - a.rate || b.total - a.total);
  return { rows: ranked, belowFloor: all.length - ranked.length };
}

function bump(map, key) {
  if (!map.has(key)) map.set(key, { total: 0, actioned: 0, called: 0, placed: 0, converted: 0 });
  return map.get(key);
}

function supercluster(demandRows, invRows, bidRows) {
  const bot = new Map();
  for (const r of demandRows) {
    const k = boardKey(r);
    if (!k || r.demandSource !== 'Bot') continue;
    const g = bump(bot, k);
    g.total++;
    const psa = r.psa == null ? '' : String(r.psa).trim();
    if (psa !== '' && psa !== BOT_PSA) g.actioned++;
  }

  // Unique demands: several inventory rows can match one demand.
  const seen = new Map();
  for (const r of invRows) {
    const k = boardKey(r);
    const dk = demandKey(r);
    if (!k || dk == null) continue;
    const id = k + '\u0000' + dk;
    const cur = seen.get(id) || { k, called: false, placed: false };
    if (r.isCalled) cur.called = true;
    if (r.isConverted) cur.placed = true;
    seen.set(id, cur);
  }
  const matched = new Map();
  for (const d of seen.values()) {
    const g = bump(matched, d.k);
    g.total++;
    if (d.called) g.called++;
    if (d.placed) g.placed++;
  }

  const bids = new Map();
  const bands = Array.from({ length: 24 / CALL_BAND_HOURS }, () => ({ called: 0, converted: 0 }));
  const bandsBySc = new Map();
  for (const r of bidRows) {
    const k = boardKey(r);
    if (!k) continue;
    // Snapshots synced before isCalled existed fall back to "any stage past POSTED".
    const called = r.isCalled != null ? !!r.isCalled : (r.stage != null && r.stage !== 'POSTED');
    const g = bump(bids, k);
    g.total++;
    if (r.isConverted) g.converted++;
    if (!called) continue;
    g.called++;
    const h = createdHourIst(r.callAt || r.firstActionAt);
    if (h == null) continue;
    const band = Math.floor(h / CALL_BAND_HOURS);
    bands[band].called++;
    if (r.isConverted) bands[band].converted++;
    if (!bandsBySc.has(k)) {
      bandsBySc.set(k, Array.from({ length: bands.length }, () => ({ called: 0, converted: 0 })));
    }
    const b = bandsBySc.get(k)[band];
    b.called++;
    if (r.isConverted) b.converted++;
  }

  const bandRow = (b, i) => ({
    band: callBandLabel(i), called: b.called, converted: b.converted, rate: pct(b.converted, b.called)
  });
  const pickBands = list => {
    const eligible = list.map(bandRow).filter(b => b.called >= BOARD_MIN_BAND);
    if (!eligible.length) return { best: null, worst: null };
    const byRate = [...eligible].sort((a, b) => b.rate - a.rate || b.called - a.called);
    return { best: byRate[0], worst: byRate[byRate.length - 1] };
  };
  const callTime = [...bandsBySc.entries()].map(([key, list]) => {
    const { best, worst } = pickBands(list);
    return { key, called: list.reduce((s, b) => s + b.called, 0), best, worst };
  }).filter(r => r.best).sort((a, b) => b.called - a.called);

  // One row per supercluster with every stage rate, and where it leaks most.
  const keys = new Set([...bot.keys(), ...matched.keys(), ...bids.keys()]);
  const table = [...keys].map(key => {
    const b = bot.get(key), m = matched.get(key), d = bids.get(key);
    const stages = [];
    if (b && b.total >= BOARD_MIN_VOLUME) stages.push(['Bot demand → PSA action', pct(b.actioned, b.total)]);
    if (m && m.total >= BOARD_MIN_VOLUME) {
      stages.push(['Matched demand → called', pct(m.called, m.total)]);
      if (m.called >= BOARD_MIN_BAND) stages.push(['Called → placed (matched)', pct(m.placed, m.called)]);
    }
    if (d && d.total >= BOARD_MIN_VOLUME) {
      stages.push(['Bid → called', pct(d.called, d.total)]);
      if (d.called >= BOARD_MIN_BAND) stages.push(['Called → fulfilled (bid)', pct(d.converted, d.called)]);
    }
    const weakest = stages.length ? stages.reduce((a, c) => (c[1] < a[1] ? c : a)) : null;
    return {
      key,
      botDemands: b ? b.total : 0,
      botActionedRate: b ? pct(b.actioned, b.total) : null,
      matchedDemands: m ? m.total : 0,
      matchedCalledRate: m ? pct(m.called, m.total) : null,
      matchedPlacedRate: m ? pct(m.placed, m.called) : null,
      bids: d ? d.total : 0,
      bidsCalledRate: d ? pct(d.called, d.total) : null,
      bidsFulfilledRate: d ? pct(d.converted, d.called) : null,
      weakestStage: weakest ? weakest[0] : null,
      weakestRate: weakest ? weakest[1] : null
    };
  }).sort((a, b) => (b.botDemands + b.matchedDemands + b.bids) - (a.botDemands + a.matchedDemands + a.bids));

  return {
    minVolume: BOARD_MIN_VOLUME,
    minBandVolume: BOARD_MIN_BAND,
    botActioned: rankBoard(bot, 'actioned'),
    matchedCalled: rankBoard(matched, 'called'),
    bidsCalled: rankBoard(bids, 'called'),
    callTime,
    callBands: bands.map(bandRow),
    table
  };
}

function aging(rows) {
  const buckets = AGING_BUCKETS.map(b => ({ bucket: b.key, total: 0, converted: 0 }));
  const untouched = { bucket: 'Never touched', total: 0, converted: 0 };
  for (const r of rows) {
    if (r.touchHours == null) {
      untouched.total++;
      if (r.isConverted) untouched.converted++;
      continue;
    }
    // Negative deltas mean the recorded "touch" predates the posting (joined
    // from demand-side activity). Treat as immediate (0h), never as 7d+.
    const hours = Math.max(0, Number(r.touchHours));
    const i = AGING_BUCKETS.findIndex(b => hours >= b.min && hours < b.max);
    const slot = buckets[i < 0 ? buckets.length - 1 : i];
    slot.total++;
    if (r.isConverted) slot.converted++;
  }
  return [...buckets, untouched].map(b => ({ ...b, rate: pct(b.converted, b.total) }));
}

// The leadership question: on which supercluster lanes did we lose demand while
// supply was sitting right there? Unfulfilled demand on a supercluster lane that
// also had unconverted inventory in the same window is a matching loss, not a
// market loss -- and a matching loss is something the team can actually fix.
function leakage(demandRows, inventoryRows, limit = 15) {
  const keyOf = r => r.superClusterLane || r.lane || 'Unknown';
  const d = new Map();
  for (const r of demandRows) {
    const key = keyOf(r);
    const g = d.get(key) || { lane: key, demand: 0, unfulfilled: 0, valueAtRisk: 0 };
    g.demand++;
    if (!r.isFulfilled) {
      g.unfulfilled++;
      g.valueAtRisk += (r.expectedPrice || 0);
    }
    d.set(key, g);
  }
  const inv = new Map();
  for (const r of inventoryRows) {
    const key = keyOf(r);
    const g = inv.get(key) || { supply: 0, unconverted: 0 };
    g.supply++;
    if (!r.isConverted) g.unconverted++;
    inv.set(key, g);
  }
  const out = [];
  for (const [lane, g] of d) {
    const i = inv.get(lane) || { supply: 0, unconverted: 0 };
    // Pairs we failed to close on both sides of the same lane in the same window.
    const matchable = Math.min(g.unfulfilled, i.unconverted);
    out.push({
      lane,
      demand: g.demand,
      fulfilled: g.demand - g.unfulfilled,
      unfulfilled: g.unfulfilled,
      supply: i.supply,
      unconverted: i.unconverted,
      matchable,
      coverage: g.demand > 0 ? round(i.supply / g.demand, 2) : null,
      valueAtRisk: Math.round(g.valueAtRisk * (g.unfulfilled ? matchable / g.unfulfilled : 0))
    });
  }
  out.sort((a, b) => b.matchable - a.matchable);
  return out.slice(0, limit);
}

// Supercluster lanes where demand and supply volume diverge.
// Demand-heavy = loads looking for trucks; supply-heavy = trucks looking for loads.
// Floor keeps thin lanes out of the "probable" list.
const IMBALANCE_MIN_VOLUME = 5;
const IMBALANCE_MIN_GAP = 3;

function imbalance(demandRows, inventoryRows, limit = 15) {
  const keyOf = r => r.superClusterLane || r.lane || 'Unknown';
  const d = new Map();
  for (const r of demandRows) {
    const key = keyOf(r);
    const g = d.get(key) || { demand: 0, fulfilled: 0 };
    g.demand++;
    if (r.isFulfilled) g.fulfilled++;
    d.set(key, g);
  }
  const inv = new Map();
  for (const r of inventoryRows) {
    const key = keyOf(r);
    inv.set(key, (inv.get(key) || 0) + 1);
  }
  const lanes = new Set([...d.keys(), ...inv.keys()]);
  const demandHeavy = [];
  const supplyHeavy = [];
  for (const lane of lanes) {
    const g = d.get(lane) || { demand: 0, fulfilled: 0 };
    const supply = inv.get(lane) || 0;
    const demand = g.demand;
    const gap = demand - supply;
    const row = {
      lane,
      demand,
      supply,
      fulfilled: g.fulfilled,
      unfulfilled: demand - g.fulfilled,
      rate: pct(g.fulfilled, demand),
      coverage: demand > 0 ? round(supply / demand, 2) : (supply > 0 ? null : 0),
      gap: Math.abs(gap)
    };
    if (gap >= IMBALANCE_MIN_GAP && demand >= IMBALANCE_MIN_VOLUME) {
      demandHeavy.push({ ...row, gap });
    } else if (-gap >= IMBALANCE_MIN_GAP && supply >= IMBALANCE_MIN_VOLUME) {
      supplyHeavy.push({ ...row, gap: -gap });
    }
  }
  demandHeavy.sort((a, b) => b.gap - a.gap || b.demand - a.demand);
  supplyHeavy.sort((a, b) => b.gap - a.gap || b.supply - a.supply);
  return {
    demandHeavy: demandHeavy.slice(0, limit),
    supplyHeavy: supplyHeavy.slice(0, limit)
  };
}

// Supercluster-lane x period grid, for spotting when a lane started slipping.
function heatmap(rows, entity, grain = 'week', limit = 12) {
  const ok = successField(entity);
  const dim = 'superClusterLane';
  const field = fieldFor(entity, dim);
  const top = groupRows(rows, entity, dim, limit).map(g => g.key);
  const set = new Set(top);
  const map = new Map();
  const periods = new Set();
  for (const r of rows) {
    const key = r[field] == null || r[field] === '' ? 'Unknown' : String(r[field]);
    if (!set.has(key)) continue;
    const p = periodKey(r.createdDate, grain);
    periods.add(p);
    const k = key + '|' + p;
    const g = map.get(k) || { key, period: p, total: 0, success: 0 };
    g.total++;
    if (r[ok]) g.success++;
    map.set(k, g);
  }
  return {
    keys: top,
    periods: [...periods].sort(),
    cells: [...map.values()].map(g => ({ ...g, rate: pct(g.success, g.total) }))
  };
}

// Movers: biggest change versus the previous window of the same length.
function movers(curr, prev, entity, dim, limit = 8) {
  const c = new Map(groupRows(curr, entity, dim, 0).map(g => [g.key, g]));
  const p = new Map(groupRows(prev, entity, dim, 0).map(g => [g.key, g]));
  const keys = new Set([...c.keys(), ...p.keys()]);
  const out = [];
  for (const k of keys) {
    const a = c.get(k) || { total: 0, success: 0, rate: null };
    const b = p.get(k) || { total: 0, success: 0, rate: null };
    // Ignore noise: a rate swing on a handful of loads is not a signal, so
    // both windows must clear a floor before the delta is comparable.
    if (a.total < MOVER_MIN_VOLUME || b.total < MOVER_MIN_VOLUME) continue;
    out.push({
      key: k,
      total: a.total,
      prevTotal: b.total,
      volumeDelta: a.total - b.total,
      rate: a.rate,
      prevRate: b.rate,
      rateDelta: (a.rate != null && b.rate != null) ? round(a.rate - b.rate) : null
    });
  }
  const rated = out.filter(x => x.rateDelta != null);
  return {
    declining: [...rated].sort((a, b) => a.rateDelta - b.rateDelta).slice(0, limit),
    improving: [...rated].sort((a, b) => b.rateDelta - a.rateDelta).slice(0, limit)
  };
}

// Concentration: share of volume held by the top N carriers, plus HHI. A high
// HHI on a lane means one carrier failing takes the lane down with it.
function concentration(rows, entity, dim = 'lsp') {
  const groups = groupRows(rows, entity, dim, 0);
  const total = groups.reduce((s, g) => s + g.total, 0);
  if (!total) return { total: 0, count: 0, top3Share: null, top5Share: null, hhi: null };
  const shares = groups.map(g => g.total / total);
  const hhi = Math.round(shares.reduce((s, x) => s + x * x, 0) * 10000);
  const cum = n => round(shares.slice(0, n).reduce((s, x) => s + x, 0) * 100);
  return { total, count: groups.length, top3Share: cum(3), top5Share: cum(5), hhi };
}

function drillRows(rows, entity, limit = 300) {
  return rows.slice(0, limit).map(r => entity === 'demand' ? {
    id: r.id, createdAt: r.createdAt, lane: r.lane, shipper: r.shipper, lsp: r.lsp,
    psa: r.psa, vehicleType: r.vehicleType, materialType: r.materialType,
    status: r.status, outcome: r.isFulfilled ? 'Fulfilled' : 'Unfulfilled',
    reason: r.isFulfilled ? null : resolveReason(r, 'demand'), latencyHours: r.ttfHours, weightTons: r.weightTons,
    expectedPrice: r.expectedPrice, bookedPrice: r.bookedPrice
  } : {
    id: r.id, createdAt: r.createdAt, lane: r.lane, lsp: r.lsp, psa: r.psa,
    vehicleType: r.vehicleType, stage: r.stage, status: r.status,
    outcome: r.isConverted ? 'Converted' : 'Not converted',
    reason: r.nonConversionReason, touchHours: r.touchHours, latencyHours: r.ttcHours,
    capacityTons: r.capacityTons, askingPrice: r.askingPrice
  });
}

// Distinct values for the filter comboboxes, ordered by volume.
function filterOptions(filters = {}, dataset = null) {
  const data = dataset || build();
  ensureDerivedFields(data.demand);
  ensureDerivedFields(data.inventory);
  ensureDerivedFields(data.bids);
  const window = { from: filters.from, to: filters.to };
  const d = applyFilters(data.demand, 'demand', window);
  const i = applyFilters(data.inventory || [], 'inventory', window);
  const b = applyFilters(data.bids || [], 'bids', window);
  const distinct = (rows, field) => {
    const m = new Map();
    for (const r of rows) {
      const v = r[field];
      if (v == null || v === '') continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  };
  const merge = (a, b) => {
    const m = new Map();
    for (const x of [...a, ...b]) m.set(x.value, (m.get(x.value) || 0) + x.count);
    return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([value, count]) => ({ value, count }));
  };
  return {
    lane: merge(merge(distinct(d, 'lane'), distinct(i, 'lane')), distinct(b, 'lane')).slice(0, 250),
    superClusterLane: merge(
      merge(distinct(d, 'superClusterLane'), distinct(i, 'superClusterLane')),
      distinct(b, 'superClusterLane')
    ).slice(0, 250),
    origin: merge(merge(distinct(d, 'originCity'), distinct(i, 'originCity')), distinct(b, 'originCity')),
    destination: merge(merge(distinct(d, 'destinationCity'), distinct(i, 'destinationCity')), distinct(b, 'destinationCity')),
    region: merge(distinct(d, 'region'), distinct(i, 'region')),
    psa: merge(merge(distinct(d, 'psa'), distinct(i, 'psa')), distinct(b, 'psa')),
    lsp: merge(merge(distinct(d, 'lsp'), distinct(i, 'lsp')), distinct(b, 'lsp')),
    shipper: distinct(d, 'shipper'),
    vehicleType: merge(merge(distinct(d, 'vehicleType'), distinct(i, 'vehicleType')), distinct(b, 'vehicleType')),
    materialType: distinct(d, 'materialType'),
    laneType: merge(merge(distinct(d, 'laneType'), distinct(i, 'laneType')), distinct(b, 'laneType')),
    demandSource: merge(
      merge(distinct(d, 'demandSource'), distinct(i, 'demandSource')),
      distinct(b, 'demandSource')
    ),
    callSource: merge(distinct(i, 'callSource'), distinct(b, 'callSource')),
    inventoryType: merge(distinct(i, 'inventoryType'), distinct(b, 'inventoryType')),
    originSuperCluster: merge(
      merge(distinct(d, 'originSuperCluster'), distinct(i, 'originSuperCluster')),
      distinct(b, 'originSuperCluster')
    ),
    destinationSuperCluster: merge(
      merge(distinct(d, 'destinationSuperCluster'), distinct(i, 'destinationSuperCluster')),
      distinct(b, 'destinationSuperCluster')
    ),
    matchType: distinct(i, 'matchType'),
    demandReason: (() => {
      const map = new Map();
      for (const r of d.filter(x => !x.isFulfilled)) {
        const v = resolveReason(r, 'demand');
        map.set(v, (map.get(v) || 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
    })(),
    inventoryReason: distinct(i.filter(r => !r.isConverted), 'nonConversionReason'),
    bidReason: distinct(b.filter(r => !r.isConverted), 'nonConversionReason')
  };
}

// A limit of 0 means "every group" -- distinct from "no limit supplied", which
// falls back to the per-metric default. `spec.limit || default` conflated them.
function limitOf(spec, fallback) {
  return spec.limit === 0 ? 0 : (spec.limit || fallback);
}

// Single entry point -- mirrors the SQL path's runSpec().
// `dataset` is { demand: [...], inventory: [...] }; it defaults to the generated
// demo data so existing callers and the self-test keep working unchanged.
function runSpec(spec, dataset = null) {
  const data = dataset || build();
  ensureDerivedFields(data.demand);
  ensureDerivedFields(data.inventory);
  ensureDerivedFields(data.bids);
  const entity = spec.entity === 'inventory'
    ? 'inventory'
    : (spec.entity === 'bids' ? 'bids' : 'demand');
  const source = data[entity] || [];
  const rows = applyFilters(source, entity, spec.filters);

  switch (spec.kind) {
    case 'summary': {
      const prevF = shiftWindow(spec.filters);
      const prev = prevF ? applyFilters(source, entity, prevF) : [];
      const current = summarise(rows, entity);
      const previous = prevF ? summarise(prev, entity) : null;
      // Enrich inventory summary with Metabase 1190 Exact/Origin aggregates when present.
      if (entity === 'inventory' && rows.some(r => r.matchType)) {
        Object.assign(current, invMatchAggregate(rows));
        if (previous) Object.assign(previous, invMatchAggregate(prev));
      }
      return {
        current,
        previous,
        concentration: concentration(rows, entity, 'lsp')
      };
    }
    case 'group':
      return { rows: groupRows(rows, entity, spec.groupBy || 'lane', limitOf(spec, 15)) };
    case 'officeHours':
      return { rows: officeHoursSplit(rows, entity), timezone: 'Asia/Kolkata' };
    case 'timeseries':
      return { rows: timeseries(rows, entity, spec.grain || 'day') };
    case 'reasons':
      return reasons(rows, entity, limitOf(spec, 12));
    case 'funnel': {
      // Inventory (Metabase 1190) and FO App bids use different stage ladders.
      const bidStages = ['POSTED', 'CALLED', 'QUOTED', 'CONVERTED'];
      const stages = entity === 'bids'
        ? bidStages
        : (data.funnelStages || FUNNEL_STAGES);
      return { rows: funnel(rows, stages) };
    }
    case 'invMatch': {
      const prevF = shiftWindow(spec.filters);
      const prev = prevF ? applyFilters(source, entity, prevF) : [];
      return {
        current: invMatchAggregate(rows),
        previous: prevF ? invMatchAggregate(prev) : null
      };
    }
    case 'invMatchGroup':
      return {
        rows: invMatchGroup(rows, spec.groupBy || 'originSuperCluster', limitOf(spec, 20))
      };
    case 'invMatchDemandRows':
      return {
        rows: invMatchDemandRows(rows, spec.matchType || 'Exact', limitOf(spec, 200)),
        totalMatched: rows.length
      };
    case 'aging':
      return { rows: aging(rows) };
    case 'heatmap':
      return heatmap(rows, entity, spec.grain || 'week', limitOf(spec, 12));
    case 'movers': {
      const prevF = shiftWindow(spec.filters);
      const prev = prevF ? applyFilters(source, entity, prevF) : [];
      return movers(rows, prev, entity, spec.groupBy || 'lane', limitOf(spec, 8));
    }
    case 'leakage': {
      const base = { ...(spec.filters || {}), outcome: 'all' };
      return {
        rows: leakage(
          applyFilters(data.demand, 'demand', base),
          applyFilters(data.inventory, 'inventory', base),
          limitOf(spec, 15)
        )
      };
    }
    case 'imbalance': {
      const base = { ...(spec.filters || {}), outcome: 'all' };
      return imbalance(
        applyFilters(data.demand, 'demand', base),
        applyFilters(data.inventory, 'inventory', base),
        limitOf(spec, 15)
      );
    }
    case 'supercluster': {
      const base = { ...(spec.filters || {}), outcome: 'all' };
      return supercluster(
        applyFilters(data.demand, 'demand', base),
        applyFilters(data.inventory, 'inventory', base),
        applyFilters(data.bids || [], 'bids', base)
      );
    }
    case 'rows':
      return { rows: drillRows(rows, entity, limitOf(spec, 300)), totalMatched: rows.length };
    default:
      throw new Error(`Unknown metric kind "${spec.kind}"`);
  }
}

module.exports = { runSpec, filterOptions, shiftWindow, AGING_BUCKETS, OFFICE_HOURS_ORDER, officeHoursBucket };
