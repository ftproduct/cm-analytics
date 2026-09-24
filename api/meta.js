// /api/meta.js
// What this deployment is wired to: demo or live, which tables, which logical
// dimensions resolved against the current mapping, and what is missing. The
// frontend uses the `dimensions` list to hide controls that cannot work, and
// shows `warnings` on the Setup tab so a half-finished mapping is visible
// rather than silently returning empty charts.

const { requireAccess } = require('./_auth.js');
const db = require('./_databricks.js');
const S = require('./_schema.js');
const store = require('./_store.js');
const source = require('./_source.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAccess(req, res)) return;

  const src = await source.resolve();
  const snapshotMeta = src.snapshot || await store.readMeta();
  const cfg = db.config();
  const out = {
    mode: src.mode,
    cache: {
      backend: store.backend(),
      durable: store.isDurable(),
      snapshot: snapshotMeta || null,
      ageSeconds: snapshotMeta?.syncedAt
        ? Math.max(0, Math.round((Date.now() - new Date(snapshotMeta.syncedAt).getTime()) / 1000))
        : null,
      warnings: []
    },
    databricks: {
      host: cfg.host,
      warehouseId: cfg.warehouseId,
      tokenConfigured: db.isConfigured()
    },
    warnings: []
  };

  // Cache problems are reported on the cache panel; `warnings` stays about the
  // table mapping so the two do not duplicate each other.
  if (out.mode === 'live') {
    out.cache.warnings.push('No snapshot has been synced yet, so every panel is querying Databricks directly. Press Sync to cache the data.');
  }
  if (out.mode === 'cached' && !store.isDurable()) {
    out.cache.warnings.push(store.backend() === 'file'
      ? 'The snapshot is a local file. That works for development, but Vercel\'s filesystem is read-only and per-instance — configure KV_REST_API_URL and KV_REST_API_TOKEN before deploying.'
      : 'The snapshot is held in this instance\'s memory only — it is lost on a cold start and not shared between instances. Configure KV_REST_API_URL and KV_REST_API_TOKEN for a durable shared cache.');
  }
  if (snapshotMeta?.truncated) {
    out.cache.warnings.push('The last sync hit its row limit, so the snapshot covers a shorter window than requested. Raise MA_SYNC_MAX_ROWS or reduce MA_SYNC_DAYS.');
  }

  try {
    const schema = S.getSchema();
    out.schema = {
      catalog: schema.catalog,
      schema: schema.schema,
      demandTable: schema.demand.table,
      inventoryTable: schema.inventory.joined
        ? `${schema.inventory.table} (Metabase unique FO, 5-min session)`
        : `${schema.inventory.table} (Metabase 1190 inventory matches)`
    };
    out.dimensions = {
      demand: S.availableDimensions('demand'),
      inventory: S.availableDimensions('inventory')
    };

    // Columns the dashboard degrades without -- surfaced rather than hidden.
    const optional = [
      ['demand', 'unfulfilmentReason', 'Unfulfilment reasons chart'],
      ['demand', 'fulfilledAt', 'Time-to-fulfil metrics'],
      ['demand', 'expectedPrice', 'Value at risk'],
      ['inventory', 'nonConversionReason', 'Non-conversion reasons chart'],
      ['inventory', 'firstActionAt', 'PSA response ageing'],
      ['inventory', 'stage', 'Full conversion funnel'],
      ['inventory', 'convertedAt', 'Time-to-convert metrics']
    ];
    for (const [entity, col, feature] of optional) {
      if (!S.has(entity, col)) {
        out.warnings.push(`${entity}.${col} is not mapped — ${feature} is unavailable.`);
      }
    }
  } catch (e) {
    out.schemaError = e.message;
  }

  res.status(200).json(out);
};
