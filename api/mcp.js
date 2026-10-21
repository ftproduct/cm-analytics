// /api/mcp.js
// The MCP server over HTTP (streamable HTTP, JSON responses only).
//
//   POST /api/mcp   a JSON-RPC message or batch
//
// Who may call it. The tools read through one service credential, so a caller
// here sees every company's tickets -- an open demo deployment must never serve
// them. Access is therefore either
//   - Authorization: Bearer <MCP_API_KEY>, for MCP clients such as Claude Desktop, or
//   - a signed-in dashboard session (or the shared Basic credentials).
// Demo mode with no auth configured is refused outright.

const crypto = require('crypto');
const { requireAccess } = require('./_auth.js');
const mcp = require('./_mcp.js');

function bearerMatches(req) {
  const key = process.env.MCP_API_KEY;
  if (!key) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization || '').trim());
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST a JSON-RPC message' });
    return;
  }

  if (!bearerMatches(req)) {
    const principal = requireAccess(req, res);
    if (!principal) return;
    if (principal.demo) {
      res.status(401).json({ error: 'Configure sign-in or set MCP_API_KEY before using the MCP server.' });
      return;
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { res.status(400).json(mcp.parseError()); return; }
  }
  if (body === undefined || body === null) { res.status(400).json(mcp.parseError()); return; }

  const out = await mcp.handle(body);
  if (out === null) { res.status(202).end(); return; }
  res.status(200).json(out);
};
