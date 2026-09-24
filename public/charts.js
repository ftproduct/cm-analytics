/* charts.js — inline-SVG chart primitives for the marketplace dashboard.
 *
 * No chart library. Every mark is drawn here so the colour roles, the 2px
 * spacers between fills, the rounded data-ends and the hover layer behave the
 * same way in every panel.
 *
 * Colour comes from CSS custom properties (see app.css), never from hex
 * literals in this file, so light and dark swap in one place.
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const BAR_RADIUS = 4;      // rounded data-end
  const GAP = 2;             // surface gap between adjacent fills
  const STROKE = 2;          // line weight

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function el(name, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      node.setAttribute(k, String(v));
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function svgRoot(host, width, height) {
    host.textContent = '';
    const svg = el('svg', {
      width, height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      class: 'chart-svg'
    }, host);
    return svg;
  }

  function measure(host, fallback = 640) {
    const w = host.clientWidth || host.parentElement?.clientWidth || fallback;
    return Math.max(280, Math.floor(w));
  }

  const fmt = {
    int: n => (n === null || n === undefined || Number.isNaN(n)) ? '—' : Math.round(n).toLocaleString('en-IN'),
    pct: n => (n === null || n === undefined || Number.isNaN(n)) ? '—' : `${n}%`,
    pts: n => (n === null || n === undefined || Number.isNaN(n)) ? '—' : `${n > 0 ? '+' : ''}${n} pts`,
    hours: n => {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      if (n < 1) return `${Math.round(n * 60)} min`;
      if (n < 48) return `${Math.round(n * 10) / 10} h`;
      return `${Math.round(n / 24 * 10) / 10} d`;
    },
    money: n => {
      if (n === null || n === undefined || Number.isNaN(n)) return '—';
      const a = Math.abs(n);
      if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
      if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
      if (a >= 1e3) return `₹${Math.round(n / 1e3)}k`;
      return `₹${Math.round(n)}`;
    },
    shortDate: s => {
      if (!s) return '';
      if (/^\d{4}-\d{2}$/.test(s)) {
        const [y, m] = s.split('-');
        return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
      }
      const d = new Date(s + 'T00:00:00Z');
      if (Number.isNaN(d.getTime())) return s;
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    },
    truncate: (s, n) => {
      const str = String(s ?? '');
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    }
  };

  // Shared tooltip element — one per page, positioned against the viewport.
  let tip = null;
  function tooltip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('role', 'status');
      document.body.appendChild(tip);
    }
    return tip;
  }
  function showTip(html, evt) {
    const t = tooltip();
    t.innerHTML = html;
    t.classList.add('is-visible');
    const pad = 12;
    const rect = t.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    t.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
  }
  function hideTip() { if (tip) tip.classList.remove('is-visible'); }
  document.addEventListener('scroll', hideTip, true);

  // "Nice" axis maximum so gridlines land on round numbers.
  function niceMax(v) {
    if (!v || v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  // Which period indices get an axis label. The last one always wins, and any
  // candidate sitting within `minGap` pixels of it is dropped so the two never
  // print on top of each other.
  function tickIndices(count, plotW, minGap = 64) {
    if (count <= 1) return [0];
    const every = Math.max(1, Math.ceil(count / Math.max(3, Math.floor(plotW / 78))));
    const step = plotW / (count - 1);
    const picked = [];
    for (let i = 0; i < count - 1; i++) {
      if (i !== 0 && i % every !== 0) continue;
      if ((count - 1 - i) * step < minGap) continue;
      picked.push(i);
    }
    picked.push(count - 1);
    return picked;
  }

  function emptyState(host, message) {
    host.innerHTML = `<p class="chart-empty">${message}</p>`;
  }

  // ---------------------------------------------------------------------
  // Ranked horizontal bars — lanes, LSPs, PSAs, reasons.
  // Ranked horizontal bars.
  //
  // opts: { value, label, meta, colorRole, max, formatValue, onSelect, stack }
  // stack: true → draw fulfilled (success) + unfulfilled (failed) as a split bar
  // ---------------------------------------------------------------------
  function rankedBars(host, rows, opts = {}) {
    if (!rows || !rows.length) return emptyState(host, opts.emptyMessage || 'No rows for this selection.');

    const width = measure(host);
    const value = opts.value || (r => r.total);
    const label = opts.label || (r => r.key);
    const formatValue = opts.formatValue || fmt.int;
    const stacked = !!opts.stack;

    // Size both gutters from the actual strings rather than a fixed guess, so a
    // long meta ("0.96x on 52 loads") never lands on top of its own bar.
    const metaText = r => (opts.meta ? opts.meta(r) : formatValue(value(r)));
    const widestMeta = rows.reduce((m, r) => Math.max(m, String(metaText(r)).length), 0);
    const metaW = Math.min(Math.max(48, Math.round(widestMeta * 6.7) + 12), Math.round(width * 0.34));
    const labelRatio = opts.labelRatio || 0.30;
    const labelW = Math.min(Math.max(120, Math.round(width * labelRatio)), 280);
    const rowH = stacked ? 30 : 26;
    const barH = stacked ? 16 : 14;
    const top = 6;
    const height = top + rows.length * rowH + 6;
    const plotX = labelW + 10;
    const plotW = Math.max(40, width - plotX - metaW - 8);

    const max = niceMax(opts.max ?? Math.max(...rows.map(value), 1));
    const successColor = opts.successColor || 'var(--series-3)';
    const failColor = opts.failColor || 'var(--series-2)';

    const svg = svgRoot(host, width, height);

    rows.forEach((r, i) => {
      const y = top + i * rowH;
      const v = value(r) || 0;
      const barY = y + (rowH - barH) / 2;

      // Track behind the bar makes short bars readable against long ones.
      el('rect', { x: plotX, y: barY, width: plotW, height: barH, rx: 3, class: 'bar-track' }, svg);

      let hoverTarget = null;
      if (stacked) {
        const success = Math.max(0, Number(r.success) || 0);
        const failed = Math.max(0, Number(r.failed) || 0);
        const wSuccess = Math.max(success > 0 ? 2 : 0, (success / max) * plotW);
        const wFail = Math.max(failed > 0 ? 2 : 0, (failed / max) * plotW);
        if (wSuccess > 0) {
          hoverTarget = el('rect', {
            x: plotX, y: barY, width: wSuccess, height: barH,
            rx: BAR_RADIUS, fill: successColor, class: 'bar-mark'
          }, svg);
        }
        if (wFail > 0) {
          const failBar = el('rect', {
            x: plotX + wSuccess, y: barY, width: wFail, height: barH,
            rx: BAR_RADIUS, fill: failColor, class: 'bar-mark'
          }, svg);
          if (!hoverTarget) hoverTarget = failBar;
        }
      } else {
        const w = Math.max(v > 0 ? 3 : 0, (v / max) * plotW);
        const role = typeof opts.colorRole === 'function'
          ? opts.colorRole(r)
          : (opts.colorRole || 'var(--series-1)');
        hoverTarget = el('rect', {
          x: plotX, y: barY, width: w, height: barH,
          rx: BAR_RADIUS, fill: role, class: 'bar-mark'
        }, svg);
      }

      const name = el('text', {
        x: labelW, y: y + rowH / 2, 'text-anchor': 'end',
        'dominant-baseline': 'central', class: 'axis-label'
      }, svg);
      name.textContent = fmt.truncate(label(r), Math.floor(labelW / 6.6));

      const val = el('text', {
        x: width - 6, y: y + rowH / 2, 'text-anchor': 'end',
        'dominant-baseline': 'central', class: 'value-label'
      }, svg);
      val.textContent = metaText(r);

      // Hover target spans the whole row, not just the drawn bar.
      const hit = el('rect', { x: 0, y, width, height: rowH, fill: 'transparent', class: 'hit' }, svg);
      const tipHtml = opts.tip ? opts.tip(r) : `<strong>${label(r)}</strong><br>${formatValue(v)}`;
      hit.addEventListener('mousemove', e => {
        if (hoverTarget) hoverTarget.classList.add('is-hover');
        showTip(tipHtml, e);
      });
      hit.addEventListener('mouseleave', () => {
        if (hoverTarget) hoverTarget.classList.remove('is-hover');
        hideTip();
      });
      if (opts.onSelect) {
        hit.style.cursor = 'pointer';
        hit.addEventListener('click', () => opts.onSelect(r));
      }
    });

    const title = el('title', {}, svg);
    title.textContent = opts.title || 'Ranked bar chart';
  }

  // ---------------------------------------------------------------------
  // Stacked bars over time — success vs failure per period.
  // Exactly two series, always legended and direct-labelled at the ends.
  // ---------------------------------------------------------------------
  function stackedBars(host, rows, opts = {}) {
    if (!rows || !rows.length) return emptyState(host, 'No activity in this window.');

    const width = measure(host);
    const height = opts.height || 240;
    const padT = 16, padB = 30, padL = 46, padR = 12;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const max = niceMax(Math.max(...rows.map(r => r.total), 1));
    const slot = plotW / rows.length;
    const barW = Math.max(2, Math.min(28, slot - Math.max(1, slot * 0.25)));

    const svg = svgRoot(host, width, height);

    // Recessive gridlines and y ticks.
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      const y = padT + plotH - (v / max) * plotH;
      el('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'grid-line' }, svg);
      const t = el('text', { x: padL - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'axis-tick' }, svg);
      t.textContent = fmt.int(v);
    }

    rows.forEach((r, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      const okH = (r.success / max) * plotH;
      const failH = (r.failed / max) * plotH;
      const baseY = padT + plotH;

      // Success sits on the baseline with a rounded data-end at the top only
      // when nothing is stacked above it.
      if (r.success > 0) {
        el('rect', {
          x, y: baseY - okH, width: barW, height: Math.max(1, okH),
          rx: r.failed > 0 ? 0 : BAR_RADIUS, fill: 'var(--series-1)', class: 'bar-mark'
        }, svg);
      }
      // 2px surface gap between the two fills so they never bleed together.
      if (r.failed > 0) {
        el('rect', {
          x, y: baseY - okH - failH - (r.success > 0 ? GAP : 0),
          width: barW, height: Math.max(1, failH),
          rx: BAR_RADIUS, fill: 'var(--series-2)', class: 'bar-mark'
        }, svg);
      }

      const hit = el('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, fill: 'transparent', class: 'hit' }, svg);
      hit.addEventListener('mousemove', e => showTip(
        `<strong>${fmt.shortDate(r.period)}</strong><br>` +
        `<span class="tip-key" style="--k:var(--series-1)"></span>${opts.successLabel || 'Fulfilled'} ${fmt.int(r.success)}<br>` +
        `<span class="tip-key" style="--k:var(--series-2)"></span>${opts.failLabel || 'Unfulfilled'} ${fmt.int(r.failed)}<br>` +
        `<span class="tip-muted">${opts.rateLabel || 'Fill rate'} ${fmt.pct(r.rate)}</span>`, e));
      hit.addEventListener('mouseleave', hideTip);
    });

    el('line', { x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH, class: 'axis-line' }, svg);

    // Label first, last and roughly every nth period so ticks never collide.
    const ticks = new Set(tickIndices(rows.length, plotW, 80));
    rows.forEach((r, i) => {
      if (!ticks.has(i)) return;
      const t = el('text', {
        x: padL + i * slot + slot / 2, y: height - 10,
        'text-anchor': i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle',
        class: 'axis-tick'
      }, svg);
      t.textContent = fmt.shortDate(r.period);
    });
  }

  // ---------------------------------------------------------------------
  // Line chart — one measure, one axis. Crosshair + tooltip on hover.
  // series: [{ key, label, values: [{x, y}] }]
  // ---------------------------------------------------------------------
  function lineChart(host, series, opts = {}) {
    const live = (series || []).filter(s => s.values && s.values.length);
    if (!live.length) return emptyState(host, 'Not enough history to plot.');

    const width = measure(host);
    const height = opts.height || 240;
    const padT = 16, padB = 30, padL = 46;
    // Right margin has to clear the longest direct label, not a fixed guess.
    const padR = opts.directLabels === false ? 14
      : Math.min(140, 16 + live.reduce((m, s) => Math.max(m, s.label.length), 0) * 6.4);
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xs = live[0].values.map(v => v.x);
    const allY = live.flatMap(s => s.values.map(v => v.y)).filter(v => v !== null && v !== undefined);
    const rawMax = Math.max(...allY, 0);
    const max = opts.max ?? (opts.percent ? 100 : niceMax(rawMax));
    const min = opts.min ?? 0;
    const xAt = i => padL + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
    const yAt = v => padT + plotH - ((v - min) / (max - min || 1)) * plotH;

    const svg = svgRoot(host, width, height);

    for (let i = 0; i <= 4; i++) {
      const v = min + ((max - min) / 4) * i;
      const y = yAt(v);
      el('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'grid-line' }, svg);
      const t = el('text', { x: padL - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'axis-tick' }, svg);
      t.textContent = opts.percent ? `${Math.round(v)}%` : fmt.int(v);
    }

    // Optional reference line (a target, or the window average).
    if (opts.reference !== null && opts.reference !== undefined) {
      const y = yAt(opts.reference);
      el('line', { x1: padL, y1: y, x2: width - padR, y2: y, class: 'ref-line' }, svg);
      const t = el('text', { x: width - padR + 4, y: y - 6, class: 'ref-label' }, svg);
      t.textContent = opts.referenceLabel || `avg ${opts.percent ? fmt.pct(opts.reference) : fmt.int(opts.reference)}`;
    }

    const crosshair = el('line', { x1: 0, y1: padT, x2: 0, y2: padT + plotH, class: 'crosshair' }, svg);
    crosshair.style.opacity = 0;

    live.forEach((s, si) => {
      const role = s.color || `var(--series-${(si % 8) + 1})`;
      const points = s.values.map((v, i) => (v.y === null || v.y === undefined) ? null : `${xAt(i)},${yAt(v.y)}`);
      const d = points.reduce((acc, p, i) => {
        if (p === null) return acc;
        return acc + (acc === '' || points[i - 1] === null || i === 0 ? 'M' : 'L') + p + ' ';
      }, '');
      el('path', { d: d.trim(), fill: 'none', stroke: role, 'stroke-width': STROKE, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);

      // Direct label at the series end, so identity never rests on colour alone.
      const lastIdx = s.values.map(v => v.y).reduce((acc, v, i) => (v === null || v === undefined) ? acc : i, -1);
      if (lastIdx >= 0 && opts.directLabels !== false) {
        const t = el('text', { x: xAt(lastIdx) + 8, y: yAt(s.values[lastIdx].y), 'dominant-baseline': 'central', class: 'series-end-label' }, svg);
        t.textContent = s.label;
      }
    });

    el('line', { x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH, class: 'axis-line' }, svg);

    const ticks = new Set(tickIndices(xs.length, plotW));
    xs.forEach((x, i) => {
      if (!ticks.has(i)) return;
      const t = el('text', {
        x: xAt(i), y: height - 10,
        'text-anchor': i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle',
        class: 'axis-tick'
      }, svg);
      t.textContent = fmt.shortDate(x);
    });

    // Markers appear on hover only — a dot on every point is noise.
    const markers = live.map((s, si) => el('circle', {
      r: 5, fill: 'var(--surface-1)', stroke: s.color || `var(--series-${(si % 8) + 1})`,
      'stroke-width': STROKE, class: 'point-marker'
    }, svg));
    markers.forEach(m => { m.style.opacity = 0; });

    const hit = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent', class: 'hit' }, svg);
    hit.addEventListener('mousemove', e => {
      const box = svg.getBoundingClientRect();
      const rel = (e.clientX - box.left - padL) / (plotW || 1);
      const i = Math.max(0, Math.min(xs.length - 1, Math.round(rel * (xs.length - 1))));
      crosshair.setAttribute('x1', xAt(i));
      crosshair.setAttribute('x2', xAt(i));
      crosshair.style.opacity = 1;
      let html = `<strong>${fmt.shortDate(xs[i])}</strong>`;
      live.forEach((s, si) => {
        const v = s.values[i]?.y;
        markers[si].style.opacity = (v === null || v === undefined) ? 0 : 1;
        if (v !== null && v !== undefined) {
          markers[si].setAttribute('cx', xAt(i));
          markers[si].setAttribute('cy', yAt(v));
        }
        html += `<br><span class="tip-key" style="--k:${s.color || `var(--series-${(si % 8) + 1})`}"></span>` +
                `${s.label} ${opts.percent ? fmt.pct(v) : fmt.int(v)}`;
      });
      showTip(html, e);
    });
    hit.addEventListener('mouseleave', () => {
      crosshair.style.opacity = 0;
      markers.forEach(m => { m.style.opacity = 0; });
      hideTip();
    });
  }

  // ---------------------------------------------------------------------
  // Conversion funnel — ordinal blue ramp, one bar per stage, drop-off called
  // out between stages.
  // ---------------------------------------------------------------------
  function funnelChart(host, rows, opts = {}) {
    if (!rows || !rows.length) return emptyState(host, 'No funnel data.');

    const width = measure(host);
    const rowH = 46;
    const labelW = Math.min(Math.max(112, Math.round(width * 0.22)), 170);
    const metaW = 132;
    const height = rows.length * rowH + 8;
    const plotX = labelW + 10;
    const plotW = Math.max(40, width - plotX - metaW - 8);
    const max = Math.max(...rows.map(r => r.count), 1);

    // Ordinal ramp: never lighter than step 250 on the light surface.
    const ramp = ['var(--ordinal-1)', 'var(--ordinal-2)', 'var(--ordinal-3)', 'var(--ordinal-4)', 'var(--ordinal-5)', 'var(--ordinal-6)'];
    const svg = svgRoot(host, width, height);

    rows.forEach((r, i) => {
      const y = i * rowH + 4;
      const barH = 22;
      const w = Math.max(3, (r.count / max) * plotW);
      const fill = ramp[Math.min(i, ramp.length - 1)];

      el('rect', { x: plotX, y, width: plotW, height: barH, rx: 3, class: 'bar-track' }, svg);
      const bar = el('rect', { x: plotX, y, width: w, height: barH, rx: BAR_RADIUS, fill, class: 'bar-mark' }, svg);

      const name = el('text', { x: labelW, y: y + barH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'axis-label' }, svg);
      name.textContent = r.stage;

      const val = el('text', { x: width - 6, y: y + barH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'value-label' }, svg);
      val.textContent = `${fmt.int(r.count)} · ${fmt.pct(r.fromTop)}`;

      // Drop-off annotation sits in the gutter between this stage and the next.
      if (i > 0 && r.dropOff > 0) {
        const t = el('text', { x: plotX, y: y - 8, class: 'dropoff-label' }, svg);
        const lostShare = Math.round((100 - r.fromPrev) * 10) / 10;
        t.textContent = `↓ ${fmt.int(r.dropOff)} lost (${fmt.pct(lostShare)} of previous stage)`;
      }

      const hit = el('rect', { x: 0, y: y - 12, width, height: rowH, fill: 'transparent', class: 'hit' }, svg);
      hit.addEventListener('mousemove', e => {
        bar.classList.add('is-hover');
        showTip(`<strong>${r.stage}</strong><br>${fmt.int(r.count)} postings reached this stage<br>` +
                `<span class="tip-muted">${fmt.pct(r.fromTop)} of all posted · ${fmt.pct(r.fromPrev)} of previous stage</span>`, e);
      });
      hit.addEventListener('mouseleave', () => { bar.classList.remove('is-hover'); hideTip(); });
    });
    void opts;
  }

  // ---------------------------------------------------------------------
  // Lane x period heatmap — red (0%) → green (100%).
  // ---------------------------------------------------------------------
  function heatmapGrid(host, data, opts = {}) {
    if (!data || !data.keys?.length || !data.periods?.length) {
      return emptyState(host, 'Not enough coverage to build the grid.');
    }
    const width = measure(host);
    host.innerHTML = '<div data-grid></div><div data-scale></div>';
    const scaleHost = host.querySelector('[data-scale]');
    host = host.querySelector('[data-grid]');
    const labelW = Math.min(Math.max(140, Math.round(width * 0.28)), 250);
    const cellH = 24;
    const headerH = 24;
    const cols = data.periods.length;
    const cellW = Math.max(14, (width - labelW - 8) / cols);
    const height = headerH + data.keys.length * cellH + 8;

    const byKey = new Map(data.cells.map(c => [c.key + '|' + c.period, c]));
    const svg = svgRoot(host, width, height);

    // Diverging ramp: step index rises with fill/conversion rate.
    const steps = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)', 'var(--seq-6)'];
    const stepFor = rate => {
      if (rate === null || rate === undefined) return null;
      const i = Math.min(steps.length - 1, Math.floor((rate / 100) * steps.length));
      return steps[i];
    };

    const headTicks = new Set(tickIndices(cols, cols * cellW, 60));
    data.periods.forEach((p, ci) => {
      if (!headTicks.has(ci)) return;
      const t = el('text', { x: labelW + ci * cellW + cellW / 2, y: headerH - 10, 'text-anchor': 'middle', class: 'axis-tick' }, svg);
      t.textContent = fmt.shortDate(p);
    });

    data.keys.forEach((k, ri) => {
      const y = headerH + ri * cellH;
      const name = el('text', { x: labelW - 10, y: y + cellH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'axis-label' }, svg);
      name.textContent = fmt.truncate(k, Math.floor(labelW / 6.6));

      data.periods.forEach((p, ci) => {
        const cell = byKey.get(k + '|' + p);
        const x = labelW + ci * cellW;
        const fill = stepFor(cell?.rate);
        // GAP keeps a surface-coloured hairline between adjacent fills.
        el('rect', {
          x: x + GAP / 2, y: y + GAP / 2,
          width: Math.max(1, cellW - GAP), height: cellH - GAP,
          rx: 2,
          fill: fill || 'var(--cell-empty)',
          class: fill ? 'cell-mark' : 'cell-empty'
        }, svg);
        if (!cell) return;
        const hit = el('rect', { x, y, width: cellW, height: cellH, fill: 'transparent', class: 'hit' }, svg);
        hit.addEventListener('mousemove', e => showTip(
          `<strong>${k}</strong><br>${fmt.shortDate(p)}<br>` +
          `${opts.rateLabel || 'Fill rate'} ${fmt.pct(cell.rate)}<br>` +
          `<span class="tip-muted">${fmt.int(cell.success)} of ${fmt.int(cell.total)}</span>`, e));
        hit.addEventListener('mouseleave', hideTip);
      });
    });

    // The ramp reverses between light and dark, so the scale is shown rather
    // than described. Six swatches, low to high, with the ends labelled.
    scaleHost.innerHTML =
      `<div class="ramp-legend"><span>0%</span>` +
      steps.map(c => `<i style="--k:${c}"></i>`).join('') +
      `<span>100%</span><span class="ramp-caption">${opts.rateLabel || 'Fill rate'}</span></div>`;
  }

  // ---------------------------------------------------------------------
  // India lane map — real country outline + origin→destination arcs.
  // Stroke colour: light (poor) → dark (strong). Width encodes volume.
  // ---------------------------------------------------------------------

  function projectLonLat(lon, lat) {
    const x = ((lon - 68) / 29) * 400 + 10;
    const y = ((37 - lat) / 31) * 460 + 10;
    return [x, y];
  }

  // Simplified Natural-Earth India (mainland + Andaman), projected once.
  const INDIA_OUTLINE_PATHS = ["M145.2,32.3 L148.5,32.4 L147.9,35.7 L152.0,45.2 L161.1,49.3 L161.4,51.3 L158.0,53.3 L159.0,62.0 L162.8,65.0 L168.0,65.6 L166.3,69.4 L170.2,72.8 L167.8,76.3 L166.1,75.4 L160.9,79.1 L158.6,77.3 L158.1,74.8 L153.2,76.1 L154.2,80.8 L158.2,84.7 L157.2,87.6 L159.2,90.0 L157.6,91.5 L158.2,94.5 L160.6,95.0 L163.5,92.5 L167.3,98.7 L173.5,99.7 L178.6,103.0 L178.0,105.6 L189.4,110.7 L180.6,117.5 L180.8,119.7 L178.5,122.5 L179.1,125.7 L176.0,131.1 L180.1,134.2 L182.3,135.2 L183.2,133.5 L191.7,138.2 L193.4,141.6 L194.8,141.2 L201.1,145.8 L203.5,144.8 L208.6,148.3 L212.5,148.1 L213.5,151.0 L220.8,153.5 L222.2,151.4 L228.7,153.3 L228.4,151.9 L232.3,150.8 L239.1,153.8 L239.5,158.0 L248.4,162.3 L252.9,160.6 L255.9,164.8 L262.2,164.1 L268.1,167.1 L272.6,164.6 L273.5,167.2 L276.2,168.1 L284.1,166.3 L285.5,167.8 L288.2,162.2 L285.4,156.7 L288.1,146.9 L287.2,144.6 L294.3,142.0 L297.7,145.6 L296.1,150.5 L298.2,153.7 L295.9,156.1 L297.6,159.2 L301.0,161.0 L304.4,160.5 L310.9,162.9 L318.3,159.9 L323.3,161.8 L331.3,161.7 L333.0,160.3 L339.4,161.3 L342.0,160.1 L340.9,156.6 L342.3,154.0 L340.7,151.4 L335.6,150.5 L335.0,145.8 L340.4,147.6 L344.3,145.5 L345.2,146.7 L349.0,145.8 L351.2,143.8 L350.4,141.6 L357.7,138.5 L359.2,134.6 L367.6,133.4 L368.5,131.0 L373.4,128.3 L372.6,126.5 L376.9,124.0 L379.3,126.2 L387.5,128.2 L390.2,125.1 L392.3,125.5 L392.7,124.6 L392.7,123.7 L397.2,123.2 L401.3,124.9 L398.6,127.1 L398.6,128.5 L398.9,129.6 L402.5,128.8 L404.4,132.3 L400.4,137.3 L411.6,138.1 L414.5,140.3 L415.0,143.6 L408.1,149.5 L411.6,157.1 L405.9,153.0 L398.2,154.6 L388.1,162.8 L384.1,164.2 L383.0,169.0 L384.5,172.5 L382.4,174.4 L382.5,177.1 L377.0,182.2 L376.2,184.4 L376.3,185.0 L378.4,187.7 L370.4,205.0 L359.1,202.0 L360.8,207.6 L360.0,215.8 L358.6,217.7 L356.8,217.3 L355.8,222.3 L357.2,228.7 L353.1,233.2 L350.5,230.3 L349.0,232.9 L344.6,207.3 L341.3,208.2 L340.0,207.0 L340.2,210.4 L337.5,213.7 L338.2,216.4 L335.3,218.6 L332.7,213.8 L331.6,216.2 L329.1,208.4 L332.2,201.4 L335.3,201.5 L337.4,199.4 L339.3,200.6 L339.7,197.9 L342.5,196.9 L344.1,189.7 L346.3,190.5 L347.7,189.1 L341.5,185.4 L318.5,185.8 L311.0,183.8 L311.1,173.5 L308.7,169.9 L307.1,173.8 L304.3,173.2 L301.3,171.1 L300.3,167.6 L298.2,167.5 L299.9,169.7 L295.0,169.3 L294.9,167.1 L291.0,164.2 L290.2,166.3 L292.7,168.0 L288.1,171.1 L287.1,175.7 L293.2,180.6 L296.5,180.6 L299.4,183.8 L298.6,185.6 L291.9,185.2 L290.3,189.9 L287.4,189.3 L286.2,193.3 L292.4,198.2 L296.0,198.6 L295.7,204.0 L293.8,205.1 L293.3,208.1 L296.5,210.5 L295.5,214.0 L299.1,214.7 L297.4,218.1 L300.7,230.3 L300.5,233.5 L298.3,233.0 L300.8,238.3 L298.2,237.7 L297.7,236.0 L297.7,238.0 L295.6,238.8 L296.4,230.6 L294.6,233.4 L295.0,229.5 L293.8,239.1 L292.6,239.2 L292.7,233.3 L292.2,238.2 L290.4,236.7 L290.1,238.4 L289.5,235.6 L289.4,239.2 L287.9,233.2 L288.6,230.1 L286.0,229.0 L284.6,226.3 L288.1,231.2 L283.6,236.6 L274.8,239.2 L270.9,242.6 L269.9,246.2 L271.4,249.7 L271.6,250.3 L270.4,250.7 L272.7,251.9 L268.6,255.0 L268.7,257.6 L265.1,259.5 L264.2,262.3 L260.4,260.1 L263.4,262.8 L251.1,267.2 L252.3,264.1 L248.2,265.5 L246.2,270.0 L247.9,267.4 L249.9,266.8 L249.0,268.5 L252.4,266.8 L240.9,274.9 L240.9,276.7 L232.3,287.5 L223.1,293.1 L220.2,298.0 L208.5,304.9 L206.6,307.8 L207.4,309.1 L208.2,308.1 L207.3,313.0 L199.8,316.8 L192.9,316.7 L189.5,324.9 L187.9,321.2 L186.7,325.8 L186.2,323.3 L184.8,323.0 L179.4,326.1 L176.2,335.1 L178.2,342.9 L176.2,348.2 L177.4,347.9 L179.8,359.6 L177.5,355.3 L176.2,356.9 L180.0,359.7 L180.1,363.2 L178.0,373.1 L172.6,384.4 L173.0,390.1 L171.1,391.4 L173.2,390.7 L173.5,406.3 L165.7,406.9 L165.6,410.1 L160.5,418.4 L162.8,421.0 L166.4,420.8 L168.0,423.1 L161.6,421.4 L153.6,424.0 L150.5,427.3 L148.7,434.9 L141.2,439.2 L134.1,434.9 L127.8,426.8 L129.6,425.4 L127.6,426.3 L125.4,420.7 L123.8,411.2 L125.8,415.4 L125.3,417.8 L127.3,417.5 L122.9,409.1 L123.7,407.1 L122.5,407.4 L116.7,390.3 L111.0,382.5 L112.0,381.3 L109.2,380.6 L104.2,368.7 L105.7,367.9 L104.0,368.2 L102.3,360.5 L102.9,356.4 L97.6,343.4 L98.7,344.2 L94.1,339.5 L96.0,338.3 L94.3,338.7 L91.6,335.3 L91.3,331.4 L89.8,330.4 L92.3,330.9 L89.1,328.0 L90.5,326.6 L88.9,327.1 L85.1,320.6 L80.7,298.5 L81.7,298.1 L78.0,288.6 L79.8,289.2 L80.0,287.9 L77.5,285.6 L77.9,284.0 L79.2,285.0 L76.9,281.3 L78.0,279.7 L78.9,281.1 L77.5,278.7 L79.7,276.9 L78.6,274.7 L75.8,277.9 L76.0,272.4 L79.7,273.9 L75.7,271.5 L77.3,269.2 L75.1,269.1 L74.1,264.5 L78.2,251.0 L76.7,249.9 L76.3,245.5 L73.7,245.8 L75.3,244.5 L73.0,241.7 L75.5,240.7 L73.2,241.2 L76.5,237.9 L80.8,236.2 L72.8,237.5 L73.0,234.8 L75.3,232.7 L72.1,232.9 L73.1,229.7 L77.8,228.6 L71.6,229.1 L70.7,227.1 L69.7,228.7 L67.2,228.5 L69.4,229.2 L69.5,229.8 L69.4,231.4 L66.5,232.5 L65.6,233.5 L67.5,234.9 L66.0,234.1 L66.6,235.0 L65.1,235.6 L67.5,235.6 L69.3,238.1 L66.6,244.4 L53.3,250.9 L47.8,251.6 L38.3,245.1 L23.0,228.2 L24.8,225.4 L26.7,228.5 L30.4,227.5 L30.9,225.9 L32.3,227.3 L33.9,225.5 L34.8,226.4 L40.0,224.2 L44.5,216.2 L43.0,218.6 L39.4,217.8 L31.9,221.3 L21.9,217.4 L15.8,211.1 L15.6,208.5 L21.3,204.7 L14.5,209.0 L12.0,208.7 L13.8,207.9 L12.3,206.5 L13.6,203.9 L20.0,203.4 L20.3,198.0 L21.6,199.4 L22.5,198.1 L37.2,200.5 L43.3,196.9 L44.8,196.6 L45.4,196.6 L45.4,198.9 L48.0,199.5 L52.5,196.8 L50.8,194.2 L52.3,192.8 L46.6,182.2 L46.6,178.1 L41.0,177.6 L38.5,173.5 L39.8,165.4 L30.7,162.3 L31.2,156.5 L42.3,143.4 L45.0,143.3 L49.1,148.0 L63.4,144.1 L70.1,132.2 L78.0,128.0 L84.1,114.9 L92.0,111.1 L90.7,108.3 L97.2,100.6 L101.8,97.8 L99.7,96.4 L101.3,92.2 L99.5,88.5 L100.4,86.8 L111.5,80.3 L106.9,77.3 L102.3,77.2 L102.2,71.9 L97.5,72.8 L97.1,69.4 L92.8,66.7 L94.9,62.0 L92.3,58.5 L96.5,55.1 L91.3,53.7 L92.6,51.3 L89.7,49.0 L91.6,45.0 L97.6,43.0 L117.5,47.0 L120.7,44.5 L129.3,43.4 L134.7,38.1 L145.2,32.3 Z","M355.6,361.9 L355.3,365.2 L354.0,365.1 L353.1,367.4 L354.3,368.1 L354.7,373.3 L352.7,374.5 L353.7,375.9 L351.5,379.8 L350.9,388.5 L348.3,383.1 L348.9,382.0 L349.6,383.0 L350.4,377.7 L352.0,377.9 L351.2,369.0 L352.7,361.0 L355.0,357.6 L355.6,361.9 Z"];

  const MAP_RAMP = [
    'var(--map-1)', 'var(--map-2)', 'var(--map-3)',
    'var(--map-4)', 'var(--map-5)', 'var(--map-6)'
  ];

  function mapStepFor(v, lo, hi) {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    const t = hi === lo ? 1 : (v - lo) / (hi - lo);
    const i = Math.min(MAP_RAMP.length - 1, Math.max(0, Math.floor(t * MAP_RAMP.length)));
    return MAP_RAMP[i];
  }

  function laneArcPath(x1, y1, x2, y2) {
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy) || 1;
    // Bulge perpendicular to the chord — longer lanes curve more.
    const bulge = Math.min(48, 12 + dist * 0.18);
    const cx = mx - (dy / dist) * bulge;
    const cy = my + (dx / dist) * bulge;
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  // lanes: [{ key, origin, dest, oLon, oLat, dLon, dLat, value, volume, detail }]
  function indiaLaneMap(host, lanes, opts = {}) {
    const list = (lanes || []).filter(l =>
      l.oLon != null && l.oLat != null && l.dLon != null && l.dLat != null);
    if (!list.length) {
      return emptyState(host, opts.emptyMessage || 'No mappable lanes in this window — origins/destinations need coordinates.');
    }

    const formatValue = opts.formatValue || (v => fmt.int(v));
    const metricLabel = opts.metricLabel || 'Value';
    const minVolume = opts.minVolume || 0;

    const scored = list.map(l => {
      const thin = minVolume > 0 && (l.volume || 0) < minVolume;
      return { ...l, raw: thin ? null : l.value, thin };
    });

    const nums = scored.map(s => s.raw).filter(v => v != null && Number.isFinite(v));
    let lo = 0, hi = 1;
    if (opts.scale === 'absolute' && opts.domain) {
      lo = opts.domain[0];
      hi = opts.domain[1];
    } else if (nums.length) {
      lo = Math.min(...nums);
      hi = Math.max(...nums);
      if (lo === hi) { lo = Math.min(0, lo); hi = hi || 1; }
    }

    const maxVol = Math.max(...scored.map(s => s.volume || 0), 1);
    const width = measure(host, 640);
    const mapW = Math.min(560, width);
    const mapH = Math.round(mapW * (480 / 420));
    host.innerHTML = '<div class="india-map-wrap" data-map></div><div data-scale></div>';
    const mapHost = host.querySelector('[data-map]');
    const scaleHost = host.querySelector('[data-scale]');
    const svg = svgRoot(mapHost, mapW, mapH);
    svg.setAttribute('viewBox', '0 0 420 480');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.classList.add('india-map-svg');

    // Landmass
    const land = el('g', { class: 'india-land' }, svg);
    INDIA_OUTLINE_PATHS.forEach(d => {
      el('path', {
        d,
        class: 'india-outline',
        fill: 'var(--surface-2)',
        stroke: 'var(--border-strong)',
        'stroke-width': 1.25
      }, land);
    });

    // Draw thin lanes first so strong lanes sit on top.
    const ordered = [...scored].sort((a, b) => (a.volume || 0) - (b.volume || 0));
    const laneLayer = el('g', { class: 'india-lanes' }, svg);

    ordered.forEach(s => {
      const [x1, y1] = projectLonLat(s.oLon, s.oLat);
      const [x2, y2] = projectLonLat(s.dLon, s.dLat);
      const stroke = mapStepFor(s.raw, lo, hi) || 'var(--axis-line)';
      const sw = 1.1 + 7.5 * Math.sqrt((s.volume || 0) / maxVol);
      const path = el('path', {
        d: laneArcPath(x1, y1, x2, y2),
        class: 'india-lane' + (opts.onSelect ? ' is-clickable' : ''),
        fill: 'none',
        stroke,
        'stroke-width': sw.toFixed(2),
        'stroke-linecap': 'round',
        opacity: s.raw == null ? 0.28 : 0.78
      }, laneLayer);

      const tip = () => {
        const extra = s.detail ? `<br><span class="tip-muted">${s.detail}</span>` : '';
        const thin = s.thin
          ? `<br><span class="tip-muted">Below volume floor (${fmt.int(minVolume)}) — colour withheld</span>`
          : '';
        return `<strong>${s.key}</strong><br>${metricLabel}: ${formatValue(s.raw)}${thin}${extra}`;
      };
      path.addEventListener('mousemove', e => {
        path.classList.add('is-hover');
        path.setAttribute('opacity', '1');
        showTip(tip(), e);
      });
      path.addEventListener('mouseleave', () => {
        path.classList.remove('is-hover');
        path.setAttribute('opacity', s.raw == null ? '0.28' : '0.78');
        hideTip();
      });
      if (opts.onSelect) {
        path.style.cursor = 'pointer';
        path.addEventListener('click', () => opts.onSelect(s));
      }
    });

    // Hub cities that appear as lane endpoints.
    const hubMap = new Map();
    scored.forEach(s => {
      for (const [name, lon, lat, role] of [
        [s.origin, s.oLon, s.oLat, 'origin'],
        [s.dest, s.dLon, s.dLat, 'dest']
      ]) {
        if (!name || lon == null) continue;
        let h = hubMap.get(name);
        if (!h) {
          h = { key: name, lon, lat, volume: 0, roles: new Set() };
          hubMap.set(name, h);
        }
        h.volume += s.volume || 0;
        h.roles.add(role);
      }
    });
    const hubs = [...hubMap.values()].sort((a, b) => b.volume - a.volume);
    const hubMax = Math.max(...hubs.map(h => h.volume), 1);
    const hubLayer = el('g', { class: 'india-hubs' }, svg);
    const labelTop = hubs.slice(0, Math.min(14, hubs.length));

    hubs.forEach(h => {
      const [cx, cy] = projectLonLat(h.lon, h.lat);
      const r = 2.2 + 4.5 * Math.sqrt(h.volume / hubMax);
      const dot = el('circle', {
        cx, cy, r,
        class: 'india-hub' + (opts.onHubSelect ? ' is-clickable' : ''),
        fill: 'var(--text-primary)',
        stroke: 'var(--page)',
        'stroke-width': 1.1
      }, hubLayer);
      dot.addEventListener('mousemove', e => showTip(
        `<strong>${h.key}</strong><br><span class="tip-muted">Lane endpoint · ${fmt.int(h.volume)} on connected lanes</span>`, e));
      dot.addEventListener('mouseleave', hideTip);
      if (opts.onHubSelect) {
        dot.style.cursor = 'pointer';
        dot.addEventListener('click', ev => {
          ev.stopPropagation();
          opts.onHubSelect(h);
        });
      }
    });

    labelTop.forEach(h => {
      const [cx, cy] = projectLonLat(h.lon, h.lat);
      const t = el('text', {
        x: cx + 5, y: cy - 5,
        class: 'india-hub-label'
      }, hubLayer);
      t.textContent = h.key;
    });

    const loLabel = formatValue(lo);
    const hiLabel = formatValue(hi);
    scaleHost.innerHTML =
      `<div class="ramp-legend"><span>Poor · ${loLabel}</span>` +
      MAP_RAMP.map(c => `<i style="--k:${c}"></i>`).join('') +
      `<span>${hiLabel} · Strong</span>` +
      `<span class="ramp-caption">${metricLabel} · lane colour · width = volume</span></div>`;
  }

  // ---------------------------------------------------------------------
  // Sparkline for stat tiles. No axes, no labels — the tile carries those.
  // ---------------------------------------------------------------------
  function sparkline(host, values, opts = {}) {
    const clean = (values || []).filter(v => v !== null && v !== undefined);
    if (clean.length < 2) { host.innerHTML = ''; return; }
    const width = opts.width || measure(host, 120);
    const height = opts.height || 30;
    const max = Math.max(...clean), min = Math.min(...clean);
    const span = (max - min) || 1;
    const xAt = i => (i / (values.length - 1)) * (width - 2) + 1;
    const yAt = v => height - 2 - ((v - min) / span) * (height - 4);
    const svg = svgRoot(host, width, height);
    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(v)}`).join(' ');
    el('path', { d, fill: 'none', stroke: opts.color || 'var(--series-1)', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85 }, svg);
  }

  // ---------------------------------------------------------------------
  // Table view — the relief for sub-3:1 marks, and the analyst's own view.
  // columns: [{ key, label, align, format }]
  // ---------------------------------------------------------------------
  function table(host, rows, columns, opts = {}) {
    if (!rows || !rows.length) return emptyState(host, opts.emptyMessage || 'No rows.');
    const thead = columns.map(c =>
      `<th scope="col" class="${c.align === 'right' ? 'num' : ''}">${c.label}</th>`).join('');
    const tbody = rows.map((r, i) => {
      const cells = columns.map(c => {
        const v = c.format ? c.format(r[c.key], r) : (r[c.key] ?? '—');
        return `<td class="${c.align === 'right' ? 'num' : ''}">${v}</td>`;
      }).join('');
      const clickable = opts.onSelect ? ' class="clickable"' : '';
      return `<tr data-row="${i}"${clickable}>${cells}</tr>`;
    }).join('');
    host.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
    if (opts.onSelect) {
      host.querySelectorAll('tbody tr').forEach(tr => {
        tr.addEventListener('click', () => opts.onSelect(rows[Number(tr.dataset.row)]));
        tr.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            opts.onSelect(rows[Number(tr.dataset.row)]);
          }
        });
        tr.tabIndex = 0;
        tr.setAttribute('role', 'button');
      });
    }
  }

  function toCsv(rows, columns) {
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = columns.map(c => esc(c.label)).join(',');
    const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
    return head + '\n' + body;
  }

  function downloadCsv(filename, rows, columns) {
    const blob = new Blob([toCsv(rows, columns)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.Charts = {
    rankedBars, stackedBars, lineChart, funnelChart, heatmapGrid, indiaLaneMap,
    sparkline, table, toCsv, downloadCsv, fmt, emptyState, measure, hideTip
  };
})(window);
