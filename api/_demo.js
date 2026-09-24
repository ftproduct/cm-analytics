// /api/_demo.js
// Deterministic synthetic marketplace dataset.
//
// Why this exists: the app must be demoable and reviewable the moment it is
// deployed, before anyone has wired up a Databricks token or confirmed the real
// column names. Every number here is generated from a fixed seed, so the same
// filter produces the same answer on every request and across every instance.
//
// The shapes returned by _engine.js over these rows are byte-for-byte the same
// shapes the SQL path returns, so the frontend never knows which one it got.

const DAYS = 180;

// mulberry32 -- small, fast, deterministic.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = [
  { city: 'Delhi NCR',  state: 'Delhi',          w: 14 },
  { city: 'Mumbai',     state: 'Maharashtra',    w: 13 },
  { city: 'Chennai',    state: 'Tamil Nadu',     w: 10 },
  { city: 'Bengaluru',  state: 'Karnataka',      w: 10 },
  { city: 'Kolkata',    state: 'West Bengal',    w: 8 },
  { city: 'Hyderabad',  state: 'Telangana',      w: 8 },
  { city: 'Pune',       state: 'Maharashtra',    w: 7 },
  { city: 'Ahmedabad',  state: 'Gujarat',        w: 7 },
  { city: 'Jaipur',     state: 'Rajasthan',      w: 5 },
  { city: 'Nagpur',     state: 'Maharashtra',    w: 4 },
  { city: 'Surat',      state: 'Gujarat',        w: 4 },
  { city: 'Indore',     state: 'Madhya Pradesh', w: 4 },
  { city: 'Ludhiana',   state: 'Punjab',         w: 3 },
  { city: 'Coimbatore', state: 'Tamil Nadu',     w: 3 },
  { city: 'Vizag',      state: 'Andhra Pradesh', w: 3 },
  { city: 'Guwahati',   state: 'Assam',          w: 2 }
];

const REGION_OF = {
  Delhi: 'North', Punjab: 'North', Rajasthan: 'North',
  Maharashtra: 'West', Gujarat: 'West', 'Madhya Pradesh': 'Central',
  'Tamil Nadu': 'South', Karnataka: 'South', Telangana: 'South', 'Andhra Pradesh': 'South',
  'West Bengal': 'East', Assam: 'East'
};

// Liquid-lane style city → zone (subset of config/zone_map.json for demo cities).
const CITY_ZONE = {
  'Delhi NCR': 'North', Mumbai: 'West', Chennai: 'South', Bengaluru: 'South',
  Kolkata: 'East', Hyderabad: 'South', Pune: 'West', Ahmedabad: 'West',
  Jaipur: 'North', Nagpur: 'West', Surat: 'West', Indore: 'Central',
  Ludhiana: 'North', Coimbatore: 'South', Vizag: 'South', Guwahati: 'East'
};

const VEHICLES = [
  { name: '32ft SXL',      w: 22, tons: 9 },
  { name: '32ft MXL',      w: 20, tons: 15 },
  { name: '22ft Truck',    w: 16, tons: 10 },
  { name: '20ft Container', w: 14, tons: 12 },
  { name: 'Trailer 40ft',  w: 12, tons: 25 },
  { name: 'LCV 14ft',      w: 10, tons: 4 },
  { name: 'Tanker',        w: 6,  tons: 20 }
];

const MATERIALS = ['FMCG', 'Steel & Metals', 'Cement', 'Auto Components', 'Textiles', 'Chemicals', 'Agri & Food', 'Electronics', 'Pharma'];

const LSPS = [
  { name: 'Shree Roadlines',      w: 14, reliability: 0.86 },
  { name: 'Bharat Cargo Movers',  w: 12, reliability: 0.81 },
  { name: 'Apex Freight Systems', w: 11, reliability: 0.88 },
  { name: 'Sunrise Transport Co', w: 10, reliability: 0.74 },
  { name: 'National Carriers',    w: 9,  reliability: 0.79 },
  { name: 'Metro Logistics',      w: 8,  reliability: 0.83 },
  { name: 'Deccan Transways',     w: 8,  reliability: 0.70 },
  { name: 'Coastal Movers',       w: 7,  reliability: 0.77 },
  { name: 'Highway Express',      w: 7,  reliability: 0.66 },
  { name: 'Unity Fleet Services', w: 6,  reliability: 0.84 },
  { name: 'Prime Haulers',        w: 5,  reliability: 0.72 },
  { name: 'Orbit Transolutions',  w: 3,  reliability: 0.62 }
];

const PSAS = [
  { name: 'Aarav Sharma',   w: 11, skill: 0.90 },
  { name: 'Neha Kulkarni',  w: 10, skill: 0.86 },
  { name: 'Rohit Menon',    w: 10, skill: 0.82 },
  { name: 'Priya Nair',     w: 9,  skill: 0.88 },
  { name: 'Imran Qureshi',  w: 9,  skill: 0.78 },
  { name: 'Sneha Reddy',    w: 8,  skill: 0.84 },
  { name: 'Vikram Singh',   w: 8,  skill: 0.71 },
  { name: 'Ananya Ghosh',   w: 7,  skill: 0.80 },
  { name: 'Karthik Rao',    w: 7,  skill: 0.68 },
  { name: 'Meera Joshi',    w: 6,  skill: 0.75 },
  { name: 'Unassigned',     w: 5,  skill: 0.35 }
];

const SHIPPERS = [
  'Aditya Cements', 'Vertex Consumer Goods', 'IronBridge Steel', 'NovaAuto India',
  'Sunfield Agro', 'Helios Chemicals', 'Trendline Textiles', 'Medipro Healthcare',
  'Voltaic Electronics', 'Greenline Foods', 'Summit Paints', 'Crescent Tyres'
];

const UNFULFILMENT_REASONS = [
  { name: 'No supply available on lane',     w: 24 },
  { name: 'Rate mismatch with shipper',      w: 19 },
  { name: 'Vehicle not placed by LSP',       w: 14 },
  { name: 'Indent raised too late',          w: 11 },
  { name: 'Shipper cancelled load',          w: 10 },
  { name: 'Required vehicle type unavailable', w: 8 },
  { name: 'Expired without PSA action',      w: 6 },
  { name: 'Credit / payment terms blocked',  w: 4 },
  { name: 'Loading point constraint',        w: 2 },
  { name: 'Compliance / documents pending',  w: 2 }
];

const NON_CONVERSION_REASONS = [
  { name: 'No matching demand on lane',      w: 26 },
  { name: 'Rate expectation too high',       w: 20 },
  { name: 'Vehicle unavailable at load time', w: 14 },
  { name: 'LSP withdrew vehicle',            w: 12 },
  { name: 'Expired without PSA action',      w: 10 },
  { name: 'Shipper rejected vehicle',        w: 7 },
  { name: 'Failed compliance check',         w: 6 },
  { name: 'Duplicate posting',               w: 5 }
];

const FUNNEL_STAGES = ['MATCHED', 'CALLED', 'VEHICLE_AVAILABLE', 'PLACED'];

function pick(list, r) {
  const total = list.reduce((s, x) => s + (x.w ?? 1), 0);
  let t = r() * total;
  for (const x of list) { t -= (x.w ?? 1); if (t <= 0) return x; }
  return list[list.length - 1];
}
function pickFlat(list, r) { return list[Math.floor(r() * list.length)]; }

function isoDay(d) { return d.toISOString().slice(0, 10); }

// Weekday seasonality: Mon-Fri heavy, Sunday thin. Plus a slow upward trend and
// a demand spike in the last three weeks (quarter-end push).
function dayFactor(dayIndex, date) {
  const dow = date.getUTCDay();
  const weekday = [0.45, 1.12, 1.08, 1.05, 1.06, 1.15, 0.85][dow];
  const trend = 0.85 + (dayIndex / DAYS) * 0.4;
  const quarterEnd = dayIndex > DAYS - 21 ? 1.18 : 1;
  return weekday * trend * quarterEnd;
}

let CACHE = null;

function build() {
  if (CACHE) return CACHE;
  const r = rng(20260917);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const demand = [];
  const inventory = [];
  let demandSeq = 0;
  let invSeq = 0;

  for (let d = 0; d < DAYS; d++) {
    const date = new Date(today.getTime() - (DAYS - 1 - d) * 86400000);
    const f = dayFactor(d, date);
    const nDemand = Math.round((34 + r() * 14) * f);
    const nInv = Math.round((30 + r() * 12) * f);

    for (let i = 0; i < nDemand; i++) {
      const o = pick(CITIES, r);
      let dst = pick(CITIES, r);
      let guard = 0;
      while (dst.city === o.city && guard++ < 5) dst = pick(CITIES, r);
      const veh = pick(VEHICLES, r);
      const lsp = pick(LSPS, r);
      const psa = pick(PSAS, r);
      const laneHeat = (o.w + dst.w) / 28;           // dense lanes fill better
      const base = 0.40 + 0.30 * laneHeat + 0.22 * psa.skill + 0.16 * lsp.reliability;
      const seasonal = d > DAYS - 21 ? -0.07 : 0;    // quarter-end strain
      const pFulfil = Math.max(0.12, Math.min(0.96, base + seasonal - 0.18 + (r() - 0.5) * 0.14));
      const fulfilled = r() < pFulfil;

      const createdHour = Math.floor(r() * 24);
      const createdAt = new Date(date.getTime() + createdHour * 3600000);
      const leadHours = 6 + Math.floor(r() * 90);
      const pickupAt = new Date(createdAt.getTime() + leadHours * 3600000);
      // Time to fulfil: good PSAs close faster; long tail on weak lanes.
      const ttfHours = fulfilled
        ? Math.max(0.4, (1.2 + r() * 10) * (1.9 - psa.skill) * (1.6 - laneHeat))
        : null;
      const tons = Math.round(veh.tons * (0.6 + r() * 0.5) * 10) / 10;
      const expected = Math.round((10000 + laneHeat * 52000 + veh.tons * 1400) * (0.9 + r() * 0.25));
      const booked = fulfilled ? Math.round(expected * (0.95 + r() * 0.16)) : null;

      demand.push({
        id: 'DMD-' + String(++demandSeq).padStart(6, '0'),
        createdAt: createdAt.toISOString(),
        createdDate: isoDay(date),
        pickupAt: pickupAt.toISOString(),
        fulfilledAt: fulfilled ? new Date(createdAt.getTime() + ttfHours * 3600000).toISOString() : null,
        ttfHours: ttfHours === null ? null : Math.round(ttfHours * 10) / 10,
        originCity: o.city, originState: o.state,
        destinationCity: dst.city, destinationState: dst.state,
        lane: `${o.city} → ${dst.city}`,
        superClusterLane: `${o.city} → ${dst.city}`,
        region: CITY_ZONE[o.city] || REGION_OF[o.state] || 'Other',
        branch: `${o.city} Hub`,
        shipper: pickFlat(SHIPPERS, r),
        lsp: fulfilled ? lsp.name : (r() < 0.45 ? lsp.name : null),
        psa: psa.name,
        vehicleType: veh.name,
        materialType: pickFlat(MATERIALS, r),
        quantity: 1 + (r() < 0.14 ? 1 : 0),
        weightTons: tons,
        expectedPrice: expected,
        bookedPrice: booked,
        status: fulfilled ? pickFlat(['FULFILLED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'], r)
                          : pickFlat(['EXPIRED', 'CANCELLED', 'UNFULFILLED', 'NO_SUPPLY'], r),
        isFulfilled: fulfilled,
        unfulfilmentReason: fulfilled ? null : pick(UNFULFILMENT_REASONS, r).name,
        laneType: r() < 0.28 ? 'Power lane' : 'Non power lane',
        originSuperCluster: o.city,
        destinationSuperCluster: dst.city
      });
    }

    for (let i = 0; i < nInv; i++) {
      const o = pick(CITIES, r);
      let dst = pick(CITIES, r);
      let guard = 0;
      while (dst.city === o.city && guard++ < 5) dst = pick(CITIES, r);
      const veh = pick(VEHICLES, r);
      const lsp = pick(LSPS, r);
      const psa = pick(PSAS, r);
      const laneHeat = (o.w + dst.w) / 28;
      const postedAt = new Date(date.getTime() + Math.floor(r() * 24) * 3600000);

      // PSA touch comes FIRST, because how fast someone picks the posting up is
      // the main thing the business can actually control. Strong PSAs act
      // within hours; "Unassigned" postings often go untouched entirely, and a
      // long tail of stale inventory sits for days.
      const touched = r() < (0.32 + psa.skill * 0.62);
      let touchHours = null;
      if (touched) {
        const tail = r();
        const base = (0.4 + r() * 8) * (1.9 - psa.skill);
        // ~18% of touched postings are picked up late (1-7 days).
        touchHours = tail < 0.82 ? base : base + 20 + r() * 140;
        touchHours = Math.max(0.2, touchHours);
      }

      // Conversion depends on lane density, carrier and PSA -- and decays hard
      // with how long the posting sat before anyone touched it.
      const responsePenalty = touchHours === null ? 0.34
        : touchHours <= 6 ? 0
        : touchHours <= 24 ? 0.07
        : touchHours <= 72 ? 0.18
        : 0.27;
      const pConv = Math.max(0.05, Math.min(0.94,
        0.30 + 0.34 * laneHeat + 0.20 * psa.skill + 0.12 * lsp.reliability
        - 0.18 - responsePenalty + (r() - 0.5) * 0.12));
      const converted = r() < pConv;

      const convHours = converted ? Math.max(0.5, (touchHours || 6) + 1 + r() * 20) : null;

      // Funnel stage reached -- monotonic, placed rows reach the end.
      // Stages mirror Metabase 1190: MATCHED → CALLED → VEHICLE_AVAILABLE → PLACED.
      let stageIdx;
      if (converted) stageIdx = FUNNEL_STAGES.length - 1;
      else if (!touched) stageIdx = 0;
      else {
        const u = r();
        stageIdx = u < 0.55 ? 1 : 2;
      }

      const matchType = r() < 0.18 ? 'Exact' : 'Origin';
      const isCalled = stageIdx >= 1;
      const isVehicleAvailable = stageIdx >= 2;
      const isPlacementAvailable = converted;
      const callType = !isCalled ? 'Not Called' : (r() < 0.72 ? 'Direct' : 'Indirect');
      const demandId = 'DMD-' + String(1 + Math.floor(r() * Math.max(1, demandSeq))).padStart(6, '0');
      const demandStatus = converted
        ? 'VEHICLE_PLACED_BY_FT'
        : pickFlat(['LAPSED', 'OPEN', 'VEHICLE_AVAILABLE_RATE_MISMATCH', 'CANCELLED'], r);

      inventory.push({
        id: 'INV-' + String(++invSeq).padStart(6, '0'),
        createdAt: postedAt.toISOString(),
        createdDate: isoDay(date),
        availableFrom: new Date(postedAt.getTime() + Math.floor(r() * 18) * 3600000).toISOString(),
        availableTill: new Date(postedAt.getTime() + (24 + Math.floor(r() * 72)) * 3600000).toISOString(),
        convertedAt: converted ? new Date(postedAt.getTime() + convHours * 3600000).toISOString() : null,
        firstActionAt: touched ? new Date(postedAt.getTime() + touchHours * 3600000).toISOString() : null,
        touchHours: touchHours === null ? null : Math.round(touchHours * 10) / 10,
        ttcHours: convHours === null ? null : Math.round(convHours * 10) / 10,
        originCity: o.city, originState: o.state,
        destinationCity: dst.city, destinationState: dst.state,
        lane: `${o.city} → ${dst.city}`,
        superClusterLane: `${o.city} → ${dst.city}`,
        region: CITY_ZONE[o.city] || REGION_OF[o.state] || 'Other',
        branch: `${o.city} Hub`,
        lsp: lsp.name,
        psa: psa.name,
        vehicleType: veh.name,
        capacityTons: veh.tons,
        quantity: 1,
        askingPrice: Math.round((9000 + laneHeat * 50000 + veh.tons * 1300) * (0.92 + r() * 0.3)),
        stage: FUNNEL_STAGES[stageIdx],
        matchedDemandId: demandId,
        demandId,
        demandStatus,
        status: demandStatus,
        isConverted: converted,
        nonConversionReason: converted ? null : pick(NON_CONVERSION_REASONS, r).name,
        matchType,
        isCalled,
        callType,
        isVehicleAvailable,
        isPlacementAvailable,
        inventoryId: String(100000 + invSeq),
        callNotes: isCalled && r() < 0.35 ? 'Demo call note' : null,
        laneType: r() < 0.28 ? 'Power lane' : 'Non power lane',
        originSuperCluster: o.city,
        destinationSuperCluster: dst.city
      });
    }
  }

  CACHE = { demand, inventory, bids: [], generatedAt: new Date().toISOString(), funnelStages: FUNNEL_STAGES };
  return CACHE;
}

module.exports = { build, FUNNEL_STAGES, DAYS };
