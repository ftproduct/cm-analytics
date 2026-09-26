#!/usr/bin/env node
// scripts/selftest.js
// Runs every metric through the demo engine and asserts the invariants that
// must hold whichever backend produced the numbers. Run it after changing
// _engine.js, _sql.js or the schema mapping:  npm run check

// Force a small chunk size so the snapshot round trip actually exercises the
// multi-chunk path rather than always fitting in one.
process.env.MA_SNAPSHOT_CHUNK_CHARS = '50000';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const engine = require('../api/_engine.js');
const demo = require('../api/_demo.js');
const store = require('../api/_store.js');
const S = require('../api/_schema.js');

const filters = { from: '2026-06-01', to: '2026-09-17', outcome: 'all' };
let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

console.log('\nschema');
check('config/schema.json parses and every identifier is safe', () => {
  const s = S.getSchema();
  assert.ok(s.demand.table && s.inventory.table);
});
check('core dimensions resolve for both entities', () => {
  for (const entity of ['demand', 'inventory']) {
    const dims = S.availableDimensions(entity);
    assert.ok(dims.lane, `${entity} is missing a lane dimension`);
    assert.ok(dims.psa, `${entity} is missing a PSA dimension`);
  }
  const demandDims = S.availableDimensions('demand');
  assert.ok(demandDims.superClusterLane, 'demand is missing a superClusterLane dimension');
  assert.ok(demandDims.region, 'demand is missing a zone (region) dimension');
});
check('excludeStatuses drops EXTERNAL from the fulfilment lists', () => {
  const s = S.getSchema();
  assert.ok((s.demand.excludeStatuses || []).includes('VEHICLE_PLACED_BY_EXTERNAL'));
  assert.ok(!(s.demand.fulfilledStatuses || []).includes('VEHICLE_PLACED_BY_EXTERNAL'));
  assert.ok(!(s.demand.unfulfilledStatuses || []).includes('VEHICLE_PLACED_BY_EXTERNAL'));
  const excl = S.excludeStatusesExpr('demand');
  assert.ok(excl && excl.includes('VEHICLE_PLACED_BY_EXTERNAL'));
});
check('liquid-lane cities map to North/South/East/West/Central', () => {
  const zone = require('../api/_zone.js');
  const map = zone.loadMap();
  for (const z of map.zones) assert.ok(zone.CANONICAL.has(z), z);
  // Cities that appear as phase2poc_liquid_lanes.origin
  assert.strictEqual(zone.zoneForSuperCluster('Bombay'), 'West');
  assert.strictEqual(zone.zoneForSuperCluster('Delhi NCR'), 'North');
  assert.strictEqual(zone.zoneForSuperCluster('Bangalore'), 'South');
  assert.strictEqual(zone.zoneForSuperCluster('Kolkata'), 'East');
  assert.strictEqual(zone.zoneForSuperCluster('Indore'), 'Central');
  assert.strictEqual(zone.resolveZone({ originSuperCluster: 'Pune' }), 'West');
});

console.log('\nsummary');
const summary = engine.runSpec({ entity: 'demand', kind: 'summary', filters });
check('fulfilled + unfulfilled equals total', () => {
  assert.strictEqual(summary.current.success + summary.current.failed, summary.current.total);
});
check('fill rate matches the counts it is derived from', () => {
  const expected = Math.round((summary.current.success / summary.current.total) * 1000) / 10;
  assert.strictEqual(summary.current.rate, expected);
});
check('the comparison window is the same length and does not overlap', () => {
  const prev = engine.shiftWindow(filters);
  assert.ok(prev.to < filters.from, 'previous window overlaps the current one');
  const days = s => Math.round((new Date(s.to) - new Date(s.from)) / 86400000);
  assert.strictEqual(days(prev), days(filters));
});

console.log('\ngroup + filters');
check('group totals never exceed the unfiltered total', () => {
  const g = engine.runSpec({ entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 0, filters });
  const sum = g.rows.reduce((s, r) => s + r.total, 0);
  assert.strictEqual(sum, summary.current.total);
});
check('office-hours buckets partition every demand', () => {
  const o = engine.runSpec({ entity: 'demand', kind: 'officeHours', filters });
  assert.deepStrictEqual(o.rows.map(r => r.key), ['9am–1pm', '1pm–7pm', 'After office hours']);
  const sum = o.rows.reduce((s, r) => s + r.total, 0);
  assert.strictEqual(sum, summary.current.total);
  assert.ok(Math.abs(o.rows.reduce((s, r) => s + r.share, 0) - 100) < 0.2);
});
check('an outcome filter actually narrows the rows', () => {
  const only = engine.runSpec({ entity: 'demand', kind: 'summary', filters: { ...filters, outcome: 'fail' } });
  assert.strictEqual(only.current.success, 0);
  assert.strictEqual(only.current.total, summary.current.failed);
});
check('a dimension filter narrows to that dimension only', () => {
  const lanes = engine.runSpec({ entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 1, filters });
  const lane = lanes.rows[0].key;
  const scoped = engine.runSpec({ entity: 'demand', kind: 'group', groupBy: 'superClusterLane', limit: 5, filters: { ...filters, superClusterLane: [lane] } });
  assert.strictEqual(scoped.rows.length, 1);
  assert.strictEqual(scoped.rows[0].key, lane);
});
check('zone group covers the demand total', () => {
  const g = engine.runSpec({ entity: 'demand', kind: 'group', groupBy: 'region', limit: 0, filters });
  const sum = g.rows.reduce((s, r) => s + r.total, 0);
  assert.strictEqual(sum, summary.current.total);
  assert.ok(g.rows.length >= 2, 'expected multiple zones in demo data');
});

console.log('\nreasons');
const reasons = engine.runSpec({ entity: 'demand', kind: 'reasons', limit: 50, filters });
check('reason counts add up to the unfulfilled total', () => {
  assert.strictEqual(reasons.totalFailures, summary.current.failed);
});
check('cumulative share is monotonic and ends at 100%', () => {
  let last = 0;
  for (const r of reasons.rows) {
    assert.ok(r.cumulative >= last, 'cumulative share went backwards');
    last = r.cumulative;
  }
  assert.ok(Math.abs(last - 100) < 0.5, `cumulative share ended at ${last}%`);
});

console.log('\nfunnel');
const funnel = engine.runSpec({ entity: 'inventory', kind: 'funnel', filters }).rows;
check('funnel stages never increase down the list', () => {
  for (let i = 1; i < funnel.length; i++) {
    assert.ok(funnel[i].count <= funnel[i - 1].count,
      `${funnel[i].stage} (${funnel[i].count}) exceeds ${funnel[i - 1].stage} (${funnel[i - 1].count})`);
  }
});
check('the final funnel stage equals the converted count', () => {
  const inv = engine.runSpec({ entity: 'inventory', kind: 'summary', filters });
  assert.strictEqual(funnel[funnel.length - 1].count, inv.current.success);
});

console.log('\nageing');
const aging = engine.runSpec({ entity: 'inventory', kind: 'aging', filters }).rows;
check('every posting lands in exactly one ageing bucket', () => {
  const inv = engine.runSpec({ entity: 'inventory', kind: 'summary', filters });
  assert.strictEqual(aging.reduce((s, b) => s + b.total, 0), inv.current.total);
});
check('faster response converts better than never touching it', () => {
  const fast = aging.find(b => b.bucket === '0-6h');
  const never = aging.find(b => b.bucket === 'Never touched');
  assert.ok(fast.rate > never.rate,
    `0-6h (${fast.rate}%) should beat never-touched (${never.rate}%)`);
});

console.log('\nmatching');
const leak = engine.runSpec({ kind: 'leakage', limit: 50, filters }).rows;
check('matchable never exceeds either side of the pair', () => {
  for (const r of leak) {
    assert.ok(r.matchable <= r.unfulfilled && r.matchable <= r.unconverted, `bad matchable on ${r.lane}`);
    assert.equal(r.fulfilled + r.unfulfilled, r.demand, `fulfilled+unfulfilled != demand on ${r.lane}`);
  }
});

const imb = engine.runSpec({ kind: 'imbalance', limit: 50, filters });
check('imbalance sides never overlap on the same lane', () => {
  const d = new Set((imb.demandHeavy || []).map(r => r.lane));
  const s = new Set((imb.supplyHeavy || []).map(r => r.lane));
  for (const lane of d) assert.ok(!s.has(lane), `${lane} appears on both imbalance sides`);
});
check('demand-heavy gaps are demand minus supply', () => {
  for (const r of imb.demandHeavy || []) {
    assert.strictEqual(r.gap, r.demand - r.supply, `bad demand gap on ${r.lane}`);
    assert.ok(r.demand > r.supply, `${r.lane} is not demand-heavy`);
  }
});
check('supply-heavy gaps are supply minus demand', () => {
  for (const r of imb.supplyHeavy || []) {
    assert.strictEqual(r.gap, r.supply - r.demand, `bad supply gap on ${r.lane}`);
    assert.ok(r.supply > r.demand, `${r.lane} is not supply-heavy`);
  }
});

console.log('\ntimeseries');
check('period totals reconcile with the summary total', () => {
  for (const grain of ['day', 'week', 'month']) {
    const ts = engine.runSpec({ entity: 'demand', kind: 'timeseries', grain, filters }).rows;
    const sum = ts.reduce((s, r) => s + r.total, 0);
    assert.strictEqual(sum, summary.current.total, `${grain} grain does not reconcile`);
  }
});

console.log('\nmovers');
check('movers only report periods with comparable volume on both sides', () => {
  const m = engine.runSpec({ entity: 'demand', kind: 'movers', groupBy: 'superClusterLane', limit: 50, filters });
  for (const r of [...m.declining, ...m.improving]) {
    assert.ok(r.total >= 12 && r.prevTotal >= 12, `${r.key} reported on thin volume`);
  }
});

// The allowlist in api/_specs.js is a third copy of the metric list, beside the
// engines that implement them and the frontend that asks for them. A kind that
// falls out of step is rejected at the gate and the panel reads "Unsupported
// metric" even though the implementation is right there -- which is exactly how
// officeHours shipped broken. Compare the three by reading the source.
function metricKinds() {
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const kindsBlock = /const KINDS = new Set\(\[([\s\S]*?)\]\)/.exec(read('api/_specs.js'));
  assert.ok(kindsBlock, 'api/_specs.js no longer declares KINDS — the allowlist guard is blind');
  const allowed = new Set(
    (kindsBlock[1].match(/'([a-zA-Z]+)'/g) || []).map(s => s.replace(/'/g, '')));
  const implemented = new Set(
    (read('api/_engine.js').match(/^    case '([a-zA-Z]+)':/gm) || [])
      .map(s => s.replace(/.*'([a-zA-Z]+)'.*/, '$1')));
  const requested = new Set(
    (read('public/app.js').match(/kind: '([a-zA-Z]+)'/g) || [])
      .map(s => s.replace(/.*'([a-zA-Z]+)'.*/, '$1')));
  return { allowed, implemented, requested };
}

console.log('\nmetric allowlist');
const kinds = metricKinds();
check('every metric the frontend requests is allowed by the API', () => {
  const missing = [...kinds.requested].filter(k => !kinds.allowed.has(k));
  assert.deepStrictEqual(missing, [],
    `the frontend asks for ${missing.join(", ")} but api/_specs.js rejects it`);
});
check('every allowed metric is implemented by the engine', () => {
  const orphaned = [...kinds.allowed].filter(k => !kinds.implemented.has(k));
  assert.deepStrictEqual(orphaned, [],
    `api/_specs.js allows ${orphaned.join(", ")} but _engine.js does not implement it`);
});

// The snapshot cache is only safe if a restored dataset produces byte-identical
// metrics to the one it was written from. gzip, chunking and JSON round trips
// all sit between the two.
async function snapshotChecks() {
  console.log('\nsnapshot cache');
  const original = demo.build();

  const meta = await store.writeSnapshot(original, { window: filters, rows: {
    demand: original.demand.length, inventory: original.inventory.length
  } });
  check('snapshot is written in more than one chunk at this chunk size', () => {
    assert.ok(meta.chunks > 1, `expected multiple chunks, got ${meta.chunks}`);
    assert.ok(meta.storedBytes < meta.rawBytes, 'compression did not reduce the payload');
  });

  const restored = await store.readSnapshot();
  check('snapshot reads back with every row intact', () => {
    assert.ok(restored, 'nothing came back from the store');
    assert.strictEqual(restored.dataset.demand.length, original.demand.length);
    assert.strictEqual(restored.dataset.inventory.length, original.inventory.length);
    assert.deepStrictEqual(restored.dataset.demand[0], original.demand[0]);
  });

  check('every metric is identical when computed from the restored snapshot', () => {
    const specs = [
      { entity: 'demand', kind: 'summary' },
      { entity: 'demand', kind: 'group', groupBy: 'lane', limit: 20 },
      { entity: 'demand', kind: 'timeseries', grain: 'week' },
      { entity: 'demand', kind: 'reasons', limit: 20 },
      { entity: 'inventory', kind: 'funnel' },
      { entity: 'inventory', kind: 'aging' },
      { entity: 'inventory', kind: 'group', groupBy: 'psa', limit: 20 },
      { entity: 'demand', kind: 'movers', groupBy: 'lane', limit: 10 },
      { kind: 'leakage', limit: 20 },
      { entity: 'demand', kind: 'heatmap', grain: 'week', limit: 8 }
    ];
    for (const spec of specs) {
      const a = engine.runSpec({ ...spec, filters }, original);
      const b = engine.runSpec({ ...spec, filters }, restored.dataset);
      assert.deepStrictEqual(b, a, `${spec.kind}${spec.groupBy ? '/' + spec.groupBy : ''} differs after a cache round trip`);
    }
  });

  check('filter options survive the round trip', () => {
    assert.deepStrictEqual(
      engine.filterOptions(filters, restored.dataset),
      engine.filterOptions(filters, original));
  });

  await store.clearSnapshot();
  const afterClear = await store.readSnapshot();
  check('clearing the cache leaves nothing behind', () => {
    assert.strictEqual(afterClear, null);
  });

  console.log(`\n${checks} checks passed\n`);
}

// ---------------------------------------------------------------------------
// Access control
//
// Every privileged route must agree with /api/auth/me about who is admin. The
// UI enables Sync and the SQL console from what /api/auth/me reports, so a
// route that gates differently gives you either a button you can press and a
// 401 behind it, or a greyed-out button over an endpoint that would have
// allowed you through.
// ---------------------------------------------------------------------------
console.log('\naccess control');
{
  const auth = require('../api/_auth.js');
  const AUTH_ENV = [
    'SESSION_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'BASIC_AUTH_USER',
    'BASIC_AUTH_PASSWORD', 'ADMIN_EMAILS', 'MA_DEV_ALLOW_ANONYMOUS', 'VERCEL'
  ];
  const saved = Object.fromEntries(AUTH_ENV.map(k => [k, process.env[k]]));
  const restore = () => {
    for (const k of AUTH_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  const only = env => {
    for (const k of AUTH_ENV) delete process.env[k];
    Object.assign(process.env, env);
  };
  const basicReq = (user, pass) => ({
    headers: { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64') }
  });
  const fakeRes = () => {
    const r = { code: null, body: null };
    r.status = c => { r.code = c; return r; };
    r.json = b => { r.body = b; return r; };
    r.setHeader = () => {};
    return r;
  };

  const SHARED = { BASIC_AUTH_USER: 'ft', BASIC_AUTH_PASSWORD: 'pw', SESSION_SECRET: 's'.repeat(32) };

  try {
    check('with only a shared password, holding it is admin', () => {
      only(SHARED);
      const id = auth.resolveIdentity(basicReq('ft', 'pw'));
      assert.strictEqual(id.authenticated, true);
      assert.strictEqual(id.role, 'admin', 'the shared password must grant admin when there is no OAuth');
      assert.ok(auth.requireAdmin(basicReq('ft', 'pw'), fakeRes()), 'requireAdmin must accept the shared password');
    });

    check('a wrong shared password is nobody', () => {
      only(SHARED);
      assert.strictEqual(auth.resolveIdentity(basicReq('ft', 'nope')).role, 'anonymous');
      const res = fakeRes();
      assert.strictEqual(auth.requireAdmin(basicReq('ft', 'nope'), res), null);
      assert.strictEqual(res.code, 401);
    });

    check('once OAuth is configured the shared password drops to viewer', () => {
      only({ ...SHARED, GOOGLE_OAUTH_CLIENT_ID: 'client', ADMIN_EMAILS: 'someone@freighttiger.com' });
      assert.strictEqual(auth.resolveIdentity(basicReq('ft', 'pw')).role, 'viewer');
      assert.strictEqual(auth.requireAdmin(basicReq('ft', 'pw'), fakeRes()), null);
    });
  } finally {
    restore();
  }

  check('privileged routes gate through requireAdmin rather than their own check', () => {
    for (const file of ['sync.js', 'sql.js', 'catalog.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'api', file), 'utf8');
      assert.ok(/requireAdmin\(req, res\)/.test(src), `api/${file} does not call requireAdmin`);
      assert.ok(!/isAdmin\(session\.email\)/.test(src),
        `api/${file} hand-rolls a session admin check, so it will refuse the shared password`);
    }
  });

  check('/api/auth/me reports the role from the same resolver', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'auth', 'me.js'), 'utf8');
    assert.ok(/resolveIdentity\(req\)/.test(src), 'me.js must use resolveIdentity');
    assert.ok(!/getRole\(session\?\.email\)/.test(src),
      'me.js reads the session directly, so basic-auth users report as anonymous and the UI greys out Sync');
  });
}

// ---------------------------------------------------------------------------
// View intros
//
// The one-liner under the tab strip is keyed by tab id. Rename a tab and the
// line silently disappears, which nothing else would catch.
// ---------------------------------------------------------------------------
console.log('\nview intros');
{
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const introBlock = /const VIEW_INTRO = \{([\s\S]*?)\n  \};/.exec(appSrc);
  const introKeys = introBlock
    ? [...introBlock[1].matchAll(/^\s{4}(\w+):/gm)].map(m => m[1])
    : [];
  const tabIds = [...htmlSrc.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]);

  check('every view intro is keyed to a tab that exists', () => {
    assert.ok(introKeys.length, 'VIEW_INTRO not found in public/app.js');
    for (const key of introKeys) {
      assert.ok(tabIds.includes(key), `VIEW_INTRO has "${key}", which is not a tab in index.html`);
    }
  });

  check('the six leadership views all carry an intro line', () => {
    for (const key of ['overview', 'map', 'demand', 'inventory', 'matching', 'people']) {
      assert.ok(introKeys.includes(key), `the "${key}" view has no intro line`);
    }
  });

  check('the intro element exists and stays hideable', () => {
    assert.ok(/id="viewIntro"/.test(htmlSrc), 'index.html has no #viewIntro element');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
    const rule = /\.view-intro \{([^}]*)\}/.exec(css);
    assert.ok(rule, '.view-intro has no style rule');
    assert.ok(!/display\s*:/.test(rule[1]),
      '.view-intro sets display, which outranks the [hidden] attribute — the line would show on every tab');
  });
}

// Assistant
//
// The chat lets a language model choose what to query. These assert the two
// things that keeps safe: the model can only name what the schema maps, and
// whatever it returns goes through the same validator the dashboard uses. The
// end-to-end check runs a whole turn against a stubbed gateway -- no network,
// no key -- so the planner/executor/phraser contract is covered on every run.
// ---------------------------------------------------------------------------
async function assistantChecks() {
  console.log('\nassistant');
  const specs = require('../api/_specs.js');
  const askMod = require('../api/_ask.js');
  const llmMod = require('../api/_llm.js');

  check('metrics.js uses the shared validator rather than its own copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'metrics.js'), 'utf8');
    assert.ok(/require\('\.\/_specs\.js'\)/.test(src), 'metrics.js must require _specs.js');
    assert.ok(!/function sanitiseSpec/.test(src),
      'metrics.js defines its own sanitiseSpec again — the chat and the dashboard would drift apart');
  });

  // The fixture must be the shape /api/filters really returns -- rows of
  // { value, count } -- or this suite passes while the live card is empty.
  const realOptions = engine.filterOptions({ from: '2026-06-01', to: '2026-09-17' }, demo.build());
  const card = askMod.capabilityCard({
    today: '2026-09-26',
    window: { from: '2026-06-01', to: '2026-09-17' },
    options: realOptions,
    mode: 'demo'
  });

  check('the capability card describes every metric the API allows', () => {
    for (const kind of specs.KINDS) {
      assert.ok(card.includes(`  ${kind} —`), `the card never mentions "${kind}", so the planner cannot pick it`);
    }
  });

  check('the card offers only dimensions the schema actually maps', () => {
    const demandLine = /demand: (.+)/.exec(card);
    assert.ok(demandLine, 'no demand dimension line in the card');
    const offered = demandLine[1].split(', ').map(s => s.split(' ')[0]);
    const mapped = S.availableDimensions('demand');
    for (const key of offered) {
      assert.ok(mapped[key], `the card offers "${key}" but config/schema.json does not map it`);
    }
  });

  check('the card lists real filter values, not an empty placeholder', () => {
    assert.ok(!card.includes('(no filter values loaded)'),
      'the card has no filter values — the option row shape changed and the planner is flying blind');
    const lspRow = /^ {2}lsp: (.+)$/m.exec(card);
    assert.ok(lspRow, 'no lsp filter line in the card');
    const offered = lspRow[1].split(' | ')[0];
    const real = realOptions.lsp.map(o => o.value);
    assert.ok(real.includes(offered), `the card offers lsp "${offered}", which is not a value in the data`);
  });

  check('unfulfilment reasons reach the card despite their per-entity option key', () => {
    assert.ok(/^ {2}reason: .+/m.test(card),
      'filterOptions returns reasons under demandReason; the card must still offer them as "reason"');
  });

  check('a plausible plan survives validation', () => {
    const out = askMod.validatePlan({
      intent: 'worst lanes by unfulfilled volume',
      specs: [{ entity: 'demand', kind: 'group', groupBy: 'lsp', limit: 5, filters: { from: '2026-08-01', to: '2026-08-31', outcome: 'fail' } }]
    }, {});
    assert.strictEqual(out.specs.length, 1);
    assert.strictEqual(out.specs[0].kind, 'group');
    assert.strictEqual(out.specs[0].filters.from, '2026-08-01');
    assert.strictEqual(out.specs[0].filters.outcome, 'fail');
  });

  check('an invented metric is rejected', () => {
    assert.throws(
      () => askMod.validatePlan({ specs: [{ entity: 'demand', kind: 'profitByQuarter' }] }, {}),
      /Unsupported metric/);
  });

  check('an unmapped dimension is rejected rather than silently dropped', () => {
    assert.throws(
      () => askMod.validatePlan({ specs: [{ entity: 'demand', kind: 'group', groupBy: 'driverMoodScore' }] }, {}),
      /not a demand dimension/);
  });

  check('an unknown filter key is rejected, not silently dropped', () => {
    // The dangerous case: the spec still runs, but unfiltered, while the
    // phraser is told the question was about one carrier.
    assert.throws(
      () => askMod.validatePlan({
        intent: 'demand for carrier Foo',
        specs: [{ entity: 'demand', kind: 'summary', filters: { from: '2026-06-01', to: '2026-09-17', carrier: ['Foo Logistics'] } }]
      }, {}),
      /Unknown filter: carrier/);
  });

  check('the real filter keys are still accepted', () => {
    const out = askMod.validatePlan({
      specs: [{ entity: 'demand', kind: 'summary', filters: { from: '2026-06-01', to: '2026-09-17', lsp: ['Shree Roadlines'], outcome: 'fail' } }]
    }, {});
    assert.deepStrictEqual(out.specs[0].filters.lsp, ['Shree Roadlines']);
  });

  check('a truncated snapshot reports the coverage it really has', () => {
    const src = {
      mode: 'cached',
      snapshot: {
        window: { from: '2026-01-01', to: '2026-09-17' },
        truncated: { demand: true },
        covers: { demandFrom: '2026-05-04', inventoryFrom: '2026-04-02', bidsFrom: '2026-04-30' }
      }
    };
    const w = askMod.coveredWindow(src, {});
    assert.strictEqual(w.from, '2026-05-04', 'must use the latest entity start, not the requested one');
    assert.strictEqual(w.to, '2026-09-17');
    assert.strictEqual(w.truncated, true);

    const whole = askMod.coveredWindow(
      { mode: 'cached', snapshot: { window: { from: '2026-01-01', to: '2026-09-17' } } }, {});
    assert.strictEqual(whole.from, '2026-01-01', 'an untruncated sync keeps its requested window');
    assert.ok(!whole.truncated);
  });

  check('the card warns the planner off dates a truncated sync never pulled', () => {
    const warned = askMod.capabilityCard({
      today: '2026-09-26',
      window: { from: '2026-05-04', to: '2026-09-17', truncated: true },
      options: realOptions,
      mode: 'cached'
    });
    assert.ok(/hit its row limit/.test(warned), 'a truncated window must say so in the card');
  });

  check('a clarification passes through instead of becoming a query', () => {
    const out = askMod.validatePlan({ clarify: 'Which month did you mean?' }, {});
    assert.strictEqual(out.clarify, 'Which month did you mean?');
    assert.ok(!out.specs);
  });

  check('the planner cannot widen a scan past the spec limits', () => {
    const out = askMod.validatePlan({
      specs: [{ entity: 'demand', kind: 'rows', limit: 999999, filters: { from: '2026-01-01', to: '2026-09-01' } }]
    }, {});
    assert.strictEqual(out.specs[0].limit, 2000);
  });

  check('only the first few specs of an over-long plan are run', () => {
    const many = Array.from({ length: 10 }, () => ({ entity: 'demand', kind: 'summary' }));
    const out = askMod.validatePlan({ specs: many }, {});
    assert.strictEqual(out.specs.length, askMod.MAX_PLAN_SPECS);
  });

  check('the phraser payload is trimmed but keeps its numbers', () => {
    const big = { rows: Array.from({ length: 50 }, (_, i) => ({ key: `lane-${i}`, total: i, rate: 12.345 })) };
    const small = askMod.shrinkPayload(big);
    assert.strictEqual(small.rows.length, 8);
    assert.strictEqual(small.rows[0].key, 'lane-0');
    assert.strictEqual(small.rows[3].rate, 12.3, 'rates should round to one decimal, not be dropped');
    assert.ok(small.rows_truncated.includes('50 rows total'));
  });

  // A whole turn with the gateway stubbed. The planner returns a spec, the
  // engine computes it for real, and the phraser is handed the result -- so
  // this fails if the spec shape, the executor or the payload contract breaks.
  const realChat = llmMod.chat;
  try {
    let phrasePrompt = null;
    llmMod.chat = async ({ messages }) => {
      const isPlan = messages[0].content.startsWith('You turn questions');
      if (isPlan) {
        return { text: '```json\n{"intent":"fill rate","specs":[{"id":"a","entity":"demand","kind":"summary","filters":{"from":"2026-06-01","to":"2026-09-17"}}]}\n```' };
      }
      phrasePrompt = messages[1].content;
      return { text: 'Fill rate was 68.9% over the window.' };
    };

    const turn = await askMod.ask({ question: 'what is the fill rate?', filters: {} });

    check('a full turn plans, executes and phrases', () => {
      assert.strictEqual(turn.specs.length, 1);
      assert.strictEqual(turn.specs[0].kind, 'summary');
      assert.ok(turn.answer.includes('68.9'));
    });

    check('the phraser is given engine numbers, never the raw dataset', () => {
      assert.ok(phrasePrompt, 'the phraser was never called');
      assert.ok(/"total":\d+/.test(phrasePrompt), 'computed totals should reach the phraser');
      assert.ok(phrasePrompt.length < 6000, `the phraser prompt is ${phrasePrompt.length} chars — the dataset is leaking into it`);
      assert.ok(!/createdDate/.test(phrasePrompt), 'raw row fields reached the phraser');
    });

    check('row-level answers deep-link to the tab that shows rows', () => {
    // chat.js is a browser IIFE, so assert on its routing table. Only the
    // explorer renders kind:'rows' -- app.js requests it from renderExplore.
    const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.js'), 'utf8');
    assert.ok(/spec\.kind === 'rows'\) return 'explore'/.test(chatSrc),
      "kind 'rows' must route to the explorer; the Demand tab has no row panel");
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const exploreStart = appSrc.indexOf('async function renderExplore');
    assert.ok(exploreStart > 0 && appSrc.slice(exploreStart, exploreStart + 2500).includes("kind: 'rows'"),
      'renderExplore no longer requests rows — the chat routing assumption is stale');
  });

  check('fenced JSON from a chatty model still parses', () => {
      const parsed = llmMod.parseJsonObject('Sure!\n```json\n{"a":1}\n```');
      assert.strictEqual(parsed.a, 1);
    });

    check('a gateway URL is accepted with or without its /v1 suffix', () => {
      assert.strictEqual(llmMod.completionsUrl('https://gw/v1'), 'https://gw/v1/chat/completions');
      assert.strictEqual(llmMod.completionsUrl('https://gw'), 'https://gw/v1/chat/completions');
      assert.strictEqual(llmMod.completionsUrl('https://gw/v1/chat/completions'), 'https://gw/v1/chat/completions');
    });
  } finally {
    llmMod.chat = realChat;
  }
}

assistantChecks()
  .then(snapshotChecks)
  .catch(e => { console.error('\n' + e.stack); process.exit(1); });
