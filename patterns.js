// Classic chart-pattern detection (SMC "measured move" guide: double top/
// bottom, head & shoulders, triangles, wedges, flags) via swing-point
// analysis. Standalone module — no dependency on signals.js — so it can be
// used three ways without coupling: (1) a confidence booster when a detected
// pattern agrees with the regime-based signal, (2) chart-overlay geometry
// for premium users to visually verify, (3) its own PATTERN strategy when a
// confirmed pattern completes and no other strategy already fired.
//
// Every tolerance is ATR-relative, matching the rest of the engine's
// philosophy (see signals.js) — no fixed-price/fixed-pip thresholds that
// would go stale as an instrument's price level moves.

const SWING_LOOKBACK = 3;          // bars each side to confirm a pivot
const LEVEL_TOLERANCE_ATR = 0.25;  // two peaks/troughs count as "equal" within this many ATRs
const MIN_DEPTH_ATR = 2.0;         // the trough/peak *between* two equal levels must clear this much
const MIN_LEVEL_SEPARATION_BARS = 8; // the two matched peaks/troughs must span a real chunk of the window, not just be adjacent noise
const FLAT_SLOPE_ATR_PER_BAR = 0.15; // a trendline slope below this (per bar, in ATR units) counts as "flat"
const MIN_PATTERN_SPAN_BARS = 12;    // triangles/wedges need to span at least this many bars — a handful of candles isn't a pattern, it's noise
const FLAG_POLE_MIN_ATR = 2.5;     // minimum net move over the pole window to call it a flagpole
const FLAG_CONSOL_MAX_ATR = 1.2;   // consolidation range must stay tighter than this many ATRs

function trueRanges(candles) {
  const trs = [];
  let prevClose = null;
  for (const c of candles) {
    if (prevClose == null) trs.push(c.high - c.low);
    else trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
    prevClose = c.close;
  }
  return trs;
}
function averageAtr(candles, period = 14) {
  const trs = trueRanges(candles);
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Raw pivot detection can flag several adjacent bars around the same peak
// (a rounding plateau, or a slow roll-over) as separate "swing highs" —
// without merging those, code that looks at "the last two swing highs"
// can end up comparing two points from the *same* peak instead of two
// actually-distinct ones. Cluster anything within `lookback` bars of the
// previous pivot into one, keeping the most extreme point in the cluster.
function clusterSwings(points, minGap, better) {
  if (!points.length) return [];
  const out = [points[0]];
  for (const p of points.slice(1)) {
    const last = out[out.length - 1];
    if (p.index - last.index <= minGap) {
      if (better(p, last)) out[out.length - 1] = p;
    } else {
      out.push(p);
    }
  }
  return out;
}

function findSwingPoints(candles, lookback = SWING_LOOKBACK) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const before = candles.slice(i - lookback, i);
    const after = candles.slice(i + 1, i + 1 + lookback);
    if (before.every(w => w.high <= c.high) && after.every(w => w.high <= c.high)) {
      highs.push({ index: i, time: c.time, price: c.high });
    }
    if (before.every(w => w.low >= c.low) && after.every(w => w.low >= c.low)) {
      lows.push({ index: i, time: c.time, price: c.low });
    }
  }
  return {
    highs: clusterSwings(highs, lookback, (a, b) => a.price >= b.price),
    lows: clusterSwings(lows, lookback, (a, b) => a.price <= b.price),
  };
}

function linSlope(points) {
  // points: [{index, price}] — simple least-squares slope of price vs index.
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((s, p) => s + p.index, 0) / n;
  const meanY = points.reduce((s, p) => s + p.price, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.index - meanX) * (p.price - meanY); den += (p.index - meanX) ** 2; }
  return den === 0 ? 0 : num / den;
}
function lineValueAt(points, index) {
  // Value of the least-squares line fit through `points`, at bar `index`.
  const slope = linSlope(points);
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.index, 0) / n;
  const meanY = points.reduce((s, p) => s + p.price, 0) / n;
  return meanY + slope * (index - meanX);
}

// ---------- Double Top / Double Bottom ----------
// A naive "compare the last two swing highs" trivially fires on any chop —
// every oscillation has two similarly-sized adjacent peaks by definition.
// A real double top is two peaks that are each the *most prominent* point
// in their neighborhood — i.e. among the tallest swing highs seen recently,
// not just whatever happens to be chronologically last — and separated
// enough to not just be one lumpy peak.
function detectDoubleTop(candles, swings, atr) {
  const { highs, lows } = swings;
  if (highs.length < 2) return null;
  const byHeight = [...highs].sort((a, b) => b.price - a.price);
  const h1c = byHeight[0];
  const match = byHeight.slice(1).find(h => Math.abs(h.index - h1c.index) >= MIN_LEVEL_SEPARATION_BARS && Math.abs(h.price - h1c.price) <= LEVEL_TOLERANCE_ATR * atr);
  if (!match) return null;
  const [h1, h2] = h1c.index < match.index ? [h1c, match] : [match, h1c];
  const between = lows.filter(l => l.index > h1.index && l.index < h2.index);
  if (!between.length) return null;
  const trough = between.reduce((min, l) => (l.price < min.price ? l : min), between[0]);
  // The trough must be the low point of the whole span, not just of the
  // handful of points *labeled* swing lows between the two peaks (guards
  // against a shallow dip technically counting when a deeper one is right there).
  const spanLow = Math.min(...candles.slice(h1.index, h2.index + 1).map(c => c.low));
  if (trough.price > spanLow + 1e-9) return null;
  const peakAvg = (h1.price + h2.price) / 2;
  if (peakAvg - trough.price < MIN_DEPTH_ATR * atr) return null;
  // A double TOP should sit near the top of the range it's part of — not
  // just be two similarly-tall bumps at some arbitrary mid-range elevation,
  // which any ordinary chop can produce.
  const overallHigh = Math.max(...candles.map(c => c.high));
  if (overallHigh - peakAvg > LEVEL_TOLERANCE_ATR * atr) return null;
  const last = candles.at(-1);
  const target = trough.price - (peakAvg - trough.price);
  return {
    name: 'DOUBLE_TOP', direction: 'SELL', breakoutLevel: trough.price, target,
    confirmed: last.close < trough.price,
    points: [h1, trough, h2],
  };
}
function detectDoubleBottom(candles, swings, atr) {
  const { highs, lows } = swings;
  if (lows.length < 2) return null;
  const byDepth = [...lows].sort((a, b) => a.price - b.price);
  const l1c = byDepth[0];
  const match = byDepth.slice(1).find(l => Math.abs(l.index - l1c.index) >= MIN_LEVEL_SEPARATION_BARS && Math.abs(l.price - l1c.price) <= LEVEL_TOLERANCE_ATR * atr);
  if (!match) return null;
  const [l1, l2] = l1c.index < match.index ? [l1c, match] : [match, l1c];
  const between = highs.filter(h => h.index > l1.index && h.index < l2.index);
  if (!between.length) return null;
  const peak = between.reduce((max, h) => (h.price > max.price ? h : max), between[0]);
  const spanHigh = Math.max(...candles.slice(l1.index, l2.index + 1).map(c => c.high));
  if (peak.price < spanHigh - 1e-9) return null;
  const troughAvg = (l1.price + l2.price) / 2;
  if (peak.price - troughAvg < MIN_DEPTH_ATR * atr) return null;
  const overallLow = Math.min(...candles.map(c => c.low));
  if (troughAvg - overallLow > LEVEL_TOLERANCE_ATR * atr) return null;
  const last = candles.at(-1);
  const target = peak.price + (peak.price - troughAvg);
  return {
    name: 'DOUBLE_BOTTOM', direction: 'BUY', breakoutLevel: peak.price, target,
    confirmed: last.close > peak.price,
    points: [l1, peak, l2],
  };
}

// ---------- Head & Shoulders / Inverse ----------
function detectHeadAndShoulders(candles, swings, atr) {
  const { highs, lows } = swings;
  if (highs.length < 3) return null;
  const [ls, head, rs] = highs.slice(-3); // left shoulder, head, right shoulder
  if (!(head.price > ls.price && head.price > rs.price)) return null;
  if (Math.abs(ls.price - rs.price) > LEVEL_TOLERANCE_ATR * atr) return null;
  if (head.price - Math.max(ls.price, rs.price) < MIN_DEPTH_ATR * atr) return null;
  const troughs = lows.filter(l => l.index > ls.index && l.index < rs.index);
  if (troughs.length < 2) return null;
  const neckline = (troughs[0].price + troughs.at(-1).price) / 2;
  const last = candles.at(-1);
  const target = neckline - (head.price - neckline);
  return {
    name: 'HEAD_AND_SHOULDERS', direction: 'SELL', breakoutLevel: neckline, target,
    confirmed: last.close < neckline,
    points: [ls, troughs[0], head, troughs.at(-1), rs],
  };
}
function detectInverseHeadAndShoulders(candles, swings, atr) {
  const { highs, lows } = swings;
  if (lows.length < 3) return null;
  const [ls, head, rs] = lows.slice(-3);
  if (!(head.price < ls.price && head.price < rs.price)) return null;
  if (Math.abs(ls.price - rs.price) > LEVEL_TOLERANCE_ATR * atr) return null;
  if (Math.min(ls.price, rs.price) - head.price < MIN_DEPTH_ATR * atr) return null;
  const peaks = highs.filter(h => h.index > ls.index && h.index < rs.index);
  if (peaks.length < 2) return null;
  const neckline = (peaks[0].price + peaks.at(-1).price) / 2;
  const last = candles.at(-1);
  const target = neckline + (neckline - head.price);
  return {
    name: 'INVERSE_HEAD_AND_SHOULDERS', direction: 'BUY', breakoutLevel: neckline, target,
    confirmed: last.close > neckline,
    points: [ls, peaks[0], head, peaks.at(-1), rs],
  };
}

// ---------- Triangles (ascending / descending / symmetrical) ----------
function detectTriangle(candles, swings, atr) {
  const highs = swings.highs.slice(-4);
  const lows = swings.lows.slice(-4);
  if (highs.length < 2 || lows.length < 2) return null;
  const span = Math.max(highs.at(-1).index, lows.at(-1).index) - Math.min(highs[0].index, lows[0].index);
  if (span < MIN_PATTERN_SPAN_BARS) return null;

  const upperSlope = linSlope(highs) / atr;   // ATR-units per bar
  const lowerSlope = linSlope(lows) / atr;
  const upperFlat = Math.abs(upperSlope) < FLAT_SLOPE_ATR_PER_BAR;
  const lowerFlat = Math.abs(lowerSlope) < FLAT_SLOPE_ATR_PER_BAR;
  const converging = upperSlope < lowerSlope - FLAT_SLOPE_ATR_PER_BAR; // upper falling relative to lower rising = narrowing

  const startIndex = Math.min(highs[0].index, lows[0].index);
  const endIndex = Math.max(highs.at(-1).index, lows.at(-1).index);
  const heightAtStart = lineValueAt(highs, startIndex) - lineValueAt(lows, startIndex);
  if (heightAtStart < MIN_DEPTH_ATR * atr) return null;

  const last = candles.at(-1);
  const upperNow = lineValueAt(highs, endIndex);
  const lowerNow = lineValueAt(lows, endIndex);

  let name, direction, breakoutLevel, confirmed;
  if (upperFlat && lowerSlope > FLAT_SLOPE_ATR_PER_BAR) {
    name = 'ASCENDING_TRIANGLE'; direction = 'BUY'; breakoutLevel = upperNow; confirmed = last.close > upperNow;
  } else if (lowerFlat && upperSlope < -FLAT_SLOPE_ATR_PER_BAR) {
    name = 'DESCENDING_TRIANGLE'; direction = 'SELL'; breakoutLevel = lowerNow; confirmed = last.close < lowerNow;
  } else if (converging && upperSlope < -FLAT_SLOPE_ATR_PER_BAR && lowerSlope > FLAT_SLOPE_ATR_PER_BAR) {
    // Symmetrical: direction follows whichever side the latest close actually broke.
    if (last.close > upperNow) { name = 'SYMMETRICAL_TRIANGLE'; direction = 'BUY'; breakoutLevel = upperNow; confirmed = true; }
    else if (last.close < lowerNow) { name = 'SYMMETRICAL_TRIANGLE'; direction = 'SELL'; breakoutLevel = lowerNow; confirmed = true; }
    else return null; // still consolidating, no breakout yet — nothing to report
  } else {
    return null;
  }

  const target = direction === 'BUY' ? breakoutLevel + heightAtStart : breakoutLevel - heightAtStart;
  return { name, direction, breakoutLevel, target, confirmed, points: [...highs, ...lows] };
}

// ---------- Wedges (rising = bearish, falling = bullish) ----------
function detectWedge(candles, swings, atr) {
  const highs = swings.highs.slice(-4);
  const lows = swings.lows.slice(-4);
  if (highs.length < 2 || lows.length < 2) return null;
  const span = Math.max(highs.at(-1).index, lows.at(-1).index) - Math.min(highs[0].index, lows[0].index);
  if (span < MIN_PATTERN_SPAN_BARS) return null;

  const upperSlope = linSlope(highs) / atr;
  const lowerSlope = linSlope(lows) / atr;
  const bothRising = upperSlope > FLAT_SLOPE_ATR_PER_BAR && lowerSlope > FLAT_SLOPE_ATR_PER_BAR;
  const bothFalling = upperSlope < -FLAT_SLOPE_ATR_PER_BAR && lowerSlope < -FLAT_SLOPE_ATR_PER_BAR;
  // Narrowing (the gap between the two lines shrinking over time) is always
  // upperSlope < lowerSlope, regardless of whether both lines are rising or
  // both falling — it's the same "upper edge losing ground to the lower
  // edge" relationship either way. Needs a real, non-marginal gap too, not
  // just "technically different by a hair," which any noisy series will
  // satisfy almost by accident.
  const converging = Math.abs(upperSlope - lowerSlope) > FLAT_SLOPE_ATR_PER_BAR && upperSlope < lowerSlope;
  if (!converging || (!bothRising && !bothFalling)) return null;

  const startIndex = Math.min(highs[0].index, lows[0].index);
  const endIndex = Math.max(highs.at(-1).index, lows.at(-1).index);
  const heightAtStart = lineValueAt(highs, startIndex) - lineValueAt(lows, startIndex);
  if (heightAtStart < MIN_DEPTH_ATR * atr) return null;

  const last = candles.at(-1);
  const upperNow = lineValueAt(highs, endIndex);
  const lowerNow = lineValueAt(lows, endIndex);

  if (bothRising) {
    // Rising wedge — bearish reversal, breaks down through the lower trendline.
    if (last.close >= lowerNow) return null;
    return { name: 'RISING_WEDGE', direction: 'SELL', breakoutLevel: lowerNow, target: lowerNow - heightAtStart, confirmed: true, points: [...highs, ...lows] };
  }
  // Falling wedge — bullish reversal, breaks up through the upper trendline.
  if (last.close <= upperNow) return null;
  return { name: 'FALLING_WEDGE', direction: 'BUY', breakoutLevel: upperNow, target: upperNow + heightAtStart, confirmed: true, points: [...highs, ...lows] };
}

// ---------- Flags (sharp pole + tight consolidation) ----------
function detectFlag(candles, atr) {
  if (candles.length < 20) return null;
  const last = candles.at(-1);
  const lastIndex = candles.length - 1;
  // Tightness is measured on the consolidation EXCLUDING the latest bar —
  // that bar is the candidate breakout, whose entire point is a wide range,
  // so including it here would make every real breakout fail its own
  // "was this actually tight" check.
  const consolWindow = candles.slice(-8, -1);
  const poleWindow = candles.slice(-18, -8);
  const poleStartIndex = lastIndex - 17;
  const poleEndIndex = lastIndex - 8;
  const poleMove = poleWindow.at(-1).close - poleWindow[0].open;
  const consolHigh = Math.max(...consolWindow.map(c => c.high));
  const consolLow = Math.min(...consolWindow.map(c => c.low));
  const consolRange = consolHigh - consolLow;
  if (consolRange > FLAG_CONSOL_MAX_ATR * atr) return null;
  const poleStart = { index: poleStartIndex, time: poleWindow[0].time, price: poleWindow[0].open };
  const poleEnd = { index: poleEndIndex, time: poleWindow.at(-1).time, price: poleWindow.at(-1).close };

  if (poleMove > FLAG_POLE_MIN_ATR * atr) {
    // Bull flag: sharp up move, tight sideways/down-drift consolidation, breaks up.
    if (last.close <= consolHigh) return null;
    return { name: 'BULL_FLAG', direction: 'BUY', breakoutLevel: consolHigh, target: consolHigh + poleMove, confirmed: true, points: [poleStart, poleEnd] };
  }
  if (poleMove < -FLAG_POLE_MIN_ATR * atr) {
    if (last.close >= consolLow) return null;
    return { name: 'BEAR_FLAG', direction: 'SELL', breakoutLevel: consolLow, target: consolLow + poleMove, confirmed: true, points: [poleStart, poleEnd] };
  }
  return null;
}

// Runs every detector and returns all matches found (a chart can legitimately
// show more than one at once, e.g. a double bottom nested inside a larger
// triangle) — callers decide how to use that: confluence picks the
// best-agreeing one, the chart overlay draws all of them.
function detectPatterns(candles) {
  if (!candles || candles.length < 30) return [];
  const atr = averageAtr(candles);
  if (!atr) return [];
  const swings = findSwingPoints(candles);

  const results = [
    detectDoubleTop(candles, swings, atr),
    detectDoubleBottom(candles, swings, atr),
    detectHeadAndShoulders(candles, swings, atr),
    detectInverseHeadAndShoulders(candles, swings, atr),
    detectTriangle(candles, swings, atr),
    detectWedge(candles, swings, atr),
    detectFlag(candles, atr),
  ].filter(Boolean);

  return results;
}

module.exports = { detectPatterns, findSwingPoints, averageAtr };
