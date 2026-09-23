// Multi-strategy signal engine, ported from BOTS/universal.py (the same
// regime-classification + strategy-selection logic used by the live XAU
// trading bot), adapted here for read-only "informational insight" output
// instead of placing real trades. All thresholds stay ATR-relative so they
// don't go stale as an instrument's price level moves — see universal.py's
// module docstring for the full rationale.

const { detectPatterns } = require('./patterns');
const { detectSmcSetup, classifyStructure } = require('./smc');
const { detectWyckoffSetup } = require('./wyckoff');
const { detectVolatilityBreakout } = require('./volatility');
const { computeZones, explainZones } = require('./zones');

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
// current regime are evaluated, in priority order. PATTERN is a peer
// strategy alongside CRT/TREND/BRK/MREV, but only steps in as a fallback
// when none of those already fired — a confirmed classic chart pattern
// (double top/bottom, head & shoulders, triangle, wedge, flag) fills the
// gap rather than competing with or overriding an established trigger.
function selectSignal(closed, regime, atrNow, atrBaseline, patterns) {
  if (regime === 'QUIET' || regime === 'NO_DATA') return { strategy: null, signal: null };

  if (regime === 'VOLATILE_BREAKOUT') {
    const sig = signalBreakout(closed, atrNow, atrBaseline);
    if (sig) return { strategy: 'BRK', signal: sig };
  } else if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') {
    let sig = signalTrend(closed, atrNow, regime);
    if (sig) return { strategy: 'TREND', signal: sig };
    sig = signalCrt(closed, atrNow);
    if (sig) return { strategy: 'CRT', signal: sig };
  } else if (regime === 'RANGING') {
    let sig = signalCrt(closed, atrNow);
    if (sig) return { strategy: 'CRT', signal: sig };
    sig = signalMeanReversion(closed, atrNow);
    if (sig) return { strategy: 'MREV', signal: sig };
  }

  const confirmedPattern = (patterns || []).find(p => p.confirmed);
  if (confirmedPattern) {
    return { strategy: 'PATTERN', signal: { side: confirmedPattern.direction }, patternMeta: confirmedPattern };
  }
  return { strategy: null, signal: null };
}

const STRATEGY_LABEL = {
  CRT: 'Candle Range Theory (liquidity sweep + rejection)',
  TREND: 'Trend-pullback continuation',
  BRK: 'Volatility breakout',
  MREV: 'Range mean-reversion',
  PATTERN: 'Classic chart pattern',
  SMC: 'Smart Money Concepts (multi-timeframe order block/FVG)',
  WYCKOFF: 'Wyckoff Spring/Upthrust (institutional liquidity sweep)',
  VOLBRK: 'Volatility compression breakout (ATR/Donchian)',
};

// Plain-language, non-jargon explanations of *why* a signal appeared — the
// causal story behind the strategy trigger, for users who don't know what
// "ATR-relative rejection" means. Kept separate from STRATEGY_LABEL (the
// technical name) so the UI can show both: the name for credibility, the
// explanation for understanding.
function explainSignal(strategy, side, regime, patternMeta, smcMeta, wyckoffMeta, volMeta) {
  const dir = side === 'BUY' ? 'up' : 'down';
  const rangeSide = side === 'BUY' ? 'range low' : 'range high';
  switch (strategy) {
    case 'CRT':
      return `Price pushed beyond the recent ${rangeSide}, then closed back inside the range — a common sign that the move outside was a liquidity grab, not real follow-through, and price is likely to continue ${dir} from here.`;
    case 'TREND':
      return `The market has been trending, and price just pulled back and then closed strongly back in the trend's direction — a sign the trend is resuming rather than reversing.`;
    case 'BRK':
      return `Price just broke out of a quiet range with a much bigger candle than usual, closing strongly in one direction — a sign of a fresh volatility expansion that can continue ${dir}.`;
    case 'MREV':
      return `Price wicked beyond the recent trading range and then rejected back inside it, suggesting the extreme was overextended and a move back toward the middle of the range is likely.`;
    case 'PATTERN':
      return `A ${PATTERN_LABEL[patternMeta?.name] || 'chart pattern'} has formed and broken out, which historically tends to continue toward its measured-move target.`;
    case 'SMC': {
      const zoneWord = smcMeta?.zoneKind === 'fvg' ? 'fair value gap' : 'order block';
      const confluenceNote = smcMeta?.confluence ? ' Both an order block and a fair value gap line up in the same zone, which is stronger confluence than either alone.' : '';
      return `The higher timeframe is structurally ${dir === 'up' ? 'bullish' : 'bearish'} (higher highs and higher lows${dir === 'down' ? ' — reversed, lower highs and lower lows' : ''}). Price pulled back into a ${zoneWord} left behind by an earlier institutional-style move, then reclaimed it with a decisive candle — a classic higher-timeframe-direction, lower-timeframe-entry setup.${confluenceNote}`;
    }
    case 'WYCKOFF': {
      const sweepWord = wyckoffMeta?.type === 'SPRING' ? 'below the range low' : 'above the range high';
      const phaseWord = wyckoffMeta?.type === 'SPRING' ? 'accumulation' : 'distribution';
      return `Price had been ranging (an ${phaseWord} phase), then briefly spiked ${sweepWord} on a burst of volume — a classic stop-hunt that grabs retail liquidity right before institutions push the real move — and immediately closed back inside the range. The next candle then broke decisively back through the sweep candle's own extreme, confirming the range is resolving ${dir}.`;
    }
    case 'VOLBRK': {
      const ratio = volMeta?.volumeRatio != null ? volMeta.volumeRatio.toFixed(1) : 'well above';
      return `Volatility had compressed into a tight range (recent ATR well below its longer-run average) — the calm that often precedes a real expansion. Price just broke out of that range on ${ratio}x normal volume, in the same direction as the higher-timeframe trend, which is the combination this setup specifically waits for rather than trading every quiet-range breakout.`;
    }
    default:
      return 'No clear setup right now.';
  }
}

// What would confirm this setup is working vs. invalidate it — used by both
// the plain-language explanation and (later) the AI Elite explanation layer.
function invalidationNote(strategy, side, levels) {
  const slSide = side === 'BUY' ? 'below' : 'above';
  return `This idea weakens if price closes back ${slSide} ${levels?.sl ?? 'the stop level'} — that's the invalidation point.`;
}

const PATTERN_LABEL = {
  DOUBLE_TOP: 'Double Top', DOUBLE_BOTTOM: 'Double Bottom',
  HEAD_AND_SHOULDERS: 'Head & Shoulders', INVERSE_HEAD_AND_SHOULDERS: 'Inverse Head & Shoulders',
  ASCENDING_TRIANGLE: 'Ascending Triangle', DESCENDING_TRIANGLE: 'Descending Triangle', SYMMETRICAL_TRIANGLE: 'Symmetrical Triangle',
  RISING_WEDGE: 'Rising Wedge', FALLING_WEDGE: 'Falling Wedge',
  BULL_FLAG: 'Bullish Flag', BEAR_FLAG: 'Bearish Flag',
};

// SL distance in units of ATR, per strategy — same relative tightness as
// universal.py's STRATEGY_RISK (CRT/MREV tightest, BRK widest, since a
// breakout setup needs more room to breathe). Unlike universal.py, TP is not
// a separate per-strategy multiplier: every setup is standardized to a 1:2
// risk:reward, laddered as TP1..TP4 so TP4 lands exactly at the 1:2 target
// (this is the level universal.py would call its single "TP"). Everything
// stays ATR-relative, so it self-scales per asset instead of using a fixed
// dollar/pip distance — a $0.07 DOGE move and a $4000 XAU move both get a
// stop sized to *that instrument's own* recent volatility.
const STRATEGY_SL_ATR = { CRT: 1.0, TREND: 1.2, BRK: 1.5, MREV: 1.0, PATTERN: 1.3, SMC: 1.3, WYCKOFF: 1.2, VOLBRK: 1.5 };
const RISK_REWARD_TO_TP4 = 2; // 1 : 2

function decimalsFor(price) {
  if (price >= 100) return 2;
  if (price >= 1) return 4;
  return 6;
}

function round(price) {
  const d = decimalsFor(Math.abs(price));
  return Number(price.toFixed(d));
}

// Ladders SL and TP1-TP4 off the last close, sized to this strategy's ATR
// multiple. TP4 is normally the 1:2 target, with TP1-TP3 evenly spaced
// checkpoints toward it (0.5R / 1.0R / 1.5R / 2.0R) so a premium user can
// bank partial profit on the way instead of an all-or-nothing single target.
//
// When `explicitTarget` is given (a PATTERN-strategy signal), TP4 is instead
// the pattern's own measured-move target from the reference guide — SL stays
// ATR-based as always, but TP1-3 become fractions of the entry-to-target
// distance (25/50/75%) since that distance no longer relates cleanly to R.
// The reported risk:reward is whatever ratio that target actually works out
// to, not a forced 1:2.
function computeLevels(entry, side, atrNow, strategy, explicitTarget) {
  const slMult = STRATEGY_SL_ATR[strategy] ?? 1.0;
  const slDist = slMult * atrNow;
  const dir = side === 'BUY' ? 1 : -1;
  const sl = round(entry - dir * slDist);

  if (explicitTarget != null) {
    const targetDist = Math.abs(explicitTarget - entry);
    const [tp1, tp2, tp3, tp4] = [0.25, 0.5, 0.75, 1.0].map(f => round(entry + dir * f * targetDist));
    const ratio = slDist > 0 ? targetDist / slDist : null;
    return { entry: round(entry), sl, tp1, tp2, tp3, tp4, riskReward: ratio != null ? `1:${ratio.toFixed(1)}` : 'n/a' };
  }
  const rMultiples = [0.5, 1.0, 1.5, RISK_REWARD_TO_TP4];
  const [tp1, tp2, tp3, tp4] = rMultiples.map(r => round(entry + dir * r * slDist));
  return { entry: round(entry), sl, tp1, tp2, tp3, tp4, riskReward: `1:${RISK_REWARD_TO_TP4}` };
}

// A rough 0-100 "setup strength" — how cleanly the regime conditions were
// met, not a probability of profit. Trend strength scales with how far the
// EMA spread exceeds the minimum required multiple of ATR; breakout scales
// with how far the range exceeds the minimum expansion; CRT/mean-reversion
// (wick-rejection setups) get a flat moderate score since their trigger is
// binary (the rejection either happened or didn't) rather than a spectrum.
function computeConfidence(strategy, regime, closed, atrNow, atrBaseline) {
  if (strategy === 'TREND') {
    const closes = closed.map(c => c.close);
    const spread = Math.abs(emaSeries(closes, EMA_FAST_PERIOD).at(-1) - emaSeries(closes, EMA_SLOW_PERIOD).at(-1));
    const ratio = spread / (TREND_MIN_EMA_SPREAD_ATR * atrNow); // 1.0 = just barely qualified
    return Math.max(50, Math.min(95, Math.round(50 + (ratio - 1) * 25)));
  }
  if (strategy === 'BRK') {
    const lastRange = closed.at(-1).high - closed.at(-1).low;
    const ratio = lastRange / (1.5 * atrBaseline);
    return Math.max(50, Math.min(95, Math.round(50 + (ratio - 1) * 20)));
  }
  return 65; // CRT / MREV: binary rejection trigger, flat moderate confidence
}

// Runs the full engine on a chronological array of {open,high,low,close}
// candles and returns a display-ready result. Framed as market-structure
// insight, not a buy/sell instruction — the user makes their own call.
//
// `smcCtx`, when given, is { htf, mtf, ltf } — chronological candle arrays
// for a higher, matching, and lower timeframe (conventionally 4h/1h/15m).
// It's optional and best-effort: without it (or wherever it doesn't
// confirm), the engine falls straight back to the regime-based strategies
// below, unchanged.
function runEngine(closed, smcCtx) {
  const { regime, atrNow, atrBaseline } = classifyRegime(closed);
  if (regime === 'NO_DATA') {
    // Zones need far less history than the full regime engine (~14-20
    // candles vs. 42+), so a market that hasn't built up enough history for
    // a regime read yet can still often show zone context.
    const zones = computeZones(closed);
    return { signal: 'HOLD', regime, strategy: null, confidence: null, note: 'Gathering data — check back soon for a clearer read.', patterns: [], zones, zoneNote: explainZones(zones) };
  }

  const patterns = detectPatterns(closed);

  // Structural buy/sell zones — computed every cycle regardless of whether
  // any strategy actually fires, unlike everything below. This is standing
  // context ("where would buyers/sellers plausibly step in on this chart
  // right now"), not a trade call.
  const zones = computeZones(closed);
  const zoneNote = explainZones(zones);

  // Priority cascade: Wyckoff (institutional accumulation/distribution
  // liquidity sweep) -> SMC (multi-timeframe order block/FVG) -> ATR/
  // Donchian compression breakout -> the original regime-based strategies.
  // Each of the first three is a strict, deliberately rare-firing setup —
  // when one fires it's inherently higher conviction than a single-
  // timeframe regime read, so it takes priority. The regime-based cascade
  // below is the everyday fallback, unchanged from before these existed.
  const htfBias = smcCtx?.htf?.length ? classifyStructure(smcCtx.htf) : 'NEUTRAL';
  const wyckoffResult = detectWyckoffSetup(closed);
  const smcResult = !wyckoffResult && smcCtx ? detectSmcSetup(smcCtx) : null;
  const volResult = !wyckoffResult && !smcResult ? detectVolatilityBreakout(closed, htfBias) : null;
  let strategy, signal, patternMeta;
  if (wyckoffResult) {
    strategy = 'WYCKOFF';
    signal = { side: wyckoffResult.side };
  } else if (smcResult) {
    strategy = 'SMC';
    signal = { side: smcResult.side };
  } else if (volResult) {
    strategy = 'VOLBRK';
    signal = { side: volResult.side };
  } else {
    ({ strategy, signal, patternMeta } = selectSignal(closed, regime, atrNow, atrBaseline, patterns));
  }

  if (!signal) {
    // No strategy fired at all — still worth mentioning a pattern that's
    // visibly forming but hasn't confirmed a breakout yet (context, not a call).
    const forming = patterns.find(p => !p.confirmed);
    const formingNote = forming ? ` A ${PATTERN_LABEL[forming.name]} appears to be forming — not yet confirmed.` : '';
    return {
      signal: 'HOLD',
      regime,
      strategy: null,
      confidence: null,
      note: `Structure: ${regime.replace('_', ' ').toLowerCase()} — no clear directional setup right now.${formingNote} Informational only; conduct your own analysis before trading.`,
      patterns,
      zones,
      zoneNote,
    };
  }

  const explicitTarget = strategy === 'PATTERN' ? patternMeta.target : null;
  const levels = computeLevels(closed.at(-1).close, signal.side, atrNow, strategy, explicitTarget);
  let confidence = strategy === 'PATTERN' ? 70
    : strategy === 'SMC' ? (smcResult.confluence ? 82 : 75)
    : strategy === 'WYCKOFF' ? 80
    : strategy === 'VOLBRK' ? Math.max(60, Math.min(92, Math.round(55 + volResult.volumeRatio * 8)))
    : computeConfidence(strategy, regime, closed, atrNow, atrBaseline);

  // Confluence: an independently-detected pattern agreeing with the fired
  // strategy's direction is corroborating evidence — bump confidence rather
  // than create a second signal. A confirmed (broken-out) pattern counts for
  // more than one still just forming.
  let confluenceNote = '';
  const agreeing = patterns.find(p => p.direction === signal.side && p !== patternMeta);
  if (agreeing) {
    confidence = Math.min(95, confidence + (agreeing.confirmed ? 15 : 8));
    confluenceNote = ` Reinforced by a visible ${PATTERN_LABEL[agreeing.name]}${agreeing.confirmed ? '' : ' (still forming)'}.`;
  }

  const biasWord = signal.side === 'BUY' ? 'bullish' : 'bearish';
  const subject = strategy === 'PATTERN'
    ? `${PATTERN_LABEL[patternMeta.name]} (measured-move target ${round(patternMeta.target)})`
    : STRATEGY_LABEL[strategy];
  const explanation = explainSignal(strategy, signal.side, regime, patternMeta, smcResult, wyckoffResult, volResult);
  const invalidation = invalidationNote(strategy, signal.side, levels);
  return {
    signal: signal.side,
    regime,
    strategy,
    confidence,
    levels,
    explanation,
    invalidation,
    note: `${subject} suggests a ${biasWord} scenario in a ${regime.replace('_', ' ').toLowerCase()} structure (setup strength ${confidence}/100).${confluenceNote} Informational only — conduct your own analysis and risk assessment before making any trading decision.`,
    patterns,
    zones,
    zoneNote,
  };
}

// Builds synthetic OHLC candles from a chronological array of raw price
// samples (used for instruments where we only have polled last-price data,
// not a real candle feed) by grouping every `bucketSize` samples into one
// candle. Partial trailing groups (not yet "closed") are dropped.
// `ticksChronological` is an array of { price, time } samples (time = epoch
// ms of that poll). Each candle's `time` is its first tick's timestamp,
// matching the "candle time = open time" convention real OHLC APIs use —
// needed so trade tracking can find "candles since this signal fired."
function buildSyntheticCandles(ticksChronological, bucketSize = 6) {
  const candles = [];
  for (let i = 0; i + bucketSize <= ticksChronological.length; i += bucketSize) {
    const chunk = ticksChronological.slice(i, i + bucketSize);
    const prices = chunk.map(t => t.price);
    candles.push({
      open: prices[0],
      close: prices.at(-1),
      high: Math.max(...prices),
      low: Math.min(...prices),
      time: chunk[0].time,
    });
  }
  return candles;
}

module.exports = { runEngine, buildSyntheticCandles, emaSeries, EMA_FAST_PERIOD, EMA_SLOW_PERIOD, PATTERN_LABEL, STRATEGY_LABEL, explainSignal, invalidationNote };
