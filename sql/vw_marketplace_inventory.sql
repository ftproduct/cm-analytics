-- Optional warehouse materialisation of the same join the app already runs
-- inline when config/schema.json has inventory.joined = true.
-- Needs CREATE privilege on elh_prod.ftverse. After creating the view, you can
-- set joined to false and point inventory.table at vw_marketplace_inventory.
--
-- Exact Metabase dashboard 1042 / card 6280 ("WOW inventory Utilisation") parity:
--   source  = phase2poc_trip_location_mapping_static
--   grain   = unique FO inventory — lower(trim(fo_name)) + 5-minute session gap
--   placed  = vehicle_placed flag on the static row (STRING 'true'/'false';
--             currently stale for recent weeks → utilisation ≈ 0)
--
-- Keep in sync with api/_schema.js inventoryJoinedSubquery().

CREATE OR REPLACE VIEW elh_prod.ftverse.vw_marketplace_inventory AS
SELECT
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
    FROM elh_prod.ftverse.phase2poc_trip_location_mapping_static
    WHERE created_at IS NOT NULL
  ) b
) g
GROUP BY g.fo_key, g.unique_seq
;
