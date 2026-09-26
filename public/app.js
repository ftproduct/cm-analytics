/* app.js — dashboard shell: state, filters, tab rendering, insight narrative.
 *
 * One request per tab: every panel on a tab is declared as a metric spec and
 * they are batched into a single POST /api/metrics call.
 */
(function () {
  'use strict';

  const F = Charts.fmt;
  const $ = sel => document.querySelector(sel);

  // ------------------------------------------------------------------ State

  const FILTER_KEYS = ['lane', 'superClusterLane', 'origin', 'destination', 'region', 'psa', 'lsp', 'shipper', 'vehicleType', 'materialType', 'reason', 'laneType', 'originSuperCluster', 'destinationSuperCluster'];

  // Always-visible filters sit in the primary row; everything else lives under More.
  const MORE_FILTER_KEYS = ['region', 'origin', 'destination', 'lane', 'psa', 'lsp', 'shipper', 'vehicleType', 'materialType'];

  const State = {
    tab: 'overview',
    grain: 'week',
    imbalanceSide: 'demand', // demand-heavy | supply-heavy tab on overview
    mapMetric: 'fillRate',   // demand | inventory | fillRate — India map colour
    mapLaneLimit: 50,
    filters: { from: null, to: null, outcome: 'all' },
    meta: null,
    options: {},
    user: null,
    loading: false,
    syncing: false,
    sync: null,           // snapshot status from /api/sync
    moreFiltersOpen: false
  };

  const OPTION_SOURCE = {
    lane: 'lane', superClusterLane: 'superClusterLane',
    origin: 'origin', destination: 'destination', region: 'region',
    psa: 'psa', lsp: 'lsp', shipper: 'shipper', vehicleType: 'vehicleType',
    materialType: 'materialType',
    laneType: 'laneType',
    originSuperCluster: 'originSuperCluster',
    destinationSuperCluster: 'destinationSuperCluster'
  };

  const CHIP_LABEL = {
    lane: 'Cluster lane', superClusterLane: 'Supercluster lane',
    origin: 'Origin', destination: 'Destination', region: 'Zone',
    psa: 'PSA', lsp: 'LSP', shipper: 'Shipper', vehicleType: 'Vehicle', materialType: 'Material',
    laneType: 'Power / non-power',
    originSuperCluster: 'Origin supercluster',
    destinationSuperCluster: 'Dest supercluster'
  };

  // "3 min ago" beats a timestamp for the one question people ask of a cache.
  function relativeAge(seconds) {
    if (seconds === null || seconds === undefined) return 'never';
    if (seconds < 45) return 'just now';
    if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  function isoDaysAgo(n) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const JULY_FROM = '2026-07-01';

  const DATE_PRESETS = [
    { key: '7d', label: 'Last 7 days', from: () => isoDaysAgo(6), to: () => isoDaysAgo(0) },
    { key: '30d', label: 'Last 30 days', from: () => isoDaysAgo(29), to: () => isoDaysAgo(0) },
    { key: '90d', label: 'Last 90 days', from: () => isoDaysAgo(89), to: () => isoDaysAgo(0) },
    { key: '180d', label: 'Last 180 days', from: () => isoDaysAgo(179), to: () => isoDaysAgo(0) },
    { key: 'jul', label: 'Since July', from: () => JULY_FROM, to: () => isoDaysAgo(0) },
    { key: 'mtd', label: 'Month to date', from: () => new Date().toISOString().slice(0, 8) + '01', to: () => isoDaysAgo(0) }
  ];

  // ------------------------------------------------------------- URL sync

  function readUrl() {
    const p = new URLSearchParams(location.search);
    State.tab = p.get('tab') || 'overview';
    State.grain = ['day', 'week', 'month'].includes(p.get('grain')) ? p.get('grain') : 'week';
    State.mapMetric = ['demand', 'inventory', 'fillRate'].includes(p.get('mapMetric'))
      ? p.get('mapMetric') : 'fillRate';
    State.mapLaneLimit = [25, 50, 80].includes(Number(p.get('mapLimit'))) ? Number(p.get('mapLimit')) : 50;
    State.filters.from = p.get('from') || JULY_FROM;
    State.filters.to = p.get('to') || isoDaysAgo(0);
    State.filters.outcome = ['success', 'fail'].includes(p.get('outcome')) ? p.get('outcome') : 'all';
    for (const k of FILTER_KEYS) {
      const v = p.get(k);
      if (v) State.filters[k] = v.split('~').filter(Boolean);
      else delete State.filters[k];
    }
    // Surface secondary filters when the URL already carries them.
    if (moreFiltersActiveCount() > 0) State.moreFiltersOpen = true;
  }

  function writeUrl(push = false) {
    const p = new URLSearchParams();
    p.set('tab', State.tab);
    p.set('grain', State.grain);
    if (State.tab === 'map') {
      p.set('mapMetric', State.mapMetric);
      if (State.mapLaneLimit !== 50) p.set('mapLimit', String(State.mapLaneLimit));
    }
    if (State.filters.from) p.set('from', State.filters.from);
    if (State.filters.to) p.set('to', State.filters.to);
    if (State.filters.outcome !== 'all') p.set('outcome', State.filters.outcome);
    for (const k of FILTER_KEYS) {
      const v = State.filters[k];
      if (Array.isArray(v) && v.length) p.set(k, v.join('~'));
    }
    const url = `${location.pathname}?${p}`;
    if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
  }

  function activeFilters() {
    const out = { from: State.filters.from, to: State.filters.to, outcome: State.filters.outcome };
    for (const k of FILTER_KEYS) {
      if (Array.isArray(State.filters[k]) && State.filters[k].length) out[k] = State.filters[k];
    }
    return out;
  }

  // --------------------------------------------------------------- Fetching

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.login) { location.href = body.login + '?next=' + encodeURIComponent(location.pathname + location.search); return null; }
    }
    const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  }

  async function fetchMetrics(specs) {
    return api('/api/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: activeFilters(), specs })
    });
  }

  // --------------------------------------------------------- Filter controls

  let openPopover = null;
  function closePopover() {
    if (!openPopover) return;
    openPopover.el.remove();
    openPopover.trigger?.setAttribute('aria-expanded', 'false');
    openPopover = null;
  }
  document.addEventListener('click', e => {
    if (openPopover && !openPopover.host.contains(e.target)) closePopover();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePopover(); });

  function chipSummary(key) {
    const sel = State.filters[key];
    if (!sel || !sel.length) return 'All';
    if (sel.length === 1) return sel[0];
    return `${sel.length} selected`;
  }

  function moreFiltersActiveCount() {
    return MORE_FILTER_KEYS.reduce((n, k) => {
      const v = State.filters[k];
      return n + (Array.isArray(v) && v.length ? 1 : 0);
    }, 0);
  }

  function syncMoreFiltersUi() {
    const panel = $('#moreFilters');
    const btn = $('#moreFiltersBtn');
    if (!panel || !btn) return;

    const active = moreFiltersActiveCount();
    panel.hidden = !State.moreFiltersOpen;
    btn.setAttribute('aria-expanded', String(State.moreFiltersOpen));
    btn.classList.toggle('has-active', active > 0);
    btn.innerHTML =
      (State.moreFiltersOpen ? 'Fewer filters' : 'More filters') +
      (active > 0 ? `<span class="more-filters-count" id="moreFiltersCount">${active}</span>` : '');
  }

  function buildFilterChips() {
    for (const [key, source] of Object.entries(OPTION_SOURCE)) {
      const host = document.querySelector(`.filter-chip[data-filter="${key}"]`);
      if (!host) continue;
      const options = State.options[source] || [];
      // A dimension with no values in this deployment is not a usable control.
      if (!options.length) { host.hidden = true; host.innerHTML = ''; continue; }
      host.hidden = false;

      const active = (State.filters[key] || []).length > 0;
      host.classList.toggle('is-active', active);
      host.innerHTML =
        `<button type="button" aria-haspopup="true" aria-expanded="false">` +
        `<span class="chip-label">${CHIP_LABEL[key]}</span>` +
        `<span class="chip-value">${escapeHtml(chipSummary(key))}</span></button>`;

      host.querySelector('button').addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = openPopover?.key === key;
        closePopover();
        if (!wasOpen) openMultiSelect(host, key, options);
      });
    }
    renderDateChip();
    document.querySelectorAll('#outcomeToggle button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.outcome === State.filters.outcome));
    });
    syncMoreFiltersUi();
  }

  function openMultiSelect(host, key, options) {
    const pop = document.createElement('div');
    pop.className = 'popover';
    pop.innerHTML =
      `<input type="search" placeholder="Search ${CHIP_LABEL[key].toLowerCase()}…" aria-label="Search ${CHIP_LABEL[key]}">` +
      `<div class="popover-list"></div>` +
      `<div class="popover-footer">` +
      `<button class="ghost-btn" data-act="clear" type="button">Clear</button>` +
      `<button class="primary-btn" data-act="apply" type="button">Apply</button></div>`;
    host.appendChild(pop);
    const trigger = host.querySelector('button');
    trigger.setAttribute('aria-expanded', 'true');
    openPopover = { el: pop, host, key, trigger };

    const chosen = new Set(State.filters[key] || []);
    const list = pop.querySelector('.popover-list');
    const search = pop.querySelector('input');

    function paint(term = '') {
      const t = term.trim().toLowerCase();
      const shown = options.filter(o => !t || String(o.value).toLowerCase().includes(t)).slice(0, 300);
      list.innerHTML = shown.map(o =>
        `<button class="popover-option" type="button" data-v="${escapeHtml(o.value)}">` +
        `<span class="check">${chosen.has(o.value) ? '✓' : ''}</span>` +
        `<span class="name">${escapeHtml(o.value)}</span>` +
        `<span class="count">${F.int(o.count)}</span></button>`).join('') ||
        `<p class="chart-empty">No matches.</p>`;
      list.querySelectorAll('.popover-option').forEach(b => {
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          const v = b.dataset.v;
          if (chosen.has(v)) chosen.delete(v); else chosen.add(v);
          b.querySelector('.check').textContent = chosen.has(v) ? '✓' : '';
        });
      });
    }
    paint();
    search.addEventListener('input', () => paint(search.value));
    setTimeout(() => search.focus(), 0);

    pop.addEventListener('click', e => e.stopPropagation());
    pop.querySelector('[data-act="clear"]').addEventListener('click', () => {
      delete State.filters[key];
      closePopover();
      onFiltersChanged();
    });
    pop.querySelector('[data-act="apply"]').addEventListener('click', () => {
      if (chosen.size) State.filters[key] = [...chosen]; else delete State.filters[key];
      closePopover();
      onFiltersChanged();
    });
  }

  function currentPresetKey() {
    return DATE_PRESETS.find(p => p.from() === State.filters.from && p.to() === State.filters.to)?.key || null;
  }

  function renderDateChip() {
    const host = document.querySelector('.filter-chip[data-filter="dates"]');
    const preset = DATE_PRESETS.find(p => p.key === currentPresetKey());
    const text = preset ? preset.label : `${F.shortDate(State.filters.from)} – ${F.shortDate(State.filters.to)}`;
    host.classList.add('is-active');
    host.innerHTML =
      `<button type="button" aria-haspopup="true" aria-expanded="false">` +
      `<span class="chip-label">Dates</span><span class="chip-value">${escapeHtml(text)}</span></button>`;
    host.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = openPopover?.key === 'dates';
      closePopover();
      if (!wasOpen) openDatePopover(host);
    });
  }

  function openDatePopover(host) {
    const pop = document.createElement('div');
    pop.className = 'popover';
    const active = currentPresetKey();
    pop.innerHTML =
      DATE_PRESETS.map(p =>
        `<button class="preset-row" type="button" data-preset="${p.key}">` +
        `<span class="check">${active === p.key ? '✓' : ''}</span>${p.label}</button>`).join('') +
      `<div class="popover-footer" style="flex-direction:column;gap:6px">` +
      `<label class="sr-only" for="dFrom">From</label>` +
      `<input id="dFrom" type="date" value="${State.filters.from}">` +
      `<label class="sr-only" for="dTo">To</label>` +
      `<input id="dTo" type="date" value="${State.filters.to}">` +
      `<button class="primary-btn" data-act="custom" type="button">Apply custom range</button></div>`;
    host.appendChild(pop);
    host.querySelector('button').setAttribute('aria-expanded', 'true');
    openPopover = { el: pop, host, key: 'dates', trigger: host.querySelector('button') };

    pop.addEventListener('click', e => e.stopPropagation());
    pop.querySelectorAll('[data-preset]').forEach(b => {
      b.addEventListener('click', () => {
        const p = DATE_PRESETS.find(x => x.key === b.dataset.preset);
        State.filters.from = p.from();
        State.filters.to = p.to();
        closePopover();
        onFiltersChanged(true);
      });
    });
    pop.querySelector('[data-act="custom"]').addEventListener('click', () => {
      const from = pop.querySelector('#dFrom').value;
      const to = pop.querySelector('#dTo').value;
      if (!from || !to) return;
      State.filters.from = from <= to ? from : to;
      State.filters.to = from <= to ? to : from;
      closePopover();
      onFiltersChanged(true);
    });
  }

  async function onFiltersChanged(reloadOptions = false) {
    writeUrl();
    buildFilterChips();
    if (reloadOptions) loadFilterOptions().then(buildFilterChips);
    render();
  }

  // --------------------------------------------------------------- Rendering

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function panel(title, note, opts = {}) {
    const span = opts.span || 6;
    const actions = opts.actions || '';
    return `<section class="panel col-${span}" ${opts.id ? `id="${opts.id}"` : ''}>
      <div class="panel-head"><h3>${title}</h3><div class="panel-actions">${actions}</div></div>
      ${note ? `<p class="panel-note">${note}</p>` : ''}
      ${opts.legend || ''}
      <div class="panel-body" data-body="${opts.body}"><div class="loading">Loading…</div></div>
    </section>`;
  }

  function legend(pairs) {
    return `<div class="legend">${pairs.map(([label, role]) =>
      `<span><i style="--k:${role}"></i>${label}</span>`).join('')}</div>`;
  }

  function deltaHtml(curr, prev, opts = {}) {
    if (curr === null || curr === undefined || prev === null || prev === undefined) return '';
    const diff = Math.round((curr - prev) * 10) / 10;
    if (!Number.isFinite(diff)) return '';
    // "Higher is better" is not universal — untouched inventory rising is bad.
    const good = opts.inverse ? diff < 0 : diff > 0;
    const dir = diff === 0 ? '' : good ? 'up' : 'down';
    const arrow = diff === 0 ? '→' : diff > 0 ? '▲' : '▼';
    const text = opts.points ? F.pts(diff) : (opts.money ? F.money(diff) : `${diff > 0 ? '+' : ''}${F.int(diff)}`);
    return `<div class="delta ${dir}">${arrow} <strong>${text}</strong> <span>vs prev period</span></div>`;
  }

  function tile(label, valueHtml, delta = '') {
    return `<div class="tile"><span class="label">${label}</span>
      <div class="value">${valueHtml}</div>${delta}</div>`;
  }

  function body(name) { return document.querySelector(`[data-body="${name}"]`); }

  function showError(host, message) {
    if (host) host.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
  }

  function fill(name, payload, renderFn) {
    const host = body(name);
    if (!host) return;
    if (!payload) { showError(host, 'No data returned.'); return; }
    if (payload.error) { showError(host, payload.error); return; }
    if (payload.unavailable) { Charts.emptyState(host, payload.unavailable); return; }
    host.innerHTML = '';
    try { renderFn(host, payload); }
    catch (e) { showError(host, e.message || 'Could not render this panel.'); }
  }

  // Rate bars are coloured by the entity, never by rank, and always carry the
  // rate as a direct label so identity never depends on colour alone.
  function rateMeta(r) { return `${F.int(r.total)} · ${F.pct(r.rate)} fill`; }

  function rateTip(labelNoun, successNoun) {
    return r => `<strong>${escapeHtml(r.key)}</strong><br>` +
      `${F.int(r.total)} ${labelNoun}<br>` +
      `<span class="tip-key" style="--k:var(--series-1)"></span>${successNoun} ${F.int(r.success)} (${F.pct(r.rate)})<br>` +
      `<span class="tip-key" style="--k:var(--series-2)"></span>Missed ${F.int(r.failed)}` +
      (r.medianLatencyHours != null ? `<br><span class="tip-muted">Median ${F.hours(r.medianLatencyHours)}</span>` : '');
  }

  const LANE_SORT_MIN = 5;
  const LANE_DISPLAY = 10;

  function sortLaneRows(rows, sort) {
    const list = [...(rows || [])];
    if (sort === 'rate') {
      return list
        .filter(r => (r.total || 0) >= LANE_SORT_MIN)
        .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total)
        .slice(0, LANE_DISPLAY);
    }
    return list
      .sort((a, b) => b.total - a.total || (b.rate ?? -1) - (a.rate ?? -1))
      .slice(0, LANE_DISPLAY);
  }

  let overviewLanes = null;

  function paintLaneSide(host, rows, title) {
    if (!host) return;
    host.innerHTML =
      `<div class="subpanel-head"><h4>${title}</h4></div>` +
      `<div data-lane-chart></div>`;
    const chart = host.querySelector('[data-lane-chart]');
    Charts.rankedBars(chart, rows, {
      stack: true,
      meta: r => `${F.int(r.total)} · ${F.pct(r.rate)} fill`,
      tip: rateTip('demands', 'Fulfilled'),
      labelRatio: 0.34,
      onSelect: r => { State.filters.superClusterLane = [r.key]; onFiltersChanged(); }
    });
  }

  function paintOverviewLanes(host, payload) {
    const byDemand = sortLaneRows(payload?.rows, 'demand');
    const byRate = sortLaneRows(payload?.rows, 'rate');
    host.innerHTML =
      `<div class="panel-grid lane-split">` +
        `<div class="col-6" data-lane-side="demand"></div>` +
        `<div class="col-6" data-lane-side="rate"></div>` +
      `</div>`;
    paintLaneSide(host.querySelector('[data-lane-side="demand"]'), byDemand, 'Ranked by demand');
    paintLaneSide(host.querySelector('[data-lane-side="rate"]'), byRate, 'Ranked by fill rate');
  }

  // ------------------------------------------------------- Insight narrative

  // ------------------------------------------------------------------- Tabs

  const grainToggle = () =>
    `<div class="segmented" data-role="grain" role="group" aria-label="Time grain">` +
    ['day', 'week', 'month'].map(g =>
      `<button type="button" data-grain="${g}" aria-pressed="${State.grain === g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join('') +
    `</div>`;

  function wireGrainToggles() {
    document.querySelectorAll('[data-role="grain"] button').forEach(b => {
      b.addEventListener('click', () => {
        State.grain = b.dataset.grain;
        writeUrl();
        render();
      });
    });
  }

  const imbalanceToggle = () =>
    `<div class="segmented" data-role="imbalance" role="group" aria-label="Imbalance side">` +
    [
      { key: 'demand', label: 'Demand > inventory' },
      { key: 'supply', label: 'Inventory > demand' }
    ].map(t =>
      `<button type="button" data-side="${t.key}" aria-pressed="${State.imbalanceSide === t.key}">${t.label}</button>`
    ).join('') +
    `</div>`;

  let overviewImbalance = null;

  function imbalanceCols() {
    return [
      { key: 'lane', label: 'Supercluster lane', format: escapeHtml },
      { key: 'demand', label: 'Demand', align: 'right', format: F.int },
      { key: 'supply', label: 'Inventory', align: 'right', format: F.int },
      { key: 'gap', label: 'Gap', align: 'right', format: v => `<span class="bad">${F.int(v)}</span>` },
      { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct },
      { key: 'coverage', label: 'Inventory / demand', align: 'right', format: v => v == null ? '—' : Number(v).toFixed(2) }
    ];
  }

  function paintImbalance(host, payload) {
    const side = State.imbalanceSide === 'supply' ? 'supplyHeavy' : 'demandHeavy';
    const rows = payload?.[side] || [];
    const cols = imbalanceCols();
    const empty = State.imbalanceSide === 'supply'
      ? 'No supercluster lane has meaningfully more inventory than demand in this window.'
      : 'No supercluster lane has meaningfully more demand than inventory in this window.';
    Charts.table(host, rows, cols, {
      emptyMessage: empty,
      onSelect: r => {
        State.filters.superClusterLane = [r.lane];
        onFiltersChanged();
      }
    });
    wireCsv('imbalance', rows, cols, `imbalance-${State.imbalanceSide}-supercluster.csv`);
  }

  function wireImbalanceToggle() {
    document.querySelectorAll('[data-role="imbalance"] button').forEach(b => {
      b.addEventListener('click', () => {
        State.imbalanceSide = b.dataset.side;
        document.querySelectorAll('[data-role="imbalance"] button').forEach(x => {
          x.setAttribute('aria-pressed', String(x.dataset.side === State.imbalanceSide));
        });
        const host = body('imbalance');
        if (host && overviewImbalance && !overviewImbalance.error) {
          paintImbalance(host, overviewImbalance);
        }
      });
    });
  }

  function csvButton(id, label = 'CSV') {
    return `<button class="ghost-btn" data-csv="${id}" type="button">${label}</button>`;
  }

  function wireCsv(id, rows, columns, filename) {
    const btn = document.querySelector(`[data-csv="${id}"]`);
    if (btn) btn.addEventListener('click', () => Charts.downloadCsv(filename, rows, columns));
  }

  // ---- Executive overview ----------------------------------------------

  async function renderOverview() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('Zone overview', 'High-level demand by origin zone — North / South / East / West / Central. Mapped from liquid-lane city / origin supercluster (e.g. Bombay→West, Delhi NCR→North). Click a bar to filter.', { span: 6, body: 'zones', actions: csvButton('zones') })}
        ${panel('Power lane vs non power lane', 'Demand volume and fill rate split by liquid/power lane flag. Use the Lane type filter to lock the rest of the dashboard to one side.', { span: 6, body: 'laneTypeSplit', actions: csvButton('laneTypeSplit') })}
        ${panel('Demand vs fulfilment over time', 'Volume with the unfulfilled portion stacked on top, so the gap is visible rather than inferred.', { span: 12, body: 'trend', actions: grainToggle(), legend: legend([['Fulfilled', 'var(--series-1)'], ['Unfulfilled', 'var(--series-2)']]) })}
        ${panel('Top supercluster lanes', 'Two rankings side by side. Each bar splits fulfilled (green) and unfulfilled (orange) — the green share is the fill rate. Label = demands · fill %. Tap a lane to filter.', {
          span: 12,
          body: 'lanes',
          legend: legend([
            ['Fulfilled', 'var(--series-3)'],
            ['Unfulfilled', 'var(--series-2)']
          ])
        })}
        ${panel('Probable imbalance lanes', 'Supercluster lanes where demand and inventory-match volume diverge. Demand-heavy = more loads than inventory matches; inventory-heavy = more inventory matches than loads. Tap a lane to filter the dashboard.', {
          span: 12,
          body: 'imbalance',
          actions: imbalanceToggle() + csvButton('imbalance')
        })}
        ${panel('Supercluster lanes losing ground', 'Biggest fill-rate drops against the previous period of equal length. Lanes under 12 loads in either period are excluded as noise.', { span: 6, body: 'declining', actions: csvButton('declining') })}
        ${panel('Supercluster lanes gaining', 'The same comparison in the other direction — worth understanding and copying.', { span: 6, body: 'improving', actions: csvButton('improving') })}
        ${panel('Created by time of day', 'Demands split by creation hour in IST: 9am–1pm, 1pm–7pm, and everything else as after office hours.', { span: 6, body: 'officeHours', actions: csvButton('officeHours') })}
        ${panel('Why demand went unfilled', 'Cancel code when captured; otherwise the demand status (lapsed, no vehicle, rate enquiry, …). Ranked by frequency with cumulative share on each bar.', { span: 6, body: 'reasons' })}
      </div>`;
    wireGrainToggles();
    wireImbalanceToggle();

    const res = await fetchMetrics([
      { id: 'demandSummary', entity: 'demand', kind: 'summary' },
      { id: 'invSummary', entity: 'inventory', kind: 'invMatch' },
      { id: 'trend', entity: 'demand', kind: 'timeseries', grain: State.grain },
      { id: 'reasons', entity: 'demand', kind: 'reasons', limit: 8 },
      { id: 'officeHours', entity: 'demand', kind: 'officeHours' },
      { id: 'zones', entity: 'demand', kind: 'group', groupBy: 'region', limit: 10 },
      { id: 'lanes', entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 40 },
      { id: 'laneTypeSplit', entity: 'demand', kind: 'group', groupBy: 'laneType', limit: 5 },
      { id: 'movers', entity: 'demand', kind: 'movers', groupBy: 'superClusterLane', limit: 8 },
      { id: 'imbalance', kind: 'imbalance', limit: 20 }
    ]);
    if (!res) return;
    const R = res.results;

    renderOverviewTiles(R.demandSummary, R.invSummary, R.trend);

    fill('zones', R.zones, (host, p) => {
      Charts.rankedBars(host, p.rows, {
        meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
        onSelect: r => { State.filters.region = [r.key]; onFiltersChanged(); }
      });
      wireCsv('zones', p.rows || [], [
        { key: 'key', label: 'Zone' },
        { key: 'total', label: 'Demands', align: 'right', format: F.int },
        { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
        { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
      ], 'demand-by-zone.csv');
    });

    fill('officeHours', R.officeHours, (host, p) => {
      Charts.rankedBars(host, p.rows || [], {
        meta: r => `${F.int(r.total)} · ${F.pct(r.share)} · ${F.pct(r.rate)} fill`,
        tip: r => `<strong>${escapeHtml(r.key)}</strong><br>` +
          `${F.int(r.total)} demands (${F.pct(r.share)} of window)<br>` +
          `<span class="tip-key" style="--k:var(--series-1)"></span>Fulfilled ${F.int(r.success)} (${F.pct(r.rate)})<br>` +
          `<span class="tip-key" style="--k:var(--series-2)"></span>Missed ${F.int(r.failed)}` +
          `<br><span class="tip-muted">Hours in IST (Asia/Kolkata)</span>`
      });
      wireCsv('officeHours', p.rows || [], [
        { key: 'key', label: 'Time slot' },
        { key: 'total', label: 'Demands', align: 'right', format: F.int },
        { key: 'share', label: 'Share', align: 'right', format: F.pct },
        { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
        { key: 'failed', label: 'Unfulfilled', align: 'right', format: F.int },
        { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
      ], 'demand-by-office-hours.csv');
    });

    fill('laneTypeSplit', R.laneTypeSplit, (host, p) => {
      Charts.rankedBars(host, p.rows, {
        meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
        onSelect: r => { State.filters.laneType = [r.key]; onFiltersChanged(); }
      });
      wireCsv('laneTypeSplit', p.rows || [], [
        { key: 'key', label: 'Lane type' },
        { key: 'total', label: 'Demands', align: 'right', format: F.int },
        { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
        { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
      ], 'powerlane-split.csv');
    });

    fill('trend', R.trend, (host, p) => Charts.stackedBars(host, p.rows, {
      successLabel: 'Fulfilled', failLabel: 'Unfulfilled', rateLabel: 'Fill rate'
    }));

    fill('reasons', R.reasons, (host, p) => Charts.rankedBars(host, p.rows, {
      value: r => r.count,
      colorRole: 'var(--series-2)',
      labelRatio: 0.42,
      meta: r => `${F.pct(r.share)} · ${F.pct(r.cumulative)} cum`,
      tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.count)} misses (${F.pct(r.share)})<br>` +
        `<span class="tip-muted">${F.pct(r.cumulative)} cumulative · ${F.money(r.value)} at risk</span>`
    }));

    fill('lanes', R.lanes, (host, p) => {
      overviewLanes = p;
      paintOverviewLanes(host, p);
    });

    overviewImbalance = R.imbalance;
    fill('imbalance', R.imbalance, host => paintImbalance(host, R.imbalance));

    const moverCols = [
      { key: 'key', label: 'Supercluster lane' },
      { key: 'total', label: 'Loads', align: 'right', format: F.int },
      { key: 'prevRate', label: 'Prior fill rate', align: 'right', format: F.pct },
      { key: 'rate', label: 'Current fill rate', align: 'right', format: F.pct },
      { key: 'rateDelta', label: 'Fill rate change', align: 'right', format: v => `<span class="${v >= 0 ? 'good' : 'bad'}">${F.pts(v)}</span>` }
    ];
    fill('declining', R.movers, (host, p) => Charts.table(host, p.declining, moverCols, { emptyMessage: 'No supercluster lane moved enough to report.' }));
    fill('improving', R.movers, (host, p) => Charts.table(host, p.improving, moverCols, { emptyMessage: 'No supercluster lane moved enough to report.' }));
    wireCsv('declining', R.movers?.declining || [], moverCols, 'supercluster-lanes-declining.csv');
    wireCsv('improving', R.movers?.improving || [], moverCols, 'supercluster-lanes-improving.csv');
  }

  function renderOverviewTiles(d, i, trend) {
    const host = $('#tiles');
    if (!host) return;
    if (!d || d.error) { host.innerHTML = `<div class="error-box">${escapeHtml(d?.error || 'Summary unavailable')}</div>`; return; }
    const c = d.current, p = d.previous;
    const ic = i?.current, ip = i?.previous;

    // Volume first (demand / fulfilled / unfulfilled); rates are secondary.
    host.innerHTML = [
      tile('Demands', F.int(c.total), deltaHtml(c.total, p?.total)),
      tile('Fulfilled', F.int(c.success), deltaHtml(c.success, p?.success)),
      tile('Unfulfilled', F.int(c.failed), deltaHtml(c.failed, p?.failed, { inverse: true })),
      tile('Fill rate', `${F.pct(c.rate)}`, deltaHtml(c.rate, p?.rate, { points: true })),
      ic ? tile('Inv. matches', F.int(ic.demandMatched ?? ic.total), deltaHtml(ic.demandMatched ?? ic.total, ip?.demandMatched ?? ip?.total)) : '',
      ic ? tile('Inv. placed (Exact)', F.int(ic.demandPlacedExact ?? ic.success), deltaHtml(ic.demandPlacedExact ?? ic.success, ip?.demandPlacedExact ?? ip?.success)) : '',
      ic ? tile('Inv. placed (Origin)', F.int(ic.demandPlacedOrigin ?? ic.failed), '') : ''
    ].filter(Boolean).join('');

    // Sparkline of fulfilled volume inside the Fulfilled tile.
    const fulfilled = (trend?.rows || []).map(r => r.success).filter(v => v != null);
    if (fulfilled.length > 2) {
      const tileEl = host.children[1];
      const spark = document.createElement('div');
      spark.className = 'spark';
      tileEl.appendChild(spark);
      Charts.sparkline(spark, fulfilled, { width: tileEl.clientWidth - 28, height: 30 });
    }
  }

  // ---- Demand -----------------------------------------------------------

  async function renderDemand() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('Zone overview', 'Demand by origin zone (North / South / East / West / Central), mapped from liquid-lane city / supercluster. Click to filter.', { span: 4, body: 'zones', actions: csvButton('zones') })}
        ${panel('Demand over time', 'Unfulfilled volume stacked above fulfilled.', { span: 8, body: 'trend', actions: grainToggle(), legend: legend([['Fulfilled', 'var(--series-1)'], ['Unfulfilled', 'var(--series-2)']]) })}
        ${panel('Created by time of day', 'Demands split by creation hour in IST: 9am–1pm, 1pm–7pm, and everything else as after office hours. Fill rate sits beside each slot.', { span: 6, body: 'officeHours', actions: csvButton('officeHours') })}
        ${panel('Unfulfilment reasons', 'Cancel code when present, else demand status. Frequency-ranked with cumulative share and value at risk.', { span: 6, body: 'reasons', actions: csvButton('reasons') })}
        ${panel('Supercluster-wise demand', 'Click a bar to filter the whole dashboard to that origin→destination supercluster lane.', { span: 6, body: 'lanes', actions: csvButton('lanes') })}
        ${panel('LSP-wise demand', 'Volume by carrier with the fill rate each one delivered. "Unknown" is demand that never reached a carrier — its size is itself a finding.', { span: 6, body: 'lsps', actions: csvButton('lsps') })}
        ${panel('Fill rate by supercluster lane over time', 'Fill rate by supercluster lane and week. A row that fades across the grid is a lane going wrong.', { span: 12, body: 'heat' })}
        ${panel('Demand by vehicle type', 'Where the requirement sits, and whether that vehicle class is being served.', { span: 6, body: 'vehicles' })}
        ${panel('Demand by shipper', 'Account-level view — concentration here is a commercial risk as much as an ops one.', { span: 6, body: 'shippers', actions: csvButton('shippers') })}
      </div>`;
    wireGrainToggles();

    const res = await fetchMetrics([
      { id: 'summary', entity: 'demand', kind: 'summary' },
      { id: 'trend', entity: 'demand', kind: 'timeseries', grain: State.grain },
      { id: 'officeHours', entity: 'demand', kind: 'officeHours' },
      { id: 'reasons', entity: 'demand', kind: 'reasons', limit: 12 },
      { id: 'zones', entity: 'demand', kind: 'group', groupBy: 'region', limit: 10 },
      { id: 'lanes', entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 15 },
      { id: 'lsps', entity: 'demand', kind: 'group', groupBy: 'lsp', limit: 15 },
      { id: 'heat', entity: 'demand', kind: 'heatmap', grain: State.grain === 'day' ? 'week' : State.grain, limit: 12 },
      { id: 'vehicles', entity: 'demand', kind: 'group', groupBy: 'vehicleType', limit: 10 },
      { id: 'shippers', entity: 'demand', kind: 'group', groupBy: 'shipper', limit: 12 }
    ]);
    if (!res) return;
    const R = res.results;

    renderEntityTiles(R.summary, 'demand', R.trend);

    fill('trend', R.trend, (host, p) => Charts.stackedBars(host, p.rows, {}));

    fill('officeHours', R.officeHours, (host, p) => {
      Charts.rankedBars(host, p.rows || [], {
        meta: r => `${F.int(r.total)} · ${F.pct(r.share)} · ${F.pct(r.rate)} fill`,
        tip: r => `<strong>${escapeHtml(r.key)}</strong><br>` +
          `${F.int(r.total)} demands (${F.pct(r.share)} of window)<br>` +
          `<span class="tip-key" style="--k:var(--series-1)"></span>Fulfilled ${F.int(r.success)} (${F.pct(r.rate)})<br>` +
          `<span class="tip-key" style="--k:var(--series-2)"></span>Missed ${F.int(r.failed)}` +
          `<br><span class="tip-muted">Hours in IST (Asia/Kolkata)</span>`
      });
      wireCsv('officeHours', p.rows || [], [
        { key: 'key', label: 'Time slot' },
        { key: 'total', label: 'Demands', align: 'right', format: F.int },
        { key: 'share', label: 'Share', align: 'right', format: F.pct },
        { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
        { key: 'failed', label: 'Unfulfilled', align: 'right', format: F.int },
        { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
      ], 'demand-by-office-hours.csv');
    });

    const reasonCols = [
      { key: 'key', label: 'Reason' },
      { key: 'count', label: 'Misses', align: 'right', format: F.int },
      { key: 'share', label: 'Share', align: 'right', format: F.pct },
      { key: 'cumulative', label: 'Cumulative', align: 'right', format: F.pct },
      { key: 'value', label: 'Value at risk', align: 'right', format: F.money }
    ];
    fill('reasons', R.reasons, (host, p) => Charts.rankedBars(host, p.rows, {
      value: r => r.count, colorRole: 'var(--series-2)', labelRatio: 0.42,
      meta: r => `${F.pct(r.share)} · ${F.pct(r.cumulative)} cum`,
      tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.count)} misses (${F.pct(r.share)})<br>` +
        `<span class="tip-muted">${F.pct(r.cumulative)} cumulative · ${F.money(r.value)} lost</span>`
    }));
    wireCsv('reasons', R.reasons?.rows || [], reasonCols, 'unfulfilment-reasons.csv');

    const groupCols = noun => ([
      { key: 'key', label: noun },
      { key: 'total', label: 'Demands', align: 'right', format: F.int },
      { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct },
      { key: 'medianLatencyHours', label: 'Median TAT', align: 'right', format: F.hours },
      { key: 'value', label: 'Value', align: 'right', format: F.money }
    ]);

    fill('zones', R.zones, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
      onSelect: r => { State.filters.region = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('zones', R.zones?.rows || [], groupCols('Zone'), 'demand-by-zone.csv');

    fill('lanes', R.lanes, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
      onSelect: r => { State.filters.superClusterLane = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('lanes', R.lanes?.rows || [], groupCols('Supercluster lane'), 'demand-by-supercluster-lane.csv');

    fill('lsps', R.lsps, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
      onSelect: r => { State.filters.lsp = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('lsps', R.lsps?.rows || [], groupCols('LSP'), 'demand-by-lsp.csv');

    fill('heat', R.heat, (host, p) => Charts.heatmapGrid(host, p, { rateLabel: 'Fill rate' }));
    fill('vehicles', R.vehicles, (host, p) => Charts.rankedBars(host, p.rows, { meta: rateMeta, tip: rateTip('demands', 'Fulfilled') }));
    fill('shippers', R.shippers, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('demands', 'Fulfilled'),
      onSelect: r => { State.filters.shipper = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('shippers', R.shippers?.rows || [], groupCols('Shipper'), 'demand-by-shipper.csv');
  }

  function renderEntityTiles(s, entity, trend) {
    const host = $('#tiles');
    if (!host) return;
    if (!s || s.error) { host.innerHTML = `<div class="error-box">${escapeHtml(s?.error || 'Summary unavailable')}</div>`; return; }
    const c = s.current, p = s.previous;

    const tiles = entity === 'demand' ? [
      tile('Demands', F.int(c.total), deltaHtml(c.total, p?.total)),
      tile('Fulfilled', F.int(c.success), deltaHtml(c.success, p?.success)),
      tile('Unfulfilled', F.int(c.failed), deltaHtml(c.failed, p?.failed, { inverse: true })),
      tile('Fill rate', F.pct(c.rate), deltaHtml(c.rate, p?.rate, { points: true })),
      tile('Median TAT', F.hours(c.medianLatencyHours), deltaHtml(c.medianLatencyHours, p?.medianLatencyHours, { inverse: true })),
      tile('P90 TAT', F.hours(c.p90LatencyHours), deltaHtml(c.p90LatencyHours, p?.p90LatencyHours, { inverse: true })),
      tile('Value at risk', F.money(c.valueAtRisk), deltaHtml(c.valueAtRisk, p?.valueAtRisk, { money: true, inverse: true })),
      tile('Active lanes', F.int(c.uniqueLanes), deltaHtml(c.uniqueLanes, p?.uniqueLanes))
    ] : [
      tile('Postings', F.int(c.total), deltaHtml(c.total, p?.total)),
      tile('Converted', F.int(c.success), deltaHtml(c.success, p?.success)),
      tile('Not converted', F.int(c.failed), deltaHtml(c.failed, p?.failed, { inverse: true })),
      tile('Conversion rate', F.pct(c.rate), deltaHtml(c.rate, p?.rate, { points: true })),
      tile('Never touched', F.pct(c.untouchedRate), deltaHtml(c.untouchedRate, p?.untouchedRate, { points: true, inverse: true })),
      tile('Median time to first touch', F.hours(c.medianTouchHours), deltaHtml(c.medianTouchHours, p?.medianTouchHours, { inverse: true })),
      tile('Median time to convert', F.hours(c.medianLatencyHours), deltaHtml(c.medianLatencyHours, p?.medianLatencyHours, { inverse: true })),
      tile('Idle capacity', `${F.int(c.capacityTons)}<span class="unit"> t</span>`, '')
    ];
    host.innerHTML = tiles.filter(Boolean).join('');

    const rates = (trend?.rows || []).map(r => r.rate).filter(v => v !== null);
    if (rates.length > 2) {
      const tileEl = host.children[3];
      const spark = document.createElement('div');
      spark.className = 'spark';
      tileEl.appendChild(spark);
      Charts.sparkline(spark, rates, { width: tileEl.clientWidth - 28, height: 30 });
    }
  }

  // ---- Inventory (Metabase 1190 demand↔inventory match) ----------------

  async function renderInventory() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('Exact match funnel', 'Lane matches only: matched → called → vehicle available → demand placed (Metabase 1190).', { span: 6, body: 'exactFunnel' })}
        ${panel('Origin match funnel', 'Origin matches only — the broader inventory pool against the same demand set.', { span: 6, body: 'originFunnel' })}
        ${panel('Inventory matches over time', 'Match volume with demands that placed via inventory stacked as success.', { span: 6, body: 'trend', actions: grainToggle(), legend: legend([['Placed (match rows)', 'var(--series-1)'], ['Not placed', 'var(--series-2)']]) })}
        ${panel('Why inventory matches did not place', 'Demand status / call answer when the match did not lead to FT placement.', { span: 6, body: 'reasons', actions: csvButton('reasons') })}
        ${panel('Inventory — city wise', 'Demands matched with inventory, Exact vs Origin split, and funnel counts by origin city.', { span: 12, body: 'city', actions: csvButton('city') })}
        ${panel('Inventory — PSA wise', 'Same funnel by PSA (Demand_Bot_PSA excluded).', { span: 12, body: 'psa', actions: csvButton('psa') })}
        ${panel('Inventory — demand wise (Exact match)', 'One row per demand with Exact/Lane inventory matches. Call and availability detail inline.', { span: 12, body: 'demandRows', actions: csvButton('demandRows') })}
      </div>`;
    wireGrainToggles();

    const res = await fetchMetrics([
      { id: 'summary', entity: 'inventory', kind: 'invMatch' },
      { id: 'exactFunnel', entity: 'inventory', kind: 'funnel', filters: { matchType: ['Exact'] } },
      { id: 'originFunnel', entity: 'inventory', kind: 'funnel', filters: { matchType: ['Origin'] } },
      { id: 'trend', entity: 'inventory', kind: 'timeseries', grain: State.grain },
      { id: 'reasons', entity: 'inventory', kind: 'reasons', limit: 12 },
      { id: 'city', entity: 'inventory', kind: 'invMatchGroup', groupBy: 'originSuperCluster', limit: 30 },
      { id: 'psa', entity: 'inventory', kind: 'invMatchGroup', groupBy: 'psa', limit: 40 },
      { id: 'demandRows', entity: 'inventory', kind: 'invMatchDemandRows', matchType: 'Exact', limit: 150 }
    ]);
    if (!res) return;
    const R = res.results;

    renderInvMatchTiles(R.summary);

    fill('exactFunnel', R.exactFunnel, (host, p) => Charts.funnelChart(host, p.rows));
    fill('originFunnel', R.originFunnel, (host, p) => Charts.funnelChart(host, p.rows));

    fill('trend', R.trend, (host, p) => Charts.stackedBars(host, p.rows, {
      successLabel: 'Placed', failLabel: 'Not placed', rateLabel: 'Place rate'
    }));

    const reasonCols = [
      { key: 'key', label: 'Reason' },
      { key: 'count', label: 'Matches', align: 'right', format: F.int },
      { key: 'share', label: 'Share', align: 'right', format: F.pct },
      { key: 'cumulative', label: 'Cumulative', align: 'right', format: F.pct }
    ];
    fill('reasons', R.reasons, (host, p) => Charts.rankedBars(host, p.rows, {
      value: r => r.count, colorRole: 'var(--series-2)', labelRatio: 0.42,
      meta: r => `${F.pct(r.share)} · ${F.pct(r.cumulative)} cum`,
      tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.count)} matches (${F.pct(r.share)})`
    }));
    wireCsv('reasons', R.reasons?.rows || [], reasonCols, 'inventory-match-reasons.csv');

    const matchCols = [
      { key: 'key', label: 'City / PSA' },
      { key: 'demandMatched', label: 'Demands matched', align: 'right', format: F.int },
      { key: 'demandExact', label: 'Demands Exact', align: 'right', format: F.int },
      { key: 'demandOrigin', label: 'Demands Origin', align: 'right', format: F.int },
      { key: 'exactInventoryMatches', label: 'Inv Exact', align: 'right', format: F.int },
      { key: 'originInventoryMatches', label: 'Inv Origin', align: 'right', format: F.int },
      { key: 'exactCalled', label: 'Exact called', align: 'right', format: F.int },
      { key: 'exactVehicleAvailable', label: 'Exact avail', align: 'right', format: F.int },
      { key: 'demandPlacedExact', label: 'Placed Exact', align: 'right', format: F.int },
      { key: 'originCalled', label: 'Origin called', align: 'right', format: F.int },
      { key: 'originVehicleAvailable', label: 'Origin avail', align: 'right', format: F.int },
      { key: 'demandPlacedOrigin', label: 'Placed Origin', align: 'right', format: F.int }
    ];

    fill('city', R.city, (host, p) => Charts.table(host, p.rows || [], matchCols.map((c, i) =>
      i === 0 ? { ...c, label: 'City' } : c
    ), { emptyMessage: 'No inventory matches in this window.' }));
    wireCsv('city', R.city?.rows || [], matchCols.map((c, i) => i === 0 ? { ...c, label: 'City' } : c), 'inventory-by-city.csv');

    fill('psa', R.psa, (host, p) => Charts.table(host, p.rows || [], matchCols.map((c, i) =>
      i === 0 ? { ...c, label: 'PSA' } : c
    ), { emptyMessage: 'No PSA attribution on inventory matches.' }));
    wireCsv('psa', R.psa?.rows || [], matchCols.map((c, i) => i === 0 ? { ...c, label: 'PSA' } : c), 'inventory-by-psa.csv');

    const demandCols = [
      { key: 'demandId', label: 'Demand' },
      { key: 'createdDate', label: 'Created' },
      { key: 'psa', label: 'PSA' },
      { key: 'city', label: 'City' },
      { key: 'status', label: 'Status' },
      { key: 'matchCount', label: 'Exact matches', align: 'right', format: F.int },
      { key: 'acted', label: 'Acted', align: 'right', format: F.int },
      { key: 'directCalls', label: 'Direct', align: 'right', format: F.int },
      { key: 'indirectCalls', label: 'Indirect', align: 'right', format: F.int },
      { key: 'vehicleAvailable', label: 'Veh avail', align: 'right', format: F.int },
      { key: 'placementAvailable', label: 'Placement', align: 'right', format: F.int },
      { key: 'matchedInventoryIds', label: 'Inventory IDs' }
    ];
    fill('demandRows', R.demandRows, (host, p) => Charts.table(host, p.rows || [], demandCols, {
      emptyMessage: 'No Exact inventory matches in this window.'
    }));
    wireCsv('demandRows', R.demandRows?.rows || [], demandCols, 'inventory-demand-exact.csv');
  }

  function renderInvMatchTiles(s) {
    const host = $('#tiles');
    if (!host) return;
    if (!s || s.error) {
      host.innerHTML = `<div class="error-box">${escapeHtml(s?.error || 'Summary unavailable')}</div>`;
      return;
    }
    const c = s.current || {};
    const p = s.previous || {};
    host.innerHTML = [
      tile('Demands matched', F.int(c.demandMatched), deltaHtml(c.demandMatched, p.demandMatched)),
      tile('Exact / Origin demands', `${F.int(c.demandExact)} / ${F.int(c.demandOrigin)}`, ''),
      tile('Inventory matches', `${F.int(c.exactInventoryMatches)} / ${F.int(c.originInventoryMatches)}`,
        '<span class="tile-note">Exact / Origin</span>'),
      tile('Exact called', F.int(c.exactCalled),
        `Direct ${F.int(c.exactCalledDirect)} · Indirect ${F.int(c.exactCalledIndirect)}`),
      tile('Exact vehicle avail', F.int(c.exactVehicleAvailable), deltaHtml(c.exactVehicleAvailable, p.exactVehicleAvailable)),
      tile('Placed (Exact)', F.int(c.demandPlacedExact), deltaHtml(c.demandPlacedExact, p.demandPlacedExact)),
      tile('Origin called', F.int(c.originCalled),
        `Direct ${F.int(c.originCalledDirect)} · Indirect ${F.int(c.originCalledIndirect)}`),
      tile('Placed (Origin)', F.int(c.demandPlacedOrigin), deltaHtml(c.demandPlacedOrigin, p.demandPlacedOrigin))
    ].join('');
  }

  // ---- FO App bids ------------------------------------------------------

  async function renderBids() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('Bid → act → fulfil', 'FO App bids only. Fulfilled = linked demand status VEHICLE_PLACED_BY_FT. Time to act is bid placed → first PSA call/accept.', { span: 6, body: 'funnel' })}
        ${panel('Why the bid was not fulfilled', 'Best available reason: acceptance comment, DS comment, cancellation reason, call answer, or demand status.', { span: 6, body: 'reasons', actions: csvButton('reasons') })}
        ${panel('Time to act on bid vs fulfilment', 'Fulfilment rate by how long the bid waited before PSA acted (call or accept).', { span: 6, body: 'aging', legend: legend([['Fulfilment rate', 'var(--series-3)']]) })}
        ${panel('Bids over time', 'FT-fulfilled volume with the rest stacked on top.', { span: 6, body: 'trend', actions: grainToggle(), legend: legend([['Fulfilled', 'var(--series-1)'], ['Not fulfilled', 'var(--series-2)']]) })}
        ${panel('PSA handling FO App bids', 'Bids touched, fulfilment, and median time to act.', { span: 6, body: 'psa', actions: csvButton('psa') })}
        ${panel('FO placing bids', 'Which FOs bid from the app and how often those bids convert to FT placement.', { span: 6, body: 'fos', actions: csvButton('fos') })}
        ${panel('Recent FO App bids', 'Row-level: bid time, time to act, outcome, and probable reason when not fulfilled.', { span: 12, body: 'rows', actions: csvButton('rows') })}
      </div>`;
    wireGrainToggles();

    const res = await fetchMetrics([
      { id: 'summary', entity: 'bids', kind: 'summary' },
      { id: 'funnel', entity: 'bids', kind: 'funnel' },
      { id: 'reasons', entity: 'bids', kind: 'reasons', limit: 12 },
      { id: 'aging', entity: 'bids', kind: 'aging' },
      { id: 'trend', entity: 'bids', kind: 'timeseries', grain: State.grain },
      { id: 'psa', entity: 'bids', kind: 'group', groupBy: 'psa', limit: 15 },
      { id: 'fos', entity: 'bids', kind: 'group', groupBy: 'lsp', limit: 15 },
      { id: 'rows', entity: 'bids', kind: 'rows', limit: 100 }
    ]);
    if (!res) return;
    const R = res.results;

    renderEntityTiles(R.summary, 'inventory', R.trend);

    fill('funnel', R.funnel, (host, p) => Charts.funnelChart(host, p.rows));

    fill('reasons', R.reasons, (host, p) => Charts.rankedBars(host, p.rows, {
      value: r => r.count, colorRole: 'var(--series-2)', labelRatio: 0.42,
      meta: r => `${F.pct(r.share)} · ${F.pct(r.cumulative)} cum`,
      tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.count)} bids (${F.pct(r.share)})`
    }));
    wireCsv('reasons', R.reasons?.rows || [], [
      { key: 'key', label: 'Reason' },
      { key: 'count', label: 'Bids', align: 'right', format: F.int },
      { key: 'share', label: 'Share', align: 'right', format: F.pct }
    ], 'fo-bid-reasons.csv');

    fill('aging', R.aging, (host, p) => Charts.rankedBars(host, p.rows, {
      value: r => r.rate ?? 0,
      label: r => r.bucket,
      colorRole: 'var(--series-3)',
      max: 100,
      meta: r => `${F.pct(r.rate)} of ${F.int(r.total)}`,
      tip: r => `<strong>Acted ${r.bucket === 'Never touched' ? 'never' : 'in ' + r.bucket}</strong><br>` +
        `${F.int(r.converted)} of ${F.int(r.total)} fulfilled (${F.pct(r.rate)})`
    }));

    fill('trend', R.trend, (host, p) => Charts.stackedBars(host, p.rows, {
      successLabel: 'Fulfilled', failLabel: 'Not fulfilled', rateLabel: 'Fulfilment'
    }));

    fill('psa', R.psa, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('bids', 'Fulfilled'),
      onSelect: r => { State.filters.psa = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('psa', R.psa?.rows || [], [
      { key: 'key', label: 'PSA' },
      { key: 'total', label: 'Bids', align: 'right', format: F.int },
      { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'rate', label: 'Rate', align: 'right', format: F.pct },
      { key: 'medianLatencyHours', label: 'Median time to act', align: 'right', format: F.hours }
    ], 'fo-bids-by-psa.csv');

    fill('fos', R.fos, (host, p) => Charts.rankedBars(host, p.rows, {
      meta: rateMeta, tip: rateTip('bids', 'Fulfilled'),
      onSelect: r => { State.filters.lsp = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('fos', R.fos?.rows || [], [
      { key: 'key', label: 'FO' },
      { key: 'total', label: 'Bids', align: 'right', format: F.int },
      { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'rate', label: 'Rate', align: 'right', format: F.pct }
    ], 'fo-bids-by-fo.csv');

    const rowCols = [
      { key: 'createdAt', label: 'Bid at', format: v => escapeHtml(String(v || '').replace('T', ' ').slice(0, 19)) },
      { key: 'lsp', label: 'FO', format: escapeHtml },
      { key: 'psa', label: 'PSA', format: escapeHtml },
      { key: 'lane', label: 'Lane', format: escapeHtml },
      { key: 'touchHours', label: 'Time to act', align: 'right', format: F.hours },
      { key: 'outcome', label: 'Outcome', format: escapeHtml },
      { key: 'reason', label: 'Reason if not', format: escapeHtml }
    ];
    fill('rows', R.rows, (host, p) => Charts.table(host, p.rows || [], rowCols, {
      emptyMessage: 'No FO App bids in this window. Re-sync after deploying the bids pull.'
    }));
    wireCsv('rows', R.rows?.rows || [], rowCols, 'fo-app-bids.csv');
  }

  // ---- Matching ---------------------------------------------------------

  async function renderMatching() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('Zone overview', 'Demand by origin zone (North / South / East / West / Central) from the liquid-lane city map — high-level cut before supercluster lanes.', { span: 12, body: 'zones', actions: csvButton('zones') })}
        ${panel('Demand fulfilment by supercluster lane', 'Demand, fulfilled, and unfulfilled volume at origin→destination supercluster grain. Sorted by unfulfilled.', { span: 12, body: 'lanes', actions: csvButton('lanes') })}
        ${panel('Where supply sat idle next to unfilled demand', 'Only supercluster lanes where both sides missed in the same window. Matchable = trips that should have closed.', { span: 12, body: 'leak', actions: csvButton('leak') })}
        ${panel('Demand vs supply volume by supercluster lane', 'Posted capacity beside demand for the busiest supercluster lanes.', { span: 12, body: 'sides', legend: legend([['Demand', 'var(--series-1)'], ['Supply posted', 'var(--series-3)']]) })}
      </div>`;

    const res = await fetchMetrics([
      { id: 'demandSummary', entity: 'demand', kind: 'summary' },
      { id: 'zones', entity: 'demand', kind: 'group', groupBy: 'region', limit: 10 },
      { id: 'demandLanes', entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 40 },
      { id: 'leak', kind: 'leakage', limit: 25 },
      { id: 'supplyLanes', entity: 'inventory', kind: 'group', groupBy: 'superClusterLane', limit: 200 }
    ]);
    if (!res) return;
    const R = res.results;

    const ds = R.demandSummary?.current;
    const tileHost = $('#tiles');
    if (tileHost && ds) {
      tileHost.innerHTML = [
        tile('Demands', F.int(ds.total), deltaHtml(ds.total, R.demandSummary?.previous?.total)),
        tile('Fulfilled', F.int(ds.success), deltaHtml(ds.success, R.demandSummary?.previous?.success)),
        tile('Unfulfilled', F.int(ds.failed), deltaHtml(ds.failed, R.demandSummary?.previous?.failed, { inverse: true }))
      ].join('');
    } else if (tileHost) {
      tileHost.innerHTML = '';
    }

    const zoneCols = [
      { key: 'key', label: 'Zone', format: escapeHtml },
      { key: 'total', label: 'Demand', align: 'right', format: F.int },
      { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'failed', label: 'Unfulfilled', align: 'right', format: v => `<span class="bad">${F.int(v)}</span>` },
      { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
    ];
    fill('zones', R.zones, (host, p) => Charts.table(host, p.rows || [], zoneCols, {
      emptyMessage: 'No zone data — re-sync to map origin supercluster → zone (liquid-lane city grain).'
    }));
    wireCsv('zones', R.zones?.rows || [], zoneCols, 'demand-fulfilment-by-zone.csv');

    const laneRows = [...(R.demandLanes?.rows || [])]
      .map(r => ({
        lane: r.key,
        demand: r.total,
        fulfilled: r.success,
        unfulfilled: r.failed,
        rate: r.rate
      }))
      .sort((a, b) => b.unfulfilled - a.unfulfilled || b.demand - a.demand);

    const laneCols = [
      { key: 'lane', label: 'Supercluster lane', format: escapeHtml },
      { key: 'demand', label: 'Demand', align: 'right', format: F.int },
      { key: 'fulfilled', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'unfulfilled', label: 'Unfulfilled', align: 'right', format: v => `<span class="bad">${F.int(v)}</span>` },
      { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct }
    ];
    fill('lanes', { ok: true, rows: laneRows }, (host, p) => Charts.table(host, p.rows, laneCols, {
      emptyMessage: 'No demand in this window.'
    }));
    wireCsv('lanes', laneRows, laneCols, 'demand-fulfilment-by-supercluster-lane.csv');

    const leakRows = [...(R.leak?.rows || [])].filter(r => r.matchable > 0);
    const leakCols = [
      { key: 'lane', label: 'Supercluster lane' },
      { key: 'demand', label: 'Demand', align: 'right', format: F.int },
      { key: 'fulfilled', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'unfulfilled', label: 'Unfulfilled', align: 'right', format: F.int },
      { key: 'supply', label: 'Supply', align: 'right', format: F.int },
      { key: 'unconverted', label: 'Idle trucks', align: 'right', format: F.int },
      { key: 'matchable', label: 'Matchable', align: 'right', format: v => `<span class="bad">${F.int(v)}</span>` },
      { key: 'valueAtRisk', label: 'Value at risk', align: 'right', format: F.money }
    ];
    fill('leak', { ok: true, rows: leakRows }, (host, p) => Charts.table(host, p.rows, leakCols, {
      emptyMessage: 'No supercluster lane had unfilled demand and idle supply at the same time in this window.'
    }));
    wireCsv('leak', leakRows, leakCols, 'matching-loss-by-supercluster-lane.csv');

    fill('sides', R.demandLanes, (host, p) => {
      const supply = new Map((R.supplyLanes?.rows || []).map(r => [r.key, r.total]));
      const rows = (p.rows || []).slice(0, 12).map(r => ({
        key: r.key, demand: r.total, supply: supply.get(r.key) || 0
      }));
      const max = Math.max(...rows.flatMap(r => [r.demand, r.supply]), 1);
      host.innerHTML = `<div class="panel-grid"><div class="col-6" data-sub="d"></div><div class="col-6" data-sub="s"></div></div>`;
      Charts.rankedBars(host.querySelector('[data-sub="d"]'), rows, {
        value: r => r.demand, max, colorRole: 'var(--series-1)',
        meta: r => F.int(r.demand),
        tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.demand)} demands`
      });
      Charts.rankedBars(host.querySelector('[data-sub="s"]'), rows, {
        value: r => r.supply, max, colorRole: 'var(--series-3)',
        meta: r => F.int(r.supply),
        tip: r => `<strong>${escapeHtml(r.key)}</strong><br>${F.int(r.supply)} trucks posted`
      });
    });
  }

  // ---- India map --------------------------------------------------------
  // Real India outline with origin→destination supercluster lane arcs.
  // Colour = selected metric (darker = stronger); width = volume.

  const CITY_COORDS = {"Adilabad":[78.5,19.7],"Agra":[78,27.2],"Ahmedabad":[72.6,23],"Aligarh":[78.1,27.9],"Allahabad":[81.8,25.4],"Almora":[79.7,29.6],"Ambala":[76.8,30.4],"Amritsar":[74.9,31.6],"Anantapur":[77.6,14.7],"Arunachal Pradesh":[87.8,24],"Aurangabad":[75.3,19.9],"Balasore":[86.9,21.5],"Bangalore":[77.6,13],"Bathinda":[75,30.2],"Bellary":[76.9,15.1],"Bhagalpur":[87,25.2],"Bhawani patna":[88,23],"Bhopal":[77.4,23.3],"Bhuj":[69.7,23.3],"Bhuvaneshwar":[85.8,20.3],"Bikaner":[73.3,28],"Bilaspur":[82.1,22.1],"Bombay":[72.9,19.1],"Brahmapur":[84.8,19.3],"Calicut":[75.8,11.3],"Central MP":[77.5,21.4],"Central Orissa":[86.5,21.8],"Chandigarh":[76.8,30.7],"Chennai":[80.3,13.1],"Cochin":[76.3,9.9],"Coimbatore":[77,11],"Cooch behar":[89.4,26.3],"Delhi NCR":[77.2,28.6],"Dhanbad":[86.4,23.8],"Dibrugarh":[95,27.5],"Durgapur":[87.3,23.5],"East Bihar":[85.8,21.2],"East JH":[75.9,20.8],"East MP":[75.7,19.3],"Eastern MH":[71.6,20.4],"Eastern UP":[75.7,28.9],"Goa":[74,15.4],"Godavari":[78.5,14.2],"Golpara":[90.6,26.2],"Gorakhpur":[83.4,26.8],"Gulbarga":[76.8,17.3],"Guwahati":[91.7,26.1],"Gwalior":[78.2,26.2],"Haridwar":[78.2,29.9],"Hisar":[75.7,29.1],"Hubli":[75.1,15.4],"Hyderabad":[78.5,17.4],"Indore":[75.9,22.7],"Itanagar":[93.6,27.1],"Jabalpur":[79.9,23.2],"Jagdalpur":[82,19.1],"Jaipur":[75.8,26.9],"Jaisalmer":[70.9,26.9],"Jalandhar":[75.6,31.3],"Jammu":[74.9,32.7],"Jamnagar":[70.1,22.5],"Jodhpur":[73,26.3],"Kangra":[76.3,32.1],"Kanpur":[80.3,26.4],"Kolhapur":[74.2,16.7],"Kolkata":[88.4,22.6],"Kota":[75.9,25.2],"Kurnool":[78,15.8],"Lucknow":[80.9,26.8],"Ludhiana":[75.9,30.9],"Madurai":[78.1,9.9],"Malda":[88.1,25],"Mangalore":[74.9,12.9],"Manipur":[84.4,22.2],"Meghalaya":[86.9,21.3],"Mizoram":[86.2,20.6],"Moradabad":[78.8,28.8],"Muzaffarnagar":[77.7,29.5],"Mysore":[76.6,12.3],"Nagaland":[89.2,24.7],"Nagpur":[79.1,21.1],"Nanded":[77.3,19.1],"Nashik":[73.8,20],"Neemuch":[74.9,24.5],"North Bihar":[89.8,24.1],"Norther UP":[72.7,26.8],"Northern GJ":[69.8,19.4],"Northern HP":[74.3,26],"Northern KA":[74,11],"Northern TG":[76.4,11.1],"Northern UK":[75.6,27.1],"Northern UP":[73.4,27.1],"Patna":[85.1,25.6],"Puducherry":[73.7,12],"Pune":[73.9,18.5],"Raigarh":[83.4,21.9],"Raipur":[81.6,21.3],"Rajkot":[70.8,22.3],"Ranchi":[85.3,23.3],"Rest of J&K":[78.4,28.5],"Rewa":[81.3,24.5],"Roorkee":[77.9,29.9],"Rourkela":[84.9,22.2],"Rudrapur":[79.4,28.98],"Salem":[78.1,11.7],"Sambalpur":[83.97,21.47],"Sikkim":[85.3,20.9],"Silchar":[92.8,24.8],"Siliguri":[88.4,26.7],"Silvassa":[73,20.3],"Solapur":[75.9,17.7],"South Assam":[84.2,21.8],"South CH":[78.2,22.4],"South JH":[80.6,21.9],"South MP":[80.4,22.8],"South Orissa":[88.5,23.7],"Southern GJ":[73.9,19.7],"Southern RJ":[78.1,29.1],"Srinagar":[74.8,34.1],"Surat":[72.8,21.2],"Tirunelveli":[77.7,8.7],"Trichy":[78.7,10.8],"Tripura":[88.5,23.9],"Trivandrum":[77,8.5],"Udaipur":[73.7,24.6],"Vadodara":[73.2,22.3],"Varanasi":[83,25.3],"Vijayawada":[80.6,16.5],"Vizag":[83.2,17.7],"Warangal":[79.6,18],"Western HP":[73.9,27.8],"Western HR":[74.3,27.8],"Western KA":[73.7,10.4],"Western RJ":[73.6,28.1],"Kochi":[76.3,9.9],"Bhubaneswar":[85.8,20.3]};

  function coordsFor(name) {
    if (!name) return null;
    return CITY_COORDS[name] || CITY_COORDS[String(name).trim()] || null;
  }

  function parseLaneKey(key) {
    const parts = String(key || '').split(' → ');
    if (parts.length < 2) return null;
    return { origin: parts[0].trim(), dest: parts.slice(1).join(' → ').trim() };
  }

  const mapMetricToggle = () =>
    `<div class="segmented" data-role="mapMetric" role="group" aria-label="Map metric">` +
    [
      { key: 'demand', label: 'Demand' },
      { key: 'inventory', label: 'Inventory' },
      { key: 'fillRate', label: 'Fill rate' }
    ].map(o =>
      `<button type="button" data-metric="${o.key}" aria-pressed="${String(o.key === State.mapMetric)}">${o.label}</button>`
    ).join('') + `</div>`;

  const mapLimitToggle = () =>
    `<div class="segmented" data-role="mapLimit" role="group" aria-label="Lane count">` +
    [25, 50, 80].map(n =>
      `<button type="button" data-limit="${n}" aria-pressed="${String(n === State.mapLaneLimit)}">Top ${n}</button>`
    ).join('') + `</div>`;

  function wireMapControls(paint) {
    document.querySelectorAll('[data-role="mapMetric"] button').forEach(b => {
      b.addEventListener('click', () => {
        State.mapMetric = b.dataset.metric;
        document.querySelectorAll('[data-role="mapMetric"] button').forEach(x => {
          x.setAttribute('aria-pressed', String(x.dataset.metric === State.mapMetric));
        });
        writeUrl();
        paint();
      });
    });
    document.querySelectorAll('[data-role="mapLimit"] button').forEach(b => {
      b.addEventListener('click', () => {
        State.mapLaneLimit = Number(b.dataset.limit);
        document.querySelectorAll('[data-role="mapLimit"] button').forEach(x => {
          x.setAttribute('aria-pressed', String(Number(x.dataset.limit) === State.mapLaneLimit));
        });
        writeUrl();
        paint();
      });
    });
  }

  function buildLaneRows(demandLanes, invLanes) {
    const dMap = new Map((demandLanes || []).map(r => [r.key, r]));
    const iMap = new Map((invLanes || []).map(r => [r.key, r]));
    const keys = new Set([...dMap.keys(), ...iMap.keys()]);
    const out = [];
    let skipped = 0;
    for (const key of keys) {
      const parsed = parseLaneKey(key);
      if (!parsed) { skipped++; continue; }
      const o = coordsFor(parsed.origin);
      const d = coordsFor(parsed.dest);
      if (!o || !d) { skipped++; continue; }
      const dem = dMap.get(key);
      const inv = iMap.get(key);
      let value, volume, detail;
      if (State.mapMetric === 'demand') {
        value = dem?.total ?? 0;
        volume = dem?.total ?? 0;
        detail = dem ? `${F.int(dem.success)} fulfilled · ${F.pct(dem.rate)} fill` : 'No demand';
      } else if (State.mapMetric === 'inventory') {
        value = inv?.demandMatched ?? inv?.inventoryMatches ?? 0;
        volume = value;
        detail = inv
          ? `${F.int(inv.demandPlacedExact ?? 0)} Exact placed · ${F.int(inv.demandPlacedOrigin ?? 0)} Origin placed`
          : 'No inventory matches';
      } else {
        value = dem?.rate ?? null;
        volume = dem?.total ?? 0;
        detail = dem ? `${F.int(dem.success)} of ${F.int(dem.total)} demands` : 'No demand';
      }
      if (!volume && (value == null || value === 0)) continue;
      out.push({
        key,
        origin: parsed.origin,
        dest: parsed.dest,
        oLon: o[0], oLat: o[1],
        dLon: d[0], dLat: d[1],
        value, volume, detail,
        total: dem?.total ?? 0,
        success: dem?.success ?? 0,
        rate: dem?.rate ?? null,
        demandMatched: inv?.demandMatched ?? 0,
        demandPlacedExact: inv?.demandPlacedExact ?? 0
      });
    }
    out.sort((a, b) => b.volume - a.volume);
    return { rows: out, skipped };
  }

  async function renderMap() {
    $('#main').innerHTML = `
      <div class="tile-row" id="tiles"><div class="loading">Loading…</div></div>
      <div class="panel-grid">
        ${panel('India — supercluster lanes',
          'Each arc is an origin→destination supercluster lane on a real India outline. Colour = selected metric (darker = stronger). Width = volume. Click a lane to filter the dashboard; click a hub city to filter by origin.',
          {
            span: 8,
            body: 'map',
            actions: mapMetricToggle() + mapLimitToggle()
          })}
        ${panel('Lane scorecard', 'Same lanes as the map, ranked by the active metric. Click a row to filter.', {
          span: 4, body: 'scorecard', actions: csvButton('scorecard')
        })}
        ${panel('Unmapped lanes', 'Lanes whose origin or destination supercluster has no coordinates yet — they cannot be drawn.', {
          span: 12, body: 'unmapped'
        })}
      </div>`;

    const res = await fetchMetrics([
      { id: 'demandSummary', entity: 'demand', kind: 'summary' },
      { id: 'invSummary', entity: 'inventory', kind: 'invMatch' },
      { id: 'demandLanes', entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 200 },
      { id: 'invLanes', entity: 'inventory', kind: 'invMatchGroup', groupBy: 'superClusterLane', limit: 200 }
    ]);
    if (!res) return;
    const R = res.results;

    const ds = R.demandSummary?.current;
    const ic = R.invSummary?.current;
    const tileHost = $('#tiles');
    if (tileHost && ds) {
      tileHost.innerHTML = [
        tile('Demands', F.int(ds.total), deltaHtml(ds.total, R.demandSummary?.previous?.total)),
        tile('Fill rate', F.pct(ds.rate), deltaHtml(ds.rate, R.demandSummary?.previous?.rate, { points: true })),
        ic ? tile('Inv. matches', F.int(ic.demandMatched ?? ic.inventoryMatches), '') : '',
        ic ? tile('Inv. placed (Exact)', F.int(ic.demandPlacedExact ?? 0), '') : ''
      ].filter(Boolean).join('');
    }

    const mapPayload = { demandLanes: R.demandLanes, invLanes: R.invLanes };

    function paintMap() {
      const host = body('map');
      if (!host) return;
      const built = buildLaneRows(mapPayload.demandLanes?.rows, mapPayload.invLanes?.rows);
      const limit = State.mapLaneLimit || 50;
      const lanes = built.rows.slice(0, limit);

      let formatValue, metricLabel, scale, domain, minVolume;
      if (State.mapMetric === 'demand') {
        formatValue = F.int;
        metricLabel = 'Demand';
      } else if (State.mapMetric === 'inventory') {
        formatValue = F.int;
        metricLabel = 'Demands with inventory match';
      } else {
        formatValue = F.pct;
        metricLabel = 'Fill rate';
        scale = 'absolute';
        domain = [0, 100];
        minVolume = 12;
      }

      Charts.indiaLaneMap(host, lanes, {
        formatValue, metricLabel, scale, domain, minVolume,
        onSelect: s => {
          State.filters.superClusterLane = [s.key];
          onFiltersChanged();
        },
        onHubSelect: h => {
          State.filters.originSuperCluster = [h.key];
          onFiltersChanged();
        }
      });

      const scoreCols = [
        { key: 'key', label: 'Supercluster lane' },
        { key: 'total', label: 'Demand', align: 'right', format: F.int },
        { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct },
        { key: 'demandMatched', label: 'Inv. matched', align: 'right', format: F.int },
        { key: 'demandPlacedExact', label: 'Exact placed', align: 'right', format: F.int }
      ];
      fill('scorecard', { ok: true, rows: lanes }, (h, p) => Charts.table(h, p.rows, scoreCols, {
        emptyMessage: 'No mappable lanes in this window.',
        onSelect: r => { State.filters.superClusterLane = [r.key]; onFiltersChanged(); }
      }));
      const scoreCsv = document.querySelector('[data-csv="scorecard"]');
      if (scoreCsv) {
        scoreCsv.onclick = () => Charts.downloadCsv('india-map-lanes.csv', lanes, scoreCols);
      }

      const unmappedHost = body('unmapped');
      if (unmappedHost) {
        const totalCandidates = (mapPayload.demandLanes?.rows?.length || 0);
        const mapped = built.rows.length;
        unmappedHost.innerHTML =
          `<p class="panel-note" style="margin:0">Drawing ${F.int(lanes.length)} of ${F.int(mapped)} mappable lanes` +
          (built.skipped ? ` · ${F.int(built.skipped)} skipped (no coordinates)` : '') +
          (totalCandidates ? ` · ${F.int(totalCandidates)} lanes in the window` : '') +
          `.</p>`;
      }
    }

    wireMapControls(paintMap);
    paintMap();
  }

  // ---- People -----------------------------------------------------------

  async function renderPeople() {
    $('#main').innerHTML = `
      <div class="panel-grid">
        ${panel('PSA scorecard — demand side', 'Demands owned and the fill rate each PSA delivered. Rate alone is unfair on whoever carries the hard lanes, so volume sits beside it.', { span: 6, body: 'psaDemand', actions: csvButton('psaDemand') })}
        ${panel('PSA scorecard — supply side', 'Postings owned, conversion achieved, and median time to convert.', { span: 6, body: 'psaInv', actions: csvButton('psaInv') })}
        ${panel('PSAs moving', 'Fill-rate change against the previous period of equal length.', { span: 12, body: 'psaMovers', actions: csvButton('psaMovers') })}
        ${panel('LSP reliability', 'Fill rate by carrier. A low rate on high volume is a commercial conversation; a low rate on low volume is a sourcing one. Demands with no carrier attributed are excluded — they would otherwise show as a carrier that never delivers.', { span: 6, body: 'lspRate', actions: csvButton('lspRate') })}
        ${panel('Carrier concentration', 'How much of the book rests on the largest carriers.', { span: 6, body: 'conc' })}
      </div>`;

    const res = await fetchMetrics([
      { id: 'psaDemand', entity: 'demand', kind: 'group', groupBy: 'psa', limit: 20 },
      { id: 'psaInv', entity: 'inventory', kind: 'group', groupBy: 'psa', limit: 20 },
      { id: 'psaMovers', entity: 'demand', kind: 'movers', groupBy: 'psa', limit: 10 },
      { id: 'lspRate', entity: 'demand', kind: 'group', groupBy: 'lsp', limit: 20 },
      { id: 'summary', entity: 'demand', kind: 'summary' }
    ]);
    if (!res) return;
    const R = res.results;

    const psaDemandCols = [
      { key: 'key', label: 'PSA' },
      { key: 'total', label: 'Demands', align: 'right', format: F.int },
      { key: 'success', label: 'Fulfilled', align: 'right', format: F.int },
      { key: 'rate', label: 'Fill rate', align: 'right', format: F.pct },
      { key: 'medianLatencyHours', label: 'Median TAT', align: 'right', format: F.hours },
      { key: 'value', label: 'Value', align: 'right', format: F.money }
    ];
    fill('psaDemand', R.psaDemand, (host, p) =>
      Charts.table(host, p.rows, psaDemandCols, { emptyMessage: 'No PSA attribution in this window.' }));
    wireCsv('psaDemand', R.psaDemand?.rows || [], psaDemandCols, 'psa-demand-scorecard.csv');

    const psaInvCols = [
      { key: 'key', label: 'PSA' },
      { key: 'total', label: 'Postings', align: 'right', format: F.int },
      { key: 'success', label: 'Converted', align: 'right', format: F.int },
      { key: 'rate', label: 'Conversion', align: 'right', format: F.pct },
      { key: 'medianLatencyHours', label: 'Median TTC', align: 'right', format: F.hours }
    ];
    fill('psaInv', R.psaInv, (host, p) =>
      Charts.table(host, p.rows, psaInvCols, { emptyMessage: 'No PSA attribution on inventory.' }));
    wireCsv('psaInv', R.psaInv?.rows || [], psaInvCols, 'psa-inventory-scorecard.csv');

    const moverCols = [
      { key: 'key', label: 'PSA' },
      { key: 'total', label: 'Demands', align: 'right', format: F.int },
      { key: 'prevRate', label: 'Prior fill rate', align: 'right', format: F.pct },
      { key: 'rate', label: 'Current fill rate', align: 'right', format: F.pct },
      { key: 'rateDelta', label: 'Fill rate change', align: 'right', format: v => `<span class="${v >= 0 ? 'good' : 'bad'}">${F.pts(v)}</span>` }
    ];
    fill('psaMovers', R.psaMovers, (host, p) => {
      const rows = [...(p.declining || []), ...[...(p.improving || [])].reverse()]
        .filter((r, i, arr) => arr.findIndex(x => x.key === r.key) === i);
      Charts.table(host, rows, moverCols, { emptyMessage: 'No PSA moved enough to report.' });
      wireCsv('psaMovers', rows, moverCols, 'psa-movement.csv');
    });

    // Unfulfilled demand frequently carries no LSP, so an "Unknown" bucket would
    // sit at 0% by construction and read as the worst carrier on the book.
    const attributed = (R.lspRate?.rows || []).filter(r => r.key && r.key !== 'Unknown');
    fill('lspRate', R.lspRate, host => Charts.rankedBars(host, attributed, {
      value: r => r.rate ?? 0, max: 100, colorRole: 'var(--series-1)',
      meta: r => `${F.pct(r.rate)} on ${F.int(r.total)}`,
      tip: rateTip('demands', 'Fulfilled'),
      emptyMessage: 'No demand in this window has a carrier attributed.',
      onSelect: r => { State.filters.lsp = [r.key]; onFiltersChanged(); }
    }));
    wireCsv('lspRate', attributed, psaDemandCols.map(c => c.key === 'key' ? { ...c, label: 'LSP' } : c), 'lsp-reliability.csv');

    fill('conc', R.summary, (host, p) => {
      const c = p.concentration;
      if (!c || c.hhi == null) { Charts.emptyState(host, 'No carrier attribution available.'); return; }
      const level = c.hhi > 2500 ? 'critical' : c.hhi > 1500 ? 'warning' : 'good';
      const reading = c.hhi > 2500 ? 'highly concentrated' : c.hhi > 1500 ? 'moderately concentrated' : 'well spread';
      host.innerHTML = `
        <div class="tile-row" style="margin:0">
          ${tile('Active carriers', F.int(c.count))}
          ${tile('Top 3 share', F.pct(c.top3Share))}
          ${tile('Top 5 share', F.pct(c.top5Share))}
          ${tile('HHI', F.int(c.hhi))}
        </div>
        <p class="panel-note" style="margin-top:12px">
          <span class="pill ${level}">${reading}</span>
          Herfindahl–Hirschman Index over carrier volume share. Below 1,500 is a competitive book;
          above 2,500 means a single carrier withdrawing would be felt across the network.
        </p>`;
    });
  }

  // ---- Explore ----------------------------------------------------------

  let exploreEntity = 'demand';

  async function renderExplore() {
    $('#main').innerHTML = `
      <div class="panel-grid">
        ${panel('Row-level explorer', 'Every record matching the current filters. Group by any dimension, or export the rows for your own analysis.', {
          span: 12, body: 'explore',
          actions: `<div class="segmented" data-role="entity" role="group" aria-label="Dataset">
              <button type="button" data-entity="demand" aria-pressed="${exploreEntity === 'demand'}">Demand</button>
              <button type="button" data-entity="inventory" aria-pressed="${exploreEntity === 'inventory'}">Inventory</button>
            </div>${csvButton('explore', 'Export CSV')}`
        })}
        ${panel('Group by any dimension', 'Pick a dimension to see volume and success rate across it.', {
          span: 12, body: 'group',
          actions: `<select id="groupDim" aria-label="Group by"></select>${csvButton('group')}`
        })}
      </div>`;

    document.querySelectorAll('[data-role="entity"] button').forEach(b => {
      b.addEventListener('click', () => { exploreEntity = b.dataset.entity; render(); });
    });

    const dims = State.meta?.dimensions?.[exploreEntity] || {};
    const select = $('#groupDim');
    const preferred = ['laneType', 'region', 'originSuperCluster', 'destinationSuperCluster', 'superClusterLane', 'lane', 'psa', 'lsp', 'vehicleType', 'origin', 'destination', 'shipper', 'materialType', 'reason', 'status', 'stage'];
    const keys = preferred.filter(k => dims[k]);
    select.innerHTML = keys.map(k => `<option value="${k}">${dims[k].label}</option>`).join('') ||
      `<option value="superClusterLane">Supercluster lane</option>`;
    select.value = keys.includes('superClusterLane') ? 'superClusterLane' : (keys.includes('region') ? 'region' : (keys[0] || 'superClusterLane'));
    select.addEventListener('change', () => loadGroup(select.value));

    const res = await fetchMetrics([
      { id: 'rows', entity: exploreEntity, kind: 'rows', limit: 500 }
    ]);
    if (!res) return;

    const cols = exploreEntity === 'demand' ? [
      { key: 'id', label: 'ID' },
      { key: 'createdAt', label: 'Created', format: v => escapeHtml(String(v || '').replace('T', ' ').slice(0, 16)) },
      { key: 'lane', label: 'Lane', format: escapeHtml },
      { key: 'shipper', label: 'Shipper', format: escapeHtml },
      { key: 'lsp', label: 'LSP', format: v => escapeHtml(v || '—') },
      { key: 'psa', label: 'PSA', format: escapeHtml },
      { key: 'vehicleType', label: 'Vehicle', format: escapeHtml },
      { key: 'outcome', label: 'Outcome', format: v => `<span class="${v === 'Fulfilled' ? 'good' : 'bad'}">${escapeHtml(v)}</span>` },
      { key: 'reason', label: 'Reason', format: v => escapeHtml(v || '—') },
      { key: 'latencyHours', label: 'TAT', align: 'right', format: F.hours },
      { key: 'expectedPrice', label: 'Expected', align: 'right', format: F.money },
      { key: 'bookedPrice', label: 'Booked', align: 'right', format: F.money }
    ] : [
      { key: 'id', label: 'ID' },
      { key: 'createdAt', label: 'Posted', format: v => escapeHtml(String(v || '').replace('T', ' ').slice(0, 16)) },
      { key: 'lane', label: 'Lane', format: escapeHtml },
      { key: 'lsp', label: 'LSP', format: escapeHtml },
      { key: 'psa', label: 'PSA', format: escapeHtml },
      { key: 'vehicleType', label: 'Vehicle', format: escapeHtml },
      { key: 'stage', label: 'Stage', format: escapeHtml },
      { key: 'outcome', label: 'Outcome', format: v => `<span class="${v === 'Converted' ? 'good' : 'bad'}">${escapeHtml(v)}</span>` },
      { key: 'reason', label: 'Reason', format: v => escapeHtml(v || '—') },
      { key: 'touchHours', label: 'To first touch', align: 'right', format: F.hours },
      { key: 'latencyHours', label: 'To convert', align: 'right', format: F.hours },
      { key: 'askingPrice', label: 'Asking', align: 'right', format: F.money }
    ];

    fill('explore', res.results.rows, (host, p) => {
      Charts.table(host, p.rows, cols);
      const head = host.closest('.panel').querySelector('.panel-note');
      if (head) head.textContent = `Showing ${F.int(p.rows.length)} of ${F.int(p.totalMatched)} matching records. Narrow the filters to see a different slice.`;
    });
    wireCsv('explore', res.results.rows?.rows || [], cols.map(c => ({ key: c.key, label: c.label })), `${exploreEntity}-rows.csv`);

    loadGroup(select.value);
  }

  async function loadGroup(dim) {
    const host = body('group');
    if (host) host.innerHTML = '<div class="loading">Loading…</div>';
    const res = await fetchMetrics([{ id: 'group', entity: exploreEntity, kind: 'group', groupBy: dim, limit: 40 }]);
    if (!res) return;
    const noun = exploreEntity === 'demand' ? 'Demands' : 'Postings';
    const success = exploreEntity === 'demand' ? 'Fulfilled' : 'Converted';
    const cols = [
      { key: 'key', label: State.meta?.dimensions?.[exploreEntity]?.[dim]?.label || dim },
      { key: 'total', label: noun, align: 'right', format: F.int },
      { key: 'success', label: success, align: 'right', format: F.int },
      { key: 'failed', label: 'Missed', align: 'right', format: F.int },
      { key: 'rate', label: 'Rate', align: 'right', format: F.pct },
      { key: 'medianLatencyHours', label: 'Median', align: 'right', format: F.hours },
      { key: 'value', label: 'Value', align: 'right', format: F.money }
    ];
    fill('group', res.results.group, (h, p) => Charts.table(h, p.rows, cols));
    wireCsv('group', res.results.group?.rows || [], cols, `${exploreEntity}-by-${dim}.csv`);
  }

  // ---- Setup ------------------------------------------------------------

  async function renderSetup() {
    const m = State.meta || {};
    const isAdmin = State.user?.role === 'admin';
    const cache = m.cache || { backend: 'memory', durable: false, ageSeconds: null, warnings: [] };
    const snap = cache.snapshot;

    $('#main').innerHTML = `
      ${m.mode === 'demo' ? `<div class="banner warning"><span class="icon">▲</span><div>
        <p><strong>Demo mode.</strong> Every number on this dashboard is generated sample data, not your warehouse.</p>
        <p>Set <code>DATABRICKS_TOKEN</code> in the Vercel project, map your tables in <code>config/schema.json</code>, then press <strong>Sync</strong> — the same views run against real data with no other change.</p>
      </div></div>` : ''}
      <div class="setup-grid">
        <section class="panel">
          <div class="panel-head"><h3>Connection</h3>
            <div class="panel-actions"><button class="ghost-btn" id="healthBtn" type="button">Test connection</button></div></div>
          <dl class="kv-list">
            <dt>Mode</dt><dd>${
              m.mode === 'cached' ? 'Cached snapshot — no query per panel'
              : m.mode === 'live' ? 'Live — querying Databricks on every panel'
              : 'Demo — generated sample data'}</dd>
            <dt>Workspace host</dt><dd>${escapeHtml(m.databricks?.host || '—')}</dd>
            <dt>SQL warehouse</dt><dd>${escapeHtml(m.databricks?.warehouseId || '—')}</dd>
            <dt>Token configured</dt><dd>${m.databricks?.tokenConfigured ? 'Yes' : 'No'}</dd>
            <dt>Signed in as</dt><dd>${escapeHtml(State.user?.email || 'Not signed in')} (${escapeHtml(State.user?.role || 'anonymous')})</dd>
          </dl>
          <div id="healthOut" style="margin-top:12px"></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Data cache</h3>
            <div class="panel-actions">${isAdmin && m.mode !== 'demo'
              ? `<button class="ghost-btn" id="clearCache" type="button">Clear</button>` : ''}</div></div>
          <p class="panel-note">${m.mode === 'demo'
            ? 'Not in use — the dashboard is serving generated data, which costs nothing to query.'
            : 'Sync pulls row-level demand and inventory once. Every panel, filter and date range is then answered from that snapshot in memory, so changing a filter costs no Databricks query at all.'}</p>
          <dl class="kv-list">
            <dt>Serving</dt><dd>${
              m.mode === 'demo' ? 'Generated demo data'
              : m.mode === 'cached' ? 'Cached snapshot'
              : 'Live queries — nothing cached yet'}</dd>
            <dt>Last synced</dt><dd>${snap ? `${relativeAge(cache.ageSeconds)} (${escapeHtml(String(snap.syncedAt).replace('T', ' ').slice(0, 16))} UTC)` : 'Never'}</dd>
            ${snap ? `<dt>Rows held</dt><dd>${F.int(snap.rows?.demand)} demand · ${F.int(snap.rows?.inventory)} inventory</dd>
            <dt>Window covered</dt><dd>${escapeHtml(snap.window?.from || '—')} to ${escapeHtml(snap.window?.to || '—')} (${F.int(snap.requestedDays)} days)</dd>
            <dt>Snapshot size</dt><dd>${(snap.storedBytes / 1048576).toFixed(2)} MB compressed, ${snap.chunks} chunk${snap.chunks === 1 ? '' : 's'}</dd>
            <dt>Pull time</dt><dd>${F.int(snap.queryMs)} ms for ${F.int(snap.statements)} statements</dd>` : ''}
            <dt>Cache backend</dt><dd>${
              cache.backend === 'upstash' ? 'Upstash KV — durable and shared across instances'
              : cache.backend === 'file' ? 'Local file — development only'
              : 'In-instance memory — lost on cold start, not shared'}</dd>
          </dl>
          ${(cache.warnings || []).length ? `<div class="banner warning" style="margin-top:12px"><span class="icon">▲</span><div>
            ${cache.warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div></div>` : ''}
          <div id="cacheOut" style="margin-top:12px"></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h3>Table mapping</h3></div>
          <p class="panel-note">Edit <code>config/schema.json</code> and redeploy, or set the whole mapping as JSON in the <code>MA_SCHEMA_JSON</code> environment variable to change it without a deploy.</p>
          <dl class="kv-list">
            <dt>Catalog</dt><dd>${escapeHtml(m.schema?.catalog || '—')}</dd>
            <dt>Schema</dt><dd>${escapeHtml(m.schema?.schema || '—')}</dd>
            <dt>Demand table</dt><dd>${escapeHtml(m.schema?.demandTable || '—')}</dd>
            <dt>Inventory table</dt><dd>${escapeHtml(m.schema?.inventoryTable || '—')}</dd>
          </dl>
          ${m.schemaError ? `<div class="error-box" style="margin-top:12px">${escapeHtml(m.schemaError)}</div>` : ''}
        </section>

        <section class="panel">
          <div class="panel-head"><h3>What is mapped</h3></div>
          <p class="panel-note">Dimensions resolved against the current mapping. Anything missing here is hidden from the filter bar rather than failing at query time.</p>
          <p style="font-size:13px;color:var(--text-secondary)">
            <strong>Demand:</strong> ${Object.values(m.dimensions?.demand || {}).map(d => escapeHtml(d.label)).join(', ') || '—'}<br><br>
            <strong>Inventory:</strong> ${Object.values(m.dimensions?.inventory || {}).map(d => escapeHtml(d.label)).join(', ') || '—'}
          </p>
          ${(m.warnings || []).length ? `<div class="banner warning" style="margin-top:12px"><span class="icon">▲</span><div>
            ${m.warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div></div>` : ''}
        </section>
      </div>

      <div class="panel-grid" style="margin-top:14px">
        <section class="panel col-12">
          <div class="panel-head"><h3>SQL console</h3>
            <div class="panel-actions">${isAdmin ? `<button class="primary-btn" id="runSql" type="button">Run</button>` : ''}</div></div>
          <p class="panel-note">${isAdmin
            ? 'Read-only. SELECT, WITH, SHOW, DESCRIBE and EXPLAIN only, one statement at a time. Issue this deployment a SELECT-only Databricks principal — the checks here are defence in depth, not the boundary.'
            : 'Available to addresses listed in the <code>ADMIN_EMAILS</code> environment variable.'}</p>
          ${isAdmin ? `<textarea class="sql-input" id="sqlInput" spellcheck="false" aria-label="SQL statement">SELECT current_catalog(), current_schema()</textarea>
            <div id="sqlOut" style="margin-top:12px"></div>` : ''}
        </section>
      </div>`;

    $('#healthBtn')?.addEventListener('click', async () => {
      const out = $('#healthOut');
      out.innerHTML = '<div class="loading">Checking…</div>';
      try {
        const res = await fetch('/api/health');
        const json = await res.json();
        const dbx = json.databricks;
        out.innerHTML = `<div class="banner ${json.ok ? '' : 'critical'}">
          <span class="icon">${json.ok ? '✓' : '●'}</span><div>
          <p><strong>${json.ok ? 'Healthy' : 'Problem found'}</strong> — mode ${escapeHtml(json.mode)}, schema ${json.schemaValid ? 'valid' : 'invalid'}.</p>
          ${json.schemaError ? `<p>${escapeHtml(json.schemaError)}</p>` : ''}
          ${dbx ? `<p>Databricks ${dbx.reachable ? `reachable in ${F.int(dbx.elapsedMs)} ms` : `unreachable: ${escapeHtml(dbx.error || '')}`}</p>` : '<p>No Databricks token configured — nothing to reach.</p>'}
          </div></div>`;
      } catch (e) {
        out.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      }
    });

    $('#clearCache')?.addEventListener('click', async () => {
      const out = $('#cacheOut');
      if (!confirm('Discard the cached snapshot? Panels will query Databricks directly until the next sync.')) return;
      out.innerHTML = '<div class="loading">Clearing…</div>';
      try {
        const res = await fetch('/api/sync', { method: 'DELETE' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Could not clear the cache');
        State.sync = json;
        State.meta = await api('/api/meta').catch(() => State.meta);
        applyMode(State.meta?.mode || 'live', State.sync);
        render();
      } catch (e) {
        out.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      }
    });

    $('#runSql')?.addEventListener('click', async () => {
      const out = $('#sqlOut');
      out.innerHTML = '<div class="loading">Running…</div>';
      try {
        const res = await fetch('/api/sql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ statement: $('#sqlInput').value, limit: 500 })
        });
        const json = await res.json();
        if (!res.ok) { out.innerHTML = `<div class="error-box">${escapeHtml(json.error || 'Query failed')}</div>`; return; }
        const cols = json.columns.map(c => ({ key: c.name, label: c.name, format: v => escapeHtml(v ?? '—') }));
        out.innerHTML = `<p class="panel-note">${F.int(json.rowCount)} rows in ${F.int(json.elapsedMs)} ms</p><div data-body="sqlTable"></div>`;
        Charts.table(out.querySelector('[data-body="sqlTable"]'), json.rows, cols);
      } catch (e) {
        out.innerHTML = `<div class="error-box">${escapeHtml(e.message)}</div>`;
      }
    });
  }

  // ------------------------------------------------------------- Shell

  const TABS = {
    overview: renderOverview,
    demand: renderDemand,
    inventory: renderInventory,
    bids: renderBids,
    matching: renderMatching,
    map: renderMap,
    people: renderPeople,
    explore: renderExplore,
    setup: renderSetup
  };

  // One line per view, above the filters: what question this tab answers, so a
  // reader landing on a shared link knows what they are looking at before they
  // start reading panel titles. Tabs that explain themselves (Explore, Setup)
  // are left out rather than given filler.
  const VIEW_INTRO = {
    overview: 'Marketplace health in one screen — demand in, fill rate out, and where the gap is widening.',
    map: 'Demand and fill rate by geography — the regional shape of the gap, before you drill into lanes.',
    demand: "Every demand raised, cut by lane, LSP and PSA — what filled, what didn't, and why.",
    inventory: 'The supply side — how much inventory was offered, how much converted, and where it stalls.',
    matching: 'The two sides against each other — where demand outruns inventory, and where inventory sits with no demand.',
    people: 'Who moves the needle — PSA response and conversion, LSP fill rate and reliability.'
  };

  async function render() {
    Charts.hideTip();
    document.querySelectorAll('.tab').forEach(t =>
      t.setAttribute('aria-selected', String(t.dataset.tab === State.tab)));

    const intro = document.getElementById('viewIntro');
    const introText = VIEW_INTRO[State.tab] || '';
    intro.textContent = introText;
    intro.hidden = !introText;

    // Setup describes the deployment, not a slice of data — filters do nothing there.
    document.getElementById('filterBar').hidden = State.tab === 'setup';
    const fn = TABS[State.tab] || renderOverview;
    State.loading = true;
    $('#refreshBtn').disabled = true;
    try {
      await fn();
    } catch (e) {
      $('#main').innerHTML = `<div class="error-box">${escapeHtml(e.message || 'Something went wrong loading this view.')}</div>`;
    } finally {
      State.loading = false;
      $('#refreshBtn').disabled = false;
    }
  }

  async function loadFilterOptions() {
    try {
      const res = await api(`/api/filters?from=${State.filters.from}&to=${State.filters.to}`);
      if (res) State.options = res.options || {};
    } catch {
      State.options = {};
    }
  }

  // The chip answers "where did these numbers come from, and how old are they".
  function applyMode(mode, syncStatus) {
    const chip = $('#modeChip');
    const age = syncStatus?.ageSeconds;
    // Anything over 12 hours is called out rather than quietly shown as fresh.
    const stale = mode === 'cached' && age !== null && age !== undefined && age > 43200;

    chip.classList.toggle('is-demo', mode === 'demo');
    chip.classList.toggle('is-cached', mode === 'cached' && !stale);
    chip.classList.toggle('is-stale', stale);
    chip.classList.toggle('is-live', mode === 'live');

    if (mode === 'demo') {
      $('#modeLabel').textContent = 'Demo data';
      chip.title = 'Generated sample data. Configure DATABRICKS_TOKEN to query the warehouse.';
    } else if (mode === 'cached') {
      $('#modeLabel').textContent = `Synced ${relativeAge(age)}`;
      const rows = syncStatus?.snapshot?.rows;
      chip.title = `Serving a cached snapshot — no Databricks query for any filter.` +
        (rows ? ` ${Charts.fmt.int(rows.demand)} demands, ${Charts.fmt.int(rows.inventory)} inventory rows.` : '');
    } else {
      $('#modeLabel').textContent = 'Not synced — querying live';
      chip.title = 'No snapshot cached yet, so every panel queries Databricks directly. Press Sync.';
    }

    // Sync only means anything once there is a warehouse to sync from.
    const canSee = mode !== 'demo' || State.meta?.databricks?.tokenConfigured;
    const btn = $('#syncBtn');
    btn.hidden = !canSee;
    if (canSee) {
      const isAdmin = State.user?.role === 'admin';
      btn.disabled = !isAdmin || State.syncing;
      btn.title = isAdmin
        ? 'Pull fresh rows from Databricks into the shared cache'
        : 'Syncing is limited to addresses listed in ADMIN_EMAILS';
    }
  }

  async function loadSyncStatus() {
    try {
      State.sync = await api('/api/sync');
    } catch {
      State.sync = null;
    }
    return State.sync;
  }

  async function runSync() {
    if (State.syncing) return;
    State.syncing = true;
    const btn = $('#syncBtn');
    const chip = $('#modeChip');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    chip.classList.add('is-syncing');
    $('#modeLabel').textContent = 'Pulling from Databricks…';

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Sync failed (${res.status})`);
      State.sync = json;
      // The mapping and warnings can change with the data, so refresh meta too.
      State.meta = await api('/api/meta').catch(() => State.meta);
      await loadFilterOptions();
      buildFilterChips();
      applyMode(State.meta?.mode || 'cached', State.sync);
      render();
    } catch (e) {
      applyMode(State.meta?.mode || 'live', State.sync);
      alert(`Sync failed.\n\n${e.message}`);
    } finally {
      State.syncing = false;
      chip.classList.remove('is-syncing');
      btn.textContent = 'Sync from Databricks';
      btn.disabled = State.user?.role !== 'admin';
    }
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function wireShell() {
    document.querySelectorAll('.tab').forEach(t => {
      t.addEventListener('click', () => {
        State.tab = t.dataset.tab;
        writeUrl(true);
        render();
      });
    });
    $('#refreshBtn').addEventListener('click', () => render());
    $('#syncBtn').addEventListener('click', () => runSync());
    $('#moreFiltersBtn')?.addEventListener('click', () => {
      State.moreFiltersOpen = !State.moreFiltersOpen;
      // Allow collapsing even when secondary filters are active.
      syncMoreFiltersUi();
      if (!State.moreFiltersOpen) closePopover();
    });
    $('#resetFilters').addEventListener('click', () => {
      for (const k of FILTER_KEYS) delete State.filters[k];
      State.filters.outcome = 'all';
      State.moreFiltersOpen = false;
      onFiltersChanged();
    });
    $('#copyLink').addEventListener('click', async () => {
      const btn = $('#copyLink');
      try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy view link'; }, 1600);
    });
    document.querySelectorAll('#outcomeToggle button').forEach(b => {
      b.addEventListener('click', () => {
        State.filters.outcome = b.dataset.outcome;
        onFiltersChanged();
      });
    });
    $('#themeBtn').addEventListener('click', () => {
      const curr = document.documentElement.getAttribute('data-theme');
      const next = curr === 'dark' ? 'light' : curr === 'light' ? null : 'dark';
      applyTheme(next);
      try { next ? localStorage.setItem('ma-theme', next) : localStorage.removeItem('ma-theme'); } catch { /* private mode */ }
      render();
    });
    window.addEventListener('popstate', () => { readUrl(); buildFilterChips(); render(); });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (!State.loading) render(); }, 220);
    });
  }

  async function init() {
    try { applyTheme(localStorage.getItem('ma-theme')); } catch { /* private mode */ }
    readUrl();
    wireShell();

    try {
      const [me, meta] = await Promise.all([
        fetch('/api/auth/me').then(r => r.json()).catch(() => null),
        api('/api/meta').catch(e => ({ mode: 'demo', schemaError: e.message }))
      ]);
      State.user = me;
      State.meta = meta;
      if (meta?.mode !== 'demo') await loadSyncStatus();
      applyMode(meta?.mode || 'demo', State.sync);

      const slot = $('#userSlot');
      if (me?.authenticated) {
        slot.innerHTML = `<a class="icon-btn" href="/api/auth/logout" title="${escapeHtml(me.email)}">Sign out</a>`;
      } else if (me?.authConfigured) {
        slot.innerHTML = `<a class="icon-btn" href="/api/auth/login">Sign in</a>`;
      }
    } catch (e) {
      applyMode('demo', null);
    }

    await loadFilterOptions();
    buildFilterChips();
    writeUrl();
    render();
  }

  init();
})();
