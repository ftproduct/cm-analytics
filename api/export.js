// /api/export.js
// Downloads the synced rows behind the dashboard as CSV or JSON.
//
//   GET /api/export?entity=demand|inventory|bids&format=csv|json
//       &from=YYYY-MM-DD&to=YYYY-MM-DD&outcome=all|success|fail
//       &<filter>=a~b ...            (same names and `~` separator as the page URL)
//
// Reads the snapshot only -- it never queries Databricks. With nothing synced
// there are no local rows to export, so it says so instead of falling back to a
// live scan of the warehouse.

const once = require('events').once;
const { requireAccess } = require('./_auth.js');
const source = require('./_source.js');
const { FILTER_KEYS, sanitiseFilters } = require('./_specs.js');
const exporter = require('./_export.js');

function filtersFromQuery(query) {
  const raw = { from: query.from, to: query.to, outcome: query.outcome };
  for (const k of FILTER_KEYS) {
    if (typeof query[k] === 'string' && query[k]) raw[k] = query[k].split('~').filter(Boolean);
  }
  return sanitiseFilters(raw);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  if (!requireAccess(req, res)) return;

  const query = req.query || {};
  const entity = String(query.entity || '');
  const format = String(query.format || 'csv');
  if (!exporter.ENTITIES.includes(entity)) {
    res.status(400).json({ error: `entity must be one of ${exporter.ENTITIES.join(', ')}` });
    return;
  }
  if (!exporter.FORMATS[format]) {
    res.status(400).json({ error: 'format must be csv or json' });
    return;
  }

  const src = await source.resolve();
  if (!src.dataset) {
    res.status(409).json({ error: 'Nothing is synced yet. Run Sync from Databricks first, then export.' });
    return;
  }

  const filters = filtersFromQuery(query);
  const rows = exporter.selectRows(src.dataset, entity, filters);

  res.statusCode = 200;
  res.setHeader('Content-Type', exporter.FORMATS[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${exporter.filename(entity, format, filters)}"`);
  res.setHeader('X-Export-Rows', String(rows.length));
  res.setHeader('X-Synced-At', src.snapshot?.syncedAt || '');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Synced-At');

  // Streamed so the size is not bounded by a serverless response limit.
  for (const chunk of exporter.chunks(rows, format)) {
    if (!res.write(chunk)) await once(res, 'drain');
  }
  res.end();
};
