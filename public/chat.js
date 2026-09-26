// /public/chat.js
// The floating assistant.
//
// Asks /api/ask, which plans a metric spec, runs it against the cached snapshot
// and writes one to three lines. Every answer carries the spec that produced it,
// so "show the numbers" and "open as a view" are exact, not approximate.
//
// Current filters are read from the URL rather than from app.js. app.js already
// mirrors every filter change into the query string -- that is how "Copy view
// link" works -- so the URL is the state both features share, and this file
// stays decoupled from the dashboard's internals.

(function () {
  'use strict';

  const FILTER_KEYS = [
    'lane', 'superClusterLane', 'origin', 'destination', 'region', 'psa', 'lsp', 'shipper',
    'vehicleType', 'materialType', 'reason', 'laneType',
    'originSuperCluster', 'destinationSuperCluster', 'matchType'
  ];

  const SUGGESTIONS = [
    'Which lane lost the most demand?',
    'What is the fill rate this month vs last?',
    'Top 5 reasons demand went unfulfilled',
    'Which PSA converts inventory best?'
  ];

  const State = { open: false, busy: false, history: [], scoped: true };

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  // ------------------------------------------------------------ Filters

  function urlFilters() {
    const p = new URLSearchParams(location.search);
    const out = {};
    if (p.get('from')) out.from = p.get('from');
    if (p.get('to')) out.to = p.get('to');
    const outcome = p.get('outcome');
    if (outcome === 'success' || outcome === 'fail') out.outcome = outcome;
    for (const k of FILTER_KEYS) {
      const v = p.get(k);
      if (v) out[k] = v.split('~').filter(Boolean);
    }
    return out;
  }

  function scopeLabel(f) {
    const parts = [];
    if (f.from && f.to) parts.push(`${f.from} → ${f.to}`);
    if (f.outcome) parts.push(f.outcome === 'fail' ? 'unfulfilled only' : 'fulfilled only');
    const named = FILTER_KEYS.filter(k => f[k]?.length).length;
    if (named) parts.push(`${named} filter${named > 1 ? 's' : ''}`);
    return parts.join(' · ') || 'all cached data';
  }

  // Which tab shows this kind of answer, so "open as a view" lands somewhere
  // that actually contains the number rather than just the right filters.
  function tabForSpec(spec) {
    if (!spec) return 'overview';
    if (['leakage', 'imbalance', 'invMatch', 'invMatchGroup', 'invMatchDemandRows'].includes(spec.kind)) return 'matching';
    if (['psa', 'lsp'].includes(spec.groupBy)) return 'people';
    if (spec.entity === 'inventory') return 'inventory';
    if (spec.entity === 'bids') return 'bids';
    return 'demand';
  }

  function viewLink(spec) {
    const p = new URLSearchParams();
    p.set('tab', tabForSpec(spec));
    p.set('grain', spec.grain || 'week');
    const f = spec.filters || {};
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.outcome && f.outcome !== 'all') p.set('outcome', f.outcome);
    for (const k of FILTER_KEYS) {
      if (Array.isArray(f[k]) && f[k].length) p.set(k, f[k].join('~'));
    }
    return `${location.pathname}?${p}`;
  }

  // ------------------------------------------------------------- Render

  function bubble(role, node) {
    return h('div', { class: `chat-msg chat-msg-${role}` }, node);
  }

  function numbersTable(data) {
    // The first array of objects in the payload is the one worth showing; the
    // rest is available in the raw JSON below it.
    let rows = null;
    const walk = v => {
      if (rows || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        if (v.length && typeof v[0] === 'object') rows = v.slice(0, 8);
        return;
      }
      Object.values(v).forEach(walk);
    };
    walk(data);
    if (!rows) return null;

    const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].slice(0, 5);
    return h('table', { class: 'chat-table' },
      h('thead', {}, h('tr', {}, ...cols.map(c => h('th', { text: c })))),
      h('tbody', {}, ...rows.map(r => h('tr', {}, ...cols.map(c => {
        const v = r[c];
        return h('td', { text: v === null || v === undefined ? '—' : String(v) });
      }))))
    );
  }

  function answerNode(payload) {
    const wrap = h('div', {});
    wrap.appendChild(h('p', { class: 'chat-answer', text: payload.answer }));

    if (payload.mode === 'demo') {
      wrap.appendChild(h('p', { class: 'chat-flag', text: 'Demo data — not your warehouse.' }));
    }

    const spec = payload.specs?.[0];
    if (spec) {
      const table = numbersTable(payload.data);
      const details = h('details', { class: 'chat-details' },
        h('summary', { text: 'Show the numbers' }),
        table,
        h('pre', { class: 'chat-spec', text: JSON.stringify(payload.specs, null, 2) })
      );
      wrap.appendChild(details);
      wrap.appendChild(h('a', { class: 'chat-link', href: viewLink(spec), text: 'Open as a view →' }));
    }
    return wrap;
  }

  // -------------------------------------------------------------- Widget

  function build() {
    const log = h('div', { class: 'chat-log', id: 'chatLog', role: 'log', 'aria-live': 'polite' });

    const input = h('textarea', {
      class: 'chat-input',
      id: 'chatInput',
      rows: 1,
      placeholder: 'Ask about the cached data…',
      'aria-label': 'Ask a question about the data'
    });

    const scopeChip = h('button', {
      class: 'chat-scope',
      type: 'button',
      title: 'Answers are scoped to the dashboard filters. Click to ignore them.'
    });

    function paintScope() {
      const f = urlFilters();
      scopeChip.textContent = State.scoped ? `Scoped to: ${scopeLabel(f)}` : 'Ignoring dashboard filters';
      scopeChip.setAttribute('aria-pressed', String(State.scoped));
    }
    scopeChip.addEventListener('click', () => { State.scoped = !State.scoped; paintScope(); });

    const send = h('button', { class: 'chat-send', type: 'button', text: 'Ask', 'aria-label': 'Send question' });

    const panel = h('div', { class: 'chat-panel', id: 'chatPanel', role: 'dialog', 'aria-label': 'Data assistant', hidden: true },
      h('div', { class: 'chat-head' },
        h('div', {}, h('strong', { text: 'Ask the data' }),
          h('span', { class: 'chat-sub', text: 'answers from the cached snapshot' })),
        h('button', { class: 'chat-close', type: 'button', 'aria-label': 'Close assistant', text: '✕', onclick: () => toggle(false) })
      ),
      log,
      h('div', { class: 'chat-foot' }, scopeChip, h('div', { class: 'chat-row' }, input, send))
    );

    const launcher = h('button', {
      class: 'chat-launcher',
      id: 'chatLauncher',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': 'chatPanel',
      title: 'Ask a question about the data'
    }, h('span', { text: 'Ask' }));

    launcher.addEventListener('click', () => toggle(!State.open));

    function toggle(open) {
      State.open = open;
      panel.hidden = !open;
      launcher.setAttribute('aria-expanded', String(open));
      launcher.classList.toggle('is-open', open);
      if (open) { paintScope(); greetOnce(); input.focus(); }
    }

    let greeted = false;
    function greetOnce() {
      if (greeted) return;
      greeted = true;
      const chips = h('div', { class: 'chat-chips' },
        ...SUGGESTIONS.map(s => h('button', {
          class: 'chat-chip', type: 'button', text: s,
          onclick: () => { input.value = s; submit(); }
        })));
      log.appendChild(bubble('bot', h('div', {},
        h('p', { class: 'chat-answer', text: 'Ask anything the dashboard can measure. I read the cached snapshot, so answers cost nothing in Databricks.' }),
        chips)));
    }

    async function submit() {
      const question = input.value.trim();
      if (!question || State.busy) return;
      input.value = '';
      input.style.height = 'auto';

      log.appendChild(bubble('you', h('p', { text: question })));
      const pending = bubble('bot', h('p', { class: 'chat-thinking', text: 'Working it out…' }));
      log.appendChild(pending);
      log.scrollTop = log.scrollHeight;

      State.busy = true;
      send.disabled = true;
      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            filters: State.scoped ? urlFilters() : {},
            history: State.history.slice(-4)
          })
        });
        const payload = await res.json().catch(() => ({}));
        pending.remove();

        if (!res.ok) {
          log.appendChild(bubble('bot', h('p', { class: 'chat-error', text: payload.error || `Request failed (${res.status}).` })));
        } else {
          log.appendChild(bubble('bot', answerNode(payload)));
          State.history.push({ role: 'user', content: question });
          State.history.push({ role: 'assistant', content: payload.answer });
        }
      } catch (e) {
        pending.remove();
        log.appendChild(bubble('bot', h('p', { class: 'chat-error', text: e.message || 'Could not reach the assistant.' })));
      } finally {
        State.busy = false;
        send.disabled = false;
        log.scrollTop = log.scrollHeight;
        input.focus();
      }
    }

    send.addEventListener('click', submit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && State.open) toggle(false);
    });

    document.body.appendChild(panel);
    document.body.appendChild(launcher);
  }

  // The bubble only appears where an LLM gateway is configured, so a deployment
  // without one looks exactly as it did before.
  async function init() {
    try {
      const res = await fetch('/api/ask');
      if (!res.ok) return;
      const { enabled } = await res.json();
      if (enabled) build();
    } catch { /* no assistant, no bubble */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
