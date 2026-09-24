-- ============================================================================
-- Reconcile Metabase 1042 card 6280 ("WOW inventory Utilisation") vs the app
-- Inventory tab for 2026-08-24 → 2026-09-21 (Monday ISO weeks).
--
-- Run in Databricks against elh_prod.ftverse.
--
-- VERDICT (verified 2026-09-21):
--   They are DIFFERENT TABLES / GRAINS — do not expect the totals to match.
--
--   Metabase  → phase2poc_trip_location_mapping_static
--               FO inventory + CRM/FO_APP bids, FO-name 5-min session dedupe
--               ~6,255 unique / ~6,539 raw  |  vehicle_placed always 'false'
--
--   App       → phase2poc_supplier_inventory (+ demand via source_demand_ids)
--               marketplace supplier postings only (no FO_APP/CRM bids)
--               ~2,926 postings               |  ~1,609 FT-converted
--
--   Overlap:  reference_id on TLMS → demand_supply.id (bids), NOT supplier_inventory.id
--             (0 rows join TLMS.reference_id = si.id)
--   PSA INNER JOIN is NOT the cause of the 6.5k → 2.9k gap.
-- ============================================================================

WITH params AS (
  SELECT
    date('2026-08-24') AS from_d,   -- Monday (ISO week start); use 2026-08-23 if matching the app UI
    date('2026-09-21') AS to_d
),

-- ---------------------------------------------------------------------------
-- Metabase side (card 6280 logic, Spark-SQL port)
-- ---------------------------------------------------------------------------
mb_base AS (
  SELECT
    id,
    lower(trim(fo_name)) AS fo_key,
    fo_company_id,
    fo_name,
    lower(trim(coalesce(inventory_type, ''))) AS inventory_type,
    upper(trim(coalesce(entry_type, ''))) AS entry_type,
    grade,
    -- vehicle_placed is STRING in Databricks ('true'/'false'), not boolean
    lower(trim(coalesce(vehicle_placed, ''))) IN ('true', '1', 't', 'yes', 'y') AS vehicle_placed,
    reference_id,
    cast(created_at AS timestamp) AS created_ts
  FROM elh_prod.ftverse.phase2poc_trip_location_mapping_static
  CROSS JOIN params p
  WHERE created_at IS NOT NULL
    AND to_date(created_at) BETWEEN p.from_d AND p.to_d
),

mb_ordered AS (
  SELECT
    *,
    lag(created_ts) OVER (
      PARTITION BY fo_key
      ORDER BY created_ts, id
    ) AS prev_ts
  FROM mb_base
),

mb_grouped AS (
  SELECT
    *,
    sum(
      CASE
        WHEN prev_ts IS NULL THEN 1
        WHEN (unix_timestamp(created_ts) - unix_timestamp(prev_ts)) > 300 THEN 1
        ELSE 0
      END
    ) OVER (
      PARTITION BY fo_key
      ORDER BY created_ts, id
    ) AS unique_seq
  FROM mb_ordered
),

mb_unique AS (
  SELECT
    date(date_trunc('WEEK', created_ts)) AS week_start,
    fo_key,
    unique_seq,
    max(entry_type) AS entry_type,          -- representative; groups can mix
    max(grade) AS grade,
    max(CASE WHEN vehicle_placed THEN 1 ELSE 0 END) = 1 AS vehicle_placed,
    min(inventory_type) AS inventory_type   -- same alphabetical bias as Metabase
  FROM mb_grouped
  GROUP BY 1, 2, 3
),

mb_weekly AS (
  SELECT
    week_start,
    count(*) AS mb_unique_inventory,
    sum(CASE WHEN vehicle_placed THEN 1 ELSE 0 END) AS mb_placed_flag,
    sum(CASE WHEN entry_type = 'BID' THEN 1 ELSE 0 END) AS mb_unique_bids,
    sum(CASE WHEN entry_type = 'INVENTORY' THEN 1 ELSE 0 END) AS mb_unique_inventory_only
  FROM mb_unique
  GROUP BY week_start
),

-- ---------------------------------------------------------------------------
-- App side (supplier_inventory + FT placement via source_demand_ids)
-- ---------------------------------------------------------------------------
app_link AS (
  SELECT
    inventory_id,
    demand_status
  FROM (
    SELECT
      e.inventory_id,
      d.status AS demand_status,
      row_number() OVER (
        PARTITION BY e.inventory_id
        ORDER BY
          CASE WHEN upper(trim(coalesce(d.status, ''))) = 'VEHICLE_PLACED_BY_FT' THEN 0 ELSE 1 END,
          coalesce(d.vehicle_placed_ft_timestamp, d.updated_at, d.created_at) DESC NULLS LAST
      ) AS rn
    FROM (
      SELECT
        inv.id AS inventory_id,
        cast(trim(x) AS bigint) AS demand_id
      FROM elh_prod.ftverse.phase2poc_supplier_inventory inv
      LATERAL VIEW explode(
        split(regexp_replace(coalesce(inv.source_demand_ids, ''), '[{}]', ''), ',')
      ) t AS x
      WHERE trim(x) RLIKE '^[0-9]+$'
    ) e
    LEFT JOIN elh_prod.ftverse.phase2poc_demand d
      ON d.id = e.demand_id
  )
  WHERE rn = 1
),

app_base AS (
  SELECT
    si.id,
    date(date_trunc('WEEK', si.created_at)) AS week_start,
    upper(trim(coalesce(link.demand_status, ''))) = 'VEHICLE_PLACED_BY_FT' AS is_converted
  FROM elh_prod.ftverse.phase2poc_supplier_inventory si
  CROSS JOIN params p
  LEFT JOIN app_link link
    ON link.inventory_id = si.id
  WHERE to_date(si.created_at) BETWEEN p.from_d AND p.to_d
),

app_weekly AS (
  SELECT
    week_start,
    count(*) AS app_postings,
    sum(CASE WHEN is_converted THEN 1 ELSE 0 END) AS app_converted
  FROM app_base
  GROUP BY week_start
),

-- ---------------------------------------------------------------------------
-- Overlap probes (prove the tables are not the same universe)
-- ---------------------------------------------------------------------------
overlap AS (
  SELECT
    count(*) AS mb_rows,
    sum(CASE WHEN mb.reference_id IS NOT NULL THEN 1 ELSE 0 END) AS mb_with_reference_id,
    sum(CASE WHEN si.id IS NOT NULL THEN 1 ELSE 0 END) AS mb_ref_joins_supplier_inventory,
    sum(CASE WHEN ds.id IS NOT NULL THEN 1 ELSE 0 END) AS mb_ref_joins_demand_supply
  FROM mb_base mb
  LEFT JOIN elh_prod.ftverse.phase2poc_supplier_inventory si
    ON si.id = mb.reference_id
  LEFT JOIN elh_prod.ftverse.phase2poc_demand_supply ds
    ON ds.id = mb.reference_id
)

-- Weekly side-by-side (primary output)
SELECT
  'weekly' AS section,
  cast(coalesce(m.week_start, a.week_start) AS string) AS key,
  m.mb_unique_inventory,
  m.mb_unique_bids,
  m.mb_unique_inventory_only,
  m.mb_placed_flag,
  a.app_postings,
  a.app_converted,
  cast(NULL AS bigint) AS mb_rows,
  cast(NULL AS bigint) AS mb_ref_joins_supplier_inventory,
  cast(NULL AS bigint) AS mb_ref_joins_demand_supply
FROM mb_weekly m
FULL OUTER JOIN app_weekly a
  ON m.week_start = a.week_start

UNION ALL

-- Window totals
SELECT
  'totals',
  'ALL',
  (SELECT count(*) FROM mb_unique),
  (SELECT sum(CASE WHEN entry_type = 'BID' THEN 1 ELSE 0 END) FROM mb_unique),
  (SELECT sum(CASE WHEN entry_type = 'INVENTORY' THEN 1 ELSE 0 END) FROM mb_unique),
  (SELECT sum(CASE WHEN vehicle_placed THEN 1 ELSE 0 END) FROM mb_unique),
  (SELECT count(*) FROM app_base),
  (SELECT sum(CASE WHEN is_converted THEN 1 ELSE 0 END) FROM app_base),
  NULL, NULL, NULL

UNION ALL

-- Join overlap
SELECT
  'overlap',
  'reference_id',
  NULL, NULL, NULL, NULL, NULL, NULL,
  o.mb_rows,
  o.mb_ref_joins_supplier_inventory,
  o.mb_ref_joins_demand_supply
FROM overlap o

ORDER BY 1, 2;
