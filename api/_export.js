// /api/_export.js
// Turns the synced row snapshot into a downloadable file.
//
// The rows are exactly what the snapshot holds -- every column, not the subset
// the Explore tab shows -- narrowed by the same filters the dashboard applies,
// so an export always matches the view it was taken from.

const engine = require('./_engine.js');

const ENTITIES = ['demand', 'inventory', 'bids'];
const FORMATS = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' };

// Rows are written in batches so a large snapshot never becomes one huge string.
const BATCH = 2000;

function selectRows(dataset, entity, filters) {
  const rows = dataset?.[entity] || [];
  engine.ensureDerivedFields(rows);
  return engine.applyFilters(rows, entity, filters);
}

// Union of keys in first-seen order. Rows are not guaranteed to share a shape:
// older snapshots lack columns newer syncs add.
function columnsOf(rows) {
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

// Spreadsheets run a cell that starts with = + - @ as a formula, and several of
// these columns (call notes, shipper names) are free text typed by people.
// Prefixing an apostrophe makes the cell inert; real numbers are left alone.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function* csvChunks(rows, columns) {
  // The byte-order mark makes Excel read the file as UTF-8 (lane names contain "→").
  yield '﻿' + columns.map(csvCell).join(',') + '\r\n';
  for (let i = 0; i < rows.length; i += BATCH) {
    yield rows.slice(i, i + BATCH)
      .map(r => columns.map(c => csvCell(r[c])).join(',') + '\r\n').join('');
  }
}

function* jsonChunks(rows, columns) {
  if (!rows.length) { yield '[]\n'; return; }
  // Every object carries every column (null when absent) so consumers see one shape.
  const one = r => JSON.stringify(Object.fromEntries(columns.map(c => [c, r[c] ?? null])));
  for (let i = 0; i < rows.length; i += BATCH) {
    const body = rows.slice(i, i + BATCH).map(one).join(',\n');
    yield (i === 0 ? '[\n' : ',\n') + body;
  }
  yield '\n]\n';
}

function chunks(rows, format) {
  const columns = columnsOf(rows);
  return format === 'json' ? jsonChunks(rows, columns) : csvChunks(rows, columns);
}

function filename(entity, format, filters) {
  const range = [filters.from, filters.to].filter(Boolean).join('_to_');
  return `marketplace-${entity}${range ? `-${range}` : ''}.${format}`;
}

module.exports = { ENTITIES, FORMATS, selectRows, columnsOf, csvCell, chunks, filename };
