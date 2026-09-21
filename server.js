const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createMemoryStorage, createPgStorage } = require('./storage');
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
// Per-plan PayPal.me links: same handle, different amount per tier — mirrors
// the pattern already proven out on ResumeBuilderAI. PAYPAL_LINK stays as a
// back-compat override for the Premium price specifically (existing env var).
const PAYPAL_HANDLE = process.env.PAYPAL_HANDLE || 'IYTechnologies';
const PAYPAL_LINK = process.env.PAYPAL_LINK || `https://paypal.me/${PAYPAL_HANDLE}/${PLANS.premium.price}`;
const PRICE_MONTHLY = process.env.PRICE_LABEL || `R${PLANS.premium.price}/month`;
function payLinkFor(plan) { return `https://paypal.me/${PAYPAL_HANDLE}/${PLANS[plan]?.price ?? PLANS.premium.price}`; }
function priceLabelFor(plan) { return `R${PLANS[plan]?.price ?? PLANS.premium.price}/month`; }
const DEMO_MODE = !process.env.DATABASE_URL;

// ---- Storage: real Postgres if DATABASE_URL is set, else in-memory demo mode ----
let store;
if (DEMO_MODE) {
  console.log('[demo mode] no DATABASE_URL set — using in-memory storage, no real payments required.');
  store = createMemoryStorage();
} else {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  store = createPgStorage(pool);
}

// ---- Instruments ----
const CRYPTO_INSTRUMENTS = [
  { key: 'BTC_USDT', label: 'BTC/USDT' },
  { key: 'ETH_USDT', label: 'ETH/USDT' },
  { key: 'SOL_USDT', label: 'SOL/USDT' },
  { key: 'XRP_USDT', label: 'XRP/USDT' },
  { key: 'DOGE_USDT', label: 'DOGE/USDT' },
  { key: 'ADA_USDT', label: 'ADA/USDT' },
  { key: 'AVAX_USDT', label: 'AVAX/USDT' },
  { key: 'LINK_USDT', label: 'LINK/USDT' },
  { key: 'DOT_USDT', label: 'DOT/USDT' },
  { key: 'LTC_USDT', label: 'LTC/USDT' },
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
        open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), time: c.t,
      }));
    } catch (e) {
      console.error(`candlestick poll failed for ${key}`, e.message);
    }
  }
}

async function pollForex() {
  const rows = [];
  for (const fx of FX_INSTRUMENTS) {
    try {
      let price;
      if (fx.kind === 'metal') {
        // Works fine unauthenticated too — the key just gives more headroom
        // if gold-api.com ever rate-limits anonymous requests.
        const res = await fetch('https://api.gold-api.com/price/XAU', {
          headers: process.env.GOLD_API_KEY ? { 'x-api-key': process.env.GOLD_API_KEY } : {},
        });
        const json = await res.json();
        price = json?.price;
      } else {
        const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${fx.base}&symbols=${fx.quote}`);
        const json = await res.json();
        price = json?.rates?.[fx.quote];
      }
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
  return data.map(c => ({ open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c), time: c.t }));
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
async function computeSignal(instrument) {
  const candles = await getCandlesFor(instrument);
  return runEngine(candles);
}
async function getCachedInsight(instrument) {
  if (insightCache[instrument]) return insightCache[instrument];
  // Cold start (no poll has run yet) — compute once and cache it so the
  // very first request isn't left with nothing either.
  const result = await computeSignal(instrument);
  insightCache[instrument] = result;
  return result;
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
  const status = seen.has('TP4') ? 'closed' : slHitAt ? 'closed' : 'open';
  const outcome = seen.has('TP4') ? 'TP4' : slHitAt ? 'SL' : null;
  const closedAt = seen.has('TP4') ? (hitHistory.find(h => h.level === 'TP4')?.time ?? Date.now()) : slHitAt;

  return { hitHistory, bestLevel, status, outcome, closedAt: closedAt ? new Date(closedAt).toISOString() : null };
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
  const recipients = await getAlertRecipients();
  if (!recipients.length) return;
  const subject = `New ${sig.confidence}%-confidence setup: ${LABELS[sig.instrument] || sig.instrument} (${sig.side})`;
  const body = `${LABELS[sig.instrument] || sig.instrument} — ${sig.side} via ${sig.strategy}, confidence ${sig.confidence}/100.\nEntry: ${sig.entry}\nStop loss: ${sig.sl}\nTargets: ${sig.tp1}, ${sig.tp2}, ${sig.tp3}, ${sig.tp4}\n\nInformational only — conduct your own analysis before trading.`;
  for (const r of recipients) sendMail(r.email, subject, body);
}
async function alertLevelTouch(sig, newLevels) {
  if (!newLevels.length) return;
  const recipients = await getAlertRecipients();
  if (!recipients.length) return;
  const subject = `${LABELS[sig.instrument] || sig.instrument} touched ${newLevels.join(', ')}`;
  const body = `Your tracked setup on ${LABELS[sig.instrument] || sig.instrument} (${sig.side} via ${sig.strategy}) just touched: ${newLevels.join(', ')}.\n\nInformational only.`;
  for (const r of recipients) sendMail(r.email, subject, body);
}

// ---- Track record: logs each new setup the engine surfaces, and resolves
// open ones by walking real candle history every poll cycle. This is what
// lets /api/performance show an honest, non-cherry-picked history (wins AND
// losses), instead of just the live "current read".
async function trackSignals() {
  for (const key of ALL_KEYS) {
    let result;
    try { result = await computeSignal(key); insightCache[key] = result; } catch (e) { continue; }

    const openForKey = (await store.getOpenSignals()).filter(s => s.instrument === key);
    if (openForKey.length) {
      let candles;
      try { candles = await getCandlesFor(key); } catch (e) { candles = []; }
      for (const sig of openForKey) {
        if (!candles.length) continue;
        const resolved = resolveSignalFromCandles(sig, candles);
        const changed = JSON.stringify(resolved.hitHistory) !== JSON.stringify(sig.hit_history || [])
          || resolved.bestLevel !== sig.best_level || resolved.status !== sig.status;
        if (!changed) continue;
        const patch = { hit_history: resolved.hitHistory, best_level: resolved.bestLevel };
        if (resolved.status === 'closed') { patch.status = 'closed'; patch.outcome = resolved.outcome; patch.closed_at = resolved.closedAt; }

        const alertedLevels = new Set(sig.alerted_levels || []);
        const newlyHitLevels = resolved.hitHistory.map(h => h.level).filter(l => !alertedLevels.has(l));
        const newlyHitSL = resolved.status === 'closed' && resolved.outcome === 'SL' && !alertedLevels.has('SL');
        const touchLabels = [...newlyHitLevels, ...(newlyHitSL ? ['SL'] : [])];
        if (touchLabels.length) {
          await alertLevelTouch(sig, touchLabels);
          patch.alerted_levels = [...alertedLevels, ...touchLabels];
        }
        await store.updateSignalOutcome(sig.id, patch);
      }
    }

    if (result.signal !== 'HOLD' && result.levels) {
      const latest = await store.getLatestSignalFor(key);
      const sameOngoingSetup = latest && latest.status === 'open' && latest.side === result.signal && latest.strategy === result.strategy;
      if (!sameOngoingSetup) {
        if (latest && latest.status === 'open') {
          // Structure changed before this setup resolved — close it out as invalidated rather than leaving it dangling.
          await store.updateSignalOutcome(latest.id, { status: 'closed', outcome: 'INVALIDATED', closed_at: new Date().toISOString() });
        }
        const row = await store.logSignal({
          instrument: key, strategy: result.strategy, regime: result.regime, side: result.signal,
          entry: result.levels.entry, sl: result.levels.sl,
          tp1: result.levels.tp1, tp2: result.levels.tp2, tp3: result.levels.tp3, tp4: result.levels.tp4,
          confidence: result.confidence,
        });
        await alertNewSignal(row);
        await store.updateSignalOutcome(row.id, { alerted_new: true });
      }
    }
  }
}

function computePerformanceStats(rows) {
  const closed = rows.filter(r => r.status === 'closed');
  const wins = closed.filter(r => r.outcome === 'TP4').length;
  const losses = closed.filter(r => r.outcome === 'SL').length;
  const invalidated = closed.filter(r => r.outcome === 'INVALIDATED').length;
  const open = rows.filter(r => r.status === 'open').length;
  const decided = wins + losses;
  const winRate = decided ? Math.round((wins / decided) * 1000) / 10 : null;

  const byInstrument = {};
  for (const r of closed) {
    if (r.outcome !== 'TP4' && r.outcome !== 'SL') continue;
    byInstrument[r.instrument] = byInstrument[r.instrument] || { wins: 0, losses: 0 };
    byInstrument[r.instrument][r.outcome === 'TP4' ? 'wins' : 'losses']++;
  }
  return { total: rows.length, open, wins, losses, invalidated, winRate, byInstrument };
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

app.post('/api/auth/signup', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const existing = await store.getSubscriber(email);
  if (existing?.password_hash) return res.status(409).json({ error: 'An account already exists for this email — log in instead.' });

  await store.setPassword(email, hashPassword(password));
  const token = crypto.randomBytes(24).toString('hex');
  await store.createSession(token, email);
  const sub = await store.getSubscriber(email);
  sendMail(email, 'Welcome to TradingAnalysis', `Your account has been created. Live market data is free — subscribe any time for ${PRICE_MONTHLY} to unlock full insights.`);
  res.json({ ok: true, token, email, status: sub?.status || 'pending' });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const sub = await store.getSubscriber(email);
  if (!sub?.password_hash || !verifyPassword(password, sub.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  await store.createSession(token, email);
  res.json({ ok: true, token, email, status: sub.status });
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
  res.json({ email: req.authEmail, status: sub?.status || 'pending', expiresAt: sub?.expires_at || null, active, plan: planOf(sub), favourites: sub?.favourites || [] });
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
  const actionable = signals.filter(s => s.signal !== 'HOLD' && s.confidence != null);
  const topPick = actionable.length
    ? actionable.reduce((best, s) => (s.confidence > best.confidence ? s : best))
    : null;

  const payload = { locked: false, plan, expiresAt: sub.expires_at, signals, topPick, proTools, elite };

  if (proTools) {
    payload.favourites = sub.favourites || [];
    const stats = computePerformanceStats(await store.listSignals(500));
    payload.bestMarkets = Object.entries(stats.byInstrument)
      .map(([key, s]) => ({ key, label: LABELS[key], ...s, winRate: (s.wins + s.losses) ? Math.round((s.wins / (s.wins + s.losses)) * 1000) / 10 : null }))
      .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
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
  const stats = computePerformanceStats(rows); // aggregate stats stay public either way — that's the credibility number
  const recent = rows.slice(0, 50).map(r => {
    if (r.status === 'open' && !premium) {
      return { id: r.id, status: 'open', locked: true, created_at: r.created_at };
    }
    return { ...r, label: LABELS[r.instrument] };
  });

  const payload = { stats, recent, premium, plan };
  if (proTools) {
    payload.bestMarkets = Object.entries(stats.byInstrument)
      .map(([key, s]) => ({ key, label: LABELS[key], ...s, winRate: (s.wins + s.losses) ? Math.round((s.wins / (s.wins + s.losses)) * 1000) / 10 : null }))
      .sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
  }
  res.json(payload);
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
    payload.insight.engineTimeframe = '1h'; // so the UI can label it even when displaying a different timeframe
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
if (!DEMO_MODE && ADMIN_KEY === 'change-me-admin-key') {
  console.warn('[SECURITY WARNING] ADMIN_KEY is still the default value while running against a real database. Set a real ADMIN_KEY env var before selling access — anyone can currently activate/deactivate subscribers and read admin stats.');
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
