// /api/catalog.js
// Databricks catalog browser -- the tool for filling in config/schema.json
// without leaving the app. Admin only.
//
// GET /api/catalog                                   -> catalogs
// GET /api/catalog?catalog=main                      -> schemas
// GET /api/catalog?catalog=main&schema=marketplace   -> tables
// GET /api/catalog?catalog=main&schema=marketplace&table=fact_demand -> columns
//
// Every path segment is validated as a plain identifier and then bound as a
// parameter against information_schema, so nothing here is string-built SQL
// with user input in it.

const { requireAdmin } = require('./_auth.js');
const db = require('./_databricks.js');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAdmin(req, res)) return;
  if (!db.isConfigured()) {
    res.status(400).json({ error: 'DATABRICKS_TOKEN is not configured, so there is no catalog to browse.' });
    return;
  }

  const { catalog, schema, table } = req.query || {};
  for (const [name, value] of Object.entries({ catalog, schema, table })) {
    if (value !== undefined && !IDENT.test(String(value))) {
      res.status(400).json({ error: `Invalid ${name} name` });
      return;
    }
  }

  try {
    if (!catalog) {
      const { rows } = await db.query('SHOW CATALOGS');
      res.status(200).json({ level: 'catalog', rows });
      return;
    }
    if (!schema) {
      const { rows } = await db.query(
        `SELECT schema_name FROM \`${catalog}\`.information_schema.schemata ORDER BY schema_name`);
      res.status(200).json({ level: 'schema', catalog, rows });
      return;
    }
    if (!table) {
      const { rows } = await db.query(
        `SELECT table_name, table_type FROM \`${catalog}\`.information_schema.tables
         WHERE table_schema = :p0 ORDER BY table_name`,
        [{ name: 'p0', value: schema }]);
      res.status(200).json({ level: 'table', catalog, schema, rows });
      return;
    }
    const { rows } = await db.query(
      `SELECT column_name, data_type, ordinal_position
       FROM \`${catalog}\`.information_schema.columns
       WHERE table_schema = :p0 AND table_name = :p1
       ORDER BY ordinal_position`,
      [{ name: 'p0', value: schema }, { name: 'p1', value: table }]);
    res.status(200).json({ level: 'column', catalog, schema, table, rows });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Catalog query failed' });
  }
};
