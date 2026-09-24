# Mapping the app to your Databricks tables

Everything the dashboard needs is declared in [`config/schema.json`](./config/schema.json).
Change only the right-hand values. Set a column to `null` when your warehouse
does not have it — the app hides the panels that need it and lists the gap on the
**Setup** tab rather than failing at query time.

To change the mapping without a redeploy, put the whole JSON document in the
`MA_SCHEMA_JSON` environment variable; it takes precedence over the file.

---

## Finding your table and column names

Signed-in admins can do all of this from the **Setup** tab's SQL console. Outside
the app, run these in a Databricks SQL editor against warehouse
`123f8c6553d1967b`.

```sql
-- 1. Which catalogs and schemas exist
SHOW CATALOGS;
SELECT schema_name FROM <catalog>.information_schema.schemata ORDER BY 1;

-- 2. Tables that look like marketplace facts
SELECT table_schema, table_name
FROM <catalog>.information_schema.tables
WHERE lower(table_name) RLIKE '(demand|indent|load|inventory|supply|vehicle|truck|posting)'
ORDER BY table_schema, table_name;

-- 3. Columns of a candidate table
SELECT column_name, data_type
FROM <catalog>.information_schema.columns
WHERE table_schema = '<schema>' AND table_name = '<table>'
ORDER BY ordinal_position;

-- 4. What the status column actually contains -- this decides
--    fulfilledStatuses / convertedStatuses below
SELECT status, count(*) AS n
FROM <catalog>.<schema>.<table>
GROUP BY status ORDER BY n DESC;

-- 5. Same for the reason columns, to confirm they are populated
SELECT unfulfilment_reason, count(*) AS n
FROM <catalog>.<schema>.<table>
WHERE unfulfilment_reason IS NOT NULL
GROUP BY 1 ORDER BY n DESC LIMIT 30;
```

---

## Demand fields

One row per demand / indent / load posted by a shipper.

| Logical field | Required | What it must contain |
|---|:---:|---|
| `id` | | Demand identifier, shown in the row explorer |
| `createdAt` | **yes** | When the demand was raised. Every date filter and every time series keys off this. |
| `pickupAt` | | Required pickup time |
| `fulfilledAt` | | When it was fulfilled. Drives time-to-fulfil and is the preferred fulfilment signal. |
| `originCity` / `originState` | **yes** | Either one. Lane is built as `origin → destination`. |
| `destinationCity` / `destinationState` | **yes** | Either one |
| `shipper` | | Shipper / customer name |
| `lsp` | | Carrier that fulfilled or was assigned |
| `psa` | | The owner the demand is attributed to |
| `vehicleType` | | Vehicle class requested |
| `materialType` | | Commodity |
| `region` / `branch` | | Roll-up dimensions |
| `status` | **yes*** | Raw lifecycle status |
| `unfulfilmentReason` | | Why it was not served. Without it the reasons panel is hidden — and it is the panel that turns a fill-rate number into an action. |
| `quantity` / `weightTons` | | Vehicle count and tonnage |
| `expectedPrice` | | Indicative rate. Prices "value at risk" on unfilled demand. |
| `bookedPrice` | | Final booked rate |

\* `status` is required **unless** `fulfilledAt` is mapped. Fulfilment is
`status IN (fulfilledStatuses)` when that list is set (preferred), otherwise
`fulfilledAt IS NOT NULL`. Map both when you have both.

```jsonc
"fulfilledStatuses":   ["VEHICLE_PLACED_BY_FT"],
"excludeStatuses":     ["VEHICLE_PLACED_BY_EXTERNAL"],
"unfulfilledStatuses": ["LAPSED", "CANCELLED", "VEHICLE_NOT_AVAILABLE", "..."]
```

**`excludeStatuses`** — out of scope for marketplace metrics. Those rows are
filtered out of sync and live SQL before any rate is computed: they are neither
fulfilled nor unfulfilled. Use this for placements served outside the
marketplace (`VEHICLE_PLACED_BY_EXTERNAL`). Do **not** put them in
`unfulfilledStatuses`.

Statuses are compared as `upper(trim(status))`, so casing and stray whitespace in
the warehouse do not matter. **Run query 4 above and replace these lists with
your real values** — everything on the demand side depends on this one list being
right.

---

## Inventory fields

One row per truck / capacity posting by a carrier.

| Logical field | Required | What it must contain |
|---|:---:|---|
| `id` | | Posting identifier |
| `createdAt` | **yes** | When the capacity was posted |
| `availableFrom` / `availableTill` | | Availability window |
| `convertedAt` | | When it turned into a trip. Drives time-to-convert. |
| `firstActionAt` | | **When a PSA first acted on it.** This one column produces the response-time-versus-conversion panel — the clearest controllable lever on the supply side. Worth deriving from an audit or event table if it is not on the fact table. |
| `originCity` / `originState` | **yes** | Either one |
| `destinationCity` / `destinationState` | **yes** | Either one |
| `lsp` | | Carrier that posted the capacity |
| `psa` | | Owner the posting is attributed to |
| `vehicleType` / `capacityTons` | | Vehicle class and capacity |
| `region` / `branch` | | Roll-up dimensions |
| `status` | **yes*** | Raw lifecycle status |
| `stage` | | Furthest funnel stage reached. Without it the funnel collapses to posted → converted. |
| `nonConversionReason` | | Why it never converted |
| `matchedDemandId` | | Demand it was matched to |
| `askingPrice` | | Quoted rate |

\* Same rule as demand: `status` is required unless `convertedAt` is mapped.

```jsonc
"convertedStatuses":    ["CONVERTED", "TRIP_CREATED", "ASSIGNED", "COMPLETED"],
"nonConvertedStatuses": ["EXPIRED", "WITHDRAWN", "REJECTED", "LAPSED"],
"funnelStages":         ["POSTED", "MATCHED", "QUOTED", "NEGOTIATED", "CONFIRMED", "CONVERTED"]
```

`funnelStages` must be listed **in order, earliest first**. Stages are treated as
cumulative — a posting at `CONFIRMED` is counted at `QUOTED` too — so the funnel
only ever descends. Values are compared as `upper(trim(stage))`.

---

## Rules the mapping must satisfy

- Every value is a plain identifier: letters, digits and underscores, optionally
  dotted (`alias.column`). Anything else is rejected before it can reach SQL.
- `catalog` and `schema` apply to both tables. Fully qualify in `table` if the
  two facts live in different schemas.
- Both tables must be **queryable by the token's principal**. Views work.

---

## Pointing at views instead of raw tables

If the raw tables do not line up with the fields above — statuses spread across
several columns, PSA attribution living in a separate assignment table, no
first-action timestamp — the cleanest route is a view per entity that presents
exactly these columns, and pointing the mapping at the views:

```sql
CREATE OR REPLACE VIEW marketplace.vw_demand_analytics AS
SELECT
  d.demand_id,
  d.created_at,
  d.required_pickup_at,
  d.fulfilled_at,
  d.origin_city, d.origin_state,
  d.destination_city, d.destination_state,
  s.shipper_name,
  l.lsp_name,
  u.psa_name,                      -- attribution resolved here, once
  d.vehicle_type,
  d.material_type,
  d.region,
  d.status,
  r.reason_text AS unfulfilment_reason,
  d.vehicle_count,
  d.weight_tons,
  d.expected_price,
  d.booked_price
FROM marketplace.demand d
LEFT JOIN marketplace.shipper s ON s.id = d.shipper_id
LEFT JOIN marketplace.lsp     l ON l.id = d.lsp_id
LEFT JOIN marketplace.user    u ON u.id = d.owner_user_id
LEFT JOIN marketplace.reason  r ON r.id = d.unfulfilment_reason_id;
```

This keeps the joins in the warehouse where they can be tested, versioned and
reused, and leaves the app reading flat columns. It also means the dashboard
cannot be the thing that makes an expensive join decision at request time.

---

## Verifying the mapping

1. Open the **Setup** tab and press **Test connection** — it runs a real query
   against the warehouse and reports the round trip.
2. Check the **What is mapped** panel. Anything listed under warnings names both
   the missing column and the feature it disables.
3. Open the **Executive overview** with the date range set wide. Fill rate at 0%
   or 100% almost always means `fulfilledStatuses` does not match the real
   values — go back to query 4.
4. Press **Sync from Databricks**. The Data cache panel then reports how many
   rows came back for each entity — a count of zero means the mapping resolved
   but nothing matched the date window, which is usually a `createdAt` mapped to
   the wrong column.
5. Run `npm run check` locally after editing the mapping. The 22 assertions cover
   the invariants that must hold whichever backend served the numbers: counts
   reconcile, funnel stages descend, cumulative shares reach 100%, comparison
   windows do not overlap, and a snapshot round trip produces identical metrics.
