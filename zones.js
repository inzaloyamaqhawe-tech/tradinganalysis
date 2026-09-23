// Per-asset buy/sell zones, based on structure — always computed, whether
// or not any strategy actually fires this cycle. A strategy (SMC, Wyckoff,
// CRT, etc.) only fires when a strict multi-condition setup confirms; a
// zone is a standing, always-on answer to "where would buyers/sellers
// plausibly step in on this chart right now" — the same demand/supply-zone
// idea from the reference material's "Order Block" and "Support and
// Resistance" concepts, surfaced as context on every market, every cycle.
//
// Reuses smc.js's own order-block/FVG detectors instead of duplicating
// them, so a zone reported here is the exact same zone SMC's own strategy
// would use as its key level — no risk of the two disagreeing. Needs only
// the instrument's own OHLC candles (no volume, no multi-timeframe fetch),
// so — unlike SMC/Wyckoff/the volatility breakout — this runs for every
// tracked market, FX/gold included, not just crypto.

const { detectOrderBlocks, detectFairValueGaps } = require('./smc');
const { averageAtr } = require('./patterns');

const MAX_ZONE_DISTANCE_ATR = 6.0; // beyond this, a zone is too far away to be useful context right now

function distanceToZone(price, zone) {
  if (price >= zone.low && price <= zone.high) return 0;
  return Math.min(Math.abs(price - zone.high), Math.abs(price - zone.low));
}

function nearestZone(zones, price, atr) {
  if (!zones.length) return null;
  const sorted = [...zones].sort((a, b) => distanceToZone(price, a) - distanceToZone(price, b));
  const best = sorted[0];
  const dist = distanceToZone(price, best);
  if (dist > MAX_ZONE_DISTANCE_ATR * atr) return null;
  return { low: best.low, high: best.high, kind: best.kind, distanceAtr: Math.round((dist / atr) * 10) / 10, containsPrice: dist === 0 };
}

// Returns { buyZone, sellZone, currentlyIn } — buyZone/sellZone are each
// either null (nothing nearby) or { low, high, kind, distanceAtr,
// containsPrice }. currentlyIn is 'buy' | 'sell' | null, for whichever zone
// (if either) the latest close is actually sitting inside right now.
function computeZones(candles) {
  if (!candles || candles.length < 20) return null;
  const atr = averageAtr(candles);
  if (!atr) return null;
  const price = candles.at(-1).close;

  const obs = detectOrderBlocks(candles, atr).filter(o => !o.mitigated);
  const fvgs = detectFairValueGaps(candles, atr).filter(g => !g.filled);

  const buyZones = [
    ...obs.filter(o => o.type === 'bullish').map(o => ({ low: o.low, high: o.high, kind: 'order block' })),
    ...fvgs.filter(g => g.type === 'bullish').map(g => ({ low: g.bottom, high: g.top, kind: 'fair value gap' })),
  ];
  const sellZones = [
    ...obs.filter(o => o.type === 'bearish').map(o => ({ low: o.low, high: o.high, kind: 'order block' })),
    ...fvgs.filter(g => g.type === 'bearish').map(g => ({ low: g.bottom, high: g.top, kind: 'fair value gap' })),
  ];

  const buyZone = nearestZone(buyZones, price, atr);
  const sellZone = nearestZone(sellZones, price, atr);
  const currentlyIn = buyZone?.containsPrice ? 'buy' : sellZone?.containsPrice ? 'sell' : null;

  return { buyZone, sellZone, currentlyIn };
}

// Plain-language context for whatever computeZones found — separate from
// explainSignal (that explains why a STRATEGY fired; this explains where
// price sits relative to structure regardless of whether one did).
function explainZones(zones) {
  if (!zones || (!zones.buyZone && !zones.sellZone)) return null;
  const fmt = (z) => `${z.low.toFixed(z.low >= 100 ? 2 : 4)}–${z.high.toFixed(z.high >= 100 ? 2 : 4)}`;
  if (zones.currentlyIn === 'buy') {
    return `Price is currently sitting inside a buy zone (${zones.buyZone.kind}, ${fmt(zones.buyZone)}) — a level where buyers have previously stepped in with force. Doesn't guarantee a bounce, but it's the level to watch.`;
  }
  if (zones.currentlyIn === 'sell') {
    return `Price is currently sitting inside a sell zone (${zones.sellZone.kind}, ${fmt(zones.sellZone)}) — a level where sellers have previously stepped in with force. Doesn't guarantee a rejection, but it's the level to watch.`;
  }
  const parts = [];
  if (zones.buyZone) parts.push(`nearest buy zone ${fmt(zones.buyZone)} (${zones.buyZone.distanceAtr} ATR away)`);
  if (zones.sellZone) parts.push(`nearest sell zone ${fmt(zones.sellZone)} (${zones.sellZone.distanceAtr} ATR away)`);
  return `Not inside a structural zone right now — ${parts.join(', ')}.`;
}

module.exports = { computeZones, explainZones };
