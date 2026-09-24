// Display labels for warehouse status / cancellation codes.
// Unknown SCREAMING_SNAKE values fall back to title case; prose strings pass through.

const REASON_LABELS = {
  LAPSED: 'Lapsed — expired without placement',
  VEHICLE_NOT_AVAILABLE: 'No vehicle available',
  LSP_RATE_ENQUIRY: 'Stuck in LSP rate enquiry',
  TRIP_CANCELLED_AFTER_PLACEMENT: 'Cancelled after placement',
  SYSTEM_ISSUE: 'System issue',
  VEHICLE_AVAILABLE_RATE_MISMATCH: 'Rate mismatch',
  OPEN: 'Still open',
  FO_BROKER_NOT_AVAILABLE: 'FO / broker not available',
  CANCELLED: 'Cancelled',
  CANCELLED_BY_FO: 'Cancelled by FO',
  CANCELLED_BY_LSP: 'Cancelled by LSP',
  CANCELLED_BY_LSP_AFTER_VEHICLE_REPORTED: 'Cancelled by LSP after report',
  VEHICLE_AVAILABLE_LSP_NOT_RESPONDING: 'LSP not responding',
  RATES_MATCHED_VEHICLE_UNAVAILABLE: 'Rates matched, no vehicle',
  VEHICLE_AVAILABLE_LSP_TO_CONFIRM: 'LSP yet to confirm',
  MATERIAL_NOT_READY: 'Material not ready',
  DRIVER_DENIED_FOR_LOADING: 'Driver denied for loading',
  VEHICLE_CONDITION: 'Vehicle condition',
  VEHICLE_PLACED: 'Vehicle already placed elsewhere',
  VEHICLE_NOT_UNLOADED_FROM_PREV_TRIP: 'Still unloading previous trip',
  VEHICLE_BREAK_DOWN: 'Vehicle breakdown',
  DRIVER_AND_SUPPLIER_NOT_RESPONDING: 'Driver / supplier not responding',
  LABOUR_ISSUE: 'Labour issue',
  'Not captured': 'Not captured'
};

const SNAKE = /^[A-Z0-9]+(_[A-Z0-9]+)+$/;
const ALL_CAPS = /^[A-Z0-9]{3,}$/;

function titleCaseSnake(s) {
  return s.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function humanizeReason(raw) {
  if (raw == null) return 'Not captured';
  const s = String(raw).trim();
  if (!s) return 'Not captured';
  if (REASON_LABELS[s]) return REASON_LABELS[s];
  const upper = s.toUpperCase();
  if (REASON_LABELS[upper]) return REASON_LABELS[upper];
  if (SNAKE.test(upper)) return titleCaseSnake(upper);
  if (ALL_CAPS.test(s) && s === upper) return titleCaseSnake(s);
  return s;
}

module.exports = { humanizeReason, REASON_LABELS };
