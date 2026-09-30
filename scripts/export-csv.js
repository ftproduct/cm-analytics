#!/usr/bin/env node
// scripts/export-csv.js
// Pulls straight from Databricks and writes CSVs to disk, so the same rows the
// dashboard charts can be opened in Excel or handed to someone who does not
// have the app. Nothing is cached and no snapshot is touched -- this is a plain
// read, separate from `npm run sync`.
//
//   npm run export                          # last 90 days, all three datasets
//   npm run export -- --days 30
//   npm run export -- --only demand,bids
//   npm run export -- --out ~/Downloads
//   npm run export -- --sql "SELECT ..." --name my-query
//
// The columns are the logical names the dashboard uses (createdDate, region,
// demandSource, callSource ...), not the warehouse's physical ones, so a number
// in the CSV reconciles with the same number on a tab.

require('./_env.js').load();

const fs = require('fs');
const path = require('path');
const db = require('../api/_databricks.js');
const S = require('../api/_sync.js');

const DATASETS = ['demand', 'inventory', 'bids'];

function parseArgs(argv) {
  const out = { only: DATASETS, days: undefined, outDir: null, sql: null, name: 'query' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === '--days') out.days = Number(next());
    else if (flag === '--out') out.outDir = next();
    else if (flag === '--name') out.name = next();
    else if (flag === '--sql') out.sql = next();
    else if (flag === '--only') {
      const picked = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
      const unknown = picked.filter(p => !DATASETS.includes(p));
      if (unknown.length) {
        throw new Error(`--only got ${unknown.join(', ')}; pick from ${DATASETS.join(', ')}`);
      }
      out.only = picked;
    } else {
      throw new Error(`Unknown option ${flag}. See the header of scripts/export-csv.js.`);
    }
  }
  if (out.days != null && !Number.isFinite(out.days)) throw new Error('--days needs a number.');
  return out;
}

// RFC 4180: quote when the value carries a comma, quote, newline or carriage
// return, and double an embedded quote. Excel opens the result without asking.
function csvCell(value) {
  if (value == null) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === 'object' && !(value instanceof Date)) s = JSON.stringify(value);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// Union of keys in first-seen order, so a column a later row introduces still
// makes it into the header instead of being silently dropped.
function columnsOf(rows) {
  const seen = [];
  const known = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) { known.add(key); seen.push(key); }
    }
  }
  return seen;
}

function writeCsv(file, rows) {
  const cols = columnsOf(rows);
  const fd = fs.openSync(file, 'w');
  try {
    // ﻿ so Excel reads the file as UTF-8 rather than the local codepage --
    // lane names carry the arrow character and would otherwise come out mangled.
    fs.writeSync(fd, '﻿' + cols.map(csvCell).join(',') + '\n');
    // Chunked rather than one big string: a 90-day pull is comfortably past the
    // point where joining it all in memory is wasteful.
    let buf = '';
    for (const row of rows) {
      buf += cols.map(c => csvCell(row[c])).join(',') + '\n';
      if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
    }
    if (buf) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  return { rows: rows.length, cols: cols.length, bytes: fs.statSync(file).size };
}

function report(label, file, stat) {
  const mb = (stat.bytes / 1048576).toFixed(2);
  console.log(`  ${label.padEnd(10)} ${String(stat.rows).padStart(8)} rows × ${stat.cols} cols  ${mb} MB  ${file}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!db.isConfigured()) {
    console.error('\nDatabricks is not configured. Copy .env.example to .env and fill in');
    console.error('DATABRICKS_CLIENT_ID/SECRET (or DATABRICKS_TOKEN), then re-run.\n');
    process.exit(1);
  }

  const outDir = path.resolve(args.outDir || path.join(__dirname, '..', 'exports'));
  fs.mkdirSync(outDir, { recursive: true });

  const cfg = db.config();
  console.log(`\nReading from ${cfg.host} (warehouse ${cfg.warehouseId})…`);

  // --sql is the escape hatch for a one-off question the dashboard does not ask.
  if (args.sql) {
    const started = Date.now();
    const res = await db.query(args.sql, [], { rowLimit: S.MAX_ROWS });
    const file = path.join(outDir, `${args.name}.csv`);
    report(args.name, file, writeCsv(file, res.rows));
    console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    return;
  }

  const days = Math.min(Math.max(Number(args.days) || S.DEFAULT_DAYS, 1), 1095);
  const limit = S.MAX_ROWS;
  const w = S.windowFor(days);
  const params = [
    { name: 'p0', value: w.from, type: 'STRING' },
    { name: 'p1', value: w.to, type: 'STRING' }
  ];
  console.log(`Window ${w.from} to ${w.to} (${days} days), ceiling ${limit.toLocaleString('en-IN')} rows/dataset.\n`);

  const build = {
    demand: [S.demandQuery, 'isFulfilled'],
    inventory: [S.inventoryQuery, 'isConverted'],
    bids: [S.bidsQuery, 'isConverted']
  };

  const started = Date.now();
  const failures = [];
  for (const name of args.only) {
    const [queryFor, okField] = build[name];
    try {
      const res = await db.query(queryFor(w.from, w.to, limit), params, { rowLimit: limit });
      const rows = S.normalise(res.rows, okField);
      const file = path.join(outDir, `${name}-${w.from}-to-${w.to}.csv`);
      report(name, file, writeCsv(file, rows));
      if (rows.length >= limit) {
        console.log(`  ${''.padEnd(10)} WARNING: hit the row ceiling, so this file starts later than ${w.from}.`);
      } else if (!rows.length) {
        console.log(`  ${''.padEnd(10)} WARNING: zero rows -- check the mapping on the Setup tab.`);
      }
    } catch (e) {
      // One dataset failing should not cost the others; an empty CSV would read
      // as "no rows in the window", which is exactly the wrong conclusion.
      failures.push(`${name}: ${e.message || e}`);
      console.log(`  ${name.padEnd(10)} FAILED -- no file written.`);
    }
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (failures.length) {
    console.log('\nFailed pulls:');
    for (const f of failures) console.log(`  ${f}`);
    console.log('\nUsually a column mapping -- check config/schema.json against the Setup tab.\n');
    process.exit(1);
  }
  console.log(`\nFiles are in ${outDir}\n`);
}

if (require.main === module) {
  main().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
}

module.exports = { parseArgs, csvCell, columnsOf, writeCsv, DATASETS };
