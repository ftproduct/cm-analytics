#!/usr/bin/env node
// scripts/sync-cli.js
// Runs a sync from the command line, without the dashboard. Useful for the very
// first pull (it prints what came back) and for checking the mapping resolves
// before anyone opens the app.
//
//   npm run sync
//   npm run sync -- --days 30

require('./_env.js').load();

const db = require('../api/_databricks.js');
const { runSync } = require('../api/_sync.js');
const store = require('../api/_store.js');
const path = require('path');

if (!process.env.MA_SNAPSHOT_FILE && !process.env.KV_REST_API_URL) {
  process.env.MA_SNAPSHOT_FILE = path.join(__dirname, '..', '.cache', 'snapshot.json');
}

const args = process.argv.slice(2);
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : undefined;

(async () => {
  if (!db.isConfigured()) {
    console.error('\nDATABRICKS_TOKEN is not set. Copy .env.example to .env and fill it in.\n');
    process.exit(1);
  }
  const cfg = db.config();
  console.log(`\nSyncing from ${cfg.host} (warehouse ${cfg.warehouseId})…`);

  const startedAt = Date.now();
  const meta = await runSync({ days });

  console.log(`\nDone in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`  window     ${meta.window.from} to ${meta.window.to} (${meta.requestedDays} days)`);
  console.log(`  demand     ${meta.rows.demand.toLocaleString('en-IN')} rows`);
  console.log(`  inventory  ${meta.rows.inventory.toLocaleString('en-IN')} rows`);
  if (meta.rows.bids != null) {
    console.log(`  bids       ${meta.rows.bids.toLocaleString('en-IN')} rows`);
  }
  if (meta.inventoryError) {
    console.log(`\n  WARNING: inventory pull skipped — ${meta.inventoryError}`);
    console.log('  Check inventory.joined / joins in api/_schema.js, then re-sync.');
  }
  if (meta.bidsError) {
    console.log(`\n  WARNING: bids pull skipped — ${meta.bidsError}`);
  }
  console.log(`  snapshot   ${(meta.storedBytes / 1048576).toFixed(2)} MB in ${meta.chunks} chunk(s), via ${meta.backend}`);
  if (meta.truncated) {
    console.log(`\n  WARNING: hit the ${meta.rowLimit.toLocaleString('en-IN')} row ceiling.`);
    console.log('  The snapshot covers less than the requested window. Raise MA_SYNC_MAX_ROWS.');
  }
  if (!meta.rows.demand) {
    console.log('\n  WARNING: zero demand rows. The table resolved but nothing matched the date');
    console.log('  window — usually createdAt mapped to the wrong column.');
  }
  console.log('\nNow run `npm run dev` and the dashboard will serve this snapshot.\n');
})().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
