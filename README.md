# Marketplace Analytics

Demand and inventory analytics for the Freight Tiger marketplace, reading from a
Databricks SQL warehouse and deployable to Vercel as its own project.

Built for the question leadership actually asks: **where are we losing loads, and
is it because the market had no trucks or because we failed to match the ones we
had?**

---

## Quick start

```bash
cd marketplace-analytics
npm run dev          # http://localhost:3000, generated demo data
npm run check        # 22 assertions over every metric and the cache round trip
npm run discover     # scan Databricks and propose config/schema.json
npm run sync         # pull a snapshot from Databricks
```

**To connect it to real data, follow [CONNECT.md](./CONNECT.md)** — four steps,
and the workspace details are already in the code.

It runs with no configuration at all. Until a Databricks token is present the app
serves a deterministic synthetic dataset — ~7,500 demands and ~6,700 inventory
postings across 180 days, 16 cities and 12 carriers — so the whole dashboard is
reviewable before anyone touches credentials. A **Demo data** chip in the header
says so at all times.

---

## Deploying to Vercel

This directory is its own Vercel project. It does **not** share a deployment with
the engineering hub at the repository root.

1. **New Project** → import this repository.
2. Set **Root Directory** to `marketplace-analytics`.
3. Framework preset: **Other**. No build command, no install step — it is static
   files plus Node serverless functions.
4. Add the environment variables below and deploy.

### Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `DATABRICKS_TOKEN` | live data | Personal access token, or a service-principal token. **Grant it `SELECT` only.** |
| `DATABRICKS_HOST` | live data | Defaults to `dbc-a52503fa-6486.cloud.databricks.com` |
| `DATABRICKS_WAREHOUSE_ID` | live data | Defaults to `123f8c6553d1967b`. The full HTTP path (`/sql/1.0/warehouses/…`) is accepted too. |
| `BASIC_AUTH_USER` | site lock | Shared username for HTTP Basic Auth. When set with `BASIC_AUTH_PASSWORD`, the browser prompts before any page or API. |
| `BASIC_AUTH_PASSWORD` | site lock | Shared password. Prefer a long random value. |
| `SESSION_SECRET` | sign-in | Any long random string. `openssl rand -base64 32` |
| `GOOGLE_OAUTH_CLIENT_ID` | sign-in | Google OAuth web client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | sign-in | |
| `ALLOWED_EMAIL_DOMAIN` | sign-in | Defaults to `freighttiger.com` |
| `ADMIN_EMAILS` | sync + SQL console | Comma-separated. These addresses can trigger a sync and use the catalog browser and SQL console. |
| `KV_REST_API_URL` | the cache | Upstash Redis REST URL. Without it the snapshot is not durable — see below. |
| `KV_REST_API_TOKEN` | the cache | Upstash Redis REST token |
| `MA_SYNC_DAYS` | optional | How many days each sync pulls. Default `180`. |
| `MA_SYNC_MAX_ROWS` | optional | Row ceiling per entity per sync. Default `200000`. |
| `MA_SNAPSHOT_CHUNK_CHARS` | optional | Characters per KV chunk. Default `480000`, sized for a 1 MB request limit. |
| `CRON_SECRET` | optional | Lets a scheduler call `POST /api/sync` with `Authorization: Bearer <secret>`. |
| `MA_SCHEMA_JSON` | optional | The whole table mapping as JSON, overriding `config/schema.json` without a redeploy. |
| `MA_DEMO_MODE` | optional | `true` forces demo data even with a token configured. Useful for a public review link. |
| `MA_DEV_ALLOW_ANONYMOUS` | local only | `true` skips sign-in so `npm run dev` can exercise the live and cached paths. Vercel always sets `VERCEL=1`, so this can never take effect in a deployment. |

Set the OAuth redirect URI in Google Cloud Console to
`https://<your-deployment>/api/auth/callback`.

**Site-wide Basic Auth:** set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` to
require a browser username/password prompt before any page or API loads. This
works locally (`npm run dev`) and on Vercel (via Edge Middleware). `/api/health`
and cron `POST /api/sync` with `Authorization: Bearer <CRON_SECRET>` are exempt.

**Sign-in becomes mandatory the moment `DATABRICKS_TOKEN` is set.** If real data
is reachable but OAuth has not been configured, the API refuses to serve rather
than exposing the warehouse — so the open demo can never quietly become an open
production dashboard.

---

## How data reaches the dashboard

There are three modes. The chip in the header always says which one you are
looking at, and every API response carries the mode too.

| Mode | When | Databricks load |
|---|---|---|
| **demo** | no `DATABRICKS_TOKEN` | none — generated data |
| **cached** | a snapshot has been synced | **none** — every panel and filter is answered in memory |
| **live** | token set, nothing synced yet | one query per panel, on every render |

### Sync

**Sync from Databricks** (header, admins only) runs **two** queries — one for
demand, one for inventory — pulling row-level records for the configured window.
The rows are gzipped and written to the shared cache. From then on every panel,
every filter combination and every date range inside that window is computed
from those rows in memory.

A PSA-filtered overview served from the snapshot returns in single-digit
milliseconds and issues **zero** warehouse queries.

This is deliberately a row snapshot rather than cached aggregates. Caching
aggregates would key on filter combination, so every new lane or PSA selection
would miss the cache and hit the warehouse again — which is the problem being
solved. `_engine.js` already computes every metric from rows, so the snapshot
feeds the exact code path demo mode uses.

### What it costs

Roughly: 14,000 rows compress to about 1 MB stored from 9 MB of JSON. Tune the
snapshot with `MA_SYNC_DAYS` and `MA_SYNC_MAX_ROWS` — a sync that hits the row
ceiling keeps the **most recent** rows and says so, on the Setup tab and in the
header, rather than quietly implying full coverage.

### Where the snapshot lives

| Backend | Chosen when | Survives cold start | Shared between instances |
|---|---|:---:|:---:|
| **Upstash KV** | `KV_REST_API_URL` + `KV_REST_API_TOKEN` | yes | yes |
| **file** | `MA_SNAPSHOT_FILE` set (the dev server sets it) | yes | no — local dev only |
| **memory** | neither | no | no |

**Configure Upstash before deploying.** Vercel's filesystem is read-only and each
instance is separate, so without KV the snapshot lives only in whichever warm
lambda happened to write it: other instances would fall back to live queries and
a cold start would lose it. The Setup tab warns when this is the case.

The engineering hub at the repository root already uses Upstash, so the same
integration and variable names apply.

### Keeping it fresh

The cache never expires on its own — it is explicit, so nobody is surprised by
numbers changing under them. The header shows the age and turns amber past 12
hours.

To refresh on a schedule, set `CRON_SECRET` and add a cron to `vercel.json`:

```json
"crons": [{ "path": "/api/sync", "schedule": "0 2 * * *" }]
```

Vercel's scheduler sends `Authorization: Bearer $CRON_SECRET`, which
`POST /api/sync` accepts in place of a session. Sub-daily schedules need a Pro
plan. Concurrent syncs are coalesced onto one run, so overlapping triggers
cannot double-scan the tables.

**Refresh** (next to Sync) only redraws from the snapshot. It never queries
Databricks — that is what Sync is for.

---

## Pointing it at your tables

The app never hardcodes a column name. `config/schema.json` maps *logical* fields
(`lane`, `psa`, `unfulfilmentReason`) to *physical* ones, and everything else is
derived from that. See **[SCHEMA.md](./SCHEMA.md)** for the full field list and
the discovery queries.

Start with `npm run discover`: it scans your catalogs, matches columns to the
logical fields, prints the real values in your status columns and proposes a
complete mapping. `npm run discover -- --write` saves it.

Two things to know:

- A column you leave `null` is not an error. The dashboard hides the panels that
  need it and lists what is missing on the **Setup** tab.
- Signed-in admins get a **catalog browser** (`/api/catalog`) and a **read-only
  SQL console** on the Setup tab to work out the right names without leaving the
  app.

---

## What each tab answers

### Executive overview
Fill rate, unfulfilled volume, value at risk, conversion rate and response time,
each against the previous window of equal length. Below the tiles, **an
auto-written narrative** — the conclusions an analyst would draw from these
charts, stated in sentences with the numbers in them, so the tab can be read in
fifteen seconds before a review.

### Demand
Lane-wise and LSP-wise demand, fulfilled versus unfulfilled over time, the
unfulfilment-reason Pareto (ranked bars with cumulative share printed on each —
never a dual axis), and a lane × week fill-rate grid for spotting *when* a lane
started slipping rather than just that it has.

### Inventory
The conversion funnel with the drop-off called out between every stage, the
non-conversion reason breakdown, per-PSA and per-LSP conversion — and **response
time versus conversion**, which in practice is the single clearest controllable
lever on the supply side.

### Demand ↔ supply
The tab worth having. For every lane it pairs unfilled demand against unbooked
trucks *in the same window* and reports the **matchable** count: trips that
should have happened and did not.

That single number separates the two problems that look identical on a fill-rate
chart and need completely different responses:

- **Coverage below 1.0×** — genuinely not enough trucks. Carrier acquisition.
- **Coverage above 1.0× with poor fill** — the trucks were there and we did not
  match them. Process, pricing or response time.

### PSA & LSP
Scorecards for both sides, who is moving against the previous period, carrier
reliability, and carrier concentration with HHI — because a fill rate that
depends on three carriers is a different risk from the same fill rate spread
across twelve.

### Explore
Row-level records for the current filter selection, group-by on any mapped
dimension, and CSV export from every panel.

### Setup
Connection state, a live **Test connection** button, the cache — when it was last
synced, how many rows it holds, what window it covers and how big it is — the
current mapping, what is unmapped and which feature each gap disables, plus the
SQL console for admins.

---

## Filters

Date range (presets or custom), PSA, lane, LSP, origin, destination, region,
vehicle type, shipper, and a fulfilled / unfulfilled toggle — all combinable, all
applied server-side, all reflected in the URL.

**Copy view link** produces a URL that reproduces the exact view, filters
included, which is the difference between "fill rate is down" in a message and a
link the other person can open on the same slice.

Clicking any lane, LSP, PSA or shipper bar filters the whole dashboard to it.

---

## Architecture

```
marketplace-analytics/
├── config/schema.json     # logical -> physical column mapping (the only file to edit)
├── api/
│   ├── _schema.js         # validates identifiers, resolves dimensions
│   ├── _databricks.js     # SQL Statement Execution API client
│   ├── _sql.js            # builds the SQL for every metric
│   ├── _demo.js           # deterministic synthetic dataset
│   ├── _engine.js         # the same metrics computed in memory (demo + cached)
│   ├── _store.js          # snapshot storage: Upstash / file / memory
│   ├── _sync.js           # pulls rows from Databricks into a snapshot
│   ├── _source.js         # picks demo / cached / live for a request
│   ├── _auth.js           # session cookie, roles, the live-data gate
│   ├── metrics.js         # POST — batched metric specs, the only read endpoint
│   ├── sync.js            # POST run a sync, GET status, DELETE clear (admin)
│   ├── filters.js         # distinct values for the filter comboboxes
│   ├── meta.js            # what is wired up and what is missing
│   ├── catalog.js         # information_schema browser (admin)
│   ├── sql.js             # read-only SQL console (admin)
│   └── health.js          # liveness + a real Databricks round trip
├── public/
│   ├── index.html
│   ├── app.js             # state, filters, tabs, insight narrative
│   ├── charts.js          # inline-SVG chart primitives, no chart library
│   └── app.css            # colour tokens, light + dark
└── scripts/selftest.js
```

**`_engine.js` and `_sql.js` return byte-identical JSON.** The frontend cannot
tell which one served it, which is what lets demo mode be a faithful preview
rather than a mockup — and makes `_engine.js` readable as the specification of
what each metric means.

One tab is one HTTP request: every panel declares a metric spec and they are
batched into a single `POST /api/metrics`. In cached mode that request resolves
the snapshot once and answers every spec from it.

### Safety

- **Identifiers** come only from `config/schema.json` and are validated against
  `^[A-Za-z_][A-Za-z0-9_]*$` before they can reach SQL.
- **Values** from the browser always travel as named bind parameters (`:p0`,
  `:p1`). Nothing the browser sends is concatenated into a statement.
- **The SQL console** rejects anything but `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/
  `EXPLAIN`, strips comments before the keyword scan, and refuses multiple
  statements — but that is defence in depth. The boundary is the token, so give
  this deployment a `SELECT`-only principal.

### Charts

No charting library. Every mark is drawn in `charts.js` so the rules hold
everywhere: a validated colourblind-safe palette, 2px surface gaps between
stacked fills, 4px rounded data-ends, hover tooltips on every mark, direct labels
alongside every legend, and a table view for every chart.

**No dual-axis charts anywhere.** Two measures of different scale get two charts
or a shared scale — which is why the reason breakdown prints cumulative share as
a label rather than drawing a second axis over the bars.

Dark mode is a selected set of steps against the dark surface, not an inverted
light palette, and follows both the OS setting and the in-app toggle.

---

## Things worth knowing about the numbers

- **The comparison period** is always the window immediately before the selected
  one, of the same length — not "last month" or a fixed 30 days.
- **Movers** exclude anything under 12 records in either window. A lane with five
  loads swinging forty points is noise, and reporting it trains people to ignore
  the panel.
- **LSP reliability excludes unattributed demand.** Unfilled loads often carry no
  carrier, so an "Unknown" bucket would sit at 0% and read as the worst carrier
  on the book.
- **Funnel stages are cumulative**: a posting sitting at `CONFIRMED` is counted in
  `QUOTED` too, so the bars only ever descend.
- **Value at risk** prices unfilled demand at expected rather than booked price,
  since a load that never moved has no booked price.
- **Matching loss** is `min(unfilled demand, unconverted supply)` on the same lane
  in the same window. It is an upper bound on what better matching could have
  recovered — the two sides still have to agree on timing, vehicle type and
  price — so read it as the size of the opportunity, not a guaranteed recovery.
