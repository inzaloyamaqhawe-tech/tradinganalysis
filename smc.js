// Smart Money Concepts (order blocks, fair value gaps, market structure,
// liquidity sweep + reclaim) with a 4H -> 1H -> 15min top-down workflow:
// 4H decides direction, 1H supplies the key zone (an order block or fair
// value gap in that direction), 15min confirms the entry (price sweeps into
// the zone and reclaims it in the bias direction). Reuses the swing-point
// and ATR helpers already proven out in patterns.js instead of duplicating
// them, so both modules stay in sync on what counts as a "swing".
//
// Every tolerance is ATR-relative, matching the rest of the engine's
// philosophy (see signals.js) — no fixed-price/fixed-pip thresholds.

const { findSwingPoints, averageAtr } = require('./patterns');

const IMPULSE_MIN_ATR = 1.5;      // how strong the move away from a candle must be to call that candle an order block
const FVG_MIN_ATR = 0.1;          // minimum gap size to not just be noise
const MAX_ZONE_DISTANCE_ATR = 3.0; // how far price may sit from a zone and still treat it as "the" key level
const LTF_TOUCH_LOOKBACK = 5;      // how many recent LTF candles count as "recently touched the zone"
// 2 was tested and found to fire a directional bias on pure random-walk
// noise roughly 58% of the time (only 2 points need to happen to line up).
// 3 cuts that false-positive rate to ~11% while still being achievable
// within a normal amount of real chart history — the right trade-off for a
// "should we trust this multi-timeframe bias" gate.
const STRUCTURE_SWING_COUNT = 3;

// Bullish structure = each of the last swing highs and lows is higher than
// the one before it (HH + HL). Bearish = the mirror (LH + LL). Anything
// else (a high got higher while a low got lower, i.e. expanding range, or
// too few swings to tell) is NEUTRAL — no confident directional bias.
function classifyStructure(candles) {
  const { highs, lows } = findSwingPoints(candles);
  if (highs.length < STRUCTURE_SWING_COUNT || lows.length < STRUCTURE_SWING_COUNT) return 'NEUTRAL';
  const recentHighs = highs.slice(-STRUCTURE_SWING_COUNT);
  const recentLows = lows.slice(-STRUCTURE_SWING_COUNT);
  const higherHighs = recentHighs.every((h, i) => i === 0 || h.price > recentHighs[i - 1].price);
  const higherLows = recentLows.every((l, i) => i === 0 || l.price > recentLows[i - 1].price);
  const lowerHighs = recentHighs.every((h, i) => i === 0 || h.price < recentHighs[i - 1].price);
  const lowerLows = recentLows.every((l, i) => i === 0 || l.price < recentLows[i - 1].price);
  if (higherHighs && higherLows) return 'BULLISH';
  if (lowerHighs && lowerLows) return 'BEARISH';
  return 'NEUTRAL';
}

// An order block is the last opposite-direction candle before a sharp
// impulsive move — the last down candle right before a strong rally
// (bullish OB, the institutional buy zone) or the last up candle right
// before a strong decline (bearish OB, the institutional sell zone).
// "Mitigated" means price has already fully traded back through the zone
// since — a zone that's been revisited and left behind is stale, not a
// live key level anymore.
function detectOrderBlocks(candles, atr) {
  if (!atr || candles.length < 6) return [];
  const obs = [];
  for (let i = 1; i < candles.length - 3; i++) {
    const c = candles[i];
    const impulseWindow = candles.slice(i + 1, i + 4);
    if (impulseWindow.length < 3) continue;
    const impulseMove = impulseWindow.at(-1).close - c.close;
    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;
    if (isBearishCandle && impulseMove > IMPULSE_MIN_ATR * atr) {
      obs.push({ type: 'bullish', index: i, time: c.time, high: c.high, low: c.low, mitigated: false });
    } else if (isBullishCandle && impulseMove < -IMPULSE_MIN_ATR * atr) {
      obs.push({ type: 'bearish', index: i, time: c.time, high: c.high, low: c.low, mitigated: false });
    }
  }
  // Mitigated means price has fully invalidated the zone — CLOSED through
  // its far side, not merely wicked into it. A wick that taps the zone and
  // holds is exactly the "retest and reclaim" entry this module looks for;
  // treating any touch as mitigation would invalidate a zone the instant
  // it becomes usable, before a confirmation candle ever gets a chance.
  for (const ob of obs) {
    for (let j = ob.index + 4; j < candles.length; j++) {
      const cj = candles[j];
      if (ob.type === 'bullish' && cj.close < ob.low) { ob.mitigated = true; break; }
      if (ob.type === 'bearish' && cj.close > ob.high) { ob.mitigated = true; break; }
    }
  }
  return obs;
}

// A fair value gap is a 3-candle imbalance: the 1st candle's high/low never
// overlaps the 3rd candle's low/high, leaving a gap price moved through
// without trading — a zone price often returns to "fill" before continuing.
function detectFairValueGaps(candles, atr) {
  if (!atr || candles.length < 3) return [];
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i - 2], c3 = candles[i];
    if (c1.high < c3.low && (c3.low - c1.high) > FVG_MIN_ATR * atr) {
      gaps.push({ type: 'bullish', index: i - 1, time: candles[i - 1].time, top: c3.low, bottom: c1.high, filled: false });
    } else if (c1.low > c3.high && (c1.low - c3.high) > FVG_MIN_ATR * atr) {
      gaps.push({ type: 'bearish', index: i - 1, time: candles[i - 1].time, top: c1.low, bottom: c3.high, filled: false });
    }
  }
  // Same reasoning as detectOrderBlocks: "filled" means price closed all
  // the way through the gap, not just wicked into it — a wick tapping the
  // gap and holding is the entry, not evidence the zone is already spent.
  for (const g of gaps) {
    for (let j = g.index + 2; j < candles.length; j++) {
      const cj = candles[j];
      if (g.type === 'bullish' && cj.close < g.bottom) { g.filled = true; break; }
      if (g.type === 'bearish' && cj.close > g.top) { g.filled = true; break; }
    }
  }
  return gaps;
}

function distanceToZone(price, zone) {
  if (price >= zone.low && price <= zone.high) return 0;
  return Math.min(Math.abs(price - zone.high), Math.abs(price - zone.low));
}

// LTF confirmation: price must have actually traded into the zone recently
// (a "liquidity sweep" into the institutional level), then the latest
// candle must reclaim it — close back through the zone's near edge in the
// bias direction, with a decisive (not indecisive) candle body. This is the
// same sweep-then-reject idea as signals.js's CRT strategy, just applied to
// a structurally-defined zone instead of the prior candle's range.
function confirmEntryOnLtf(ltf, zone, side) {
  if (!ltf.length) return null;
  const last = ltf.at(-1);
  const recentTouch = ltf.slice(-LTF_TOUCH_LOOKBACK).some(c => c.low <= zone.high && c.high >= zone.low);
  if (!recentTouch) return null;
  const lastRange = Math.max(1e-9, last.high - last.low);
  const bodyPct = Math.abs(last.close - last.open) / lastRange;
  if (bodyPct < 0.4) return null; // indecisive candle isn't a confirmation
  if (side === 'BUY' && last.close > zone.high && last.close > last.open) {
    return { entry: last.close, time: last.time };
  }
  if (side === 'SELL' && last.close < zone.low && last.close < last.open) {
    return { entry: last.close, time: last.time };
  }
  return null;
}

// The full top-down workflow. `htf`/`mtf`/`ltf` are chronological OHLC
// candle arrays for three different timeframes (conventionally 4h/1h/15m).
// Returns null whenever any stage doesn't confirm — this is a strict,
// multi-timeframe-aligned setup, not a fallback strategy, so it should fire
// rarely and mean something when it does.
function detectSmcSetup({ htf, mtf, ltf }) {
  if (!htf || htf.length < 20 || !mtf || mtf.length < 20 || !ltf || ltf.length < 6) return null;

  const bias = classifyStructure(htf);
  if (bias === 'NEUTRAL') return null;
  const side = bias === 'BULLISH' ? 'BUY' : 'SELL';

  const atrMtf = averageAtr(mtf);
  if (!atrMtf) return null;

  const wantType = side === 'BUY' ? 'bullish' : 'bearish';
  const obs = detectOrderBlocks(mtf, atrMtf).filter(o => !o.mitigated && o.type === wantType);
  const fvgs = detectFairValueGaps(mtf, atrMtf).filter(g => !g.filled && g.type === wantType);

  const lastPrice = mtf.at(-1).close;
  const candidates = [
    ...obs.map(o => ({ kind: 'orderBlock', high: o.high, low: o.low, time: o.time })),
    ...fvgs.map(g => ({ kind: 'fvg', high: g.top, low: g.bottom, time: g.time })),
  ];
  if (!candidates.length) return null;

  candidates.sort((a, b) => distanceToZone(lastPrice, a) - distanceToZone(lastPrice, b));
  const zone = candidates[0];
  if (distanceToZone(lastPrice, zone) > MAX_ZONE_DISTANCE_ATR * atrMtf) return null;

  const confirmation = confirmEntryOnLtf(ltf, zone, side);
  if (!confirmation) return null;

  // Both an order block AND a fair value gap overlapping the same area is
  // stronger confluence than either alone — surfaced so the caller can
  // reward it with a bit more confidence.
  const confluence = candidates.filter(c => c !== zone && distanceToZone((zone.high + zone.low) / 2, c) === 0).length > 0;

  return {
    side, bias, zoneKind: zone.kind, zoneHigh: zone.high, zoneLow: zone.low,
    entry: confirmation.entry, confluence,
  };
}

module.exports = { classifyStructure, detectOrderBlocks, detectFairValueGaps, detectSmcSetup };
