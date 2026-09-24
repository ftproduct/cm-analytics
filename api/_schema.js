// /api/_schema.js
// Loads the logical -> physical column mapping and turns it into safe SQL
// fragments. Nothing from the client ever reaches this file as an identifier:
// callers pass LOGICAL names ("lane", "psa"), we look them up in the config and
// emit a backtick-quoted physical identifier. Values always travel as bound
// parameters, never string-interpolated.

const fs = require('fs');
const path = require('path');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

let cached = null;

function loadRaw() {
  // Runtime override wins so the mapping can be changed without a redeploy.
  const inline = process.env.MA_SCHEMA_JSON;
  if (inline && inline.trim()) return JSON.parse(inline);
  const file = path.join(__dirname, '..', 'config', 'schema.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getSchema() {
  if (cached) return cached;
  const raw = loadRaw();
  // Reject anything that is not a plain identifier before it can reach SQL.
  for (const entity of ['demand', 'inventory']) {
    const e = raw[entity];
    if (!e) throw new Error(`schema.json missing "${entity}" section`);
    if (!IDENT.test(e.table)) throw new Error(`Unsafe table name for ${entity}: ${e.table}`);
    for (const [logical, physical] of Object.entries(e.columns || {})) {
      if (physical === null || physical === undefined || physical === '') continue;
      if (!IDENT.test(physical)) {
        throw new Error(`Unsafe column mapping ${entity}.${logical} -> ${physical}`);
      }
    }
  }
  for (const k of ['catalog', 'schema']) {
    if (raw[k] && !IDENT.test(raw[k])) throw new Error(`Unsafe ${k}: ${raw[k]}`);
  }
  cached = raw;
  return cached;
}

function quote(ident) {
  // Already validated by getSchema(); split dotted paths so each part is quoted.
  return ident.split('.').map(p => '`' + p + '`').join('.');
}

// Fully-qualified, backtick-quoted table reference for an entity.
// `table` may already be catalog.schema.table (or schema.table) when the two
// facts live in different homes — do not re-prefix in that case.
function tableRef(entity) {
  const s = getSchema();
  const segments = String(s[entity].table).split('.');
  let parts;
  if (segments.length >= 3) {
    parts = segments;
  } else if (segments.length === 2) {
    parts = s.catalog ? [s.catalog, ...segments] : segments;
  } else {
    parts = [];
    if (s.catalog) parts.push(s.catalog);
    if (s.schema) parts.push(s.schema);
    parts.push(segments[0]);
  }
  return parts.map(p => '`' + p + '`').join('.');
}

function qualifiedName(...segments) {
  const s = getSchema();
  const parts = [];
  if (s.catalog) parts.push(s.catalog);
  if (s.schema) parts.push(s.schema);
  for (const seg of segments) parts.push(seg);
  return parts.map(p => '`' + p + '`').join('.');
}

// Inventory fact assembled at query time (no warehouse view required).
// Same shape as sql/vw_marketplace_inventory.sql — keep them in sync.
//
// Exact Metabase dashboard 1042 / card 6280 parity:
//   source  = phase2poc_trip_location_mapping_static
//   grain   = unique FO inventory (lower(trim(fo_name)) + 5-minute session gap)
//   placed  = vehicle_placed flag on the static table (often stale → 0 util)
function inventoryJoinedSubquery() {
  const tlms = qualifiedName('phase2poc_trip_location_mapping_static');

  return `SELECT
  cast(min(g.id) AS string) AS id,
  min(g.created_ts) AS created_at,
  cast(NULL AS timestamp) AS available_from,
  cast(NULL AS timestamp) AS available_till,
  CASE
    WHEN max(CASE WHEN g.vehicle_placed THEN 1 ELSE 0 END) = 1
      THEN min(g.created_ts)
    ELSE NULL
  END AS converted_at,
  cast(NULL AS timestamp) AS first_action_at,
  max(g.origin) AS origin,
  max(g.destination) AS destination,
  max(g.fo_name) AS lsp,
  max(g.updated_by) AS psa,
  max(g.truck_type) AS vehicle_type,
  CASE
    WHEN max(CASE WHEN g.vehicle_placed THEN 1 ELSE 0 END) = 1 THEN 'CONVERTED'
    ELSE 'POSTED'
  END AS status,
  CASE
    WHEN max(CASE WHEN g.vehicle_placed THEN 1 ELSE 0 END) = 1 THEN 'CONVERTED'
    ELSE 'POSTED'
  END AS funnel_stage,
  cast(NULL AS string) AS non_conversion_reason,
  cast(NULL AS bigint) AS matched_demand_id,
  1 AS quantity,
  cast(NULL AS double) AS asking_price
FROM (
  SELECT
    b.id,
    b.origin,
    b.destination,
    b.fo_name,
    b.truck_type,
    b.updated_by,
    b.created_ts,
    b.fo_key,
    b.vehicle_placed,
    sum(
      CASE
        WHEN b.prev_ts IS NULL THEN 1
        WHEN (unix_timestamp(b.created_ts) - unix_timestamp(b.prev_ts)) > 300 THEN 1
        ELSE 0
      END
    ) OVER (
      PARTITION BY b.fo_key
      ORDER BY b.created_ts, b.id
    ) AS unique_seq
  FROM (
    SELECT
      id,
      origin,
      destination,
      fo_name,
      truck_type,
      updated_by,
      cast(created_at AS timestamp) AS created_ts,
      lower(trim(fo_name)) AS fo_key,
      lower(trim(coalesce(vehicle_placed, ''))) IN ('true', '1', 't', 'yes', 'y') AS vehicle_placed,
      lag(cast(created_at AS timestamp)) OVER (
        PARTITION BY lower(trim(fo_name))
        ORDER BY cast(created_at AS timestamp), id
      ) AS prev_ts
    FROM ${tlms}
    WHERE created_at IS NOT NULL
  ) b
) g
GROUP BY g.fo_key, g.unique_seq`;
}

// FROM clause for an entity. Inventory can be a joined subquery when
// schema.inventory.joined is true (avoids needing CREATE VIEW).
function fromRef(entity) {
  const s = getSchema();
  if (entity === 'inventory' && s.inventory.joined) {
    return `(${inventoryJoinedSubquery()})`;
  }
  return tableRef(entity);
}

// Physical column for a logical name, or null when unmapped.
function col(entity, logical) {
  const s = getSchema();
  const physical = s[entity]?.columns?.[logical];
  if (!physical) return null;
  return quote(physical);
}

// Same, but throws -- for columns the query cannot run without.
function reqCol(entity, logical) {
  const c = col(entity, logical);
  if (!c) throw new Error(`Column "${logical}" is not mapped for ${entity} in config/schema.json`);
  return c;
}

function has(entity, logical) {
  return col(entity, logical) !== null;
}

// Lane = "Origin -> Destination". Built from city columns, falling back to state.
function laneExpr(entity) {
  const o = col(entity, 'originCity') || col(entity, 'originState');
  const d = col(entity, 'destinationCity') || col(entity, 'destinationState');
  if (!o || !d) return null;
  return `concat(coalesce(${o}, 'Unknown'), ' → ', coalesce(${d}, 'Unknown'))`;
}

// Supercluster lane = origin supercluster → destination supercluster.
function superClusterLaneExpr(entity) {
  const o = col(entity, 'originSuperCluster');
  const d = col(entity, 'destinationSuperCluster');
  if (!o || !d) return null;
  return `concat(coalesce(${o}, 'Unknown'), ' → ', coalesce(${d}, 'Unknown'))`;
}

// Why demand went unfilled: prefer a free-text / cancel code when present.
// cancellation_reason is blank on ~98% of misses, so fall back to status
// (LAPSED, VEHICLE_NOT_AVAILABLE, rate mismatch, …) which is always set.
function unfulfilmentReasonExpr() {
  const reason = col('demand', 'unfulfilmentReason');
  const status = col('demand', 'status');
  if (reason && status) {
    return `coalesce(nullif(trim(cast(${reason} AS string)), ''), nullif(trim(cast(${status} AS string)), ''), 'Not captured')`;
  }
  if (reason) return `coalesce(nullif(trim(cast(${reason} AS string)), ''), 'Not captured')`;
  if (status) return `coalesce(nullif(trim(cast(${status} AS string)), ''), 'Not captured')`;
  return null;
}

function statusListSql(values) {
  return (values || []).map(v => `'${String(v).replace(/'/g, "''")}'`);
}

// Boolean expression for "this demand was fulfilled".
// Prefer an explicit status allow-list when present (so statuses like
// VEHICLE_PLACED_BY_EXTERNAL can be excluded even if a timestamp is set).
// Fall back to fulfilledAt IS NOT NULL when there is no status list.
function isFulfilledExpr() {
  const s = getSchema();
  const at = col('demand', 'fulfilledAt');
  const status = col('demand', 'status');
  const list = statusListSql(s.demand.fulfilledStatuses);
  if (status && list.length) return `upper(trim(${status})) IN (${list.join(', ')})`;
  if (at) return `${at} IS NOT NULL`;
  throw new Error('Cannot determine fulfilment: map demand.fulfilledAt or demand.status');
}

// Rows whose status is in excludeStatuses are out of scope for marketplace
// metrics (e.g. VEHICLE_PLACED_BY_EXTERNAL — fulfilled outside, not by FT).
// Returns null when there is nothing to exclude.
function excludeStatusesExpr(entity) {
  const s = getSchema();
  const list = statusListSql(s[entity]?.excludeStatuses);
  if (!list.length) return null;
  const status = col(entity, 'status');
  if (!status) return null;
  return `upper(trim(${status})) NOT IN (${list.join(', ')})`;
}

// Boolean expression for "this inventory converted".
function isConvertedExpr() {
  const s = getSchema();
  const at = col('inventory', 'convertedAt');
  const matched = col('inventory', 'matchedDemandId');
  const status = col('inventory', 'status');
  const list = (s.inventory.convertedStatuses || []).map(v => `'${String(v).replace(/'/g, "''")}'`);
  const clauses = [];
  if (at) clauses.push(`${at} IS NOT NULL`);
  if (status && list.length) clauses.push(`upper(trim(${status})) IN (${list.join(', ')})`);
  if (!clauses.length && matched) clauses.push(`${matched} IS NOT NULL`);
  if (!clauses.length) throw new Error('Cannot determine conversion: map inventory.convertedAt or inventory.status');
  return `(${clauses.join(' OR ')})`;
}

// Logical dimensions the UI can group or filter by, per entity.
// `expr` is resolved lazily so an unmapped column simply drops out of the list.
const DIMENSIONS = {
  demand: {
    lane:        { label: 'Lane (cluster)', expr: () => laneExpr('demand') },
    superClusterLane: { label: 'Supercluster lane', expr: () => superClusterLaneExpr('demand') },
    origin:      { label: 'Origin',       expr: () => col('demand', 'originCity') || col('demand', 'originState') },
    destination: { label: 'Destination',  expr: () => col('demand', 'destinationCity') || col('demand', 'destinationState') },
    originState: { label: 'Origin state', expr: () => col('demand', 'originState') },
    lsp:         { label: 'LSP',          expr: () => col('demand', 'lsp') },
    psa:         { label: 'PSA',          expr: () => col('demand', 'psa') },
    shipper:     { label: 'Shipper',      expr: () => col('demand', 'shipper') },
    vehicleType: { label: 'Vehicle type', expr: () => col('demand', 'vehicleType') },
    materialType:{ label: 'Material',     expr: () => col('demand', 'materialType') },
    laneType:    { label: 'Lane type',    expr: () => col('demand', 'laneType') },
    originSuperCluster: { label: 'Origin super cluster', expr: () => col('demand', 'originSuperCluster') },
    destinationSuperCluster: { label: 'Destination super cluster', expr: () => col('demand', 'destinationSuperCluster') },
    region:      { label: 'Zone',         expr: () => col('demand', 'region') || `cast(NULL AS string)` },
    branch:      { label: 'Branch',       expr: () => col('demand', 'branch') },
    status:      { label: 'Status',       expr: () => col('demand', 'status') },
    reason:      { label: 'Unfulfilment reason', expr: () => unfulfilmentReasonExpr() }
  },
  inventory: {
    lane:        { label: 'Lane (cluster)', expr: () => laneExpr('inventory') },
    superClusterLane: { label: 'Supercluster lane', expr: () => superClusterLaneExpr('inventory') },
    origin:      { label: 'Origin',       expr: () => col('inventory', 'originCity') || col('inventory', 'originState') },
    destination: { label: 'Destination',  expr: () => col('inventory', 'destinationCity') || col('inventory', 'destinationState') },
    originState: { label: 'Origin state', expr: () => col('inventory', 'originState') },
    lsp:         { label: 'LSP',          expr: () => col('inventory', 'lsp') },
    psa:         { label: 'PSA',          expr: () => col('inventory', 'psa') },
    vehicleType: { label: 'Vehicle type', expr: () => col('inventory', 'vehicleType') },
    originSuperCluster: { label: 'Origin super cluster', expr: () => col('inventory', 'originSuperCluster') },
    destinationSuperCluster: { label: 'Destination super cluster', expr: () => col('inventory', 'destinationSuperCluster') },
    region:      { label: 'Zone',         expr: () => col('inventory', 'region') || `cast(NULL AS string)` },
    branch:      { label: 'Branch',       expr: () => col('inventory', 'branch') },
    status:      { label: 'Status',       expr: () => col('inventory', 'status') },
    stage:       { label: 'Funnel stage', expr: () => col('inventory', 'stage') },
    reason:      { label: 'Non-conversion reason', expr: () => col('inventory', 'nonConversionReason') }
  }
};

// Dimensions actually available given the current mapping.
function availableDimensions(entity) {
  const out = {};
  for (const [key, def] of Object.entries(DIMENSIONS[entity] || {})) {
    let e = null;
    try { e = def.expr(); } catch { e = null; }
    if (e) out[key] = { key, label: def.label };
  }
  return out;
}

function dimensionExpr(entity, key) {
  const def = DIMENSIONS[entity]?.[key];
  if (!def) throw new Error(`Unknown dimension "${key}" for ${entity}`);
  const e = def.expr();
  if (!e) throw new Error(`Dimension "${key}" is not mapped for ${entity} in config/schema.json`);
  return e;
}

module.exports = {
  getSchema, tableRef, fromRef, col, reqCol, has, quote,
  laneExpr, superClusterLaneExpr, unfulfilmentReasonExpr,
  isFulfilledExpr, isConvertedExpr, excludeStatusesExpr,
  inventoryJoinedSubquery,
  DIMENSIONS, availableDimensions, dimensionExpr
};
