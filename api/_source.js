// /api/_source.js
// Decides where a request's numbers come from, and runs the metric there.
//
//   demo   -- no Databricks token. Generated dataset from _demo.js.
//   cached -- a synced snapshot exists. Every metric is computed in memory from
//             those rows, so no filter combination touches the warehouse.
//   live   -- token configured but nothing synced yet. Falls back to querying
//             Databricks per metric, which is what the app did before sync
//             existed. Correct, just expensive.
//
// The three return identical JSON, so nothing downstream has to branch.

const { isDemoMode } = require('./_databricks.js');
const demo = require('./_demo.js');
const engine = require('./_engine.js');
const sql = require('./_sql.js');
const store = require('./_store.js');

async function resolve() {
  if (isDemoMode()) {
    return { mode: 'demo', dataset: demo.build(), snapshot: null };
  }
  const snap = await store.readSnapshot();
  if (snap) {
    return { mode: 'cached', dataset: snap.dataset, snapshot: snap.meta };
  }
  // Nothing cached: report any metadata we do have so the UI can explain why.
  return { mode: 'live', dataset: null, snapshot: await store.readMeta() };
}

function runSpec(source, spec) {
  return source.dataset
    ? engine.runSpec(spec, source.dataset)
    : sql.runSpec(spec);
}

function filterOptions(source, window) {
  return source.dataset
    ? engine.filterOptions(window, source.dataset)
    : sql.filterOptions(window);
}

module.exports = { resolve, runSpec, filterOptions };
