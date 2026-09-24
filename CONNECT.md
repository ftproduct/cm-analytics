# Connecting to real data

Four steps. The workspace details are already in the code — only the token and
the table mapping are missing.

| Already configured | Value |
|---|---|
| Server hostname | `dbc-a52503fa-6486.cloud.databricks.com` |
| SQL warehouse | `123f8c6553d1967b` (`cm_warehouse`) |
| HTTP path | `/sql/1.0/warehouses/123f8c6553d1967b` |

---

## 1. Add credentials

```bash
cp .env.example .env
```

Pick one auth method in `.env`:

| Method | Variables |
|---|---|
| Service-principal OAuth (recommended) | `DATABRICKS_CLIENT_ID` + `DATABRICKS_CLIENT_SECRET` |
| Access token | `DATABRICKS_TOKEN=dapi…` from [access tokens](https://dbc-a52503fa-6486.cloud.databricks.com/settings/user/developer/access-tokens) |

Use a principal with **`SELECT`-only** grants on the marketplace schema when you can.

`.env` is gitignored. Never commit it, and do not paste secrets into a chat or
a ticket — anything that ends up in a transcript is effectively published.

---

## 2. Find your tables

```bash
npm run discover
```

This connects, scans your catalogs for tables that look like demand and
inventory facts, and proposes a full `config/schema.json`. It is read-only —
`SHOW CATALOGS`, `information_schema` lookups, and a couple of `GROUP BY status`
counts.

It prints:

- the best-matching demand and inventory tables, with scores
- every logical field and the column it matched, or **not found**
- the real distinct values in your status and stage columns, with counts
- **a row count for the last 30 days** — the reconciliation check that matters

Narrow the scan if it guesses wrong:

```bash
npm run discover -- --catalog main --schema marketplace
npm run discover -- --demand main.mkt.fact_demand --inventory main.mkt.fact_supply
```

When the output looks right:

```bash
npm run discover -- --write        # saves config/schema.json, keeps a .bak
```

### Read the output before trusting it

Column matching is pattern-based. Three things decide whether every number in
the app is right, and all three deserve a manual look:

- **`createdAt`** — every date filter and time series keys off this one column.
  If the 30-day row count is wrong, this is almost always why.
- **`fulfilledStatuses`** — decides your entire fill rate. The script classifies
  observed values by name and lists anything it could not place. Resolve those
  by hand. Put out-of-scope statuses (e.g. outside placements) in
  **`excludeStatuses`**, not in `unfulfilledStatuses`.
- **`funnelStages`** — must be listed **in order, earliest first**. The script
  prints them by frequency, not sequence, so this one usually needs reordering.

---

## 3. Pull the data

```bash
npm run sync
```

Reports rows pulled per entity, the window covered and the snapshot size.

**Reconcile here, before opening the dashboard.** If the demand row count does
not match what you expect for that window, stop and fix the mapping — every
chart downstream inherits the error.

If the count is lower than expected, the usual cause is that one row is not one
demand: if you count vehicles but the table holds one row per indent with a
vehicle-count column, the app is counting indents. That is a real modelling
decision, not a bug — tell me which you want and I will change what "demands"
means throughout.

---

## 4. Run it

```bash
MA_DEV_ALLOW_ANONYMOUS=true npm run dev
```

(`.env.example` already sets this, so `npm run dev` is enough once you have
copied it.)

The header chip should read **"Synced just now"** in green. If it reads **"Demo
data"**, the token is not being picked up. If it reads **"Not synced — querying
live"**, the sync has not run.

Check the **Setup** tab: it lists what resolved, what did not, and which feature
each gap disables.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Chip says "Demo data" | `DATABRICKS_TOKEN` empty or `.env` not in `marketplace-analytics/` |
| `Databricks 403` | Token lacks access to the warehouse, or is expired |
| `TABLE_OR_VIEW_NOT_FOUND` | `catalog` / `schema` / `table` in `config/schema.json` is wrong |
| Sync returns 0 rows | `createdAt` mapped to the wrong column, or the window predates your data |
| Fill rate is 0% or 100% | `fulfilledStatuses` does not match real values — re-run `npm run discover` |
| Row count far below expected | One row is not one demand — see step 3 |
| Reasons panel empty / all "Not captured" | `cancellation_reason` is blank on most rows — the app now falls back to demand `status` |
| Response-time panel missing | `firstActionAt` unmapped — often needs deriving from an audit table |
| Inventory sync / panels empty | Joins failed or `inventory.joined` / column map wrong — see below |

---

## Marketplace tables (`elh_prod.ftverse`)

**Demand (live today):** `phase2poc_demand` only. Catalog/schema in
`config/schema.json` are `elh_prod` / `ftverse`.

Fulfilment is **marketplace FT placement only**:
- `fulfilledAt` → `vehicle_placed_ft_timestamp`
- `fulfilledStatuses` → `["VEHICLE_PLACED_BY_FT"]`
- `excludeStatuses` → `["VEHICLE_PLACED_BY_EXTERNAL"]` — fulfilled *outside*
  the marketplace; dropped from both numerator and denominator (not counted as
  unfulfilled either)

**Inventory:** demand↔inventory matches from `phase2poc_demand_supply`
where `matched_by = 'INVENTORY'` (Metabase dashboard **1190** — Overall / City /
PSA / Demand-wise Exact). Date filter is `demand.created_at`. Exact = Lane match,
Origin = Origin match. Placement is demand-level when
`is_placement_available` and demand status is `VEHICLE_PLACED_BY_FT`.

| Table | Role |
|---|---|
| `phase2poc_demand` + `phase2poc_demand_supply` | Inventory match funnel (Exact / Origin) |
| `phase2poc_trip_location_mapping_static` | FO App bids (Bids tab); optional FO utilisation view in `sql/vw_marketplace_inventory.sql` |

Grain (Metabase 1190 parity):

- One row per **inventory match** (`demand_supply` where `matched_by = INVENTORY`).
- Funnel: Matched → Called (direct/indirect) → Vehicle available → Demand placed.
- City = `origin_super_cluster_name`; PSA excludes `Demand_Bot_PSA`.
- Zone = North / South / East / West / Central, mapped from origin supercluster
  (same city names as `phase2poc_liquid_lanes.origin`) via
  `phase2poc_ftn_clusters.super_cluster → zone`. Checked-in fallback:
  `config/zone_map.json`.

```bash
MA_SYNC_DAYS=30 npm run sync
```

Optional later: `vw_marketplace_demand` to drop `LSP_RATE_ENQUIRY` from the
demand denominator if product decides those should not count.


## Before deploying to Vercel

Set the same variables in the Vercel project, **plus**:

- `SESSION_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` —
  sign-in becomes mandatory as soon as a token is present, so the app refuses to
  serve real data without them.
- `ADMIN_EMAILS` — who can press Sync.
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — without these the snapshot is not
  shared between instances and is lost on a cold start.

Do **not** set `MA_DEV_ALLOW_ANONYMOUS` in Vercel; it is ignored there by design.
