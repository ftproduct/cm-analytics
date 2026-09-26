// /api/ask.js
// The chat endpoint.
//
//   GET  /api/ask  -> { enabled, model } so the UI knows whether to show the bubble
//   POST /api/ask  -> { question, filters, history } -> { answer, specs, data }
//
// Reads the cached snapshot only. See _ask.js for why the model never touches
// a row.

const { requireAccess } = require('./_auth.js');
const llm = require('./_llm.js');
const ask = require('./_ask.js');

const MAX_QUESTION_CHARS = 500;

// Per-instance, per-principal throttle. A warm lambda is the only thing that
// sees a burst from one person, so this does not need to be shared state to be
// useful -- it exists to stop a stuck client looping, not to bill anyone.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const hits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const bucket = (hits.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  bucket.push(now);
  hits.set(key, bucket);
  if (hits.size > 500) hits.clear(); // bounded; a cleared bucket only forgives
  return bucket.length > RATE_MAX;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    if (!requireAccess(req, res)) return;
    res.status(200).json({ enabled: llm.isConfigured(), model: llm.config().model || null });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST' }); return; }

  const principal = requireAccess(req, res);
  if (!principal) return;

  if (!llm.isConfigured()) {
    res.status(503).json({
      error: 'The assistant is not configured for this deployment. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.'
    });
    return;
  }

  if (rateLimited(principal.email || principal.user || 'shared')) {
    res.status(429).json({ error: 'Too many questions in a row. Give it a minute.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const question = String(body.question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) { res.status(400).json({ error: 'Ask a question.' }); return; }

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

  try {
    const out = await ask.ask({ question, filters: body.filters || {}, history });
    res.status(200).json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || 'The assistant could not answer that.' });
  }
};
