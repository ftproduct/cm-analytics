#!/usr/bin/env node
// scripts/mcp-stdio.js
// The same MCP server over stdio, for desktop MCP clients:  npm run mcp
//
//   { "mcpServers": { "marketplace": {
//       "command": "node",
//       "args": ["/path/to/cm-analytics/scripts/mcp-stdio.js"],
//       "env": { "FT_API_TOKEN": "..." } } } }
//
// Newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only; anything
// else on stdout would corrupt the protocol.

require('./_env.js').load();

const readline = require('readline');
const mcp = require('../api/_mcp.js');
const tools = require('../api/_mcp_tools.js');

if (!tools.isConfigured()) {
  console.error('marketplace-mcp: FT_API_TOKEN is not set; tools/list works but every call will fail.');
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify(mcp.parseError())}\n`); return; }
  const out = await mcp.handle(msg);
  if (out !== null) process.stdout.write(`${JSON.stringify(out)}\n`);
});
