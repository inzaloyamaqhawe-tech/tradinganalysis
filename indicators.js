// Classic indicator strategies from the reference trading-strategy book
// (sections 5.2-5.5): RSI, MACD, Bollinger Bands, VWAP. Each detector
// returns null or { side, structureLevel }, same contract as every other
// strategy in signals.js/smc.js/wyckoff.js/candlestick.js.

const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const RSI_TREND_MID = 50; // momentum-regime continuation reference in a trend, per the book

const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

const BOLLINGER_PERIOD = 20;
const BOLLINGER_STDDEV = 2;

// VWAP has no fixed universal lookback like the others — a real session
// VWAP resets at the start of each trading day. Without a clean session
// boundary on a continuously-polled 1h feed, this approximates it with a
// rolling 24-candle (≈1 day at 1h) window, which is the same practical
// trade-off the book itself flags ("VWAP depends on market and data
// source").
const VWAP_WINDOW = 24;

function emaSeriesLocal(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(out[out.length - 1] + k * (values[i] - out[out.length - 1]));
  return out;
}

// Wilder's smoothing, the standard RSI calculation — returns the full
// series (sparse: undefined before there's enough data) so callers can
// compare the latest value against the previous one for a crossover.
function rsiSeries(closes, period = RSI_PERIOD) {
  if (closes.length < period + 2) return [];
  const rsis = new Array(closes.length);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  rsis[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsis[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsis;
}

// 5.2 RSI Momentum/Reversal — meaning differs by regime, per the book:
// in a RANGE, trade extreme-zone reversals; in a TREND, trade the
// momentum-regime continuation (RSI back through the 50 midline in the
// trend's direction after a pullback), never a bare RSI number alone.
function detectRsiSignal(candles, regime, atrNow) {
  if (!candles || !atrNow) return null;
  const closes = candles.map(c => c.close);
  const rsis = rsiSeries(closes);
  if (!rsis.length) return null;
  const last = rsis.length - 1;
  const rsiNow = rsis[last], rsiPrev = rsis[last - 1];
  if (rsiNow == null || rsiPrev == null) return null;
  const lastCandle = candles.at(-1);

  if (regime === 'RANGING') {
    // Oversold and turning back up (not just "is below 30" — the book's
    // structure/price-action confirmation requirement).
    if (rsiPrev < RSI_OVERSOLD && rsiNow >= RSI_OVERSOLD && lastCandle.close > lastCandle.open) {
      return { side: 'BUY', structureLevel: lastCandle.low };
    }
    if (rsiPrev > RSI_OVERBOUGHT && rsiNow <= RSI_OVERBOUGHT && lastCandle.close < lastCandle.open) {
      return { side: 'SELL', structureLevel: lastCandle.high };
    }
    return null;
  }
  if (regime === 'TRENDING_UP' && rsiPrev < RSI_TREND_MID && rsiNow >= RSI_TREND_MID) {
    return { side: 'BUY', structureLevel: Math.min(...candles.slice(-3).map(c => c.low)) };
  }
  if (regime === 'TRENDING_DOWN' && rsiPrev > RSI_TREND_MID && rsiNow <= RSI_TREND_MID) {
    return { side: 'SELL', structureLevel: Math.max(...candles.slice(-3).map(c => c.high)) };
  }
  return null;
}

// 5.3 MACD — a tested crossover plus supportive structure (the trend/
// regime already classified for this cycle), not the crossover alone.
function detectMacdSignal(candles, regime) {
  if (!candles || candles.length < MACD_SLOW + MACD_SIGNAL + 2) return null;
  const closes = candles.map(c => c.close);
  const emaFast = emaSeriesLocal(closes, MACD_FAST);
  const emaSlow = emaSeriesLocal(closes, MACD_SLOW);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = emaSeriesLocal(macdLine, MACD_SIGNAL);
  const last = macdLine.length - 1;
  const diffNow = macdLine[last] - signalLine[last];
  const diffPrev = macdLine[last - 1] - signalLine[last - 1];
  const lastCandle = candles.at(-1);

  const bullishCross = diffPrev <= 0 && diffNow > 0;
  const bearishCross = diffPrev >= 0 && diffNow < 0;
  if (bullishCross && regime === 'TRENDING_UP') return { side: 'BUY', structureLevel: Math.min(...candles.slice(-3).map(c => c.low)) };
  if (bearishCross && regime === 'TRENDING_DOWN') return { side: 'SELL', structureLevel: Math.max(...candles.slice(-3).map(c => c.high)) };
  return null;
}

// 5.4 Bollinger Band Mean Reversion — real stdev bands (distinct from
// signals.js's existing MREV, which fades a simple recent high/low band,
// not a statistical one), gated to range conditions per the book.
function detectBollingerSignal(candles, regime) {
  if (!candles || candles.length < BOLLINGER_PERIOD + 1 || regime !== 'RANGING') return null;
  const window = candles.slice(-BOLLINGER_PERIOD);
  const closes = window.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
  const stdev = Math.sqrt(variance);
  if (!stdev) return null;
  const upper = mean + BOLLINGER_STDDEV * stdev;
  const lower = mean - BOLLINGER_STDDEV * stdev;
  const last = candles.at(-1);

  if (last.low <= lower && last.close > lower && last.close > last.open) {
    return { side: 'BUY', structureLevel: last.low };
  }
  if (last.high >= upper && last.close < upper && last.close < last.open) {
    return { side: 'SELL', structureLevel: last.high };
  }
  return null;
}

// 5.5 VWAP — crypto only (needs real per-candle volume, same constraint
// as SMC/Wyckoff — see signals.js's runEngine for why FX/gold skip it).
// Trend variant: pullback to VWAP with acceptance back in the trend
// direction. Reversion variant: a stretch away from VWAP followed by a
// reversal back toward it.
function detectVwapSignal(candles, regime) {
  if (!candles || candles.length < VWAP_WINDOW + 1) return null;
  const window = candles.slice(-VWAP_WINDOW);
  if (!window.every(c => (c.volume || 0) > 0)) return null; // no real volume data — skip rather than guess
  let pvSum = 0, vSum = 0;
  for (const c of window) {
    const typical = (c.high + c.low + c.close) / 3;
    pvSum += typical * c.volume;
    vSum += c.volume;
  }
  const vwap = pvSum / vSum;
  const last = candles.at(-1);
  const prev = candles.at(-2);

  if (regime === 'TRENDING_UP' && prev.low <= vwap && last.close > vwap && last.close > last.open) {
    return { side: 'BUY', structureLevel: Math.min(vwap, last.low) };
  }
  if (regime === 'TRENDING_DOWN' && prev.high >= vwap && last.close < vwap && last.close < last.open) {
    return { side: 'SELL', structureLevel: Math.max(vwap, last.high) };
  }
  return null;
}

module.exports = { rsiSeries, detectRsiSignal, detectMacdSignal, detectBollingerSignal, detectVwapSignal };
