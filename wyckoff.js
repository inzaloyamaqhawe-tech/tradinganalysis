// Wyckoff Method: detects an accumulation (bullish) or distribution
// (bearish) range, then a Spring (accumulation) or Upthrust-After-
// Distribution/UTAD (distribution) — a brief liquidity sweep beyond the
// range that closes back inside within a couple of candles — followed by a
// Change of Character (CHoCH) candle that confirms the range is resolving
// in that direction. SMC's order-block/FVG concepts are built on top of
// this same "institutions sweep liquidity before the real move" idea; this
// module looks at it through Wyckoff's range+volume lens instead.
//
// Needs real per-candle volume — crypto only (see server.js's computeSignal
// for why FX/gold, which don't have reliable trade volume from the
// providers this app uses, are excluded from this and from SMC).

const RANGE_LOOKBACK = 20;        // bars scanned for the accumulation/distribution range
const MIN_RANGE_BARS = 10;        // a range needs to have actually persisted, not just be 2-3 candles of noise
const SWEEP_MAX_BARS = 2;         // a spring/UTAD must close back inside the range within this many candles
const CHOCH_MIN_BODY_PCT = 0.5;   // the confirmation candle must be a decisive, not indecisive, body
const VOLUME_SPIKE_MULT = 1.3;    // the sweep candle's volume vs. the range's average, to count as a real liquidity grab and not just drift

// Finds the tightest recent range: the highest high and lowest low over the
// lookback window, excluding the most recent few candles (those are where
// the sweep/breakout itself would happen, so including them would make the
// range include its own breakout).
function findRange(candles, lookback = RANGE_LOOKBACK) {
  if (candles.length < lookback + SWEEP_MAX_BARS + 2) return null;
  const rangeCandles = candles.slice(-(lookback + SWEEP_MAX_BARS + 2), -(SWEEP_MAX_BARS + 2));
  if (rangeCandles.length < MIN_RANGE_BARS) return null;
  const high = Math.max(...rangeCandles.map(c => c.high));
  const low = Math.min(...rangeCandles.map(c => c.low));
  const avgVolume = rangeCandles.reduce((s, c) => s + (c.volume || 0), 0) / rangeCandles.length;
  return { high, low, avgVolume, barCount: rangeCandles.length };
}

// Looks for a Spring (accumulation: sweep below range low, reclaim) or a
// UTAD (distribution: sweep above range high, reclaim) in the last few
// candles, on above-average volume (the "institutional absorption" signal
// — real conviction pushing beyond the range on a liquidity grab, not just
// drift), followed by a CHoCH candle confirming the direction.
function detectSpringOrUtad(candles, range) {
  if (!range) return null;
  const n = candles.length;
  for (let sweepBarsAgo = SWEEP_MAX_BARS; sweepBarsAgo >= 1; sweepBarsAgo--) {
    const sweepIndex = n - 1 - sweepBarsAgo;
    if (sweepIndex < 0) continue;
    const sweepCandle = candles[sweepIndex];
    const hasVolume = (sweepCandle.volume || 0) > 0 && range.avgVolume > 0;
    const volumeSpike = hasVolume && sweepCandle.volume > VOLUME_SPIKE_MULT * range.avgVolume;
    if (!volumeSpike) continue;

    // Spring: wicks below range low, but the candle (or one shortly after)
    // closes back above it.
    if (sweepCandle.low < range.low) {
      const closedBackInside = candles.slice(sweepIndex, n).some(c => c.close > range.low);
      if (!closedBackInside) continue;
      const confirmCandle = candles[n - 1];
      const lastRange = Math.max(1e-9, confirmCandle.high - confirmCandle.low);
      const bodyPct = Math.abs(confirmCandle.close - confirmCandle.open) / lastRange;
      if (confirmCandle.close > sweepCandle.high && bodyPct >= CHOCH_MIN_BODY_PCT && confirmCandle.close > confirmCandle.open) {
        return { type: 'SPRING', side: 'BUY', sweepLow: sweepCandle.low, rangeLow: range.low, rangeHigh: range.high, confirmTime: confirmCandle.time };
      }
    }
    // UTAD: wicks above range high, but closes back below it.
    if (sweepCandle.high > range.high) {
      const closedBackInside = candles.slice(sweepIndex, n).some(c => c.close < range.high);
      if (!closedBackInside) continue;
      const confirmCandle = candles[n - 1];
      const lastRange = Math.max(1e-9, confirmCandle.high - confirmCandle.low);
      const bodyPct = Math.abs(confirmCandle.close - confirmCandle.open) / lastRange;
      if (confirmCandle.close < sweepCandle.low && bodyPct >= CHOCH_MIN_BODY_PCT && confirmCandle.close < confirmCandle.open) {
        return { type: 'UTAD', side: 'SELL', sweepHigh: sweepCandle.high, rangeLow: range.low, rangeHigh: range.high, confirmTime: confirmCandle.time };
      }
    }
  }
  return null;
}

// Full pipeline: find the recent range, then look for a confirmed
// spring/UTAD off it. Returns null wherever either stage doesn't confirm —
// like SMC, this is a strict setup meant to fire rarely and mean something
// when it does, not a fallback strategy.
function detectWyckoffSetup(candles) {
  if (!candles || candles.length < RANGE_LOOKBACK + SWEEP_MAX_BARS + 5) return null;
  const range = findRange(candles);
  if (!range) return null;
  return detectSpringOrUtad(candles, range);
}

module.exports = { findRange, detectSpringOrUtad, detectWyckoffSetup };
