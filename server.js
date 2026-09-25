const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createMemoryStorage, createPgStorage, createMysqlStorage } = require('./storage');
const { runEngine, buildSyntheticCandles, emaSeries, EMA_FAST_PERIOD, EMA_SLOW_PERIOD, PATTERN_LABEL } = require('./signals');
const { sendMail } = require('./mailer');
const twelveData = require('./twelvedata');
const { detectPatterns } = require('./patterns');
const { PLANS, RANK, planOf, atLeast } = require('./plans');
const ai = require('./ai');

const app = express();
app.use(cors());
app.use(express.json());
// We redeploy often during active development — always revalidate static
// assets instead of letting browsers cache a stale index.html/app.js
// indefinitely (that class of bug looks exactly like a server-side bug from
// the user's side, but is actually just an old page still running).
app.use(express.static('public', { etag: true, lastModified: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
// This one account gets Elite Max free, forever, automatically — everyone
// else buys it. Applied the moment this exact email signs up or logs in.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'langelihleimbongi@gmail.com').toLowerCase();
const ADMIN_EXPIRES_AT = '2099-12-31T00:00:00.000Z';
async function applyAdminOverrideIfNeeded(email) {
  if (email !== ADMIN_EMAIL) return;
  const sub = await store.getSubscriber(email);
  if (sub?.is_admin && sub?.plan === 'elite_max') return; // already applied
  await store.setAdmin(email, 'elite_max', ADMIN_EXPIRES_AT);
}
// Per-plan PayPal.me links: same handle, different amount per tier — mirrors
// the pattern already proven out on ResumeBuilderAI. PAYPAL_LINK stays as a
// back-compat override for the Premium price specifically (existing env var).
const PAYPAL_HANDLE = process.env.PAYPAL_HANDLE || 'IYTechnologies';
const PAYPAL_LINK = process.env.PAYPAL_LINK || `https://paypal.me/${PAYPAL_HANDLE}/${PLANS.premium.price}`;
const PRICE_MONTHLY = process.env.PRICE_LABEL || `R${PLANS.premium.price}/month`;
function payLinkFor(plan) { return `https://paypal.me/${PAYPAL_HANDLE}/${PLANS[plan]?.price ?? PLANS.premium.price}`; }
function priceLabelFor(plan) { return `R${PLANS[plan]?.price ?? PLANS.premium.price}/month`; }
// Same env var names as the PHP admin's own db.php (DB_HOST/DB_USER/
// DB_PASS/DB_NAME, MYSQL_* as aliases) so both apps configure against the
// one Xneelo MySQL database the exact same way.
const MYSQL_HOST = process.env.DB_HOST || process.env.MYSQL_HOST;
const MYSQL_USER = process.env.DB_USER || process.env.MYSQL_USER;
const MYSQL_PASS = process.env.DB_PASS || process.env.MYSQL_PASSWORD;
const MYSQL_NAME = process.env.DB_NAME || process.env.MYSQL_DATABASE;
const HAS_MYSQL = !!(MYSQL_HOST && MYSQL_USER && MYSQL_NAME);
const DEMO_MODE = !HAS_MYSQL && !process.env.DATABASE_URL;

// ---- Storage: MySQL (Xneelo, shared with the PHP admin + bot) takes
// priority when configured; Postgres if DATABASE_URL is set instead;
// otherwise in-memory demo mode with no real payments required. ----
let store;
if (HAS_MYSQL) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: MYSQL_HOST, user: MYSQL_USER, password: MYSQL_PASS, database: MYSQL_NAME,
    waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4_general_ci',
  });
  store = createMysqlStorage(pool);
} else if (DEMO_MODE) {
  console.log('[demo mode] no DB_HOST/DATABASE_URL set — using in-memory storage, no real payments required.');
  store = createMemoryStorage();
} else {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  store = createPgStorage(pool);
}

// ---- Instruments ----
// Every pair here is verified tradeable on BOTH Crypto.com (our backend
// candle/signal source) and Binance (the live WebSocket ticker/kline
// source — see BINANCE_SYMBOL in public/js/app.js), sorted roughly by
// 24h volume on Crypto.com. Picking pairs off just one exchange's list
// risked a "live" card that's actually still on the 30-second poll because
// Binance doesn't carry it — this list is the intersection, so "all from
// Binance" is actually true for every one of these.
// Trimmed to a fixed 12-asset crypto list per feedback (was 45 — combined
// with the 4 FX/gold instruments below, that was 49 total tracked markets).
const CRYPTO_INSTRUMENTS = [
  { key: 'BTC_USDT', label: 'BTC/USDT' },
  { key: 'XLM_USDT', label: 'XLM/USDT' },
  { key: 'ETH_USDT', label: 'ETH/USDT' },
  { key: 'SOL_USDT', label: 'SOL/USDT' },
  { key: 'XRP_USDT', label: 'XRP/USDT' },
  { key: 'ADA_USDT', label: 'ADA/USDT' },
  { key: 'DOGE_USDT', label: 'DOGE/USDT' },
  { key: 'LTC_USDT', label: 'LTC/USDT' },
  { key: 'PAXG_USDT', label: 'PAXG/USDT' },
  { key: 'LINK_USDT', label: 'LINK/USDT' },
  { key: 'AVAX_USDT', label: 'AVAX/USDT' },
  { key: 'ENA_USDT', label: 'ENA/USDT' },
];
// kind 'fiat': live tick via Frankfurter (base->quote). kind 'metal': via
// gold-api.com. twelveDataSymbol: real candle feed once TWELVEDATA_API_KEY
// is set — without it, these fall back to a slow self-built synthetic
// candle bootstrap (see getCandlesFor below).
const FX_INSTRUMENTS = [
  { key: 'EURUSD', label: 'EUR/USD', kind: 'fiat', base: 'EUR', quote: 'USD', twelveDataSymbol: 'EUR/USD' },
  { key: 'GBPUSD', label: 'GBP/USD', kind: 'fiat', base: 'GBP', quote: 'USD', twelveDataSymbol: 'GBP/USD' },
  { key: 'USDJPY', label: 'USD/JPY', kind: 'fiat', base: 'USD', quote: 'JPY', twelveDataSymbol: 'USD/JPY' },
  { key: 'XAUUSD', label: 'XAU/USD (Gold)', kind: 'metal', twelveDataSymbol: 'XAU/USD' },
];
const ALL_KEYS = [...CRYPTO_INSTRUMENTS, ...FX_INSTRUMENTS].map(a => a.key);
const LABELS = Object.fromEntries([...CRYPTO_INSTRUMENTS, ...FX_INSTRUMENTS].map(a => [a.key, a.label]));
// XAU/USD no longer runs through our own regime/strategy engine — a
// separate Telegram bot posts professional-analyst XAU calls straight into
// the `signals` table (source='bot'; see sql/BOT_INSTRUCTIONS.md), and this
// app just displays whatever it finds there. Live price ticking for XAU is
// untouched (it stays in ALL_KEYS/FX_INSTRUMENTS for that); ENGINE_KEYS is
// what everything analysis-related (computeSignal/trackSignals/the
// single-active-recommendation posting logic) iterates instead of ALL_KEYS.
const XAU_PRIORITY_WINDOW_MS = 20 * 60 * 1000;
const ENGINE_KEYS = ALL_KEYS.filter(k => k !== 'XAUUSD');

// In-memory cache of latest prices (fast reads for /api/prices)
let latestCache = {}; // key -> { price, changePct, updatedAt }
let lastPollAt = null;
const SERVER_STARTED_AT = new Date().toISOString();
// In-memory cache of real crypto candles (chronological, oldest first) for
// the signal engine — refreshed on every poll cycle, not per-request.
let cryptoCandleCache = {}; // key -> [{open,high,low,close}]

// ---- Pollers ----
async function pollCrypto() {
  const res = await fetch('https://api.crypto.com/exchange/v1/public/get-tickers');
  const json = await res.json();
  const data = json?.result?.data || [];
  const wanted = new Set(CRYPTO_INSTRUMENTS.map(c => c.key));
  const rows = [];
  for (const t of data) {
    if (!wanted.has(t.i)) continue;
    const price = parseFloat(t.a ?? t.b ?? t.k);
    const changePct = parseFloat(t.c) * 100;
    if (!isFinite(price)) continue;
    latestCache[t.i] = { price, changePct, updatedAt: new Date().toISOString() };
    rows.push({ instrument: t.i, price });
  }
  return rows;
}

async function pollCryptoCandles() {
  for (const { key } of CRYPTO_INSTRUMENTS) {
    try {
      const res = await fetch(`https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=${key}&timeframe=1h&count=100`);
      const json = await res.json();
      const data = json?.result?.data || [];
      cryptoCandleCache[key] = data.map(c => ({
        open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), time: c.t, volume: parseFloat(c.v) || 0,
      }));
    } catch (e) {
      console.error(`candlestick poll failed for ${key}`, e.message);
    }
  }
}

async function pollForex() {
  const rows = [];

  // Fiat pairs: one batched Twelve Data quote call covers all of them (real
  // intraday % change), instead of the Frankfurter fallback's once-a-day
  // ECB reference rate — which never moves intraday, so its % change reads
  // as a permanently flat 0.00% no matter how often we poll it.
  const fiatInstruments = FX_INSTRUMENTS.filter(fx => fx.kind === 'fiat');
  let twelveDataQuotes = {};
  if (twelveData.isConfigured()) {
    try { twelveDataQuotes = await twelveData.getQuotes(fiatInstruments.map(fx => fx.twelveDataSymbol)); }
    catch (e) { console.error('Twelve Data quote poll failed, falling back to Frankfurter', e.message); }
  }
  for (const fx of fiatInstruments) {
    try {
      const tdQuote = twelveDataQuotes[fx.twelveDataSymbol];
      if (tdQuote && isFinite(tdQuote.price)) {
        latestCache[fx.key] = { price: tdQuote.price, changePct: isFinite(tdQuote.changePct) ? tdQuote.changePct : 0, updatedAt: new Date().toISOString() };
        rows.push({ instrument: fx.key, price: tdQuote.price });
        continue;
      }
      const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${fx.base}&symbols=${fx.quote}`);
      const json = await res.json();
      const price = json?.rates?.[fx.quote];
      if (isFinite(price)) {
        const prev = latestCache[fx.key]?.price;
        const changePct = prev ? ((price - prev) / prev) * 100 : 0;
        latestCache[fx.key] = { price, changePct, updatedAt: new Date().toISOString() };
        rows.push({ instrument: fx.key, price });
      }
    } catch (e) { console.error(`${fx.key} poll failed`, e.message); }
  }

  for (const fx of FX_INSTRUMENTS.filter(fx => fx.kind === 'metal')) {
    try {
      // Works fine unauthenticated too — the key just gives more headroom
      // if gold-api.com ever rate-limits anonymous requests.
      const res = await fetch('https://api.gold-api.com/price/XAU', {
        headers: process.env.GOLD_API_KEY ? { 'x-api-key': process.env.GOLD_API_KEY } : {},
      });
      const json = await res.json();
      const price = json?.price;
      if (isFinite(price)) {
        const prev = latestCache[fx.key]?.price;
        const changePct = prev ? ((price - prev) / prev) * 100 : 0;
        latestCache[fx.key] = { price, changePct, updatedAt: new Date().toISOString() };
        rows.push({ instrument: fx.key, price });
      }
    } catch (e) { console.error(`${fx.key} poll failed`, e.message); }
  }
  return rows;
}

// Real OHLC candles for FX/gold via Twelve Data — same idea as
// pollCryptoCandles, just a different upstream. No-op (and the synthetic
// fallback in getCandlesFor takes over) until TWELVEDATA_API_KEY is set.
let fxCandleCache = {};
async function pollForexCandles() {
  if (!twelveData.isConfigured()) return;
  for (const fx of FX_INSTRUMENTS) {
    try {
      fxCandleCache[fx.key] = await twelveData.getCandles(fx.twelveDataSymbol, '1h', 100);
    } catch (e) {
      console.error(`Twelve Data candle poll failed for ${fx.key}`, e.message);
    }
  }
}

async function pollAllAndStore() {
  try {
    const cryptoRows = await pollCrypto();
    const fxRows = await pollForex();
    const rows = [...cryptoRows, ...fxRows];
    await store.addPollBatch(rows);
    await pollCryptoCandles();
    await pollForexCandles();
    await trackSignals();
    lastPollAt = new Date().toISOString();
    console.log(`[poll] stored ${rows.length} price points + refreshed crypto candles + tracked signals @ ${lastPollAt}`);
  } catch (e) {
    console.error('poll failed', e);
  }
}

const CRYPTO_KEYS = new Set(CRYPTO_INSTRUMENTS.map(c => c.key));

// Chart timeframe selector — the trading ENGINE always reads 1h structure
// (that's the granularity every threshold in signals.js was tuned against),
// but the CHART is free to display any of these; only the visual EMA overlay
// re-renders at the chosen timeframe, never the signal/regime/levels.
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'];
const CRYPTO_TF_MAP = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1D': '1D', '1W': '7D', '1M': '1M' };
const TWELVEDATA_TF_MAP = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '1D': '1day', '1W': '1week', '1M': '1month' };

async function fetchCryptoCandles(key, timeframe) {
  const res = await fetch(`https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=${key}&timeframe=${CRYPTO_TF_MAP[timeframe]}&count=100`);
  const json = await res.json();
  const data = json?.result?.data || [];
  return data.map(c => ({ open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), time: c.t, volume: parseFloat(c.v) || 0 }));
}

// ---- Full-history candle fetch, used ONLY to resolve an OPEN signal —
// distinct from getCandlesFor's cheap ~100-candle cache below, which the
// live engine uses for regime/ATR reads and doesn't need to change.
// A signal can sit open a long time, and this free Render service spins
// down from inactivity whenever the keepalive ping doesn't land, so the
// poll loop itself can go quiet for a stretch — a fixed ~4-day candle
// window meant whatever happened outside it was invisible forever, so a
// setup that had already reached its SL or TP days ago just sat "open"
// with no evidence either way, permanently. This instead walks real
// history all the way back to the signal's own entry time, in pages —
// same approach as the older CRT dashboard's monitorSetups (see
// PROJECTS/CRT-Trade-Dashboard-Old-Files) — so a stale open signal can
// actually catch up and settle instead of sitting open forever.
const CRYPTO_CANDLESTICK_MAX = 300; // crypto.com's own per-request cap
async function fetchCryptoCandlesSince(key, sinceMs) {
  const HOUR = 3600 * 1000;
  const all = [];
  let cursor = sinceMs;
  const now = Date.now();
  while (cursor < now && all.length < 5000) {
    const endTs = Math.min(now, cursor + CRYPTO_CANDLESTICK_MAX * HOUR);
    const url = `https://api.crypto.com/exchange/v1/public/get-candlestick?instrument_name=${key}&timeframe=1h&start_ts=${cursor}&end_ts=${endTs}&count=${CRYPTO_CANDLESTICK_MAX}`;
    let json;
    try { json = await (await fetch(url)).json(); } catch (e) { break; }
    const page = json?.result?.data || [];
    if (!page.length) { cursor = endTs + 1; continue; }
    all.push(...page.map(c => ({ open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), time: c.t, volume: parseFloat(c.v) || 0 })));
    const lastT = page[page.length - 1].t;
    if (lastT <= cursor) break; // safety: guarantee forward progress
    cursor = lastT + HOUR;
  }
  return all;
}
async function getResolutionCandlesFor(instrument, sinceMs) {
  if (CRYPTO_KEYS.has(instrument)) {
    try { return await fetchCryptoCandlesSince(instrument, sinceMs); }
    catch (e) { console.error(`resolution candle fetch failed for ${instrument}`, e.message); return []; }
  }
  if (twelveData.isConfigured()) {
    const fx = FX_INSTRUMENTS.find(f => f.key === instrument);
    if (fx) {
      const hoursSince = Math.ceil((Date.now() - sinceMs) / (3600 * 1000)) + 5;
      const outputsize = Math.min(5000, Math.max(100, hoursSince));
      try { return await twelveData.getCandles(fx.twelveDataSymbol, '1h', outputsize); }
      catch (e) { console.error(`Twelve Data resolution fetch failed for ${instrument}`, e.message); return []; }
    }
  }
  // No real historical source (FX without a Twelve Data key) — fall back to
  // the regular cache; not a full catch-up, but no worse than before.
  return getCandlesFor(instrument);
}

// Shared candle retrieval — crypto gets real candles straight from the
// exchange; FX/gold get real candles from Twelve Data once configured,
// otherwise fall back to bucketing our own 10-minute price polls into
// synthetic (lower-fidelity, slow-to-bootstrap, 1h-only) candles.
async function getCandlesFor(instrument, timeframe = '1h') {
  if (CRYPTO_KEYS.has(instrument)) {
    if (timeframe === '1h') return cryptoCandleCache[instrument] || [];
    try { return await fetchCryptoCandles(instrument, timeframe); }
    catch (e) { console.error(`on-demand candle fetch failed for ${instrument} @ ${timeframe}`, e.message); return []; }
  }

  if (timeframe === '1h' && fxCandleCache[instrument]?.length) {
    return fxCandleCache[instrument];
  }
  if (twelveData.isConfigured()) {
    const fx = FX_INSTRUMENTS.find(f => f.key === instrument);
    if (fx) {
      try { return await twelveData.getCandles(fx.twelveDataSymbol, TWELVEDATA_TF_MAP[timeframe], 100); }
      catch (e) { console.error(`Twelve Data on-demand fetch failed for ${instrument} @ ${timeframe}`, e.message); }
    }
  }
  if (timeframe !== '1h') return []; // no source for non-1h FX candles without Twelve Data
  const recentFirst = await store.getHistory(instrument, 600);
  return buildSyntheticCandles(recentFirst.slice().reverse(), 3);
}

// Multi-strategy engine (signals.js, ported from BOTS/universal.py).
// Cached per instrument and refreshed once per poll cycle (below), instead
// of recomputed on every request — so /api/insights and /api/history always
// serve a consistent, already-known-good result instantly, and a visitor in
// demo/test mode isn't dependent on a live recompute succeeding at the exact
// moment they check (a transient upstream hiccup no longer means "no data").
let insightCache = {};
// Multi-timeframe context for the SMC strategy (signals.js/smc.js): 4H for
// direction, 1H (the same `candles` the rest of the engine already uses)
// for the key zone, 15min for entry confirmation. Crypto only, deliberately
// — crypto's exchange candle API is free and uncapped at any timeframe, but
// FX/gold's is Twelve Data's free tier (800 requests/day). This runs once
// per market per 10-minute poll cycle (trackSignals), so two extra
// timeframes across all 4 FX/gold markets would add ~1,150 calls/day on
// top of the ~576/day the existing 1h polling already uses — enough to
// exhaust the daily quota and break the FX chart feature that already
// depends on it. Crypto has no such ceiling, so it's the only place this
// runs; FX/gold signals simply fall back to the regime-based engine, same
// as before this feature existed.
async function computeSignal(instrument) {
  const candles = await getCandlesFor(instrument);
  let smcCtx = null;
  if (CRYPTO_KEYS.has(instrument)) {
    try {
      const [htf, ltf] = await Promise.all([
        getCandlesFor(instrument, '4h'),
        getCandlesFor(instrument, '15m'),
      ]);
      smcCtx = { htf, mtf: candles, ltf };
    } catch (e) {
      // SMC context is a bonus layer, never a hard dependency — the regime-based engine still works without it.
    }
  }
  return runEngine(candles, smcCtx);
}
async function getCachedInsight(instrument) {
  if (instrument === 'XAUUSD') return getXauInsight();
  if (insightCache[instrument]) return insightCache[instrument];
  // Cold start (no poll has run yet) — compute once and cache it so the
  // very first request isn't left with nothing either.
  const result = await computeSignal(instrument);
  insightCache[instrument] = result;
  return result;
}

// Shapes whatever the bot last posted for XAU into the same insight-object
// contract computeSignal/runEngine produces, so every downstream consumer
// (topPick selection, the Insights list, the chart side panel) needs no
// special-casing beyond this one function. `priority` is true exactly when
// the spec's freshness rule applies — an open bot signal posted within the
// last 20 minutes — and is what makes /api/insights force XAU to the top
// regardless of what our own engine's best confidence elsewhere is.
async function getXauInsight() {
  const latest = await store.getLatestSignalFor('XAUUSD');
  const isFreshBotCall = !!(latest && latest.source === 'bot' && latest.status === 'open'
    && (Date.now() - new Date(latest.created_at).getTime()) < XAU_PRIORITY_WINDOW_MS);

  if (!latest || latest.source !== 'bot') {
    return {
      signal: 'HOLD', regime: null, strategy: null, confidence: null, levels: null,
      note: 'No professional XAU/USD signal posted right now. This market is covered by our professional trading team rather than the automated engine — check back soon, and as always, conduct your own analysis.',
      explanation: null, invalidation: null, patterns: [], zones: null, zoneNote: null, priority: false,
    };
  }

  const isOpen = latest.status === 'open';
  const levels = isOpen ? { entry: latest.entry, sl: latest.sl, tp1: latest.tp1, tp2: latest.tp2, tp3: latest.tp3, tp4: latest.tp4, riskReward: null } : null;
  const biasWord = latest.side === 'BUY' ? 'bullish' : 'bearish';
  return {
    signal: isOpen ? latest.side : 'HOLD',
    regime: null,
    strategy: 'PROFESSIONAL',
    confidence: latest.confidence,
    levels,
    note: isOpen
      ? `This setup was analyzed and posted by our professional trading team, not our automated engine (setup strength ${latest.confidence != null ? latest.confidence + '/100' : 'not rated'}). Informational only — conduct your own analysis and risk assessment before making any trading decision.`
      : 'The most recent professional XAU/USD call has since resolved — check Track Record for the outcome. Our own engine no longer analyzes XAU directly.',
    explanation: isOpen
      ? `A member of our professional trading team identified this ${biasWord} XAU/USD setup${latest.posted_by ? ` via ${latest.posted_by}` : ''}. This is a human, discretionary call — not an algorithmic signal — so treat it with the same informational-only framing as everything else on this platform.`
      : null,
    invalidation: (isOpen && levels?.sl != null) ? `This idea weakens if price closes back ${latest.side === 'BUY' ? 'below' : 'above'} ${levels.sl} — that's the invalidation point.` : null,
    patterns: [], zones: null, zoneNote: null,
    priority: isFreshBotCall,
  };
}

// Walks every candle since a signal fired and asks, authoritatively, "what
// actually happened" — instead of just comparing the current tick to each
// level once per poll (which misses a wick that touches a level and reverses
// between two 10-minute polls). Ported from an older CRT dashboard's
// trade-tracking approach (PROJECTS/CRT-Trade-Dashboard-Old-Files), not its
// signal logic.
//
// A single candle can span BOTH a TP and the SL (a wide bar). OHLC alone
// can't tell you which happened first, so — same tiebreak as the source —
// we use the candle's own close-vs-open direction as the best available
// signal: only credit the TP(s) if the candle closed in the winning
// direction; otherwise assume the stop-out came first. This is a
// conservative bias against overstating the win rate, not a coin flip.
function resolveSignalFromCandles(sig, candles) {
  const entryTime = new Date(sig.created_at).getTime();
  const levels = [['TP1', sig.tp1], ['TP2', sig.tp2], ['TP3', sig.tp3], ['TP4', sig.tp4]];
  const seen = new Set((sig.hit_history || []).map(h => h.level));
  const hitHistory = [...(sig.hit_history || [])];
  const isBuy = sig.side === 'BUY';
  let slHitAt = null;

  for (const c of candles) {
    if (c.time == null || c.time < entryTime) continue;
    const candleTPs = levels.filter(([label, lvl]) => !seen.has(label) && lvl != null && (isBuy ? c.high >= lvl : c.low <= lvl));
    let candleSL = isBuy ? c.low <= sig.sl : c.high >= sig.sl;

    // Mutually exclusive within one bar — OHLC can't tell you which extreme
    // came first, so bar direction decides which one "actually" happened:
    // closed in our favor → assume the TP side happened, not stopped out;
    // closed against us → assume the SL side happened, no TP credited.
    if (candleTPs.length && candleSL) {
      const closedWinning = isBuy ? c.close >= c.open : c.close <= c.open;
      if (closedWinning) candleSL = false;
      else candleTPs.length = 0;
    }
    for (const [label, lvl] of candleTPs) { seen.add(label); hitHistory.push({ level: label, time: c.time, price: lvl }); }
    if (candleSL) { slHitAt = c.time; break; } // trade is closed — nothing after this candle matters
  }

  const bestLevel = ['TP4', 'TP3', 'TP2', 'TP1'].find(l => seen.has(l)) || sig.best_level || null;
  // The bot's setups only ever carry TP1-TP3 (no TP4 field) — closing a
  // trade strictly on TP4 meant a bot signal that hit its own max target
  // (TP3) and then just sat there could never actually close, so it never
  // counted as a win. A signal closes once it reaches WHICHEVER of its own
  // defined targets is highest, not a hardcoded TP4.
  const topLevel = ['TP4', 'TP3', 'TP2', 'TP1'].find(l => levels.find(([lbl, lvl]) => lbl === l && lvl != null)) || null;
  const reachedTop = topLevel && seen.has(topLevel);
  const status = reachedTop ? 'closed' : slHitAt ? 'closed' : 'open';
  // Never disguise a reached target as an outright loss: once any TP has
  // actually printed, the worst honest outcome is "reached <bestLevel>, then
  // gave back the remainder" — not a full SL loss. Only a stop-out with zero
  // TPs touched at all is recorded as 'SL'. `slTouched` is tracked separately
  // (regardless of how the outcome reads) so alerts still fire on the actual
  // stop-loss touch either way.
  const outcome = reachedTop ? topLevel : slHitAt ? (bestLevel || 'SL') : null;
  const closedAt = reachedTop ? (hitHistory.find(h => h.level === topLevel)?.time ?? Date.now()) : slHitAt;

  return { hitHistory, bestLevel, status, outcome, slTouched: !!slHitAt, closedAt: closedAt ? new Date(closedAt).toISOString() : null };
}

// ---- Alerts (Pro+ only, per spec): new high-confidence signal, and TP/SL
// touches on an open one. Dedup via alerted_new/alerted_levels on the signal
// row itself, so a redeploy or a slow poll cycle can never double-send.
const HIGH_CONFIDENCE_THRESHOLD = 70;
async function getAlertRecipients() {
  const subs = await store.listSubscribers();
  const now = new Date();
  return subs.filter(s => s.status === 'active' && s.expires_at && new Date(s.expires_at) > now && atLeast(s.plan || 'free', 'pro'));
}
async function alertNewSignal(sig) {
  if (sig.confidence == null || sig.confidence < HIGH_CONFIDENCE_THRESHOLD) return;
  const subject = `New ${sig.confidence}%-confidence setup: ${LABELS[sig.instrument] || sig.instrument} (${sig.side})`;
  const body = `${LABELS[sig.instrument] || sig.instrument} — ${sig.side} via ${sig.strategy}, confidence ${sig.confidence}/100.\nEntry: ${sig.entry}\nStop loss: ${sig.sl}\nTargets: ${sig.tp1}, ${sig.tp2}, ${sig.tp3}, ${sig.tp4}\n\nInformational only — conduct your own analysis before trading.`;
  const recipients = await getAlertRecipients();
  for (const r of recipients) sendMail(r.email, subject, body);
  await store.createNotification({ signalId: sig.id, type: 'new_signal', minPlan: 'pro', title: subject, body, instrument: sig.instrument });
}
async function alertLevelTouch(sig, newLevels) {
  if (!newLevels.length) return;
  const subject = `${LABELS[sig.instrument] || sig.instrument} touched ${newLevels.join(', ')}`;
  const body = `Your tracked setup on ${LABELS[sig.instrument] || sig.instrument} (${sig.side} via ${sig.strategy}) just touched: ${newLevels.join(', ')}.\n\nInformational only.`;
  const recipients = await getAlertRecipients();
  for (const r of recipients) sendMail(r.email, subject, body);
  await store.createNotification({ signalId: sig.id, type: 'level_touch', minPlan: 'pro', title: subject, body, instrument: sig.instrument });
}
// Fired when a fresh bot-posted XAU signal is found for the first time
// this poll cycle — see checkForNewBotSignals below.
async function alertBotSignal(sig) {
  const subject = `Professional XAU/USD call posted: ${sig.side}`;
  const body = `Our professional trading team posted a new ${sig.side} setup on XAU/USD${sig.confidence != null ? ` (confidence ${sig.confidence}/100)` : ''}.\nEntry: ${sig.entry}\nStop loss: ${sig.sl}\n\nInformational only — conduct your own analysis before trading.`;
  const recipients = await getAlertRecipients();
  for (const r of recipients) sendMail(r.email, subject, body);
  await store.createNotification({ signalId: sig.id, type: 'bot_signal', minPlan: 'pro', title: subject, body, instrument: 'XAUUSD' });
}

// ---- Track record: single-active-recommendation system. /api/insights
// still shows a live read for every tracked market (a Premium+ user can
// still go for their own pick — e.g. a 75%-confidence ETH/USD read — even
// when a higher-confidence setup exists elsewhere); the DATABASE, and
// therefore the Track Record page, only ever logs the single best/highest-
// confidence setup found across ALL markets at a time, and only when
// nothing is already pending. This is what "what did the system actually
// recommend, and did it win" means for a track record: one call at a time,
// timestamped, resolved before the next one is posted — not fourteen
// markets' worth of simultaneous rows. Concretely:
//   - At most one signal is ever open in the DB at once.
//   - A brand new candidate is logged only once nothing is open (a pending
//     recommendation is always resolved — win, loss, or invalidated —
//     before the next one is considered, even if a higher-confidence setup
//     shows up on a different market in the meantime).
//   - Because posting is driven by server-side poll state, not by who's
//     looking or when, two different users logging in at different times
//     see the exact same Track Record — there's no per-visitor "pick".
// Once posted, a recommendation is never aborted just because the engine's
// read for that instrument moved on — a user may already have acted on it.
// It's tracked to its real conclusion (a target hit, or the stop) via
// resolveSignalFromCandles, same as always. When a DIFFERENT instrument
// becomes the best read, it's posted and tracked immediately, in parallel
// with whatever's still open — a user logging in right now must see the
// current best being tracked without waiting on an older, unresolved pick
// to close first. Multiple system signals can be open at once by design.
async function postNewSystemSignal(key, result) {
  const row = await store.logSignal({
    source: 'system',
    instrument: key, strategy: result.strategy, regime: result.regime, side: result.signal,
    entry: result.levels.entry, sl: result.levels.sl,
    tp1: result.levels.tp1, tp2: result.levels.tp2, tp3: result.levels.tp3, tp4: result.levels.tp4,
    confidence: result.confidence,
  });
  await alertNewSignal(row);
  await store.updateSignalOutcome(row.id, { alerted_new: true });
  return row;
}

async function trackSignals() {
  const results = {};
  // XAU is deliberately excluded — the bot manages that instrument's
  // signals entirely on its own, straight against the shared table.
  for (const key of ENGINE_KEYS) {
    try { results[key] = await computeSignal(key); insightCache[key] = results[key]; } catch (e) { /* leave this cycle's cache entry as-is */ }
  }

  // Notify Pro+ subscribers the instant the bot posts a fresh XAU call —
  // detected purely by alerted_new=0, the same dedup flag the system's own
  // alerts already use, so a redeploy or slow cycle can never double-send.
  // This only ever READS the bot's row and flips that one bookkeeping flag
  // — never touches side/entry/levels/status/outcome, which stay entirely
  // the bot's to manage.
  try {
    const openBotSignals = (await store.getOpenSignals()).filter(s => s.source === 'bot' && !s.alerted_new);
    for (const sig of openBotSignals) {
      await alertBotSignal(sig);
      await store.updateSignalOutcome(sig.id, { alerted_new: true });
    }
  } catch (e) { console.error('bot signal alert check failed', e.message); }

  // ---- Resolve every open system signal via a real candle SL/TP walk.
  // No assumption of exactly one open row — a sustained challenger can add
  // a new one while an older pick is still resolving on its own (see
  // below). Bot-sourced rows (XAU) are explicitly skipped: the bot
  // resolves its own signals directly (see sql/BOT_INSTRUCTIONS.md).
  const openSystemSignals = (await store.getOpenSignals()).filter(s => s.source !== 'bot');
  for (const sig of openSystemSignals) {
    const key = sig.instrument;
    let candles;
    try { candles = await getResolutionCandlesFor(key, new Date(sig.created_at).getTime()); } catch (e) { candles = []; }
    if (!candles.length) continue;

    const resolved = resolveSignalFromCandles(sig, candles);
    const changed = JSON.stringify(resolved.hitHistory) !== JSON.stringify(sig.hit_history || [])
      || resolved.bestLevel !== sig.best_level || resolved.status !== sig.status;
    if (!changed) continue;

    const patch = { hit_history: resolved.hitHistory, best_level: resolved.bestLevel };
    if (resolved.status === 'closed') { patch.status = 'closed'; patch.outcome = resolved.outcome; patch.closed_at = resolved.closedAt; }

    const alertedLevels = new Set(sig.alerted_levels || []);
    const newlyHitLevels = resolved.hitHistory.map(h => h.level).filter(l => !alertedLevels.has(l));
    // Once any TP has printed, the setup is already a win no matter what
    // price does afterward (see resolveSignalFromCandles's outcome logic) —
    // an "SL touched" push after that would read as a loss when it isn't
    // one, so it's not worth notifying at all once a TP is already banked.
    const anyTpHit = resolved.hitHistory.some(h => h.level?.startsWith('TP'));
    const newlyHitSL = resolved.slTouched && !alertedLevels.has('SL') && !anyTpHit;
    const touchLabels = [...newlyHitLevels, ...(newlyHitSL ? ['SL'] : [])];
    if (touchLabels.length) {
      await alertLevelTouch(sig, touchLabels);
      patch.alerted_levels = [...alertedLevels, ...touchLabels];
    }
    await store.updateSignalOutcome(sig.id, patch);
  }

  // ---- Decide whether to post a new recommendation. The current best read
  // gets tracked immediately if it isn't already an open pick — no waiting
  // period. Whatever else is already open just keeps resolving in parallel
  // via the loop above, untouched. ----
  const actionable = ENGINE_KEYS
    .map(key => ({ key, result: results[key] }))
    .filter(({ result }) => result && result.signal !== 'HOLD' && result.levels && result.confidence != null);
  if (!actionable.length) return;
  const best = actionable.reduce((a, b) => (b.result.confidence > a.result.confidence ? b : a));

  const stillOpen = (await store.getOpenSignals()).filter(s => s.source !== 'bot');
  const alreadyOpen = stillOpen.some(s => s.instrument === best.key);
  if (alreadyOpen) return;

  await postNewSystemSignal(best.key, best.result);
}

// A reached target (TP1-TP4) is a win even if the position later gave back
// the remainder and stopped out — resolveSignalFromCandles never labels
// those cases 'SL', but this set is the single place that decides what
// counts as a win everywhere stats get computed, so the two can't drift.
const WIN_OUTCOMES = new Set(['TP1', 'TP2', 'TP3', 'TP4']);

// How long a setup took to reach its logged result. For a win, that's the
// time the *best* level actually printed (from hit_history) — not
// closed_at, which for a TP-then-SL case is later, when the remainder
// stopped out. For a straight SL loss or an invalidated setup, closed_at
// is the only timestamp there is, so that's the duration.
function resolvedInMs(row) {
  if (row.status !== 'closed' || !row.created_at) return null;
  const start = new Date(row.created_at).getTime();
  if (WIN_OUTCOMES.has(row.outcome)) {
    const hit = (row.hit_history || []).find(h => h.level === row.outcome);
    const end = hit ? new Date(hit.time).getTime() : (row.closed_at ? new Date(row.closed_at).getTime() : null);
    return end != null ? Math.max(0, end - start) : null;
  }
  if (!row.closed_at) return null;
  return Math.max(0, new Date(row.closed_at).getTime() - start);
}

function computePerformanceStats(rows) {
  const closed = rows.filter(r => r.status === 'closed');
  const wins = closed.filter(r => WIN_OUTCOMES.has(r.outcome)).length;
  const losses = closed.filter(r => r.outcome === 'SL').length;
  const invalidated = closed.filter(r => r.outcome === 'INVALIDATED').length;
  const open = rows.filter(r => r.status === 'open').length;
  const decided = wins + losses;
  const winRate = decided ? Math.round((wins / decided) * 1000) / 10 : null;

  const byInstrument = {};
  for (const r of closed) {
    if (!WIN_OUTCOMES.has(r.outcome) && r.outcome !== 'SL') continue;
    byInstrument[r.instrument] = byInstrument[r.instrument] || { wins: 0, losses: 0 };
    byInstrument[r.instrument][WIN_OUTCOMES.has(r.outcome) ? 'wins' : 'losses']++;
  }
  return { total: rows.length, open, wins, losses, invalidated, winRate, byInstrument };
}

// Win rate by day-of-week (Monday..Sunday, regardless of actual calendar
// date — "historically, how do Wednesdays look") split by side, for the
// Dashboard's two weekly trend charts. Includes every closed signal
// regardless of source, so XAU's bot-resolved calls count alongside the
// system's own.
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function computeWeekdayWinRates(rows) {
  const buckets = { BUY: WEEKDAY_LABELS.map(() => ({ wins: 0, losses: 0 })), SELL: WEEKDAY_LABELS.map(() => ({ wins: 0, losses: 0 })) };
  for (const r of rows) {
    if (r.status !== 'closed' || (!WIN_OUTCOMES.has(r.outcome) && r.outcome !== 'SL')) continue;
    if (r.side !== 'BUY' && r.side !== 'SELL') continue;
    const jsDay = new Date(r.created_at).getDay(); // 0=Sun..6=Sat
    const mondayFirstIndex = (jsDay + 6) % 7; // 0=Mon..6=Sun
    buckets[r.side][mondayFirstIndex][WIN_OUTCOMES.has(r.outcome) ? 'wins' : 'losses']++;
  }
  const toSeries = (side) => buckets[side].map((b, i) => ({
    day: WEEKDAY_LABELS[i], wins: b.wins, losses: b.losses,
    winRate: (b.wins + b.losses) ? Math.round((b.wins / (b.wins + b.losses)) * 1000) / 10 : null,
  }));
  return { buy: toSeries('BUY'), sell: toSeries('SELL') };
}

// ---- Routes ----
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ demoMode: DEMO_MODE, payLink: PAYPAL_LINK, price: PRICE_MONTHLY, timeframes: TIMEFRAMES, plans: PLANS, marketCount: ALL_KEYS.length, aiConfigured: ai.isAiConfigured() });
});

// Currency conversion for display only — billing stays in ZAR via PayPal.
app.get('/api/currency/convert', async (req, res) => {
  const to = String(req.query.to || 'USD').toUpperCase();
  const amount = parseFloat(req.query.amount || '0');
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=ZAR&symbols=${to}`);
    const json = await r.json();
    const rate = json?.rates?.[to];
    if (!rate) return res.status(400).json({ error: 'Unsupported currency' });
    res.json({ from: 'ZAR', to, rate, amount, converted: Math.round(amount * rate * 100) / 100 });
  } catch (e) {
    res.status(502).json({ error: 'Conversion service unavailable' });
  }
});

// ---- Accounts: email+password with an opaque session token, so a visitor
// signs up once instead of retyping their email everywhere. Passwords are
// hashed with scrypt (Node's built-in crypto — no extra dependency).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolves req.authEmail from a Bearer session token, if one was sent.
// Never blocks the request — routes that need auth check req.authEmail themselves.
app.use(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.authEmail = token ? await store.getSessionEmail(token) : null;
  next();
});

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function isValidUsername(u) { return /^[a-zA-Z0-9_]{3,20}$/.test(u); }

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  const firstName = String(req.body?.firstName || '').trim();
  const lastName = String(req.body?.lastName || '').trim();
  const username = String(req.body?.username || '').trim();

  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!firstName || !lastName) return res.status(400).json({ error: 'Enter your first and last name.' });
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Username must be 3-20 characters, letters/numbers/underscore only.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });

  const existing = await store.getSubscriber(email);
  if (existing?.password_hash) return res.status(409).json({ error: 'An account already exists for this email — log in instead.' });
  if (await store.isUsernameTaken(username, email)) return res.status(409).json({ error: 'That username is already taken.' });

  await store.setPassword(email, hashPassword(password), { firstName, lastName, username });
  await applyAdminOverrideIfNeeded(email);
  const token = crypto.randomBytes(24).toString('hex');
  await store.createSession(token, email);
  const sub = await store.getSubscriber(email);
  sendMail(email, 'Welcome to TradingAnalysis', `Hi ${firstName}, your account has been created. Live market data is free — subscribe any time for ${PRICE_MONTHLY} to unlock full insights.`);
  res.json({ ok: true, token, email, username: sub?.username, status: sub?.status || 'pending', plan: planOf(sub) });
});

app.post('/api/auth/login', async (req, res) => {
  const identifier = String(req.body?.email || req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  // Accept either an email or a username — whichever it looks like.
  const sub = isValidEmail(identifier)
    ? await store.getSubscriber(identifier.toLowerCase())
    : await store.getSubscriberByUsername(identifier);
  if (!sub?.password_hash || !verifyPassword(password, sub.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email/username or password.' });
  }
  await applyAdminOverrideIfNeeded(sub.email);
  const token = crypto.randomBytes(24).toString('hex');
  await store.createSession(token, sub.email);
  const fresh = await store.getSubscriber(sub.email);
  res.json({ ok: true, token, email: sub.email, username: fresh?.username, status: fresh.status, plan: planOf(fresh) });
});

app.post('/api/auth/logout', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) await store.deleteSession(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.authEmail) return res.status(401).json({ error: 'Not logged in.' });
  const sub = await store.getSubscriber(req.authEmail);
  const active = !!(sub && sub.status === 'active' && sub.expires_at && new Date(sub.expires_at) > new Date());
  res.json({
    email: req.authEmail, username: sub?.username || null, firstName: sub?.first_name || null, lastName: sub?.last_name || null,
    status: sub?.status || 'pending', expiresAt: sub?.expires_at || null, active, plan: planOf(sub), favourites: sub?.favourites || [],
    isAdmin: !!sub?.is_admin, role: sub?.role || 'trader',
  });
});

app.get('/api/prices', (req, res) => {
  const assets = ALL_KEYS.map(key => ({
    key,
    label: LABELS[key],
    price: latestCache[key]?.price ?? null,
    changePct: latestCache[key]?.changePct ?? null,
    updatedAt: latestCache[key]?.updatedAt ?? null,
  }));
  res.json({ assets, payLink: PAYPAL_LINK, price: PRICE_MONTHLY, demoMode: DEMO_MODE });
});

app.post('/api/subscribe', async (req, res) => {
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  const plan = ['premium', 'pro', 'elite'].includes(req.body?.plan) ? req.body.plan : 'premium';
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  await store.upsertPending(email);
  const price = priceLabelFor(plan);
  const link = payLinkFor(plan);
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    plan,
    payLink: link,
    price,
    instructions: DEMO_MODE
      ? `Demo mode: no real charge. Click "Simulate Payment" below to test what a ${PLANS[plan].label} subscriber sees.`
      : `Pay ${price} via the link, then message us your payment reference with this email (${email}) so we can activate your ${PLANS[plan].label} access. Activation is manual for now — usually within a few hours.`,
  });
});

// Demo-only: instantly activates a subscriber with no real payment, so the
// flow can be tested end-to-end before real payments/DB are wired in.
app.post('/api/demo/activate', async (req, res) => {
  if (!DEMO_MODE) return res.status(403).json({ error: 'Demo activation is disabled — real payments are live.' });
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  const plan = ['premium', 'pro', 'elite'].includes(req.body?.plan) ? req.body.plan : 'premium';
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, 30, plan);
  sendMail(email, `Your TradingAnalysis ${PLANS[plan].label} subscription is active (demo)`, `This is a demo activation — no real payment was taken. Your ${PLANS[plan].label} access is active for 30 days.`);
  res.json({ ok: true, plan });
});

app.get('/api/insights', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });

  const sub = await store.getSubscriber(email);
  const plan = planOf(sub);
  const premium = atLeast(plan, 'premium');

  if (!premium) {
    return res.status(402).json({
      locked: true,
      plan,
      payLink: PAYPAL_LINK,
      price: PRICE_MONTHLY,
      message: `Subscribe to unlock market-structure insights for all ${ALL_KEYS.length} tracked markets.`,
    });
  }

  const proTools = atLeast(plan, 'pro');
  const elite = atLeast(plan, 'elite');

  const signals = [];
  for (const key of ALL_KEYS) {
    const s = await getCachedInsight(key);
    signals.push({ key, label: LABELS[key], ...s });
  }

  // Surface the single strongest setup across all tracked markets, so a user
  // isn't left to guess which mixed-confidence read to actually pay
  // attention to. Ties broken by which strategy fired (arbitrary but stable).
  // A fresh (posted within the last 20 minutes) professional XAU call always
  // wins this contest outright, regardless of confidence — a human analyst's
  // live call takes priority over the automated engine's own best read.
  const actionable = signals.filter(s => s.signal !== 'HOLD' && s.confidence != null);
  const freshXau = signals.find(s => s.key === 'XAUUSD' && s.priority && s.signal !== 'HOLD');
  const topPick = freshXau || (actionable.length
    ? actionable.reduce((best, s) => (s.confidence > best.confidence ? s : best))
    : null);

  const payload = {
    locked: false, plan, expiresAt: sub.expires_at, signals, topPick, proTools, elite,
  };

  if (proTools) {
    payload.favourites = sub.favourites || [];
  }

  res.json(payload);
});

// AI Elite: per-signal AI explanation, gated to elite plan.
app.get('/api/ai/explain', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  const key = String(req.query.key || '');
  if (!ALL_KEYS.includes(key)) return res.status(404).json({ error: 'unknown instrument' });
  const sub = await store.getSubscriber(email);
  if (!atLeast(planOf(sub), 'elite')) return res.status(402).json({ locked: true, message: 'AI explanations are an AI Elite feature.' });
  const insight = await getCachedInsight(key);
  if (insight.signal === 'HOLD') return res.json({ mode: 'template', explanation: insight.note });
  const result = await ai.explainSignalAi({ instrument: key, ...insight, patternName: insight.patterns?.find(p => p.confirmed)?.name });
  res.json(result);
});

// AI Elite: Q&A about a specific market's current setup, gated to elite plan.
app.post('/api/ai/ask', async (req, res) => {
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  const key = String(req.body?.key || '');
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const sub = await store.getSubscriber(email);
  if (!atLeast(planOf(sub), 'elite')) return res.status(402).json({ locked: true, message: 'Ask-the-AI is an AI Elite feature.' });
  const context = ALL_KEYS.includes(key) ? { instrument: key, label: LABELS[key], ...(await getCachedInsight(key)) } : { note: 'No specific market selected.' };
  const result = await ai.answerQuestion(question, context);
  res.json(result);
});

// AI Elite: daily summary across all open setups, gated to elite plan.
app.get('/api/ai/daily-summary', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  const sub = await store.getSubscriber(email);
  if (!atLeast(planOf(sub), 'elite')) return res.status(402).json({ locked: true, message: 'Daily AI summaries are an AI Elite feature.' });
  const open = await store.getOpenSignals();
  const result = await ai.dailySummary(open.map(s => ({ instrument: s.instrument, side: s.side, strategy: s.strategy, confidence: s.confidence })));
  res.json(result);
});

// Pro+: save/toggle favourite markets.
app.post('/api/favourites', async (req, res) => {
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const sub = await store.getSubscriber(email);
  if (!atLeast(planOf(sub), 'pro')) return res.status(402).json({ locked: true, message: 'Favourites are a Pro Trader Tools feature.' });
  const favourites = Array.isArray(req.body?.favourites) ? req.body.favourites.filter(k => ALL_KEYS.includes(k)) : [];
  await store.setFavourites(email, favourites);
  res.json({ ok: true, favourites });
});

// Notifications — Pro+ (matches the alert-eligibility rule everything
// here already uses): every "strong signal generated" event, whether the
// system's own engine fired one or the professional bot posted an XAU
// call, in one feed.
app.get('/api/notifications', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const sub = await store.getSubscriber(email);
  const plan = planOf(sub);
  if (!atLeast(plan, 'pro')) return res.status(402).json({ locked: true, message: 'Notifications are a Pro Trader Tools feature.' });
  // Dashboard shows the most recent 20 by default; "see more" pages in
  // further batches via offset instead of ever fetching the whole backlog.
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const notifications = await store.listNotifications(email, plan, limit, offset);
  res.json({ notifications, limit, offset });
});

app.post('/api/notifications/:id/read', async (req, res) => {
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.markNotificationRead(email, Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/notifications/mark-all-read', async (req, res) => {
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const sub = await store.getSubscriber(email);
  const plan = planOf(sub);
  if (!atLeast(plan, 'pro')) return res.status(402).json({ locked: true, message: 'Notifications are a Pro Trader Tools feature.' });
  await store.markAllNotificationsRead(email, plan);
  res.json({ ok: true });
});

app.get('/api/notifications/unread-count', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ count: 0 });
  const sub = await store.getSubscriber(email);
  const plan = planOf(sub);
  if (!atLeast(plan, 'pro')) return res.json({ count: 0 });
  const count = await store.countUnreadNotifications(email, plan);
  res.json({ count });
});

// Track record — public, on purpose: showing losses alongside wins is what
// makes the accuracy claim credible instead of marketing copy. BUT an
// "open" row is a live, still-actionable setup — showing its instrument +
// bias for free would just leak the paid signal through the back door, so
// only closed (resolved, no-longer-actionable) rows are ever shown in full
// to a non-premium visitor.
app.get('/api/performance', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  let plan = 'free';
  if (email) plan = planOf(await store.getSubscriber(email));
  const premium = atLeast(plan, 'premium');
  const proTools = atLeast(plan, 'pro');

  const rows = await store.listSignals(500);
  const stats = computePerformanceStats(rows); // aggregate stats computed on the full history, invalidated included
  // The displayed list only ever shows real outcomes (a target hit or the
  // stop) — an invalidated row isn't a result worth showing individually,
  // just noise. Now rare going forward: trackSignals() no longer aborts a
  // posted pick just because the engine's read moved on.
  const recent = rows.filter(r => r.outcome !== 'INVALIDATED').slice(0, 500).map(r => {
    if (r.status === 'open' && !premium) {
      return { id: r.id, status: 'open', locked: true, created_at: r.created_at };
    }
    return { ...r, label: LABELS[r.instrument], resolved_in_ms: resolvedInMs(r) };
  });

  const payload = { stats, recent, premium, plan };
  res.json(payload);
});

// Dashboard landing page: top-6 win rate bar chart (includes XAU — the
// bot's resolved calls count in byInstrument the same as everything else,
// no special-casing needed) + the two weekly buy/sell trend lines. Public,
// same "aggregate stats are the credibility number" precedent as
// /api/performance's own stats — no per-market entry/SL/TP leaks here.
app.get('/api/dashboard-stats', async (req, res) => {
  const rows = await store.listSignals(1000);
  const stats = computePerformanceStats(rows);
  const topAssets = Object.entries(stats.byInstrument)
    .map(([key, s]) => ({ key, label: LABELS[key] || key, ...s, winRate: (s.wins + s.losses) ? Math.round((s.wins / (s.wins + s.losses)) * 1000) / 10 : null }))
    .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1))
    .slice(0, 6);
  const weekly = computeWeekdayWinRates(rows);
  res.json({ stats, topAssets, weekly });
});

// Chart data for a single market: closes for everyone; EMA overlays +
// regime/strategy only for an active subscriber (checked by email).
app.get('/api/history', async (req, res) => {
  const key = String(req.query.key || '');
  if (!ALL_KEYS.includes(key)) return res.status(404).json({ error: 'unknown instrument' });

  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  let plan = 'free';
  if (email) plan = planOf(await store.getSubscriber(email));
  const premium = atLeast(plan, 'premium'); // signal/levels
  const proTools = atLeast(plan, 'pro'); // EMA/pattern overlays, chart tools

  const timeframe = TIMEFRAMES.includes(req.query.timeframe) ? req.query.timeframe : '1h';

  // The engine's signal/regime/levels are always computed on 1h structure —
  // every threshold in signals.js was tuned at that granularity, so this
  // stays fixed regardless of what the user is looking at on the chart.
  const engineCandles = await getCandlesFor(key); // always 1h (default param)
  const displayCandles = timeframe === '1h' ? engineCandles : await getCandlesFor(key, timeframe);
  const closes = displayCandles.map(c => c.close);
  const payload = {
    key,
    label: LABELS[key],
    timeframe,
    candles: displayCandles, // full OHLC, for candlestick rendering
    closes,  // convenience array, for line rendering
    high: displayCandles.length ? Math.max(...displayCandles.map(c => c.high)) : null,
    low: displayCandles.length ? Math.min(...displayCandles.map(c => c.low)) : null,
    premium,
    proTools,
    plan,
  };

  if (premium && closes.length) {
    payload.insight = { ...(await getCachedInsight(key)) };
    // XAU's "insight" comes from the professional-signal bot, not our 1h
    // engine — no engine timeframe to label there.
    if (key !== 'XAUUSD') payload.insight.engineTimeframe = '1h';
  }

  if (proTools && closes.length) {
    payload.ema8 = emaSeries(closes, EMA_FAST_PERIOD);
    payload.ema21 = emaSeries(closes, EMA_SLOW_PERIOD);
    // Detected on whatever timeframe is actually being displayed (not the
    // fixed 1h engine data) so the overlay's points line up with the chart
    // the user is looking at — visual "prove it" layer, not a new signal.
    payload.patterns = detectPatterns(displayCandles).map(p => ({ ...p, label: PATTERN_LABEL[p.name] }));
  }

  res.json(payload);
});

// ---- Admin (protected by ADMIN_KEY) ----
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/admin/subscribers', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let subs = await store.listSubscribers();
  if (q) subs = subs.filter(s => s.email.toLowerCase().includes(q));
  res.json({ subscribers: subs.map(s => ({ ...s, plan: s.plan || null })) });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const subs = await store.listSubscribers();
  const now = new Date();
  const active = subs.filter(s => s.status === 'active' && s.expires_at && new Date(s.expires_at) > now);
  const expired = subs.filter(s => s.status === 'active' && (!s.expires_at || new Date(s.expires_at) <= now));
  const pending = subs.filter(s => s.status === 'pending');
  const inactive = subs.filter(s => s.status === 'inactive');

  const estimatedMRR = active.reduce((sum, s) => sum + (PLANS[s.plan]?.price ?? PLANS.premium.price), 0);
  const byPlan = {};
  for (const s of active) {
    const p = s.plan || 'premium';
    byPlan[p] = (byPlan[p] || 0) + 1;
  }

  const signals = await store.listSignals(1000);
  const perf = computePerformanceStats(signals);

  res.json({
    demoMode: DEMO_MODE,
    storageMode: store.mode,
    lastPollAt,
    serverStartedAt: SERVER_STARTED_AT,
    users: {
      total: subs.length,
      active: active.length,
      expired: expired.length,
      pending: pending.length,
      inactive: inactive.length,
      byPlan,
    },
    revenue: {
      priceLabel: PRICE_MONTHLY,
      estimatedMRR: Math.round(estimatedMRR * 100) / 100,
      note: 'Estimate = sum of each active subscriber\'s plan price. No real payment records are tracked yet (manual activation until a payment gateway is wired in).',
    },
    signals: perf,
    marketPerformance: Object.entries(perf.byInstrument).map(([key, s]) => ({
      key, label: LABELS[key], ...s,
      winRate: (s.wins + s.losses) ? Math.round((s.wins / (s.wins + s.losses)) * 1000) / 10 : null,
    })).sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1)),
  });
});

app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const days = Number(req.body?.days || 30);
  const plan = ['premium', 'pro', 'elite'].includes(req.body?.plan) ? req.body.plan : 'premium';
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, days, plan);
  sendMail(email, 'Your TradingAnalysis subscription is active', `Thanks for your payment — your ${PLANS[plan].label} access is now active for ${days} days. You can view your insights any time you're logged in.`);
  res.json({ ok: true, plan });
});

app.post('/api/admin/deactivate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.deactivate(email);
  res.json({ ok: true });
});

// ---- Expiry emails: warn 3 days out, notify once it lapses. Dedup sets are
// in-memory (reset on restart) — an acceptable MVP tradeoff since a missed
// or occasionally-repeated notification isn't harmful, unlike spamming.
const warnedExpiring = new Set();
const notifiedExpired = new Set();
async function checkExpiries() {
  const subs = await store.listSubscribers();
  const now = Date.now();
  for (const s of subs) {
    if (s.status !== 'active' || !s.expires_at) continue;
    const msLeft = new Date(s.expires_at).getTime() - now;
    const daysLeft = msLeft / (24 * 60 * 60 * 1000);
    if (daysLeft <= 3 && daysLeft > 0 && !warnedExpiring.has(s.email)) {
      warnedExpiring.add(s.email);
      sendMail(s.email, 'Your TradingAnalysis subscription expires soon', `Your subscription expires in ${Math.ceil(daysLeft)} day(s) on ${new Date(s.expires_at).toLocaleDateString()}. Renew via PayPal.me/IYTechnologies to keep your access.`);
    } else if (daysLeft <= 0 && !notifiedExpired.has(s.email)) {
      notifiedExpired.add(s.email);
      sendMail(s.email, 'Your TradingAnalysis access has expired', `Your subscription has expired. Renew any time via PayPal.me/IYTechnologies — your live dashboard stays free either way.`);
    }
  }
}

// ---- Startup ----
// Deliberately terse — this never describes what's actually gated behind
// ADMIN_KEY, on the off chance server logs are ever exposed somewhere they
// shouldn't be.
if (!DEMO_MODE && ADMIN_KEY === 'change-me-admin-key') {
  console.warn('[config] Set a real ADMIN_KEY env var.');
}

store.init()
  .then(() => pollAllAndStore())
  .then(() => {
    setInterval(pollAllAndStore, 10 * 60 * 1000); // every 10 minutes
    checkExpiries();
    setInterval(checkExpiries, 24 * 60 * 60 * 1000); // once a day
    app.listen(PORT, () => console.log(`tradinganalysis listening on ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
