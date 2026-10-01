# cm-analytics

A Databricks-backed marketplace analytics dashboard for FreightTiger. Demand,
inventory and FO App bids, cut by lane / zone / PSA / LSP, with a funnel from
posting to placement.

Deployed on Vercel as **marketplace-analytics**; `main` auto-deploys to
production and every branch gets a preview URL.

## Hard constraints

1. **Zero dependencies.** `package.json` has an empty `dependencies` *and*
   `devDependencies`. There is no `node_modules`, no lockfile, no `npm install`.
   If a problem seems to need a package, write it in plain Node instead. Adding
   a dependency is a decision for a human, not a convenience.
2. **No build step.** `public/` is vanilla HTML/CSS/JS served as-is. No bundler,
   no transpiler, no framework. The charts in `charts.js` are hand-written SVG.
3. **Node >= 18, CommonJS.** `require`, not `import`.
4. **`.env` is gitignored and must never be committed.** Databricks credentials
   live in Vercel project settings.

## Trap: stale duplicate files at the repo root

`_env.js`, `discover.js`, `selftest.js` and `sync-cli.js` exist **both at the
repo root and in `scripts/`**. The root copies are dead and stale — root
`selftest.js` is 286 lines against the live 805 in `scripts/selftest.js`.

`package.json` points at `scripts/`. **Always edit `scripts/`.** Editing a root
copy fails silently: the change does nothing and `npm run check` never sees it.

Deleting the four root files is a reasonable cleanup, but as its own commit.

## Layout

```
api/            Vercel serverless functions
  _schema.js      owns every SQL expression and the DIMENSIONS table
  _sync.js        builds the three snapshot queries; runSync()
  _engine.js      in-memory metric engine over the snapshot
  _sql.js         live-SQL path; mirrors _engine.js
  _source.js      picks demo | cached | live
  _databricks.js  SQL Statement Execution API client
  _store.js       snapshot read/write (KV or file, chunked)
  _demo.js        generated synthetic dataset
  _zone.js        canonical zone resolution
  _ask.js _llm.js _specs.js   natural-language chat over the data
  auth/           Google OAuth + basic auth
config/
  schema.json     the mapping document: logical name -> physical column
  zone_map.json   supercluster -> zone
public/         app.js, charts.js, chat.js, app.css, index.html
scripts/        selftest.js, sync-cli.js, discover.js, _env.js
sql/            read-only reconciliation queries
```

## Three serving modes

`api/_source.js` picks one:

| Mode | When | Source |
|---|---|---|
| `demo` | no Databricks token | generated dataset, ~7,500 demands over 180 days |
| `cached` | a snapshot exists in KV or file | `npm run sync` output — **production uses this** |
| `live` | fallback | per-metric SQL straight to Databricks |

**`_engine.js` (cached/demo) and `_sql.js` (live) must give identical answers.**
A change to one needs the matching change to the other, or the same question
answers differently depending on which mode happens to be serving.

## Schema-driven mapping

`config/schema.json` maps logical names to physical warehouse columns. An
unmapped column makes that dimension **drop out cleanly** and get listed as a
gap on the Setup tab. It must never crash, and must never silently zero a tab.

`MA_SCHEMA_JSON` overrides the whole document without a redeploy.

Tables: `phase2poc_demand`, `phase2poc_demand_supply`, and
`phase2poc_trip_location_mapping_static` — a different grain, joined via
`reference_id -> phase2poc_demand_supply.id` (not `supplier_inventory.id`).

`inventory.columns.source` is currently unmapped, so the AI-called vs manual
split is dark. Setting it to the real column name turns the split back on with
no code change.

## Bug classes this repo has actually hit

1. **`[hidden]` loses to a CSS `display` property.** Setting `display` on an
   element that is sometimes `[hidden]` leaks it onto every tab. This has bitten
   `.filter-bar` and `.view-intro`. Assert it in a test rather than trusting a
   comment.

2. **`runSync` swallows query errors.** `api/_sync.js` wraps the inventory and
   bids queries in try/catch (demand is unwrapped). A failed query stores `[]`,
   which renders as **zero on every data point** — indistinguishable from "no
   rows in this window". That shipped to production once. `api/meta.js` now
   surfaces the captured error as a warning; keep it that way, and never let a
   failure present as a real zero.

3. **Filters are applied to every entity.** `_engine.js applyFilters` runs every
   filter against both demand and inventory rows. A filter that only makes sense
   for one side — `callSource`, say, since a demand row has no call to
   attribute — must be entity-scoped, or selecting it zeroes the other side's
   panels. `callSource` is fixed. **`shipper` and `materialType` still have this
   shape and are known to be wrong**: filtering by shipper zeroes the Inventory
   tab in cached and demo mode while live SQL ignores the filter entirely.

## Commands

```bash
npm run dev       # http://localhost:3000, demo data, no credentials needed
npm run check     # the full assertion suite — must pass before any push
npm run sync      # pull a snapshot from Databricks (needs .env)
npm run discover  # scan Databricks, propose config/schema.json
```

`npm run check` is the gate. It runs every metric through the demo engine and
asserts the invariants that hold whichever backend produced the numbers.
**Add assertions for anything you change** — every bug listed above came back
with a test that would have caught it.

For real data locally: `cp .env.example .env` and fill in
`DATABRICKS_CLIENT_ID` + `DATABRICKS_CLIENT_SECRET` (or `DATABRICKS_TOKEN`).

## Conventions

- Comments explain **why**, not what. Match the surrounding density: this
  codebase comments the non-obvious decision and stays quiet on the obvious.
- Commit messages carry a subject line and then prose explaining the reasoning
  and the tradeoff. Read `git log` for the register.
- Every behaviour change gets an assertion in `scripts/selftest.js`.
- Branches: `feat/...`, `fix/...`, `docs/...`.
- Never put a model name or AI identifier in commit messages, PR titles or
  bodies, or code comments.

## Before pushing

Run `npm run check`. For anything touching the UI, also drive the real app —
`npm run dev` and look at the tabs you changed. Several of the bugs above passed
the test suite and were only visible in a browser.
