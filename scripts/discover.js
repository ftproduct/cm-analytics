#!/usr/bin/env node
// scripts/discover.js
// Reads your Databricks catalog and proposes a config/schema.json.
//
//   npm run discover                          scan every catalog
//   npm run discover -- --catalog main        narrow to one catalog
//   npm run discover -- --catalog main --schema marketplace
//   npm run discover -- --demand main.mkt.fact_demand --inventory main.mkt.fact_supply
//   npm run discover -- ... --write           write config/schema.json
//
// It is read-only: SHOW CATALOGS, information_schema lookups and a couple of
// GROUP BY status counts. It never writes to the warehouse.
//
// Column matching is a starting point, not an oracle. Read what it prints and
// correct anything it guessed wrong — especially `createdAt`, which every date
// filter keys off, and the status lists, which decide your fill rate.

require('./_env.js').load();

const fs = require('fs');
const path = require('path');
const db = require('../api/_databricks.js');

// ---------------------------------------------------------------------------
// Column name patterns, most specific first. The first match wins.
// ---------------------------------------------------------------------------

const DEMAND_PATTERNS = {
  id:                  [/^demand_?id$/, /^indent_?id$/, /^load_?id$/, /^order_?id$/, /^booking_?id$/, /^id$/],
  createdAt:           [/^demand_?created_?(at|on)$/, /^indent_?created_?(at|on)$/, /^created_?at$/, /^created_?on$/, /^created_?date$/, /^placed_?at$/, /^booking_?date$/, /^order_?date$/],
  pickupAt:            [/^required_?pickup/, /^expected_?pickup/, /^pickup_?(at|date|time)$/, /^loading_?date$/],
  fulfilledAt:         [/^fulfil?l?ed_?at$/, /^fulfil?l?ment_?(at|date)$/, /^assigned_?at$/, /^confirmed_?at$/, /^allocated_?at$/],
  originCity:          [/^origin_?city$/, /^source_?city$/, /^from_?city$/, /^pickup_?city$/, /^loading_?city$/, /^origin$/, /^source$/],
  originState:         [/^origin_?state$/, /^source_?state$/, /^from_?state$/, /^pickup_?state$/],
  destinationCity:     [/^dest(ination)?_?city$/, /^to_?city$/, /^drop_?city$/, /^unloading_?city$/, /^destination$/],
  destinationState:    [/^dest(ination)?_?state$/, /^to_?state$/, /^drop_?state$/],
  shipper:             [/^shipper_?name$/, /^customer_?name$/, /^client_?name$/, /^consignor_?name$/, /^shipper$/, /^customer$/],
  lsp:                 [/^lsp_?name$/, /^transporter_?name$/, /^carrier_?name$/, /^vendor_?name$/, /^fleet_?owner/, /^lsp$/, /^transporter$/],
  psa:                 [/^psa_?name$/, /^psa$/, /^owner_?name$/, /^account_?manager/, /^assigned_?to$/, /^sales_?(person|owner)$/, /^kam$/],
  vehicleType:         [/^vehicle_?type$/, /^truck_?type$/, /^vehicle_?category$/, /^body_?type$/],
  materialType:        [/^material_?type$/, /^commodity$/, /^cargo_?type$/, /^product_?type$/, /^material$/],
  region:              [/^region$/, /^zone$/],
  branch:              [/^branch_?name$/, /^branch$/, /^hub$/, /^location$/],
  status:              [/^demand_?status$/, /^indent_?status$/, /^current_?status$/, /^status$/, /^state$/],
  unfulfilmentReason:  [/^unful?fil?l?ment_?reason$/, /^unfulfil?l?ed_?reason$/, /^cancel(lation)?_?reason$/, /^rejection_?reason$/, /^lost_?reason$/, /^failure_?reason$/, /reason/],
  quantity:            [/^(no|num|number)_?of_?vehicles?$/, /^vehicle_?count$/, /^truck_?count$/, /^quantity$/, /^qty$/],
  weightTons:          [/^weight_?(tons?|mt)$/, /^tonnage$/, /^cargo_?weight$/, /^load_?weight$/, /^weight$/],
  expectedPrice:       [/^expected_?(price|freight|rate)$/, /^indicative_?rate$/, /^estimated_?(price|freight)$/, /^target_?price$/, /^budget(ed)?_?(price|rate)$/],
  bookedPrice:         [/^booked_?(price|rate|amount)$/, /^final_?(price|rate|amount)$/, /^agreed_?rate$/, /^freight_?amount$/, /^booking_?amount$/]
};

const INVENTORY_PATTERNS = {
  id:                  [/^inventory_?id$/, /^supply_?id$/, /^vehicle_?id$/, /^truck_?id$/, /^posting_?id$/, /^id$/],
  createdAt:           [/^posted_?(at|on)$/, /^created_?at$/, /^created_?on$/, /^created_?date$/, /^posting_?date$/],
  availableFrom:       [/^available_?from$/, /^availability_?start/, /^free_?from$/],
  availableTill:       [/^available_?(till|to|until)$/, /^availability_?end/],
  convertedAt:         [/^converted_?at$/, /^conversion_?(at|date)$/, /^trip_?created_?at$/, /^assigned_?at$/, /^booked_?at$/],
  firstActionAt:       [/^first_?action_?at$/, /^first_?touch(ed)?_?at$/, /^first_?response_?at$/, /^first_?contact(ed)?_?at$/, /^actioned_?at$/],
  originCity:          [/^origin_?city$/, /^source_?city$/, /^from_?city$/, /^current_?city$/, /^origin$/],
  originState:         [/^origin_?state$/, /^source_?state$/, /^from_?state$/, /^current_?state$/],
  destinationCity:     [/^dest(ination)?_?city$/, /^to_?city$/, /^preferred_?city$/, /^destination$/],
  destinationState:    [/^dest(ination)?_?state$/, /^to_?state$/, /^preferred_?state$/],
  lsp:                 [/^lsp_?name$/, /^transporter_?name$/, /^carrier_?name$/, /^vendor_?name$/, /^fleet_?owner/, /^lsp$/, /^transporter$/],
  psa:                 [/^psa_?name$/, /^psa$/, /^owner_?name$/, /^assigned_?to$/, /^account_?manager/],
  vehicleType:         [/^vehicle_?type$/, /^truck_?type$/, /^body_?type$/],
  region:              [/^region$/, /^zone$/],
  branch:              [/^branch_?name$/, /^branch$/, /^hub$/],
  status:              [/^inventory_?status$/, /^supply_?status$/, /^current_?status$/, /^status$/, /^state$/],
  stage:               [/^funnel_?stage$/, /^stage$/, /^pipeline_?stage$/],
  nonConversionReason: [/^non_?conversion_?reason$/, /^rejection_?reason$/, /^cancel(lation)?_?reason$/, /^lost_?reason$/, /reason/],
  matchedDemandId:     [/^matched_?demand_?id$/, /^demand_?id$/, /^indent_?id$/, /^load_?id$/],
  capacityTons:        [/^capacity_?(tons?|mt)$/, /^capacity$/, /^payload$/, /^tonnage$/],
  quantity:            [/^(no|num|number)_?of_?vehicles?$/, /^vehicle_?count$/, /^quantity$/, /^qty$/],
  askingPrice:         [/^asking_?(price|rate)$/, /^quoted_?(price|rate)$/, /^expected_?(price|rate)$/, /^offer(ed)?_?rate$/]
};

// Table-name hints used to tell the two facts apart.
const DEMAND_TABLE_HINT = /(demand|indent|load|order|requirement|booking)/i;
const INVENTORY_TABLE_HINT = /(inventory|supply|vehicle|truck|capacity|posting|availab)/i;
const TABLE_CANDIDATE = /(demand|indent|load|order|requirement|booking|inventory|supply|vehicle|truck|capacity|posting|availab)/i;

const SKIP_SCHEMAS = new Set(['information_schema', 'sys', 'pg_catalog']);
const SKIP_CATALOGS = new Set(['system', 'samples', '__databricks_internal']);

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') { out.write = true; continue; }
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function matchColumns(columns, patterns) {
  const names = columns.map(c => c.column_name);
  const used = new Set();
  const mapped = {};
  for (const [logical, regexes] of Object.entries(patterns)) {
    let hit = null;
    for (const re of regexes) {
      hit = names.find(n => re.test(String(n).toLowerCase()) && !used.has(n));
      if (hit) break;
    }
    mapped[logical] = hit || null;
    if (hit) used.add(hit);
  }
  return mapped;
}

function scoreTable(tableName, columns, patterns, hint) {
  const mapped = matchColumns(columns, patterns);
  const matched = Object.values(mapped).filter(Boolean).length;
  // The table name matters, but only as a tiebreak -- columns decide.
  return matched + (hint.test(tableName) ? 5 : 0);
}

function fq(c, s, t) { return `\`${c}\`.\`${s}\`.\`${t}\``; }

async function listCatalogs(explicit) {
  if (explicit) return [explicit];
  const { rows } = await db.query('SHOW CATALOGS');
  return rows
    .map(r => r.catalog || r.catalog_name || Object.values(r)[0])
    .filter(c => c && !SKIP_CATALOGS.has(String(c).toLowerCase()));
}

async function listTables(catalog, schema) {
  const params = [];
  let where = '';
  if (schema) { where = 'WHERE table_schema = :p0'; params.push({ name: 'p0', value: schema }); }
  const { rows } = await db.query(
    `SELECT table_schema, table_name FROM \`${catalog}\`.information_schema.tables ${where}`, params);
  return rows.filter(r => !SKIP_SCHEMAS.has(String(r.table_schema).toLowerCase()));
}

async function columnsOf(catalog, schema, table) {
  const { rows } = await db.query(
    `SELECT column_name, data_type FROM \`${catalog}\`.information_schema.columns
     WHERE table_schema = :p0 AND table_name = :p1 ORDER BY ordinal_position`,
    [{ name: 'p0', value: schema }, { name: 'p1', value: table }]);
  return rows;
}

async function distinctValues(catalog, schema, table, column, limit = 25) {
  const { rows } = await db.query(
    `SELECT upper(trim(cast(\`${column}\` AS STRING))) AS v, count(*) AS n
     FROM ${fq(catalog, schema, table)}
     WHERE \`${column}\` IS NOT NULL
     GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`);
  return rows.map(r => ({ value: r.v, count: Number(r.n) }));
}

async function rowCount(catalog, schema, table, createdCol, days = 30) {
  if (!createdCol) return null;
  const { rows } = await db.query(
    `SELECT count(*) AS n FROM ${fq(catalog, schema, table)}
     WHERE to_date(\`${createdCol}\`) >= date_sub(current_date(), ${days})`);
  return Number(rows[0]?.n ?? 0);
}

function parseRef(ref) {
  if (!ref) return null;
  const parts = ref.split('.');
  if (parts.length !== 3) throw new Error(`Expected catalog.schema.table, got "${ref}"`);
  return { catalog: parts[0], schema: parts[1], table: parts[2] };
}

// Splits observed status values into fulfilled-ish and not, so the lists in the
// generated config are grounded in what the column actually contains.
const POSITIVE = /(fulfil|complete|deliver|assign|confirm|convert|trip|trans|alloc|trip_created|success|closed_won|booked)/i;
const NEGATIVE = /(expire|cancel|withdraw|reject|lapse|unfulfil|fail|no_supply|lost|closed_lost|abort)/i;

function splitStatuses(values) {
  const yes = [], no = [], unknown = [];
  for (const { value } of values) {
    if (POSITIVE.test(value) && !NEGATIVE.test(value)) yes.push(value);
    else if (NEGATIVE.test(value)) no.push(value);
    else unknown.push(value);
  }
  return { yes, no, unknown };
}

function report(label, mapped, columns) {
  console.log(`\n  ${label}`);
  const width = Math.max(...Object.keys(mapped).map(k => k.length));
  for (const [logical, physical] of Object.entries(mapped)) {
    const type = physical ? (columns.find(c => c.column_name === physical)?.data_type || '') : '';
    console.log(physical
      ? `    ${logical.padEnd(width)}  ->  ${physical}${type ? `  (${type})` : ''}`
      : `    ${logical.padEnd(width)}  ->  \x1b[33mnot found\x1b[0m`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!db.isConfigured()) {
    console.error('\nDATABRICKS_TOKEN is not set.\n\n' +
      '  cp .env.example .env     then put your token in it\n\n' +
      'Create a token at:\n' +
      `  https://${db.config().host}/settings/user/developer/access-tokens\n`);
    process.exit(1);
  }

  const cfg = db.config();
  console.log(`\nConnecting to ${cfg.host} (warehouse ${cfg.warehouseId})…`);
  await db.query('SELECT 1');
  console.log('Connected.');

  let demandRef = parseRef(args.demand);
  let inventoryRef = parseRef(args.inventory);

  if (!demandRef || !inventoryRef) {
    const catalogs = await listCatalogs(args.catalog);
    console.log(`\nScanning ${catalogs.length} catalog(s): ${catalogs.join(', ')}`);

    const candidates = [];
    for (const catalog of catalogs) {
      let tables = [];
      try {
        tables = await listTables(catalog, args.schema);
      } catch (e) {
        console.log(`  ${catalog}: skipped (${e.message.slice(0, 80)})`);
        continue;
      }
      const interesting = tables.filter(t => TABLE_CANDIDATE.test(t.table_name));
      console.log(`  ${catalog}: ${tables.length} tables, ${interesting.length} look relevant`);
      for (const t of interesting.slice(0, 60)) {
        candidates.push({ catalog, schema: t.table_schema, table: t.table_name });
      }
    }

    if (!candidates.length) {
      console.error('\nNo candidate tables found. Narrow the scan with --catalog and --schema, ' +
        'or name the tables directly with --demand and --inventory.');
      process.exit(1);
    }

    console.log(`\nInspecting ${candidates.length} candidate table(s)…`);
    const scored = [];
    for (const c of candidates) {
      let cols = [];
      try { cols = await columnsOf(c.catalog, c.schema, c.table); } catch { continue; }
      scored.push({
        ...c,
        columns: cols,
        demandScore: scoreTable(c.table, cols, DEMAND_PATTERNS, DEMAND_TABLE_HINT),
        inventoryScore: scoreTable(c.table, cols, INVENTORY_PATTERNS, INVENTORY_TABLE_HINT)
      });
    }

    const topDemand = [...scored].sort((a, b) => b.demandScore - a.demandScore);
    const topInventory = [...scored].sort((a, b) => b.inventoryScore - a.inventoryScore);

    console.log('\nBest demand-table candidates:');
    topDemand.slice(0, 5).forEach((t, i) =>
      console.log(`  ${i + 1}. ${t.catalog}.${t.schema}.${t.table}  (score ${t.demandScore}, ${t.columns.length} cols)`));
    console.log('\nBest inventory-table candidates:');
    topInventory.slice(0, 5).forEach((t, i) =>
      console.log(`  ${i + 1}. ${t.catalog}.${t.schema}.${t.table}  (score ${t.inventoryScore}, ${t.columns.length} cols)`));

    demandRef = demandRef || topDemand[0];
    // Don't pick the same table for both sides.
    inventoryRef = inventoryRef || topInventory.find(t =>
      !(t.catalog === demandRef.catalog && t.schema === demandRef.schema && t.table === demandRef.table)) || topInventory[0];
  }

  const demandCols = demandRef.columns || await columnsOf(demandRef.catalog, demandRef.schema, demandRef.table);
  const inventoryCols = inventoryRef.columns || await columnsOf(inventoryRef.catalog, inventoryRef.schema, inventoryRef.table);

  const demandMap = matchColumns(demandCols, DEMAND_PATTERNS);
  const inventoryMap = matchColumns(inventoryCols, INVENTORY_PATTERNS);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Demand    : ${demandRef.catalog}.${demandRef.schema}.${demandRef.table}`);
  console.log(`Inventory : ${inventoryRef.catalog}.${inventoryRef.schema}.${inventoryRef.table}`);
  console.log('='.repeat(72));
  report('demand columns', demandMap, demandCols);
  report('inventory columns', inventoryMap, inventoryCols);

  // Ground the status lists in real values rather than guesses.
  let demandStatuses = { yes: [], no: [], unknown: [] };
  let inventoryStatuses = { yes: [], no: [], unknown: [] };
  let stages = [];

  if (demandMap.status) {
    const vals = await distinctValues(demandRef.catalog, demandRef.schema, demandRef.table, demandMap.status);
    demandStatuses = splitStatuses(vals);
    console.log(`\n  demand.${demandMap.status} values:`);
    vals.forEach(v => console.log(`    ${String(v.count).padStart(10)}  ${v.value}`));
  }
  if (inventoryMap.status) {
    const vals = await distinctValues(inventoryRef.catalog, inventoryRef.schema, inventoryRef.table, inventoryMap.status);
    inventoryStatuses = splitStatuses(vals);
    console.log(`\n  inventory.${inventoryMap.status} values:`);
    vals.forEach(v => console.log(`    ${String(v.count).padStart(10)}  ${v.value}`));
  }
  if (inventoryMap.stage) {
    const vals = await distinctValues(inventoryRef.catalog, inventoryRef.schema, inventoryRef.table, inventoryMap.stage);
    stages = vals.map(v => v.value);
    console.log(`\n  inventory.${inventoryMap.stage} values (PUT THESE IN ORDER, earliest first):`);
    vals.forEach(v => console.log(`    ${String(v.count).padStart(10)}  ${v.value}`));
  }

  // Reconciliation: does the row count match what you expect?
  const demand30 = await rowCount(demandRef.catalog, demandRef.schema, demandRef.table, demandMap.createdAt).catch(() => null);
  const inventory30 = await rowCount(inventoryRef.catalog, inventoryRef.schema, inventoryRef.table, inventoryMap.createdAt).catch(() => null);
  console.log('\n  Last 30 days, counted on the createdAt column above:');
  console.log(`    demand    ${demand30 === null ? 'could not count' : demand30.toLocaleString('en-IN') + ' rows'}`);
  console.log(`    inventory ${inventory30 === null ? 'could not count' : inventory30.toLocaleString('en-IN') + ' rows'}`);
  console.log('    ^ compare this against the number you expect. If it is wrong, createdAt is');
  console.log('      mapped to the wrong column, or one row is not one demand.');

  // Same catalog/schema for both is the common case; otherwise fully qualify.
  const sameHome = demandRef.catalog === inventoryRef.catalog && demandRef.schema === inventoryRef.schema;
  const inventoryTable = sameHome
    ? inventoryRef.table
    : [inventoryRef.catalog, inventoryRef.schema, inventoryRef.table].filter(Boolean).join('.');
  const proposed = {
    catalog: demandRef.catalog,
    schema: demandRef.schema,
    demand: {
      table: demandRef.table,
      columns: demandMap,
      fulfilledStatuses: demandStatuses.yes.length ? demandStatuses.yes : ['FULFILLED', 'COMPLETED', 'DELIVERED'],
      unfulfilledStatuses: demandStatuses.no.length ? demandStatuses.no : ['EXPIRED', 'CANCELLED']
    },
    inventory: {
      table: inventoryTable,
      columns: inventoryMap,
      convertedStatuses: inventoryStatuses.yes.length ? inventoryStatuses.yes : ['CONVERTED', 'ASSIGNED'],
      nonConvertedStatuses: inventoryStatuses.no.length ? inventoryStatuses.no : ['EXPIRED', 'WITHDRAWN'],
      funnelStages: stages.length ? stages : undefined
    }
  };

  console.log(`\n${'='.repeat(72)}\nProposed config/schema.json\n${'='.repeat(72)}\n`);
  console.log(JSON.stringify(proposed, null, 2));

  const unresolved = [...demandStatuses.unknown, ...inventoryStatuses.unknown];
  if (unresolved.length) {
    console.log(`\n\x1b[33mStatus values it could not classify:\x1b[0m ${unresolved.join(', ')}`);
    console.log('Decide for each whether it counts as fulfilled/converted and add it to the right list.');
  }
  if (!sameHome) {
    console.log('\n\x1b[33mThe two tables are in different catalogs or schemas.\x1b[0m');
    console.log('Qualify the inventory table name, or point both at views in one schema.');
  }
  if (!inventoryMap.firstActionAt) {
    console.log('\n\x1b[33mNo first-action timestamp found on inventory.\x1b[0m');
    console.log('The response-time-versus-conversion panel needs it — it is usually the most');
    console.log('actionable chart in the app. Worth deriving from an audit or event table.');
  }

  if (args.write) {
    const target = path.join(__dirname, '..', 'config', 'schema.json');
    fs.copyFileSync(target, target + '.bak');
    fs.writeFileSync(target, JSON.stringify(proposed, null, 2) + '\n');
    console.log(`\nWritten to config/schema.json (previous saved as schema.json.bak).`);
  } else {
    console.log('\nNothing written. Re-run with --write to save this to config/schema.json,');
    console.log('or paste it in by hand after correcting anything above.');
  }
  console.log('');
}

main().catch(e => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
