// /api/_sql.js
// Builds the Databricks SQL for every metric and reshapes the result into
// exactly the JSON that _engine.js produces for the demo dataset. The frontend
// cannot tell the two apart.
//
// Safety model:
//   - identifiers come only from config/schema.json, validated in _schema.js
//   - every value from the browser travels as a named bind parameter (:p0, :p1)
//   - nothing the browser sends is ever concatenated into a SQL string

const db = require('./_databricks.js');
const S = require('./_schema.js');
const { humanizeReason } = require('./_labels.js');

const MOVER_MIN_VOLUME = 12;

// Collects bind parameters so callers never interpolate values.
function binder() {
  const params = [];
  return {
    params,
    add(value, type = 'STRING') {
      const name = `p${params.length}`;
      params.push({ name, value, type });
      return `:${name}`;
    },
    list(values, type = 'STRING') {
      return values.map(v => this.add(v, type)).join(', ');
    }
  };
}

function successExpr(entity) {
  return entity === 'demand' ? S.isFulfilledExpr() : S.isConvertedExpr();
}

function reasonCol(entity) {
  return entity === 'demand'
    ? S.unfulfilmentReasonExpr()
    : S.col('inventory', 'nonConversionReason');
}

// Hours between two timestamps, as a double. unix_timestamp keeps this portable
// across Databricks runtimes better than timestampdiff.
function hoursBetween(a, b) {
  return `((unix_timestamp(${b}) - unix_timestamp(${a})) / 3600.0)`;
}

// Latency = time to fulfil (demand) or time to convert (inventory).
function latencyExpr(entity) {
  if (entity === 'demand') {
    const a = S.col('demand', 'createdAt');
    const b = S.col('demand', 'fulfilledAt');
    return a && b ? hoursBetween(a, b) : null;
  }
  const a = S.col('inventory', 'createdAt');
  const b = S.col('inventory', 'convertedAt');
  return a && b ? hoursBetween(a, b) : null;
}

// Hours from posting to the first PSA action on an inventory row.
function touchExpr() {
  const a = S.col('inventory', 'createdAt');
  const b = S.col('inventory', 'firstActionAt');
  return a && b ? hoursBetween(a, b) : null;
}

function valueExpr(entity) {
  if (entity === 'demand') {
    const booked = S.col('demand', 'bookedPrice');
    const expected = S.col('demand', 'expectedPrice');
    if (booked && expected) return `coalesce(${booked}, ${expected})`;
    return booked || expected;
  }
  return S.col('inventory', 'askingPrice');
}

function riskValueExpr(entity) {
  // What the failures were worth: the asking/expected price, not the booked one.
  return entity === 'demand'
    ? (S.col('demand', 'expectedPrice') || S.col('demand', 'bookedPrice'))
    : S.col('inventory', 'askingPrice');
}

function tonsExpr(entity) {
  return entity === 'demand' ? S.col('demand', 'weightTons') : S.col('inventory', 'capacityTons');
}

// Maps a filter key to the column/expression it constrains, per entity.
const FILTER_TARGET = {
  lane: e => S.laneExpr(e),
  superClusterLane: e => S.superClusterLaneExpr(e),
  origin: e => S.col(e, 'originCity') || S.col(e, 'originState'),
  destination: e => S.col(e, 'destinationCity') || S.col(e, 'destinationState'),
  region: e => S.col(e, 'region'),
  psa: e => S.col(e, 'psa'),
  lsp: e => S.col(e, 'lsp'),
  shipper: e => (e === 'demand' ? S.col('demand', 'shipper') : null),
  vehicleType: e => S.col(e, 'vehicleType'),
  materialType: e => (e === 'demand' ? S.col('demand', 'materialType') : null),
  laneType: e => {
    if (e !== 'demand') return null;
    const c = S.col('demand', 'laneType');
    if (!c) return null;
    return `CASE
      WHEN ${c} IS NULL THEN NULL
      WHEN lower(trim(cast(${c} AS string))) IN ('true', '1', 't', 'yes', 'y') THEN 'Power lane'
      ELSE 'Non power lane'
    END`;
  },
  originSuperCluster: e => S.col(e, 'originSuperCluster'),
  destinationSuperCluster: e => S.col(e, 'destinationSuperCluster'),
  reason: e => reasonCol(e)
};

// Builds "WHERE ..." from the filter object. Returns { sql, } and mutates the binder.
function whereClause(entity, filters = {}, b) {
  const created = S.reqCol(entity, 'createdAt');
  const parts = [];

  if (filters.from) parts.push(`to_date(${created}) >= to_date(${b.add(filters.from)})`);
  if (filters.to) parts.push(`to_date(${created}) <= to_date(${b.add(filters.to)})`);

  for (const [key, resolve] of Object.entries(FILTER_TARGET)) {
    const values = filters[key];
    if (!Array.isArray(values) || values.length === 0) continue;
    const target = resolve(entity);
    if (!target) continue;                       // dimension not mapped -- ignore
    parts.push(`${target} IN (${b.list(values)})`);
  }

  if (filters.outcome === 'success') parts.push(successExpr(entity));
  if (filters.outcome === 'fail') parts.push(`NOT ${successExpr(entity)}`);

  const exclude = S.excludeStatusesExpr(entity);
  if (exclude) parts.push(exclude);

  return parts.length ? `WHERE ${parts.join('\n    AND ')}` : '';
}

function truncExpr(entity, grain) {
  const created = S.reqCol(entity, 'createdAt');
  if (grain === 'month') return `date_format(${created}, 'yyyy-MM')`;
  if (grain === 'week') return `date_format(date_trunc('WEEK', ${created}), 'yyyy-MM-dd')`;
  return `date_format(${created}, 'yyyy-MM-dd')`;
}

function pct(n, d) { return d > 0 ? Math.round((n / d) * 1000) / 10 : null; }
function round(n, d = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const f = Math.pow(10, d);
  return Math.round(Number(n) * f) / f;
}

// ---------------------------------------------------------------------------
// Individual metric queries
// ---------------------------------------------------------------------------

async function runSummary(entity, filters) {
  const b = binder();
  const where = whereClause(entity, filters, b);
  const ok = successExpr(entity);
  const lat = latencyExpr(entity);
  const lane = S.laneExpr(entity);
  const lsp = S.col(entity, 'lsp');
  const tons = tonsExpr(entity);
  const risk = riskValueExpr(entity);
  const booked = entity === 'demand' ? S.col('demand', 'bookedPrice') : null;
  const touch = entity === 'inventory' ? touchExpr() : null;
  const firstAction = entity === 'inventory' ? S.col('inventory', 'firstActionAt') : null;

  const select = [
    `count(*) AS total`,
    `sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS success`,
    lat ? `percentile_approx(CASE WHEN ${ok} THEN ${lat} END, 0.5) AS median_latency` : `NULL AS median_latency`,
    lat ? `percentile_approx(CASE WHEN ${ok} THEN ${lat} END, 0.9) AS p90_latency` : `NULL AS p90_latency`,
    lane ? `count(DISTINCT ${lane}) AS unique_lanes` : `NULL AS unique_lanes`,
    lsp ? `count(DISTINCT ${lsp}) AS unique_lsps` : `NULL AS unique_lsps`,
    tons ? `sum(${tons}) AS tons` : `NULL AS tons`,
    booked ? `sum(CASE WHEN ${ok} THEN ${booked} ELSE 0 END) AS booked_value` : `NULL AS booked_value`,
    risk ? `sum(CASE WHEN NOT ${ok} THEN ${risk} ELSE 0 END) AS value_at_risk` : `NULL AS value_at_risk`,
    firstAction ? `sum(CASE WHEN ${firstAction} IS NULL THEN 1 ELSE 0 END) AS untouched` : `NULL AS untouched`,
    touch ? `percentile_approx(${touch}, 0.5) AS median_touch` : `NULL AS median_touch`
  ];

  const sql = `SELECT\n  ${select.join(',\n  ')}\nFROM ${S.fromRef(entity)}\n${where}`;
  const { rows } = await db.query(sql, b.params);
  const r = rows[0] || {};
  const total = Number(r.total || 0);
  const success = Number(r.success || 0);

  const out = {
    total,
    success,
    failed: total - success,
    rate: pct(success, total),
    medianLatencyHours: round(r.median_latency),
    p90LatencyHours: round(r.p90_latency),
    uniqueLanes: r.unique_lanes == null ? null : Number(r.unique_lanes),
    uniqueLsps: r.unique_lsps == null ? null : Number(r.unique_lsps),
    valueAtRisk: r.value_at_risk == null ? null : Math.round(Number(r.value_at_risk))
  };
  if (entity === 'demand') {
    out.tons = r.tons == null ? null : Math.round(Number(r.tons));
    out.bookedValue = r.booked_value == null ? null : Math.round(Number(r.booked_value));
  } else {
    out.capacityTons = r.tons == null ? null : Math.round(Number(r.tons));
    out.untouched = r.untouched == null ? null : Number(r.untouched);
    out.untouchedRate = r.untouched == null ? null : pct(Number(r.untouched), total);
    out.medianTouchHours = round(r.median_touch);
  }
  return out;
}

async function runGroup(entity, filters, dim, limit = 15) {
  const b = binder();
  const where = whereClause(entity, filters, b);
  const key = S.dimensionExpr(entity, dim);
  const ok = successExpr(entity);
  const lat = latencyExpr(entity);
  const val = valueExpr(entity);
  const tons = tonsExpr(entity);

  const sql = `SELECT
  coalesce(cast(${key} AS STRING), 'Unknown') AS k,
  count(*) AS total,
  sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS success,
  ${lat ? `percentile_approx(CASE WHEN ${ok} THEN ${lat} END, 0.5)` : 'NULL'} AS median_latency,
  ${val ? `sum(${val})` : 'NULL'} AS value,
  ${tons ? `sum(${tons})` : 'NULL'} AS tons
FROM ${S.fromRef(entity)}
${where}
GROUP BY 1
ORDER BY total DESC
${limit ? `LIMIT ${Math.min(Number(limit) || 15, 500)}` : ''}`;

  const { rows } = await db.query(sql, b.params);
  return rows.map(r => {
    const total = Number(r.total || 0);
    const success = Number(r.success || 0);
    return {
      key: r.k,
      total,
      success,
      failed: total - success,
      rate: pct(success, total),
      medianLatencyHours: round(r.median_latency),
      value: r.value == null ? null : Math.round(Number(r.value)),
      tons: r.tons == null ? null : Math.round(Number(r.tons))
    };
  });
}

async function runTimeseries(entity, filters, grain = 'day') {
  const b = binder();
  const where = whereClause(entity, filters, b);
  const ok = successExpr(entity);
  const period = truncExpr(entity, grain);

  const sql = `SELECT
  ${period} AS period,
  count(*) AS total,
  sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS success
FROM ${S.fromRef(entity)}
${where}
GROUP BY 1
ORDER BY 1`;

  const { rows } = await db.query(sql, b.params);
  return rows.map(r => {
    const total = Number(r.total || 0);
    const success = Number(r.success || 0);
    return { period: r.period, total, success, failed: total - success, rate: pct(success, total) };
  });
}

async function runReasons(entity, filters, limit = 12) {
  const col = reasonCol(entity);
  if (!col) {
    return { totalFailures: null, valueLost: null, rows: [], unavailable: `No ${entity} reason column mapped in config/schema.json` };
  }
  const b = binder();
  const where = whereClause(entity, { ...filters, outcome: 'fail' }, b);
  const risk = riskValueExpr(entity);

  // Demand reasonCol already coalesces cancel → status → Not captured.
  const keyExpr = entity === 'demand'
    ? col
    : `coalesce(cast(${col} AS STRING), 'Not captured')`;

  const sql = `SELECT
  ${keyExpr} AS k,
  count(*) AS cnt,
  ${risk ? `sum(${risk})` : 'NULL'} AS value
FROM ${S.fromRef(entity)}
${where}
GROUP BY 1
ORDER BY cnt DESC`;

  const { rows } = await db.query(sql, b.params);
  const totalFail = rows.reduce((s, r) => s + Number(r.cnt || 0), 0);
  const valueLost = rows.reduce((s, r) => s + Number(r.value || 0), 0);
  let run = 0;
  const top = rows.slice(0, limit).map(r => {
    const count = Number(r.cnt || 0);
    run += count;
    return {
      key: entity === 'demand' ? humanizeReason(r.k) : (r.k || 'Not captured'),
      code: r.k,
      count,
      share: pct(count, totalFail),
      cumulative: pct(run, totalFail),
      value: r.value == null ? null : Math.round(Number(r.value))
    };
  });
  return { totalFailures: totalFail, valueLost: Math.round(valueLost), rows: top };
}

async function runFunnel(filters) {
  const schema = S.getSchema();
  const stageCol = S.col('inventory', 'stage');
  const ok = S.isConvertedExpr();
  const b = binder();
  const where = whereClause('inventory', filters, b);

  // Without a stage column we can still show the only two stages we can prove:
  // everything that was posted, and everything that converted.
  if (!stageCol) {
    const sql = `SELECT count(*) AS total, sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS converted
FROM ${S.fromRef('inventory')}
${where}`;
    const { rows } = await db.query(sql, b.params);
    const total = Number(rows[0]?.total || 0);
    const conv = Number(rows[0]?.converted || 0);
    return [
      { stage: 'POSTED', count: total, dropOff: 0, fromPrev: 100, fromTop: 100 },
      { stage: 'CONVERTED', count: conv, dropOff: total - conv, fromPrev: pct(conv, total), fromTop: pct(conv, total) }
    ];
  }

  const stages = schema.inventory.funnelStages || [];
  const sql = `SELECT
  upper(trim(cast(${stageCol} AS STRING))) AS stage,
  count(*) AS cnt
FROM ${S.fromRef('inventory')}
${where}
GROUP BY 1`;
  const { rows } = await db.query(sql, b.params);
  const at = new Map(rows.map(r => [String(r.stage), Number(r.cnt || 0)]));

  // Stages are monotonic: a row sitting at CONFIRMED already passed QUOTED.
  const counts = stages.map((_, i) =>
    stages.slice(i).reduce((s, st) => s + (at.get(String(st).toUpperCase()) || 0), 0));
  const top = counts[0] || 0;
  return stages.map((stage, i) => ({
    stage,
    count: counts[i],
    dropOff: i === 0 ? 0 : counts[i - 1] - counts[i],
    fromPrev: i === 0 ? 100 : pct(counts[i], counts[i - 1]),
    fromTop: pct(counts[i], top)
  }));
}

async function runAging(filters) {
  const touch = touchExpr();
  if (!touch) {
    return { rows: [], unavailable: 'Map inventory.firstActionAt in config/schema.json to see PSA response ageing' };
  }
  const ok = S.isConvertedExpr();
  const firstAction = S.col('inventory', 'firstActionAt');
  const b = binder();
  const where = whereClause('inventory', filters, b);

  const bucket = `CASE
    WHEN ${firstAction} IS NULL THEN 'Never touched'
    WHEN ${touch} < 6 THEN '0-6h'
    WHEN ${touch} < 24 THEN '6-24h'
    WHEN ${touch} < 72 THEN '1-3d'
    WHEN ${touch} < 168 THEN '3-7d'
    ELSE '7d+'
  END`;

  const sql = `SELECT
  ${bucket} AS bucket,
  count(*) AS total,
  sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS converted
FROM ${S.fromRef('inventory')}
${where}
GROUP BY 1`;

  const { rows } = await db.query(sql, b.params);
  const order = ['0-6h', '6-24h', '1-3d', '3-7d', '7d+', 'Never touched'];
  const byKey = new Map(rows.map(r => [r.bucket, r]));
  return {
    rows: order.map(k => {
      const r = byKey.get(k);
      const total = Number(r?.total || 0);
      const converted = Number(r?.converted || 0);
      return { bucket: k, total, converted, rate: pct(converted, total) };
    })
  };
}

async function runHeatmap(entity, filters, grain = 'week', limit = 12) {
  const dim = 'superClusterLane';
  const top = await runGroup(entity, filters, dim, limit);
  const keys = top.map(g => g.key);
  if (!keys.length) return { keys: [], periods: [], cells: [] };

  const b = binder();
  const where = whereClause(entity, filters, b);
  const lane = S.dimensionExpr(entity, dim);
  const ok = successExpr(entity);
  const period = truncExpr(entity, grain);
  const laneFilter = `${lane} IN (${b.list(keys)})`;

  const sql = `SELECT
  cast(${lane} AS STRING) AS k,
  ${period} AS period,
  count(*) AS total,
  sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS success
FROM ${S.fromRef(entity)}
${where ? `${where}\n    AND ${laneFilter}` : `WHERE ${laneFilter}`}
GROUP BY 1, 2`;

  const { rows } = await db.query(sql, b.params);
  const periods = [...new Set(rows.map(r => r.period))].sort();
  return {
    keys,
    periods,
    cells: rows.map(r => {
      const total = Number(r.total || 0);
      const success = Number(r.success || 0);
      return { key: r.k, period: r.period, total, success, rate: pct(success, total) };
    })
  };
}

async function runMovers(entity, filters, dim = 'lane', limit = 8) {
  const prevFilters = shiftWindow(filters);
  const [curr, prev] = await Promise.all([
    runGroup(entity, filters, dim, 0),
    prevFilters ? runGroup(entity, prevFilters, dim, 0) : Promise.resolve([])
  ]);
  return combineMovers(curr, prev, limit);
}

function combineMovers(curr, prev, limit) {
  const c = new Map(curr.map(g => [g.key, g]));
  const p = new Map(prev.map(g => [g.key, g]));
  const out = [];
  for (const k of new Set([...c.keys(), ...p.keys()])) {
    const a = c.get(k) || { total: 0, rate: null };
    const b = p.get(k) || { total: 0, rate: null };
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

// Supercluster lanes where demand went unfilled while unconverted supply sat idle.
async function runLeakage(filters, limit = 15) {
  const base = { ...filters, outcome: 'all' };
  const dim = 'superClusterLane';
  const [dem, inv] = await Promise.all([
    runGroup('demand', base, dim, 0),
    // Inventory fact does not carry supercluster columns in schema.json; reuse
    // demand's grain via the same dimension when available, else fall back.
    (async () => {
      try {
        return await runGroup('inventory', base, dim, 0);
      } catch {
        return runGroup('inventory', base, 'lane', 0);
      }
    })()
  ]);
  const invByLane = new Map(inv.map(g => [g.key, g]));

  const out = [];
  for (const g of dem) {
    const i = invByLane.get(g.key) || { total: 0, failed: 0 };
    const matchable = Math.min(g.failed, i.failed);
    // Approximation: the grouped query returns total lane value, not the value
    // of the failures alone, so risk is priced at the lane's average load value.
    const riskPerFail = g.total > 0 && g.value ? (g.value / g.total) : 0;
    out.push({
      lane: g.key,
      demand: g.total,
      fulfilled: g.success,
      unfulfilled: g.failed,
      supply: i.total,
      unconverted: i.failed,
      matchable,
      coverage: g.total > 0 ? round(i.total / g.total, 2) : null,
      valueAtRisk: Math.round(riskPerFail * matchable)
    });
  }
  out.sort((a, b) => b.matchable - a.matchable);
  return out.slice(0, limit);
}

const IMBALANCE_MIN_VOLUME = 5;
const IMBALANCE_MIN_GAP = 3;

async function runImbalance(filters, limit = 15) {
  const base = { ...filters, outcome: 'all' };
  const dim = 'superClusterLane';
  const [dem, inv] = await Promise.all([
    runGroup('demand', base, dim, 0),
    (async () => {
      try {
        return await runGroup('inventory', base, dim, 0);
      } catch {
        return runGroup('inventory', base, 'lane', 0);
      }
    })()
  ]);
  const demByLane = new Map(dem.map(g => [g.key, g]));
  const invByLane = new Map(inv.map(g => [g.key, g]));
  const lanes = new Set([...demByLane.keys(), ...invByLane.keys()]);
  const demandHeavy = [];
  const supplyHeavy = [];
  for (const lane of lanes) {
    const g = demByLane.get(lane) || { total: 0, success: 0, failed: 0, rate: null };
    const i = invByLane.get(lane) || { total: 0 };
    const demand = g.total;
    const supply = i.total;
    const gap = demand - supply;
    const row = {
      lane,
      demand,
      supply,
      fulfilled: g.success,
      unfulfilled: g.failed,
      rate: g.rate,
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

async function runDrillRows(entity, filters, limit = 300) {
  const b = binder();
  const where = whereClause(entity, filters, b);
  const c = k => S.col(entity, k);
  const ok = successExpr(entity);
  const lat = latencyExpr(entity);
  const lane = S.laneExpr(entity);

  const cols = [
    `${c('id') || 'NULL'} AS id`,
    `cast(${S.reqCol(entity, 'createdAt')} AS STRING) AS createdAt`,
    `${lane || 'NULL'} AS lane`,
    `${c('lsp') || 'NULL'} AS lsp`,
    `${c('psa') || 'NULL'} AS psa`,
    `${c('vehicleType') || 'NULL'} AS vehicleType`,
    `${c('status') || 'NULL'} AS status`,
    `CASE WHEN ${ok} THEN '${entity === 'demand' ? 'Fulfilled' : 'Converted'}' ELSE '${entity === 'demand' ? 'Unfulfilled' : 'Not converted'}' END AS outcome`,
    `${reasonCol(entity) || 'NULL'} AS reason`,
    `${lat || 'NULL'} AS latencyHours`
  ];
  if (entity === 'demand') {
    cols.push(`${c('shipper') || 'NULL'} AS shipper`);
    cols.push(`${c('materialType') || 'NULL'} AS materialType`);
    cols.push(`${c('weightTons') || 'NULL'} AS weightTons`);
    cols.push(`${c('expectedPrice') || 'NULL'} AS expectedPrice`);
    cols.push(`${c('bookedPrice') || 'NULL'} AS bookedPrice`);
  } else {
    const touch = touchExpr();
    cols.push(`${c('stage') || 'NULL'} AS stage`);
    cols.push(`${touch || 'NULL'} AS touchHours`);
    cols.push(`${c('capacityTons') || 'NULL'} AS capacityTons`);
    cols.push(`${c('askingPrice') || 'NULL'} AS askingPrice`);
  }

  const sql = `SELECT\n  ${cols.join(',\n  ')}\nFROM ${S.fromRef(entity)}\n${where}\nORDER BY ${S.reqCol(entity, 'createdAt')} DESC\nLIMIT ${Math.min(Number(limit) || 300, 2000)}`;
  const { rows } = await db.query(sql, b.params);
  return rows.map(r => ({ ...r, latencyHours: round(r.latencyHours), touchHours: round(r.touchHours) }));
}

async function runConcentration(entity, filters) {
  const groups = await runGroup(entity, filters, 'lsp', 0);
  const total = groups.reduce((s, g) => s + g.total, 0);
  if (!total) return { total: 0, count: 0, top3Share: null, top5Share: null, hhi: null };
  const shares = groups.map(g => g.total / total);
  const cum = n => round(shares.slice(0, n).reduce((s, x) => s + x, 0) * 100);
  return {
    total,
    count: groups.length,
    top3Share: cum(3),
    top5Share: cum(5),
    hhi: Math.round(shares.reduce((s, x) => s + x * x, 0) * 10000)
  };
}

function shiftWindow(f) {
  if (!f || !f.from || !f.to) return null;
  const from = new Date(f.from + 'T00:00:00Z');
  const to = new Date(f.to + 'T00:00:00Z');
  const span = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const prevTo = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (span - 1) * 86400000);
  return { ...f, from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------

// A limit of 0 means "every group" -- distinct from "no limit supplied", which
// falls back to the per-metric default. `spec.limit || default` conflated them.
function limitOf(spec, fallback) {
  return spec.limit === 0 ? 0 : (spec.limit || fallback);
}

async function runOfficeHours(filters) {
  const created = S.col('demand', 'createdAt');
  if (!created) {
    return { rows: [], unavailable: 'Demand createdAt is not mapped — cannot split by office hours.' };
  }
  const b = binder();
  const where = whereClause('demand', filters, b);
  // Wall-clock hour on the warehouse timestamp (IST for this marketplace).
  const hour = `hour(cast(${created} AS timestamp))`;
  const slot = `CASE
    WHEN ${hour} >= 9 AND ${hour} < 13 THEN '9am–1pm'
    WHEN ${hour} >= 13 AND ${hour} < 19 THEN '1pm–7pm'
    ELSE 'After office hours'
  END`;
  const ok = successExpr('demand');
  const val = valueExpr('demand');
  const sql = `SELECT
  ${slot} AS k,
  count(*) AS total,
  sum(CASE WHEN ${ok} THEN 1 ELSE 0 END) AS success,
  ${val ? `sum(${val})` : 'NULL'} AS value
FROM ${S.fromRef('demand')}
${where}
GROUP BY 1`;

  const { rows } = await db.query(sql, b.params);
  const byKey = new Map(rows.map(r => {
    const total = Number(r.total || 0);
    const success = Number(r.success || 0);
    return [r.k, {
      key: r.k,
      total,
      success,
      failed: total - success,
      rate: pct(success, total),
      value: r.value == null ? null : Math.round(Number(r.value))
    }];
  }));
  const grand = [...byKey.values()].reduce((s, r) => s + r.total, 0) || 1;
  const order = ['9am–1pm', '1pm–7pm', 'After office hours'];
  return {
    timezone: 'Asia/Kolkata',
    rows: order.map(key => {
      const g = byKey.get(key) || { key, total: 0, success: 0, failed: 0, rate: null, value: 0 };
      return { ...g, share: pct(g.total, grand) };
    })
  };
}

async function runSpec(spec) {
  const entity = spec.entity === 'inventory' ? 'inventory' : 'demand';
  const filters = spec.filters || {};

  switch (spec.kind) {
    case 'summary': {
      const prevFilters = shiftWindow(filters);
      const [current, previous, concentration] = await Promise.all([
        runSummary(entity, filters),
        prevFilters ? runSummary(entity, prevFilters) : Promise.resolve(null),
        S.col(entity, 'lsp') ? runConcentration(entity, filters) : Promise.resolve(null)
      ]);
      return { current, previous, concentration };
    }
    case 'group':
      return { rows: await runGroup(entity, filters, spec.groupBy || 'lane', limitOf(spec, 15)) };
    case 'officeHours':
      return runOfficeHours(filters);
    case 'timeseries':
      return { rows: await runTimeseries(entity, filters, spec.grain || 'day') };
    case 'reasons':
      return runReasons(entity, filters, limitOf(spec, 12));
    case 'funnel':
      return { rows: await runFunnel(filters) };
    case 'aging':
      return runAging(filters);
    case 'heatmap':
      return runHeatmap(entity, filters, spec.grain || 'week', limitOf(spec, 12));
    case 'movers':
      return runMovers(entity, filters, spec.groupBy || 'lane', limitOf(spec, 8));
    case 'leakage':
      return { rows: await runLeakage(filters, limitOf(spec, 15)) };
    case 'imbalance':
      return runImbalance(filters, limitOf(spec, 15));
    case 'rows': {
      const rows = await runDrillRows(entity, filters, limitOf(spec, 300));
      return { rows, totalMatched: rows.length };
    }
    case 'invMatch':
    case 'invMatchGroup':
    case 'invMatchDemandRows':
      throw new Error(
        `Metric "${spec.kind}" needs a synced snapshot (Metabase 1190 inventory matches). Press Sync.`
      );
    default:
      throw new Error(`Unknown metric kind "${spec.kind}"`);
  }
}

// Distinct values for the filter comboboxes. One query per dimension that is
// actually mapped, run in parallel and capped so a wide dimension cannot blow
// up the payload.
async function filterOptions(filters = {}) {
  const window = { from: filters.from, to: filters.to };
  const wanted = [
    ['lane', 'demand', 'lane', 250],
    ['superClusterLane', 'demand', 'superClusterLane', 250],
    ['origin', 'demand', 'origin', 200],
    ['destination', 'demand', 'destination', 200],
    ['region', 'demand', 'region', 50],
    ['psa', 'demand', 'psa', 300],
    ['lsp', 'demand', 'lsp', 300],
    ['shipper', 'demand', 'shipper', 300],
    ['vehicleType', 'demand', 'vehicleType', 100],
    ['materialType', 'demand', 'materialType', 100],
    ['demandReason', 'demand', 'reason', 60],
    ['inventoryReason', 'inventory', 'reason', 60]
  ];

  const out = {};
  await Promise.all(wanted.map(async ([key, entity, dim, limit]) => {
    try {
      S.dimensionExpr(entity, dim);           // throws when unmapped
    } catch { out[key] = []; return; }
    try {
      const f = dim === 'reason' ? { ...window, outcome: 'fail' } : window;
      const rows = await runGroup(entity, f, dim, limit);
      out[key] = rows.map(r => ({ value: r.key, count: r.total }));
    } catch (e) {
      out[key] = [];
    }
  }));
  return out;
}

module.exports = { runSpec, filterOptions, shiftWindow };
