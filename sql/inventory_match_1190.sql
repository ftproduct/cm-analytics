-- Metabase dashboard 1190 — Inventory match funnel (cards 7584 / 7578 / 7579 / 7580)
-- Grain: demand_supply where matched_by = 'INVENTORY'
-- App sync: api/_sync.js inventoryQuery() — keep logic aligned with this file.
--
-- Filters (same as dashboard):
--   Date Range  → demand.created_at
--   City        → demand.origin_super_cluster_name
--   Power Lane  → demand.is_liquid_lane

WITH demand_level AS (
  SELECT
    d.id AS demand_id,
    MAX(CASE WHEN ds.inventory_lane_origin_match_type = 'Lane' THEN 1 ELSE 0 END) AS has_exact_match,
    MAX(CASE WHEN ds.inventory_lane_origin_match_type = 'Origin' THEN 1 ELSE 0 END) AS has_origin_match,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Lane' THEN 1 ELSE 0 END) AS exact_inventory_matches,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Origin' THEN 1 ELSE 0 END) AS origin_inventory_matches,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Lane'
               AND (lower(trim(cast(ds.is_called AS string))) IN ('true','1','t','yes','y')
                    OR ds.call_source_ds_id IS NOT NULL) THEN 1 ELSE 0 END) AS exact_called_total,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Lane'
               AND lower(trim(cast(ds.is_vehicle_available AS string))) IN ('true','1','t','yes','y')
               THEN 1 ELSE 0 END) AS exact_vehicle_available,
    MAX(CASE WHEN ds.inventory_lane_origin_match_type = 'Lane'
               AND lower(trim(cast(ds.is_placement_available AS string))) IN ('true','1','t','yes','y')
               AND upper(trim(d.status)) = 'VEHICLE_PLACED_BY_FT' THEN 1 ELSE 0 END) AS demand_placed_exact,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Origin'
               AND (lower(trim(cast(ds.is_called AS string))) IN ('true','1','t','yes','y')
                    OR ds.call_source_ds_id IS NOT NULL) THEN 1 ELSE 0 END) AS origin_called_total,
    SUM(CASE WHEN ds.inventory_lane_origin_match_type = 'Origin'
               AND lower(trim(cast(ds.is_vehicle_available AS string))) IN ('true','1','t','yes','y')
               THEN 1 ELSE 0 END) AS origin_vehicle_available,
    MAX(CASE WHEN ds.inventory_lane_origin_match_type = 'Origin'
               AND lower(trim(cast(ds.is_placement_available AS string))) IN ('true','1','t','yes','y')
               AND upper(trim(d.status)) = 'VEHICLE_PLACED_BY_FT' THEN 1 ELSE 0 END) AS demand_placed_origin
  FROM elh_prod.ftverse.phase2poc_demand d
  INNER JOIN elh_prod.ftverse.phase2poc_demand_supply ds
    ON ds.demand_id = d.id
   AND upper(trim(coalesce(ds.matched_by, ''))) = 'INVENTORY'
  WHERE d.origin_super_cluster_name IS NOT NULL
    AND to_date(d.created_at) >= date('2026-09-01')
    AND to_date(d.created_at) <= date('2026-09-23')
  GROUP BY d.id
)
SELECT
  COUNT(*) AS demand_matched_with_inventory,
  SUM(has_exact_match) AS demand_exact,
  SUM(has_origin_match) AS demand_origin,
  SUM(exact_inventory_matches) AS exact_inventory_matches,
  SUM(origin_inventory_matches) AS origin_inventory_matches,
  SUM(exact_called_total) AS exact_called,
  SUM(exact_vehicle_available) AS exact_vehicle_available,
  SUM(demand_placed_exact) AS demand_placed_exact,
  SUM(origin_called_total) AS origin_called,
  SUM(origin_vehicle_available) AS origin_vehicle_available,
  SUM(demand_placed_origin) AS demand_placed_origin
FROM demand_level;
