// /api/_mcp_tools.js
// The read-only tools the MCP server exposes, and the one place that calls the
// Freight Tiger APIs behind them.
//
//   FT_API_TOKEN   service credential, sent the way the apps send a session token
//                  (a `token` header and a Bearer Authorization header)
//   FT_API_BASE    defaults to https://api.freighttiger.com/api
//
// No token set -> isConfigured() is false, tools/call answers with an error and
// the Ask bot never offers these tools to the planner.
//
// Every tool is a GET. Each entry was read off the calls the production apps
// make (crm-app-native /support and the CM dashboard), not off a published
// spec, so `params` lists what those apps send and nothing more. Add an entry
// here and it appears in tools/list, in the stdio server and in the Ask bot's
// capability card without any other change.

const DEFAULT_BASE = 'https://api.freighttiger.com/api';
const TIMEOUT_MS = Number(process.env.FT_API_TIMEOUT_MS) || 15_000;
const MAX_RESPONSE_CHARS = 60_000;
const MAX_STRING_ARG = 128;

// Param types: string | integer. `path: true` fills a {placeholder} in the path
// instead of the query string.
const TOOLS = [
  {
    name: 'list_support_tickets',
    description: 'List FO support tickets (Pylon-backed) for one company, filtered by status. company_fteid and status are required.',
    path: '/phase-2/fo-app/support/tickets',
    params: {
      company_fteid: { type: 'string', required: true, description: 'Company FTEID the tickets belong to.' },
      status: { type: 'string', required: true, description: 'Ticket status exactly as the support screen sends it, e.g. open or closed.' },
      category: { type: 'string', description: 'Ticket category.' },
      shipment_id: { type: 'string', description: 'Only tickets raised against this shipment.' },
      journey_fteid: { type: 'string', description: 'Only tickets raised against this journey.' },
      trip_id: { type: 'string', description: 'Only tickets raised against this trip (display id).' },
      page: { type: 'integer', min: 0, default: 0, description: 'Zero-based page.' },
      size: { type: 'integer', min: 1, max: 50, default: 10, description: 'Page size.' }
    }
  },
  {
    name: 'support_tickets_summary',
    description: 'Ticket counts for one company, as shown at the top of the support screen.',
    path: '/phase-2/fo-app/support/tickets/summary',
    params: {
      company_fteid: { type: 'string', required: true, description: 'Company FTEID.' }
    }
  },
  {
    name: 'get_support_ticket',
    description: 'One support ticket by its Pylon ticket number, with its conversation.',
    path: '/phase-2/fo-app/support/tickets/pylon/{ticket_number}',
    params: {
      ticket_number: { type: 'string', required: true, path: true, description: 'Pylon ticket number.' }
    }
  },
  {
    name: 'support_configuration',
    description: 'Support configuration the apps load before raising a ticket: categories and options.',
    path: '/phase-2/fo-app/support/callback/configuration',
    params: {}
  },
  {
    name: 'fo_advance_queue',
    description: 'FO advance-payment queue: loads whose advance is applicable, pending or processed. One tab at a time.',
    path: '/phase-2/fo-advance/queue',
    params: {
      tab: { type: 'string', default: 'all_applicable', description: 'Queue tab. all_applicable and advance_processed are the two the dashboard shows counts for.' },
      page: { type: 'integer', min: 1, default: 1, description: 'One-based page.' },
      limit: { type: 'integer', min: 1, max: 100, default: 20, description: 'Rows per page.' }
    }
  },
  {
    name: 'fo_advance_queue_summary',
    description: 'Counts for the FO advance-payment queue: all_applicable and advance_processed.',
    path: '/phase-2/fo-advance/queue/summary',
    params: {}
  },
  {
    name: 'fo_advance_approvals',
    description: 'Approval history of an FO advance payment. Give exactly one of shipment_id, advance_request_id or case_id.',
    path: '/phase-2/fo-advance/approvals',
    params: {
      shipment_id: { type: 'string', description: 'Shipment the advance was requested for.' },
      advance_request_id: { type: 'string', description: 'Advance request id.' },
      case_id: { type: 'string', description: 'Approval case id.' }
    },
    oneOf: ['shipment_id', 'advance_request_id', 'case_id']
  }
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

function baseUrl() {
  return String(process.env.FT_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

function isConfigured() {
  return Boolean(process.env.FT_API_TOKEN);
}

function list() {
  return TOOLS;
}

function get(name) {
  return BY_NAME.get(name) || null;
}

// JSON Schema for tools/list.
function inputSchema(tool) {
  const properties = {};
  const required = [];
  for (const [key, p] of Object.entries(tool.params)) {
    const prop = { type: p.type, description: p.description };
    if (p.min !== undefined) prop.minimum = p.min;
    if (p.max !== undefined) prop.maximum = p.max;
    if (p.default !== undefined) prop.default = p.default;
    properties[key] = prop;
    if (p.required) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

// Checks and normalises arguments against the tool's own declaration. Unknown
// names are rejected rather than dropped: silently ignoring a filter would
// return an unfiltered list that reads as the answer to a narrowed question.
function validateArgs(tool, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object');
  }
  const unknown = Object.keys(args).filter(k => !(k in tool.params));
  if (unknown.length) throw new Error(`Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);

  const out = {};
  for (const [key, p] of Object.entries(tool.params)) {
    let v = args[key];
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new Error(`${key} is required`);
      if (p.default !== undefined) out[key] = p.default;
      continue;
    }
    if (p.type === 'integer') {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (!Number.isInteger(n)) throw new Error(`${key} must be an integer`);
      if (p.min !== undefined && n < p.min) throw new Error(`${key} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new Error(`${key} must be at most ${p.max}`);
      out[key] = n;
    } else {
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`${key} must be a string`);
      v = String(v).trim();
      if (!v) { if (p.required) throw new Error(`${key} is required`); continue; }
      if (v.length > MAX_STRING_ARG) throw new Error(`${key} is longer than ${MAX_STRING_ARG} characters`);
      out[key] = v;
    }
  }
  if (tool.oneOf && !tool.oneOf.some(k => out[k] !== undefined)) {
    throw new Error(`Give one of: ${tool.oneOf.join(', ')}`);
  }
  return out;
}

function buildUrl(tool, args) {
  let path = tool.path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (tool.params[key].path) path = path.replace(`{${key}}`, encodeURIComponent(value));
    else query.set(key, String(value));
  }
  const qs = query.toString();
  return `${baseUrl()}${path}${qs ? `?${qs}` : ''}`;
}

// Contact details and credentials never leave this layer: a ticket thread
// carries phone numbers and the Ask bot forwards results to a model.
const SENSITIVE_KEY = /phone|mobile|contact_number|e-?mail|token|password|passcode|otp|secret|authorization/i;

function redact(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Runs a tool. Resolves to { data } with the parsed, redacted response; throws
// an Error carrying `.status` when the API refuses.
async function call(name, rawArgs, { fetchImpl = fetch } = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'unknown_tool' });
  if (!isConfigured()) {
    throw Object.assign(new Error('FT_API_TOKEN is not set on this deployment.'), { code: 'not_configured' });
  }
  const args = validateArgs(tool, rawArgs);
  const url = buildUrl(tool, args);

  const token = process.env.FT_API_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', token, Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${name} timed out after ${Math.round(TIMEOUT_MS / 1000)}s.`);
    throw new Error(`Could not reach the Freight Tiger API: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // The body can echo the request; a short prefix is enough to diagnose.
    throw Object.assign(new Error(`${name} failed with ${res.status}. ${text.slice(0, 200)}`), { status: res.status });
  }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { data: redact(data), args };
}

// Compact JSON for a tool result, capped so one list cannot flood a client.
function render(data) {
  const json = JSON.stringify(data);
  return json.length > MAX_RESPONSE_CHARS
    ? `${json.slice(0, MAX_RESPONSE_CHARS)}…(truncated, ${json.length} chars)`
    : json;
}

module.exports = {
  list, get, inputSchema, validateArgs, buildUrl, call, render, redact, isConfigured, baseUrl, TOOLS
};
