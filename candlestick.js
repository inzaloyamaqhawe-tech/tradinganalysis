// Candlestick + breakout-retest strategies from the reference trading-
// strategy book (sections 3.4, 4.1, 4.3) that weren't already covered by
// the existing CRT/Wyckoff/SMC liquidity-sweep family. Each detector
// returns null or { side, structureLevel } — structureLevel feeds
// computeLevels' structure-aware SL exactly like every other strategy.

const { donchianChannel } = require('./volatility');

const RETEST_LOOKBACK = 8;          // candles scanned for a prior break before the current retest candle
const RETEST_TOUCH_ATR = 0.3;       // how close the retest candle must come back to the broken level
const ENGULF_MIN_BODY_RATIO = 1.05; // the engulfing candle's body must genuinely exceed the prior one, not just match it

// 3.4 Breakout-Retest: instead of trading the breakout candle itself (BRK/
// VOLBRK already do that), wait for the broken level to be retested from
// the other side and hold, per the book's "do not chase the first break."
function detectBreakoutRetest(candles, atrNow) {
  if (!candles || candles.length < RETEST_LOOKBACK + 22 || !atrNow) return null;
  const channel = donchianChannel(candles.slice(0, -(RETEST_LOOKBACK - 1)));
  if (!channel) return null;
  const recent = candles.slice(-RETEST_LOOKBACK, -1);
  const last = candles.at(-1);

  const brokeUp = recent.some(c => c.close > channel.high);
  const brokeDown = recent.some(c => c.close < channel.low);
  if (brokeUp === brokeDown) return null; // neither, or both (choppy) — no clean retest to trade

  if (brokeUp) {
    const touchedLevel = last.low <= channel.high + RETEST_TOUCH_ATR * atrNow;
    const heldAndClosedAbove = last.close > channel.high && last.close > last.open;
    if (touchedLevel && heldAndClosedAbove) return { side: 'BUY', structureLevel: Math.min(last.low, channel.high) };
  } else {
    const touchedLevel = last.high >= channel.low - RETEST_TOUCH_ATR * atrNow;
    const heldAndClosedBelow = last.close < channel.low && last.close < last.open;
    if (touchedLevel && heldAndClosedBelow) return { side: 'SELL', structureLevel: Math.max(last.high, channel.low) };
  }
  return null;
}

// 4.1 Engulfing Candle: a strong body that overtakes the prior candle,
// but per the book, only at a meaningful location — gated on the
// zone-context zones.js already computes every cycle (a real buy/sell
// zone, not just "any engulfing candle anywhere").
function detectEngulfing(candles, zones) {
  if (!candles || candles.length < 3 || !zones) return null;
  const prev = candles.at(-2), last = candles.at(-1);
  const prevBody = Math.abs(prev.close - prev.open);
  const lastBody = Math.abs(last.close - last.open);
  if (lastBody < prevBody * ENGULF_MIN_BODY_RATIO) return null;

  const bullish = last.close > last.open && prev.close < prev.open && last.close >= prev.open && last.open <= prev.close;
  const bearish = last.close < last.open && prev.close > prev.open && last.close <= prev.open && last.open >= prev.close;

  if (bullish && zones.currentlyIn === 'buy') return { side: 'BUY', structureLevel: Math.min(last.low, prev.low) };
  if (bearish && zones.currentlyIn === 'sell') return { side: 'SELL', structureLevel: Math.max(last.high, prev.high) };
  return null;
}

// 4.3 Inside-Bar Breakout: a contained candle (inside the prior "mother"
// candle's range) as a compression signal, traded on a confirmed
// expansion beyond the mother candle's own extreme.
function detectInsideBarBreakout(candles) {
  if (!candles || candles.length < 4) return null;
  const mother = candles.at(-3), inside = candles.at(-2), last = candles.at(-1);
  const isInsideBar = inside.high <= mother.high && inside.low >= mother.low;
  if (!isInsideBar) return null;

  if (last.close > mother.high && last.close > last.open) return { side: 'BUY', structureLevel: mother.low };
  if (last.close < mother.low && last.close < last.open) return { side: 'SELL', structureLevel: mother.high };
  return null;
}

module.exports = { detectBreakoutRetest, detectEngulfing, detectInsideBarBreakout };
