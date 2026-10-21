// /api/_mcp.js
// A minimal Model Context Protocol server: JSON-RPC 2.0 with initialize, ping,
// tools/list and tools/call. Hand-written because this project has no install
// step, and read-only tools need nothing more of the protocol. Transport is
// separate: api/mcp.js serves it over HTTP, scripts/mcp-stdio.js over stdio.

const tools = require('./_mcp_tools.js');

const SERVER_INFO = { name: 'marketplace-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ERR = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function toolList() {
  return tools.list().map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: tools.inputSchema(t),
    annotations: { readOnlyHint: true, openWorldHint: true }
  }));
}

async function callTool(params, deps) {
  const name = params?.name;
  if (typeof name !== 'string' || !tools.get(name)) {
    return { error: [ERR.params, `Unknown tool: ${name}`] };
  }
  try {
    const { data } = await tools.call(name, params.arguments || {}, deps);
    return { result: { content: [{ type: 'text', text: tools.render(data) }] } };
  } catch (e) {
    // A failed call is a tool result the model can read and recover from, not
    // a protocol error.
    return { result: { isError: true, content: [{ type: 'text', text: e.message }] } };
  }
}

// One JSON-RPC message in, one response out -- or null for a notification.
async function handleMessage(msg, deps = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(msg?.id, ERR.request, 'Invalid JSON-RPC request');
  }
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only access to Freight Tiger FO support tickets and FO advance-payment queues.'
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: toolList() });
    case 'tools/call': {
      const out = await callTool(msg.params, deps);
      return out.error ? fail(msg.id, ...out.error) : ok(msg.id, out.result);
    }
    default:
      if (isNotification || msg.method.startsWith('notifications/')) return null;
      return fail(msg.id, ERR.method, `Method not found: ${msg.method}`);
  }
}

// Accepts a parsed body: a single message or a batch.
async function handle(body, deps) {
  if (Array.isArray(body)) {
    if (!body.length) return fail(null, ERR.request, 'Empty batch');
    const out = (await Promise.all(body.map(m => handleMessage(m, deps)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(body, deps);
}

module.exports = { handle, handleMessage, toolList, SERVER_INFO, SUPPORTED_VERSIONS, ERR, parseError: () => fail(null, ERR.parse, 'Parse error') };
