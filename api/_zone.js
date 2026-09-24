// Zone classification for marketplace analytics.
//
// Zones are exactly: North | South | East | West | Central.
// The mapping is keyed by origin supercluster name — the same city names used
// in phase2poc_liquid_lanes.origin (Bombay, Delhi NCR, Bangalore, …).
// Source of truth at sync time is phase2poc_ftn_clusters.super_cluster → zone;
// config/zone_map.json is the checked-in fallback used for demo + older snapshots.

const fs = require('fs');
const path = require('path');

const CANONICAL = new Set(['North', 'South', 'East', 'West', 'Central']);

let cached = null;

function loadMap() {
  if (cached) return cached;
  const file = path.join(__dirname, '..', 'config', 'zone_map.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bySuperCluster = {};
  const lowerIndex = {};
  for (const [k, v] of Object.entries(raw.bySuperCluster || {})) {
    const zone = canonicalZone(v);
    if (!zone) continue;
    bySuperCluster[k] = zone;
    lowerIndex[String(k).toLowerCase()] = zone;
  }
  cached = {
    zones: (raw.zones || [...CANONICAL]).filter(z => CANONICAL.has(z)),
    bySuperCluster,
    lowerIndex
  };
  return cached;
}

function canonicalZone(value) {
  if (value == null || value === '') return null;
  const t = String(value).trim().toLowerCase();
  if (t === 'north') return 'North';
  if (t === 'south') return 'South';
  if (t === 'east') return 'East';
  if (t === 'west') return 'West';
  if (t === 'central') return 'Central';
  return null;
}

// Look up zone from an origin supercluster / liquid-lane city name.
function zoneForSuperCluster(name) {
  if (name == null || name === '') return null;
  const map = loadMap();
  if (map.bySuperCluster[name]) return map.bySuperCluster[name];
  return map.lowerIndex[String(name).toLowerCase()] || null;
}

// Prefer an already-synced region when it is a canonical zone; otherwise map
// from originSuperCluster (liquid-lane city grain).
function resolveZone(row) {
  const fromRegion = canonicalZone(row?.region);
  if (fromRegion) return fromRegion;
  return zoneForSuperCluster(row?.originSuperCluster);
}

// SQL: zone from FTN clusters at supercluster grain (matches liquid-lane cities).
// `superClusterCol` is a backtick-quoted physical column or qualified expression.
function zoneSqlFromSuperCluster(clustersTableRef, superClusterCol) {
  return `(
    SELECT max(initcap(lower(trim(c.zone))))
    FROM ${clustersTableRef} c
    WHERE lower(trim(c.super_cluster)) = lower(trim(${superClusterCol}))
      AND coalesce(c.is_deleted, false) = false
      AND lower(trim(c.zone)) IN ('north', 'south', 'east', 'west', 'central')
  )`;
}

module.exports = {
  CANONICAL,
  loadMap,
  canonicalZone,
  zoneForSuperCluster,
  resolveZone,
  zoneSqlFromSuperCluster
};
