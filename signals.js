// Multi-strategy signal engine, ported from BOTS/universal.py (the same
// regime-classification + strategy-selection logic used by the live XAU
// trading bot), adapted here for read-only "informational insight" output
// instead of placing real trades. All thresholds stay ATR-relative so they
// don't go stale as an instrument's price level moves — see universal.py's
// module docstring for the full rationale.

const ATR_PERIOD = 14;
const ATR_BASELINE_PERIOD = 40;
const ATR_BREAKOUT_RATIO = 1.6;
const ATR_QUIET_RATIO = 0.65;
const EMA_FAST_PERIOD = 8;
const EMA_SLOW_PERIOD = 21;
const TREND_MIN_EMA_SPREAD_ATR = 0.4;
const TREND_LOOKBACK_BARS = 5;
const MEAN_REVERSION_BAND_BARS = 20;

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(out[out.length - 1] + k * (values[i] - out[out.length - 1]));
  return out;
}

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

function smaLast(values, period) {
  if (values.length < period) return null;
  return values.slice(values.length - period).reduce((a, b) => a + b, 0) / period;
}

function classifyRegime(closed) {
  if (closed.length < Math.max(ATR_BASELINE_PERIOD, EMA_SLOW_PERIOD) + 2) {
    return { regime: 'NO_DATA' };
  }
  const closes = closed.map(c => c.close);
  const trs = trueRanges(closed);
  const atrNow = smaLast(trs, ATR_PERIOD);
  const atrBaseline = smaLast(trs, ATR_BASELINE_PERIOD);
  if (!atrNow || !atrBaseline || atrBaseline <= 0) return { regime: 'NO_DATA' };

  const ratio = atrNow / atrBaseline;
  const emaFastLast = emaSeries(closes, EMA_FAST_PERIOD).at(-1);
  const emaSlowLast = emaSeries(closes, EMA_SLOW_PERIOD).at(-1);
  const spread = emaFastLast - emaSlowLast;

  if (ratio >= ATR_BREAKOUT_RATIO) return { regime: 'VOLATILE_BREAKOUT', atrNow, atrBaseline };
  if (ratio <= ATR_QUIET_RATIO) return { regime: 'QUIET', atrNow, atrBaseline };

  const directionalMove = closes.length > TREND_LOOKBACK_BARS ? closes.at(-1) - closes.at(-1 - TREND_LOOKBACK_BARS) : 0;
  const trending = Math.abs(spread) > TREND_MIN_EMA_SPREAD_ATR * atrNow;

  if (trending && spread > 0 && directionalMove > 0) return { regime: 'TRENDING_UP', atrNow, atrBaseline };
  if (trending && spread < 0 && directionalMove < 0) return { regime: 'TRENDING_DOWN', atrNow, atrBaseline };
  return { regime: 'RANGING', atrNow, atrBaseline };
}

// Candle Range Theory: prior candle sweeps one side of the range and closes
// back inside it (liquidity grab + rejection).
function signalCrt(closed, atrNow) {
  if (closed.length < 2 || !atrNow) return null;
  const c1 = closed.at(-2), c2 = closed.at(-1);
  if (c1.high - c1.low < 0.5 * atrNow) return null;
  const closeInside = c1.low < c2.close && c2.close < c1.high;
  const sweptHigh = c2.high > c1.high;
  const sweptLow = c2.low < c1.low;
  if (!closeInside || (sweptHigh && sweptLow) || (!sweptHigh && !sweptLow)) return null;
  return { side: sweptHigh ? 'SELL' : 'BUY' };
}

// Trend-pullback continuation: latest candle closes decisively back in the
// trend direction, beyond the prior candle's extreme.
function signalTrend(closed, atrNow, regime) {
  if (!['TRENDING_UP', 'TRENDING_DOWN'].includes(regime) || closed.length < 3 || !atrNow) return null;
  const prev = closed.at(-2), last = closed.at(-1);
  const lastRange = Math.max(1e-9, last.high - last.low);
  const bodyPct = Math.abs(last.close - last.open) / lastRange;
  if (bodyPct < 0.5) return null;
  if (regime === 'TRENDING_UP' && last.close > prev.high && last.close > last.open) return { side: 'BUY' };
  if (regime === 'TRENDING_DOWN' && last.close < prev.low && last.close < last.open) return { side: 'SELL' };
  return null;
}

// Volatility breakout: the latest closed candle is itself the expansion
// candle (range far above baseline) with a decisive close.
function signalBreakout(closed, atrNow, atrBaseline) {
  if (closed.length < 2 || !atrNow || !atrBaseline) return null;
  const last = closed.at(-1);
  const lastRange = last.high - last.low;
  if (lastRange < 1.5 * atrBaseline) return null;
  const bodyPct = Math.abs(last.close - last.open) / Math.max(1e-9, lastRange);
  if (bodyPct < 0.6) return null;
  return { side: last.close > last.open ? 'BUY' : 'SELL' };
}

// Range mean-reversion: price wicks beyond the recent range extreme and
// rejects back inside — fade toward the range.
function signalMeanReversion(closed, atrNow, bandBars = MEAN_REVERSION_BAND_BARS) {
  if (closed.length < bandBars + 2 || !atrNow) return null;
  const band = closed.slice(closed.length - (bandBars + 1), closed.length - 1);
  const bandHigh = Math.max(...band.map(c => c.high));
  const bandLow = Math.min(...band.map(c => c.low));
  const last = closed.at(-1);
  const lastRange = Math.max(1e-9, last.high - last.low);

  if (last.high > bandHigh) {
    const upperWickPct = (last.high - Math.max(last.open, last.close)) / lastRange;
    if (last.close < bandHigh && upperWickPct >= 0.5) return { side: 'SELL' };
  }
  if (last.low < bandLow) {
    const lowerWickPct = (Math.min(last.open, last.close) - last.low) / lastRange;
    if (last.close > bandLow && lowerWickPct >= 0.5) return { side: 'BUY' };
  }
  return null;
}

// Regime-driven meta-selection: only the strategy/strategies suited to the
// current regime are evaluated, in priority order.
function selectSignal(closed, regime, atrNow, atrBaseline) {
  if (regime === 'QUIET' || regime === 'NO_DATA') return { strategy: null, signal: null };

  if (regime === 'VOLATILE_BREAKOUT') {
    const sig = signalBreakout(closed, atrNow, atrBaseline);
    return sig ? { strategy: 'BRK', signal: sig } : { strategy: null, signal: null };
  }
  if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
    let sig = signalTrend(closed, atrNow, regime);
    if (sig) return { strategy: 'TREND', signal: sig };
    sig = signalCrt(closed, atrNow);
    return sig ? { strategy: 'CRT', signal: sig } : { strategy: null, signal: null };
  }
  if (regime === 'RANGING') {
    let sig = signalCrt(closed, atrNow);
    if (sig) return { strategy: 'CRT', signal: sig };
    sig = signalMeanReversion(closed, atrNow);
    return sig ? { strategy: 'MREV', signal: sig } : { strategy: null, signal: null };
  }
  return { strategy: null, signal: null };
}

const STRATEGY_LABEL = {
  CRT: 'Candle Range Theory (liquidity sweep + rejection)',
  TREND: 'Trend-pullback continuation',
  BRK: 'Volatility breakout',
  MREV: 'Range mean-reversion',
};

// Runs the full engine on a chronological array of {open,high,low,close}
// candles and returns a display-ready result.
function runEngine(closed) {
  const { regime, atrNow, atrBaseline } = classifyRegime(closed);
  if (regime === 'NO_DATA') {
    return { signal: 'HOLD', regime, strategy: null, note: 'Gathering data — check back soon for a confident signal.' };
  }
  const { strategy, signal } = selectSignal(closed, regime, atrNow, atrBaseline);
  if (!signal) {
    return {
      signal: 'HOLD',
      regime,
      strategy: null,
      note: `Regime: ${regime.replace('_', ' ').toLowerCase()} — no high-conviction setup right now. Informational only, not financial advice.`,
    };
  }
  return {
    signal: signal.side,
    regime,
    strategy,
    note: `${STRATEGY_LABEL[strategy]} in a ${regime.replace('_', ' ').toLowerCase()} regime (ATR ${atrNow.toFixed(4)}). Informational only, not financial advice.`,
  };
}

// Builds synthetic OHLC candles from a chronological array of raw price
// samples (used for instruments where we only have polled last-price data,
// not a real candle feed) by grouping every `bucketSize` samples into one
// candle. Partial trailing groups (not yet "closed") are dropped.
function buildSyntheticCandles(pricesChronological, bucketSize = 6) {
  const candles = [];
  for (let i = 0; i + bucketSize <= pricesChronological.length; i += bucketSize) {
    const chunk = pricesChronological.slice(i, i + bucketSize);
    candles.push({
      open: chunk[0],
      close: chunk.at(-1),
      high: Math.max(...chunk),
      low: Math.min(...chunk),
    });
  }
  return candles;
}

module.exports = { runEngine, buildSyntheticCandles };
