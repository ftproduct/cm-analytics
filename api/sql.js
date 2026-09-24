// /api/sql.js
// Read-only ad-hoc SQL console for analysts. Admin only.
//
// POST { statement: "SELECT ...", limit: 500 } -> { columns, rows, elapsedMs }
//
// The checks below are defence in depth, not the security boundary. The real
// boundary is the Databricks token: issue this deployment a service principal
// with SELECT-only grants on the marketplace schema. Treat anything that gets
// past these checks as something the token should have refused anyway.

const { requireAdmin } = require('./_auth.js');
const db = require('./_databricks.js');

const ALLOWED_START = /^(select|with|show|describe|desc|explain)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|drop|truncate|alter|create|replace|grant|revoke|copy|call|refresh|vacuum|optimize|restore|set\s+var)\b/i;

// Strips -- line comments and /* block */ comments before the keyword scan, so
// a forbidden verb cannot hide behind a comment.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!requireAdmin(req, res)) return;
  if (!db.isConfigured()) {
    res.status(400).json({ error: 'DATABRICKS_TOKEN is not configured — the SQL console has nothing to query.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const statement = String(body?.statement || '').trim().replace(/;\s*$/, '');
  if (!statement) { res.status(400).json({ error: 'No statement supplied' }); return; }
  if (statement.length > 20000) { res.status(400).json({ error: 'Statement is too long' }); return; }

  const bare = stripComments(statement).trim();
  if (!ALLOWED_START.test(bare)) {
    res.status(400).json({ error: 'Only SELECT, WITH, SHOW, DESCRIBE and EXPLAIN statements are allowed.' });
    return;
  }
  if (FORBIDDEN.test(bare)) {
    res.status(400).json({ error: 'This console is read-only. Write statements are rejected.' });
    return;
  }
  if (bare.includes(';')) {
    res.status(400).json({ error: 'Run one statement at a time.' });
    return;
  }

  const limit = Math.min(Math.max(Number(body?.limit) || 500, 1), 5000);
  const startedAt = Date.now();
  try {
    const result = await db.query(statement, [], { rowLimit: limit });
    res.status(200).json({ ...result, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Query failed', elapsedMs: Date.now() - startedAt });
  }
};
