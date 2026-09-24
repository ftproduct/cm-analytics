// /api/filters.js
// Distinct values for the filter comboboxes, ordered by volume so the options
// people actually use sit at the top of the list.
//
// GET /api/filters?from=YYYY-MM-DD&to=YYYY-MM-DD

const { requireAccess } = require('./_auth.js');
const source = require('./_source.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!requireAccess(req, res)) return;

  const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const window = { from: date(req.query?.from), to: date(req.query?.to) };

  try {
    const src = await source.resolve();
    const options = await source.filterOptions(src, window);
    res.status(200).json({ mode: src.mode, syncedAt: src.snapshot?.syncedAt || null, window, options });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Could not load filter options' });
  }
};
