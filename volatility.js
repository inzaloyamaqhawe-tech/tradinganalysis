// Multi-timeframe volatility compression + breakout (ATR/Donchian), matching
// the reference spec exactly: flag a "pre-breakout state" when 14-period ATR
// compresses below 60% of its 50-period average, then trigger only when
// price actually breaks a 20-period Donchian channel edge with volume at
// least 1.5x its own 20-period average — and only in the higher-timeframe
// trend's direction, so a compression breakout never fights the larger
// picture. This is a stricter, more explicit cousin of signals.js's
// existing BRK strategy (which just looks at the latest candle's own range
// vs. baseline ATR) — kept as a separate module/strategy rather than
// replacing BRK, since BRK already works and is tested; this fires under
// narrower, more specific conditions.

const ATR_FAST_PERIOD = 14;
const ATR_SLOW_PERIOD = 50;
const COMPRESSION_RATIO = 0.6;   // ATR14 / ATR50 below this = compressed ("pre-breakout state")
const DONCHIAN_PERIOD = 20;
const VOLUME_MULT = 1.5;         // breakout candle's volume vs. its own 20-period average

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

// True when the market has recently compressed into a tight range relative
// to its own longer-run volatility — the calm-before-the-storm state real
// breakouts tend to emerge from, as opposed to a breakout attempted in an
// already-volatile, "expansion already happened" market.
function isCompressed(candles) {
  const trs = trueRanges(candles);
  const atrFast = smaLast(trs, ATR_FAST_PERIOD);
  const atrSlow = smaLast(trs, ATR_SLOW_PERIOD);
  if (!atrFast || !atrSlow || atrSlow <= 0) return { compressed: false, atrFast, atrSlow };
  return { compressed: atrFast / atrSlow < COMPRESSION_RATIO, atrFast, atrSlow };
}

function donchianChannel(candles, period = DONCHIAN_PERIOD) {
  if (candles.length < period + 1) return null;
  // Excludes the current/last candle — the channel is what price is
  // breaking OUT of, not a channel that already includes the breakout bar.
  const window = candles.slice(-(period + 1), -1);
  return { high: Math.max(...window.map(c => c.high)), low: Math.min(...window.map(c => c.low)) };
}

// `htfBias`: 'BULLISH' | 'BEARISH' | 'NEUTRAL' from the higher timeframe
// (reuses smc.js's classifyStructure so both modules agree on what "trend"
// means) — a breakout only counts if it agrees with this, so a compression
// breakout never fires against the larger-picture direction.
function detectVolatilityBreakout(candles, htfBias) {
  if (!candles || candles.length < ATR_SLOW_PERIOD + 2) return null;
  const { compressed } = isCompressed(candles.slice(0, -1)); // compression measured as of BEFORE the breakout candle
  if (!compressed) return null;

  const channel = donchianChannel(candles);
  if (!channel) return null;

  const last = candles.at(-1);
  const recentVolumes = candles.slice(-(DONCHIAN_PERIOD + 1), -1).map(c => c.volume || 0);
  const avgVolume = recentVolumes.length ? recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length : 0;
  const volumeConfirmed = avgVolume > 0 && (last.volume || 0) >= VOLUME_MULT * avgVolume;
  if (!volumeConfirmed) return null;

  if (last.close > channel.high && htfBias !== 'BEARISH') {
    return { side: 'BUY', channelHigh: channel.high, channelLow: channel.low, volumeRatio: last.volume / avgVolume };
  }
  if (last.close < channel.low && htfBias !== 'BULLISH') {
    return { side: 'SELL', channelHigh: channel.high, channelLow: channel.low, volumeRatio: last.volume / avgVolume };
  }
  return null;
}

module.exports = { isCompressed, donchianChannel, detectVolatilityBreakout };
