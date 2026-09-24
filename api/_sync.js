// /api/_sync.js
// Pulls row-level demand and inventory from Databricks into a snapshot.
//
// Why rows and not aggregates: caching aggregate results would have to be keyed
// by filter combination, so every new lane/PSA/date selection would miss the
// cache and hit the warehouse again. A row snapshot answers every filter
// combination the dashboard can produce from two queries, and _engine.js
// already knows how to compute every metric from rows.
//
// The columns selected here are exactly the row shape _engine.js expects, so
// what comes back can be handed straight to it.

const db = require('./_databricks.js');
const S = require('./_schema.js');
const store = require('./_store.js');
const zone = require('./_zone.js');

const DEFAULT_DAYS = Number(process.env.MA_SYNC_DAYS) || 180;
const MAX_ROWS = Number(process.env.MA_SYNC_MAX_ROWS) || 200_000;

function hoursBetween(a, b) {
  return `((unix_timestamp(${b}) - unix_timestamp(${a})) / 3600.0)`;
}

function col(entity, logical, alias) {
  const c = S.col(entity, logical);
  return `${c || 'NULL'} AS ${alias || logical}`;
}

function demandQuery(from, to, limit) {
  const created = S.reqCol('demand', 'createdAt');
  const fulfilled = S.col('demand', 'fulfilledAt');
  const lane = S.laneExpr('demand');
  const scLane = S.superClusterLaneExpr('demand');
  const ok = S.isFulfilledExpr();
  const exclude = S.excludeStatusesExpr('demand');
  const s = S.getSchema();
  const q = (...parts) => parts.filter(Boolean).map(p => '`' + p + '`').join('.');
  const clusters = q(s.catalog, s.schema, 'phase2poc_ftn_clusters');
  // Zone = North/South/East/West/Central at liquid-lane / supercluster grain:
  // phase2poc_ftn_clusters.super_cluster matches phase2poc_liquid_lanes.origin.
  const osc = S.col('demand', 'originSuperCluster') || 'origin_super_cluster_name';
  const zoneExpr = zone.zoneSqlFromSuperCluster(clusters, osc);

  return `SELECT
  ${col('demand', 'id')},
  cast(${created} AS STRING) AS createdAt,
  date_format(${created}, 'yyyy-MM-dd') AS createdDate,
  cast(${S.col('demand', 'pickupAt') || 'NULL'} AS STRING) AS pickupAt,
  cast(${fulfilled || 'NULL'} AS STRING) AS fulfilledAt,
  ${fulfilled ? `CASE WHEN ${ok} THEN ${hoursBetween(created, fulfilled)} END` : 'NULL'} AS ttfHours,
  ${col('demand', 'originCity')},
  ${col('demand', 'originState')},
  ${col('demand', 'destinationCity')},
  ${col('demand', 'destinationState')},
  ${lane || 'NULL'} AS lane,
  ${scLane || 'NULL'} AS superClusterLane,
  ${zoneExpr} AS region,
  ${col('demand', 'branch')},
  ${col('demand', 'shipper')},
  ${col('demand', 'lsp')},
  ${col('demand', 'psa')},
  ${col('demand', 'vehicleType')},
  ${col('demand', 'materialType')},
  ${col('demand', 'quantity')},
  ${col('demand', 'weightTons')},
  ${col('demand', 'expectedPrice')},
  ${col('demand', 'bookedPrice')},
  ${col('demand', 'status')},
  ${ok} AS isFulfilled,
  CASE
    WHEN ${ok} THEN NULL
    ELSE ${S.unfulfilmentReasonExpr() || `'Not captured'`}
  END AS unfulfilmentReason,
  CASE
    WHEN ${S.col('demand', 'laneType')} IS NULL THEN NULL
    WHEN lower(trim(cast(${S.col('demand', 'laneType')} AS string))) IN ('true', '1', 't', 'yes', 'y')
      THEN 'Power lane'
    ELSE 'Non power lane'
  END AS laneType,
  ${col('demand', 'originSuperCluster')},
  ${col('demand', 'destinationSuperCluster')}
FROM ${S.fromRef('demand')}
WHERE to_date(${created}) >= to_date(:p0) AND to_date(${created}) <= to_date(:p1)
  ${exclude ? `AND ${exclude}` : ''}
ORDER BY ${created} DESC
LIMIT ${limit}`;
}

// Inventory = demand↔supply matches with matched_by = INVENTORY.
// Metabase dashboard 1190 cards 7584 / 7578 / 7579 / 7580 parity.
// Grain: one row per demand_supply inventory match. Date filter = demand.created_at.
function inventoryQuery(from, to, limit) {
  const s = S.getSchema();
  const q = (...parts) => parts.filter(Boolean).map(p => '`' + p + '`').join('.');
  const demand = q(s.catalog, s.schema, 'phase2poc_demand');
  const ds = q(s.catalog, s.schema, 'phase2poc_demand_supply');
  const clusters = q(s.catalog, s.schema, 'phase2poc_ftn_clusters');
  const boolTrue = (expr) =>
    `lower(trim(cast(${expr} AS string))) IN ('true', '1', 't', 'yes', 'y')`;
  const called = `(${boolTrue('ds.is_called')} OR ds.call_source_ds_id IS NOT NULL)`;
  const placed = `(${boolTrue('ds.is_placement_available')} AND upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT')`;

  return `SELECT
  cast(ds.id AS string) AS id,
  cast(d.created_at AS string) AS createdAt,
  date_format(d.created_at, 'yyyy-MM-dd') AS createdDate,
  cast(NULL AS string) AS availableFrom,
  cast(NULL AS string) AS availableTill,
  CASE WHEN ${placed} THEN cast(coalesce(d.vehicle_placed_ft_timestamp, d.created_at) AS string) ELSE NULL END AS convertedAt,
  CASE
    WHEN ${called} THEN cast(coalesce(ds.updated_at, d.created_at) AS string)
    ELSE NULL
  END AS firstActionAt,
  CASE
    WHEN ${called} AND ds.updated_at IS NOT NULL AND ds.updated_at >= d.created_at
      THEN ${hoursBetween('d.created_at', 'ds.updated_at')}
    WHEN ${called} THEN 0
    ELSE NULL
  END AS touchHours,
  CASE
    WHEN ${placed} THEN ${hoursBetween('d.created_at', 'coalesce(d.vehicle_placed_ft_timestamp, d.created_at)')}
    ELSE NULL
  END AS ttcHours,
  d.origin AS originCity,
  cast(NULL AS string) AS originState,
  d.destination AS destinationCity,
  cast(NULL AS string) AS destinationState,
  concat(
    coalesce(d.origin, 'Unknown'),
    ' → ',
    coalesce(d.destination, 'Unknown')
  ) AS lane,
  concat(
    coalesce(d.origin_super_cluster_name, 'Unknown'),
    ' → ',
    coalesce(d.destination_super_cluster_name, 'Unknown')
  ) AS superClusterLane,
  ${zone.zoneSqlFromSuperCluster(clusters, 'd.origin_super_cluster_name')} AS region,
  cast(NULL AS string) AS branch,
  coalesce(ds.supplier_company_name, d.lsp) AS lsp,
  d.psa AS psa,
  d.truck_type AS vehicleType,
  cast(NULL AS double) AS capacityTons,
  1 AS quantity,
  cast(ds.rate_received AS double) AS askingPrice,
  CASE
    WHEN ${placed} THEN 'PLACED'
    WHEN ${boolTrue('ds.is_vehicle_available')} THEN 'VEHICLE_AVAILABLE'
    WHEN ${called} THEN 'CALLED'
    ELSE 'MATCHED'
  END AS stage,
  ds.demand_id AS matchedDemandId,
  cast(ds.demand_id AS string) AS demandId,
  upper(trim(coalesce(d.status, ''))) AS demandStatus,
  upper(trim(coalesce(d.status, ''))) AS status,
  CASE WHEN ${placed} THEN true ELSE false END AS isConverted,
  CASE
    WHEN ${placed} THEN NULL
    ELSE coalesce(
      nullif(trim(ds.call_notes), ''),
      nullif(trim(ds.call_answer), ''),
      nullif(trim(d.status), ''),
      'Not captured'
    )
  END AS nonConversionReason,
  CASE
    WHEN upper(trim(coalesce(ds.inventory_lane_origin_match_type, ''))) = 'LANE' THEN 'Exact'
    WHEN upper(trim(coalesce(ds.inventory_lane_origin_match_type, ''))) = 'ORIGIN' THEN 'Origin'
    ELSE coalesce(nullif(trim(ds.inventory_lane_origin_match_type), ''), 'Unknown')
  END AS matchType,
  ${boolTrue('ds.is_called')} OR ds.call_source_ds_id IS NOT NULL AS isCalled,
  CASE
    WHEN ${boolTrue('ds.is_called')} AND ds.call_source_ds_id IS NULL THEN 'Direct'
    WHEN ds.call_source_ds_id IS NOT NULL THEN 'Indirect'
    ELSE 'Not Called'
  END AS callType,
  ${boolTrue('ds.is_vehicle_available')} AS isVehicleAvailable,
  ${boolTrue('ds.is_placement_available')} AS isPlacementAvailable,
  cast(ds.inventory_id AS string) AS inventoryId,
  ds.call_notes AS callNotes,
  CASE
    WHEN d.is_liquid_lane IS NULL THEN NULL
    WHEN lower(trim(cast(d.is_liquid_lane AS string))) IN ('true', '1', 't', 'yes', 'y')
      THEN 'Power lane'
    ELSE 'Non power lane'
  END AS laneType,
  d.origin_super_cluster_name AS originSuperCluster,
  d.destination_super_cluster_name AS destinationSuperCluster
FROM ${ds} ds
INNER JOIN ${demand} d
  ON d.id = ds.demand_id
WHERE upper(trim(coalesce(ds.matched_by, ''))) = 'INVENTORY'
  AND d.origin_super_cluster_name IS NOT NULL
  AND d.created_at IS NOT NULL
  AND to_date(d.created_at) >= to_date(:p0)
  AND to_date(d.created_at) <= to_date(:p1)
ORDER BY d.created_at DESC, ds.id DESC
LIMIT ${limit}`;
}

// FO App bids: TLMS BID + FO_APP → demand_supply (reference_id) → demand.
// Shape matches inventory rows so engine aging / reasons / summary reuse.
function bidsQuery(from, to, limit) {
  const s = S.getSchema();
  const q = (...parts) => parts.filter(Boolean).map(p => '`' + p + '`').join('.');
  const mb = q(s.catalog, s.schema, 'phase2poc_trip_location_mapping_static');
  const ds = q(s.catalog, s.schema, 'phase2poc_demand_supply');
  const demand = q(s.catalog, s.schema, 'phase2poc_demand');
  const clusters = q(s.catalog, s.schema, 'phase2poc_ftn_clusters');
  const bidTs = 'coalesce(ds.bid_placed_at, mb.created_at)';

  return `SELECT
  cast(mb.id AS string) AS id,
  cast(${bidTs} AS string) AS createdAt,
  date_format(${bidTs}, 'yyyy-MM-dd') AS createdDate,
  cast(NULL AS string) AS availableFrom,
  cast(NULL AS string) AS availableTill,
  CASE
    WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT'
      THEN cast(coalesce(d.vehicle_placed_ft_timestamp, ${bidTs}) AS string)
    ELSE NULL
  END AS convertedAt,
  CASE
    WHEN ds.accepted_at IS NOT NULL AND ds.accepted_at >= ${bidTs}
      THEN cast(ds.accepted_at AS string)
    WHEN lower(trim(coalesce(ds.is_called, ''))) IN ('true', '1', 'yes', 'y')
     AND ds.updated_at IS NOT NULL AND ds.updated_at >= ${bidTs}
      THEN cast(ds.updated_at AS string)
    ELSE NULL
  END AS firstActionAt,
  CASE
    WHEN ds.accepted_at IS NOT NULL AND ds.accepted_at >= ${bidTs}
      THEN ${hoursBetween(bidTs, 'ds.accepted_at')}
    WHEN lower(trim(coalesce(ds.is_called, ''))) IN ('true', '1', 'yes', 'y')
     AND ds.updated_at IS NOT NULL AND ds.updated_at >= ${bidTs}
      THEN ${hoursBetween(bidTs, 'ds.updated_at')}
    ELSE NULL
  END AS touchHours,
  CASE
    WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT'
      THEN ${hoursBetween(bidTs, 'coalesce(d.vehicle_placed_ft_timestamp, ' + bidTs + ')')}
    ELSE NULL
  END AS ttcHours,
  coalesce(d.origin, mb.origin) AS originCity,
  cast(NULL AS string) AS originState,
  coalesce(d.destination, mb.destination) AS destinationCity,
  cast(NULL AS string) AS destinationState,
  concat(
    coalesce(d.origin, mb.origin, 'Unknown'),
    ' → ',
    coalesce(d.destination, mb.destination, 'Unknown')
  ) AS lane,
  concat(
    coalesce(d.origin_super_cluster_name, 'Unknown'),
    ' → ',
    coalesce(d.destination_super_cluster_name, 'Unknown')
  ) AS superClusterLane,
  ${zone.zoneSqlFromSuperCluster(clusters, 'd.origin_super_cluster_name')} AS region,
  cast(NULL AS string) AS branch,
  mb.fo_name AS lsp,
  d.psa AS psa,
  coalesce(d.truck_type, mb.truck_type) AS vehicleType,
  cast(NULL AS double) AS capacityTons,
  1 AS quantity,
  cast(ds.rate_received AS double) AS askingPrice,
  CASE
    WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT' THEN 'CONVERTED'
    WHEN ds.accepted_at IS NOT NULL THEN 'QUOTED'
    WHEN lower(trim(coalesce(ds.is_called, ''))) IN ('true', '1', 'yes', 'y') THEN 'CALLED'
    ELSE 'POSTED'
  END AS stage,
  ds.demand_id AS matchedDemandId,
  CASE
    WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT' THEN 'CONVERTED'
    WHEN ds.accepted_at IS NOT NULL THEN 'QUOTED'
    WHEN lower(trim(coalesce(ds.is_called, ''))) IN ('true', '1', 'yes', 'y') THEN 'CALLED'
    ELSE 'POSTED'
  END AS status,
  CASE WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT' THEN true ELSE false END AS isConverted,
  CASE
    WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT' THEN NULL
    ELSE coalesce(
      nullif(trim(ds.acceptance_comment), ''),
      nullif(trim(ds.comment), ''),
      nullif(trim(d.cancellation_reason), ''),
      nullif(trim(ds.call_answer), ''),
      nullif(trim(d.status), ''),
      'Not captured'
    )
  END AS nonConversionReason,
  CASE
    WHEN d.is_liquid_lane IS NULL THEN NULL
    WHEN lower(trim(cast(d.is_liquid_lane AS string))) IN ('true', '1', 't', 'yes', 'y')
      THEN 'Power lane'
    ELSE 'Non power lane'
  END AS laneType,
  d.origin_super_cluster_name AS originSuperCluster,
  d.destination_super_cluster_name AS destinationSuperCluster
FROM ${mb} mb
INNER JOIN ${ds} ds
  ON ds.id = mb.reference_id
LEFT JOIN ${demand} d
  ON d.id = ds.demand_id
WHERE mb.created_at IS NOT NULL
  AND to_date(mb.created_at) >= to_date(:p0)
  AND to_date(mb.created_at) <= to_date(:p1)
  AND upper(trim(coalesce(mb.entry_type, ''))) = 'BID'
  AND upper(trim(coalesce(mb.inventory_type, ''))) = 'FO_APP'
ORDER BY ${bidTs} DESC
LIMIT ${limit}`;
}

// Databricks returns booleans as strings over the JSON_ARRAY wire format, and
// the engine compares them with `if (r.isFulfilled)`. Normalise once, here,
// rather than making every metric defensive.
function asBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function normalise(rows, okField) {
  for (const r of rows) {
    r[okField] = asBool(r[okField]);
    if (r.isCalled != null) r.isCalled = asBool(r.isCalled);
    if (r.isVehicleAvailable != null) r.isVehicleAvailable = asBool(r.isVehicleAvailable);
    if (r.isPlacementAvailable != null) r.isPlacementAvailable = asBool(r.isPlacementAvailable);
    if (!r.lane) r.lane = 'Unknown';
    if (!r.superClusterLane) {
      r.superClusterLane = `${r.originSuperCluster || 'Unknown'} → ${r.destinationSuperCluster || 'Unknown'}`;
    }
    // Canonical zone (North/South/East/West/Central) via liquid-lane / SC map.
    r.region = zone.resolveZone(r);
    if (!r.createdDate && typeof r.createdAt === 'string') r.createdDate = r.createdAt.slice(0, 10);
    if (r.demandId == null && r.matchedDemandId != null) r.demandId = String(r.matchedDemandId);
    // Clamp impossible negative latencies (joined demand activity before post).
    if (r.touchHours != null && Number(r.touchHours) < 0) {
      r.touchHours = null;
      r.firstActionAt = null;
    }
    if (r.ttcHours != null && Number(r.ttcHours) < 0) r.ttcHours = 0;
    if (r.ttfHours != null && Number(r.ttfHours) < 0) r.ttfHours = 0;
  }
  return rows;
}

function windowFor(days) {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to.getTime() - (Math.max(1, days) - 1) * 86400000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// Runs both pulls, stores the snapshot, returns the metadata.
async function runSync(opts = {}) {
  if (!db.isConfigured()) {
    throw new Error('DATABRICKS_TOKEN is not configured — there is nothing to sync from.');
  }

  const days = Math.min(Math.max(Number(opts.days) || DEFAULT_DAYS, 1), 1095);
  const limit = Math.min(Math.max(Number(opts.maxRows) || MAX_ROWS, 1000), 1_000_000);
  const window = windowFor(days);
  const startedAt = Date.now();

  const params = [
    { name: 'p0', value: window.from, type: 'STRING' },
    { name: 'p1', value: window.to, type: 'STRING' }
  ];

  // Demand + inventory-match (Metabase 1190) + FO App bids. Inventory is demand_supply
  // matched_by=INVENTORY — keep demand if that join fails.
  const demand = await db.query(demandQuery(window.from, window.to, limit), params, { rowLimit: limit });
  let inventory = { rows: [] };
  let inventoryError = null;
  try {
    inventory = await db.query(inventoryQuery(window.from, window.to, limit), params, { rowLimit: limit });
  } catch (e) {
    inventoryError = e.message || String(e);
  }
  let bids = { rows: [] };
  let bidsError = null;
  try {
    bids = await db.query(bidsQuery(window.from, window.to, limit), params, { rowLimit: limit });
  } catch (e) {
    bidsError = e.message || String(e);
  }

  const dataset = {
    demand: normalise(demand.rows, 'isFulfilled'),
    inventory: normalise(inventory.rows, 'isConverted'),
    bids: normalise(bids.rows, 'isConverted'),
    // Metabase 1190 inventory-match funnel (Exact / Origin share these stages).
    funnelStages: S.getSchema().inventory.funnelStages || [
      'MATCHED', 'CALLED', 'VEHICLE_AVAILABLE', 'PLACED'
    ]
  };

  // ORDER BY created DESC means a truncated pull keeps the most recent rows, so
  // the window it actually covers is shorter than the one requested. Say so
  // rather than letting the dashboard imply full coverage.
  const earliest = arr => arr.reduce((m, r) => (!m || r.createdDate < m ? r.createdDate : m), null);
  const truncated = {
    demand: dataset.demand.length >= limit,
    inventory: dataset.inventory.length >= limit,
    bids: dataset.bids.length >= limit
  };

  const meta = await store.writeSnapshot(dataset, {
    window,
    requestedDays: days,
    rowLimit: limit,
    rows: {
      demand: dataset.demand.length,
      inventory: dataset.inventory.length,
      bids: dataset.bids.length
    },
    covers: {
      demandFrom: earliest(dataset.demand),
      inventoryFrom: earliest(dataset.inventory),
      bidsFrom: earliest(dataset.bids)
    },
    truncated: truncated.demand || truncated.inventory || truncated.bids ? truncated : null,
    inventoryError: inventoryError || undefined,
    bidsError: bidsError || undefined,
    queryMs: Date.now() - startedAt,
    statements: 1 + (inventoryError ? 0 : 1) + (bidsError ? 0 : 1)
  });

  return meta;
}

module.exports = { runSync, windowFor, DEFAULT_DAYS, MAX_ROWS };
