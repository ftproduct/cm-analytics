// /api/_ask.js
// Natural-language questions against the cached snapshot, in two model calls.
//
//   plan(question)  -> metric specs, the same JSON /api/metrics accepts
//   execute(specs)  -> the engine computes them against the snapshot
//   phrase(result)  -> one to three lines
//
// The model never sees a row and never writes SQL. It chooses a kind, a
// dimension and a window from an allowlist that is generated from the live
// schema, and everything it returns is re-validated by _specs.js before it
// reaches an engine. So the worst a bad completion can do is fail validation
// and cost a retry -- it cannot invent a column, widen a scan, or make up a
// number, because the numbers in the answer are the ones the engine computed.
//
// Splitting plan from phrase is what keeps this cheap: neither prompt carries
// the dataset, so a question costs roughly 1.1k tokens end to end rather than
// however many the snapshot would be.

const llm = require('./_llm.js');
const source = require('./_source.js');
const S = require('./_schema.js');
const { KINDS, FILTER_KEYS, sanitiseSpecWithOwnWindow, unknownFilterKeys } = require('./_specs.js');

const MAX_PLAN_SPECS = 3;
// The phraser's whole input. Small on purpose: past a few hundred numbers a
// model starts summarising the payload rather than answering the question.
const MAX_PAYLOAD_CHARS = 4000;
const MAX_ROWS_PER_SPEC = 8;

// What each metric answers, in the words the planner needs to choose between
// them. Kept beside KINDS rather than inside the engine because this is prompt
// copy, not behaviour -- and assertCardCoversKinds() fails if one drifts.
const KIND_NOTES = {
  summary:     'headline totals for the window: total, success, failed, rate, tons, bookedValue, valueAtRisk, plus the same for the previous period',
  group:       'break the entity down by one dimension (needs groupBy); returns rows of {key,total,success,failed,rate,value,tons}',
  timeseries:  'volume and fill rate over time (needs grain: day|week|month)',
  reasons:     'why demand went unfulfilled — a Pareto of reasons with counts, share and value',
  funnel:      'inventory stage-to-stage conversion, MATCHED through PLACED',
  aging:       'conversion split by how long the PSA took to act',
  heatmap:     'a dimension against time (needs groupBy and grain)',
  movers:      'which groups moved most versus the previous period (needs groupBy)',
  leakage:     'lanes where demand went unfulfilled while inventory sat unconverted',
  imbalance:   'lanes where demand and supply are most out of balance',
  officeHours: 'volume and fill rate by hour of day and working vs non-working hours',
  rows:        'individual records — use only when someone asks for examples, never for a count',
  invMatch:    'inventory match funnel between demand and inventory',
  invMatchGroup: 'inventory match rates broken down by one dimension (needs groupBy)',
  invMatchDemandRows: 'individual demands with their inventory matches'
};

function assertCardCoversKinds() {
  const missing = [...KINDS].filter(k => !KIND_NOTES[k]);
  if (missing.length) throw new Error(`KIND_NOTES is missing: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// The capability card
// ---------------------------------------------------------------------------

// Everything the planner is allowed to name, derived from the schema at request
// time. A dimension that config/schema.json does not map never appears here, so
// the planner cannot ask for it.
function capabilityCard({ today, window, options = {}, mode }) {
  assertCardCoversKinds();

  const dims = entity => Object.values(S.availableDimensions(entity))
    .map(d => `${d.key} (${d.label})`).join(', ');

  // A handful of real values per filter, so the planner spells them the way the
  // data does rather than guessing at casing. /api/filters returns rows of
  // { value, count } -- both engines agree on that shape -- and the unfulfilment
  // reasons arrive under per-entity keys rather than the `reason` filter name.
  const OPTION_KEY = { reason: 'demandReason' };
  const sampleFilters = FILTER_KEYS
    .map(key => {
      const vals = options[OPTION_KEY[key] || key];
      if (!Array.isArray(vals) || !vals.length) return null;
      const sample = vals.slice(0, 8)
        .map(v => (typeof v === 'string' ? v : v?.value))
        .filter(v => typeof v === 'string' && v);
      if (!sample.length) return null;
      return `  ${key}: ${sample.join(' | ')}${vals.length > 8 ? ` … ${vals.length} total` : ''}`;
    })
    .filter(Boolean)
    .join('\n');

  return `You turn questions about a freight marketplace into metric specs. You never see the data; an engine runs your specs and another step writes the answer.

Today is ${today}. The cached data covers ${window.from || 'an unknown start'} to ${window.to || 'an unknown end'}${mode === 'demo' ? ' (generated demo data)' : ''}${window.truncated ? '. That sync hit its row limit, so nothing before that start date exists — never plan a window that begins earlier' : ''}.

Two entities:
  demand    — loads the shipper asked for. "Fulfilled" means a carrier took it.
  inventory — vehicles LSPs offered. "Converted" means it got placed on a load.

Metrics (kind):
${[...KINDS].map(k => `  ${k} — ${KIND_NOTES[k]}`).join('\n')}

Dimensions for groupBy:
  demand: ${dims('demand')}
  inventory: ${dims('inventory')}

Filters (each takes an array of exact strings):
${sampleFilters || '  (no filter values loaded)'}
  outcome: "success" (fulfilled only) | "fail" (unfulfilled only) | "all"
  from / to: YYYY-MM-DD. Always set both. Clamp to the covered window above.

Reply with JSON only, no prose:
  {"intent":"<what you are measuring, one short phrase>",
   "specs":[{"id":"a","entity":"demand","kind":"group","groupBy":"lsp","limit":5,
             "filters":{"from":"2026-08-01","to":"2026-08-31","outcome":"fail"}}]}

At most ${MAX_PLAN_SPECS} specs. Use two only when the question genuinely needs a comparison.
If the question cannot be answered from the metrics above, reply:
  {"clarify":"<one sentence asking for what you need, or saying what is not available>"}

Rules:
  - Never invent a kind, a groupBy or a filter key that is not listed.
  - "worst" / "lost the most" on demand means outcome:"fail" and reading the failed count.
  - Ranking questions use kind "group" with a limit of 5 unless asked otherwise.
  - Questions about a total or a rate use kind "summary".
  - Use kind "rows" only when asked for individual examples.`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

async function plan(question, ctx, history = []) {
  const system = capabilityCard(ctx);
  const messages = [
    { role: 'system', content: system },
    // Earlier turns give follow-ups ("and for the west zone?") something to
    // resolve against. Only the text is replayed, never the payloads.
    ...history.slice(-4).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 500)
    })),
    { role: 'user', content: question }
  ];

  const { text } = await llm.chat({ messages, maxTokens: 500, temperature: 0 });
  return llm.parseJsonObject(text);
}

// Validate what came back. Returns { specs } or throws with a message the
// planner can be shown on a retry.
function validatePlan(parsed, fallbackFilters) {
  if (parsed && typeof parsed.clarify === 'string' && parsed.clarify.trim()) {
    return { clarify: parsed.clarify.trim().slice(0, 300) };
  }
  const raw = Array.isArray(parsed?.specs) ? parsed.specs.slice(0, MAX_PLAN_SPECS) : [];
  if (!raw.length) throw new Error('No specs returned. Reply with {"specs":[...]} or {"clarify":"..."}.');

  const specs = raw.map((s, i) => {
    // sanitiseFilters drops a key it does not know. For the chat that would
    // mean running an unfiltered query while the phraser still believes the
    // question was narrowed -- and presenting the whole snapshot as the answer
    // for one carrier. Catch it here so the planner gets a chance to correct.
    const stray = unknownFilterKeys(s?.filters || {});
    if (stray.length) {
      throw new Error(`Unknown filter${stray.length > 1 ? 's' : ''}: ${stray.join(', ')}. Use only the filter names listed.`);
    }
    const spec = sanitiseSpecWithOwnWindow({ ...s, id: s?.id || `s${i}` }, fallbackFilters);
    // sanitiseSpec silently drops an unknown groupBy rather than throwing, but
    // for a chat that would mean answering a different question than the one
    // asked. Surface it so the retry can correct the name.
    if (spec.groupBy && !S.availableDimensions(spec.entity)[spec.groupBy]) {
      throw new Error(`"${spec.groupBy}" is not a ${spec.entity} dimension.`);
    }
    return spec;
  });

  return { specs, intent: typeof parsed?.intent === 'string' ? parsed.intent.slice(0, 200) : '' };
}

// ---------------------------------------------------------------------------
// Execute and shrink
// ---------------------------------------------------------------------------

async function execute(src, specs) {
  const settled = await Promise.all(specs.map(async spec => {
    try {
      return [spec.id, await source.runSpec(src, spec)];
    } catch (e) {
      return [spec.id, { error: e.message || 'Query failed' }];
    }
  }));
  return Object.fromEntries(settled);
}

function round(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v;
}

// Keep the shape but drop the tail. The phraser needs the top few rows and the
// totals; handing it 2,000 rows would cost more than the rest of the request
// and make the answer vaguer, not sharper.
function shrinkPayload(result) {
  if (!result || typeof result !== 'object') return result;
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      out[key] = value.slice(0, MAX_ROWS_PER_SPEC).map(row => {
        if (!row || typeof row !== 'object') return row;
        return Object.fromEntries(
          Object.entries(row)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => [k, round(v)])
        );
      });
      if (value.length > MAX_ROWS_PER_SPEC) out[`${key}_truncated`] = `${value.length} rows total, top ${MAX_ROWS_PER_SPEC} shown`;
    } else if (value && typeof value === 'object') {
      out[key] = shrinkPayload(value);
    } else {
      out[key] = round(value);
    }
  }
  return out;
}

function shrinkResults(results) {
  const out = {};
  for (const [id, payload] of Object.entries(results)) out[id] = shrinkPayload(payload);
  let json = JSON.stringify(out);
  // Belt and braces: a funnel plus a heatmap can still be large. Trim rows
  // further rather than letting the prompt grow without bound.
  if (json.length > MAX_PAYLOAD_CHARS) json = `${json.slice(0, MAX_PAYLOAD_CHARS)}…(truncated)`;
  return json;
}

// ---------------------------------------------------------------------------
// Phrase
// ---------------------------------------------------------------------------

const PHRASE_SYSTEM = `You write the answer to a question about freight marketplace data.

You are given the question and the numbers an engine computed for it. Write one to three short lines.

Rules:
  - Every figure you write must appear in the data. Never estimate, extrapolate or round beyond one decimal.
  - Lead with the number that answers the question. Name the thing it belongs to.
  - Add at most one line of context — a comparison, a share, or the runner-up — only if the data contains it.
  - Percentages in the data are already percentages. "rate" is the fill/conversion rate.
  - Large rupee values: write them as ₹1.2 Cr or ₹45.3 L.
  - If the data is empty or does not answer the question, say so plainly in one line.
  - No preamble, no bullet points, no markdown headings, no offers to help further.`;

async function phrase({ question, intent, specs, resultsJson, mode }) {
  const messages = [
    { role: 'system', content: PHRASE_SYSTEM },
    {
      role: 'user',
      content: `Question: ${question}
${intent ? `Measuring: ${intent}\n` : ''}Window: ${specs[0]?.filters?.from || '?'} to ${specs[0]?.filters?.to || '?'}${mode === 'demo' ? ' (demo data)' : ''}
Data: ${resultsJson}`
    }
  ];
  const { text } = await llm.chat({ messages, maxTokens: 250, temperature: 0 });
  return String(text || '').trim();
}

// ---------------------------------------------------------------------------
// The whole turn
// ---------------------------------------------------------------------------

// What the snapshot actually holds, which is not always what the sync asked for.
// A sync that hits MA_SYNC_MAX_ROWS keeps the requested window in `window` and
// records the real earliest row in `covers`. Telling the planner the requested
// window would have it happily build questions about months that were cut off,
// and get empty or half-populated answers back with nothing flagging why.
function coveredWindow(src, filters = {}) {
  const requested = src.snapshot?.window || { from: filters.from || null, to: filters.to || null };
  const covers = src.snapshot?.covers;
  if (!src.snapshot?.truncated || !covers) return requested;

  // The latest of the per-entity starts: before it, at least one entity is
  // missing rows, so a cross-entity answer there would be quietly wrong.
  const starts = [covers.demandFrom, covers.inventoryFrom, covers.bidsFrom]
    .filter(d => typeof d === 'string' && d);
  if (!starts.length) return requested;
  const from = starts.sort().pop();
  return from > (requested.from || '') ? { ...requested, from, truncated: true } : requested;
}

async function ask({ question, filters = {}, history = [] }) {
  const startedAt = Date.now();
  const src = await source.resolve();
  if (!src.dataset) {
    // Live mode means every spec would hit Databricks, and a chat invites far
    // more specs than a dashboard tab does. Refuse rather than run up a bill.
    throw Object.assign(new Error('Press Sync first — the assistant answers from the cached snapshot, not from live queries.'), { status: 409 });
  }

  const window = coveredWindow(src, filters);
  // Synchronous on the cached path, a promise on the live one. Filter values
  // are only there to help the planner spell names, so a failure here costs
  // nothing worth failing the turn over.
  let options = {};
  try { options = (await source.filterOptions(src, window)) || {}; } catch { options = {}; }
  const ctx = {
    today: new Date().toISOString().slice(0, 10),
    window,
    options,
    mode: src.mode
  };

  let parsed;
  let planned;
  try {
    parsed = await plan(question, ctx, history);
    planned = validatePlan(parsed, filters);
  } catch (e) {
    // One repair attempt with the failure quoted back. Models correct a wrong
    // dimension name reliably when told which one; a second failure is real.
    parsed = await plan(
      `${question}\n\n(Your previous reply was rejected: ${e.message} Reply with corrected JSON only.)`,
      ctx,
      history
    );
    planned = validatePlan(parsed, filters);
  }

  if (planned.clarify) {
    return { answer: planned.clarify, clarify: true, specs: [], data: null, mode: src.mode, tookMs: Date.now() - startedAt };
  }

  const results = await execute(src, planned.specs);
  const resultsJson = shrinkResults(results);
  const answer = await phrase({
    question,
    intent: planned.intent,
    specs: planned.specs,
    resultsJson,
    mode: src.mode
  });

  return {
    answer,
    intent: planned.intent,
    specs: planned.specs,
    data: results,
    mode: src.mode,
    syncedAt: src.snapshot?.syncedAt || null,
    tookMs: Date.now() - startedAt
  };
}

module.exports = {
  ask, plan, validatePlan, capabilityCard, coveredWindow, shrinkResults, shrinkPayload,
  assertCardCoversKinds, KIND_NOTES, MAX_PLAN_SPECS
};
