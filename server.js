const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createMemoryStorage, createPgStorage } = require('./storage');
const { runEngine, buildSyntheticCandles, emaSeries, EMA_FAST_PERIOD, EMA_SLOW_PERIOD } = require('./signals');
const { sendMail } = require('./mailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const PAYPAL_LINK = process.env.PAYPAL_LINK || 'https://paypal.me/IYTechnologies/45';
const PRICE_MONTHLY = process.env.PRICE_LABEL || 'R45/month';
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
const FX_INSTRUMENTS = [
  { key: 'GBPUSD', label: 'GBP/USD' },
  { key: 'XAUUSD', label: 'XAU/USD (Gold)' },
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
        open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c),
      }));
    } catch (e) {
      console.error(`candlestick poll failed for ${key}`, e.message);
    }
  }
}

async function pollForex() {
  const rows = [];
  try {
    const res = await fetch('https://api.frankfurter.dev/v1/latest?base=GBP&symbols=USD');
    const json = await res.json();
    const price = json?.rates?.USD;
    if (isFinite(price)) {
      const prev = latestCache['GBPUSD']?.price;
      const changePct = prev ? ((price - prev) / prev) * 100 : 0;
      latestCache['GBPUSD'] = { price, changePct, updatedAt: new Date().toISOString() };
      rows.push({ instrument: 'GBPUSD', price });
    }
  } catch (e) { console.error('GBPUSD poll failed', e.message); }

  try {
    const res = await fetch('https://api.gold-api.com/price/XAU');
    const json = await res.json();
    const price = json?.price;
    if (isFinite(price)) {
      const prev = latestCache['XAUUSD']?.price;
      const changePct = prev ? ((price - prev) / prev) * 100 : 0;
      latestCache['XAUUSD'] = { price, changePct, updatedAt: new Date().toISOString() };
      rows.push({ instrument: 'XAUUSD', price });
    }
  } catch (e) { console.error('XAUUSD poll failed', e.message); }

  return rows;
}

async function pollAllAndStore() {
  try {
    const cryptoRows = await pollCrypto();
    const fxRows = await pollForex();
    const rows = [...cryptoRows, ...fxRows];
    await store.addPollBatch(rows);
    await pollCryptoCandles();
    await trackSignals();
    lastPollAt = new Date().toISOString();
    console.log(`[poll] stored ${rows.length} price points + refreshed crypto candles + tracked signals @ ${lastPollAt}`);
  } catch (e) {
    console.error('poll failed', e);
  }
}

const CRYPTO_KEYS = new Set(CRYPTO_INSTRUMENTS.map(c => c.key));

// Shared candle retrieval — crypto gets real 1h candles straight from the
// exchange; FX/gold don't have a free real-time candle feed, so we bucket
// our own 10-minute price polls into synthetic hourly candles instead.
async function getCandlesFor(instrument) {
  if (CRYPTO_KEYS.has(instrument)) {
    return cryptoCandleCache[instrument] || [];
  }
  const recentFirst = await store.getHistory(instrument, 600);
  return buildSyntheticCandles(recentFirst.slice().reverse(), 6);
}

// Multi-strategy engine (signals.js, ported from BOTS/universal.py).
async function computeSignal(instrument) {
  const candles = await getCandlesFor(instrument);
  return runEngine(candles);
}

// ---- Track record: logs each new setup the engine surfaces, and resolves
// open ones against the latest price every poll cycle. This is what lets
// /api/performance show an honest, non-cherry-picked history (wins AND
// losses), instead of just the live "current read".
async function trackSignals() {
  for (const key of ALL_KEYS) {
    let result;
    try { result = await computeSignal(key); } catch (e) { continue; }
    const price = latestCache[key]?.price;

    if (price != null) {
      const openForKey = (await store.getOpenSignals()).filter(s => s.instrument === key);
      for (const sig of openForKey) {
        const dir = sig.side === 'BUY' ? 1 : -1;
        const levels = [['TP1', sig.tp1], ['TP2', sig.tp2], ['TP3', sig.tp3], ['TP4', sig.tp4]];
        let bestLevel = sig.best_level;
        for (const [label, lvl] of levels) {
          const reached = dir === 1 ? price >= lvl : price <= lvl;
          if (reached) bestLevel = label; // progressive — never regresses
        }
        const slHit = dir === 1 ? price <= sig.sl : price >= sig.sl;
        const patch = {};
        if (bestLevel !== sig.best_level) patch.best_level = bestLevel;
        if (bestLevel === 'TP4') { patch.status = 'closed'; patch.outcome = 'TP4'; patch.closed_at = new Date().toISOString(); }
        else if (slHit) { patch.status = 'closed'; patch.outcome = 'SL'; patch.closed_at = new Date().toISOString(); }
        if (Object.keys(patch).length) await store.updateSignalOutcome(sig.id, patch);
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
        await store.logSignal({
          instrument: key, strategy: result.strategy, regime: result.regime, side: result.signal,
          entry: result.levels.entry, sl: result.levels.sl,
          tp1: result.levels.tp1, tp2: result.levels.tp2, tp3: result.levels.tp3, tp4: result.levels.tp4,
          confidence: result.confidence,
        });
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
  res.json({ demoMode: DEMO_MODE, payLink: PAYPAL_LINK, price: PRICE_MONTHLY });
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
  res.json({ email: req.authEmail, status: sub?.status || 'pending', expiresAt: sub?.expires_at || null, active });
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
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  await store.upsertPending(email);
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    payLink: PAYPAL_LINK,
    price: PRICE_MONTHLY,
    instructions: DEMO_MODE
      ? `Demo mode: no real charge. Click "Simulate Payment" below to test what a subscriber sees.`
      : `Pay ${PRICE_MONTHLY} via the link, then message us your payment reference with this email (${email}) so we can activate your access. Activation is manual for now — usually within a few hours.`,
  });
});

// Demo-only: instantly activates a subscriber with no real payment, so the
// flow can be tested end-to-end before real payments/DB are wired in.
app.post('/api/demo/activate', async (req, res) => {
  if (!DEMO_MODE) return res.status(403).json({ error: 'Demo activation is disabled — real payments are live.' });
  const email = req.authEmail || String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, 30);
  sendMail(email, 'Your TradingAnalysis subscription is active (demo)', `This is a demo activation — no real payment was taken. Your access is active for 30 days.`);
  res.json({ ok: true });
});

app.get('/api/insights', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });

  const sub = await store.getSubscriber(email);
  const active = sub && sub.status === 'active' && sub.expires_at && new Date(sub.expires_at) > new Date();

  if (!active) {
    return res.status(402).json({
      locked: true,
      payLink: PAYPAL_LINK,
      price: PRICE_MONTHLY,
      message: 'Subscribe to unlock market-structure insights for all 12 tracked markets.',
    });
  }

  const signals = [];
  for (const key of ALL_KEYS) {
    const s = await computeSignal(key);
    signals.push({ key, label: LABELS[key], ...s });
  }

  // Surface the single strongest setup across all 12 markets, so a user
  // isn't left to guess which of 12 mixed-confidence reads to actually pay
  // attention to. Ties broken by which strategy fired (arbitrary but stable).
  const actionable = signals.filter(s => s.signal !== 'HOLD' && s.confidence != null);
  const topPick = actionable.length
    ? actionable.reduce((best, s) => (s.confidence > best.confidence ? s : best))
    : null;

  res.json({ locked: false, expiresAt: sub.expires_at, signals, topPick });
});

// Track record — public, on purpose: showing losses alongside wins is what
// makes the accuracy claim credible instead of marketing copy. BUT an
// "open" row is a live, still-actionable setup — showing its instrument +
// bias for free would just leak the paid signal through the back door, so
// only closed (resolved, no-longer-actionable) rows are ever shown in full
// to a non-premium visitor.
app.get('/api/performance', async (req, res) => {
  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  let premium = false;
  if (email) {
    const sub = await store.getSubscriber(email);
    premium = !!(sub && sub.status === 'active' && sub.expires_at && new Date(sub.expires_at) > new Date());
  }

  const rows = await store.listSignals(500);
  const stats = computePerformanceStats(rows); // aggregate stats stay public either way — that's the credibility number
  const recent = rows.slice(0, 50).map(r => {
    if (r.status === 'open' && !premium) {
      return { id: r.id, status: 'open', locked: true, created_at: r.created_at };
    }
    return { ...r, label: LABELS[r.instrument] };
  });
  res.json({ stats, recent, premium });
});

// Chart data for a single market: closes for everyone; EMA overlays +
// regime/strategy only for an active subscriber (checked by email).
app.get('/api/history', async (req, res) => {
  const key = String(req.query.key || '');
  if (!ALL_KEYS.includes(key)) return res.status(404).json({ error: 'unknown instrument' });

  const email = req.authEmail || String(req.query.email || '').trim().toLowerCase();
  let premium = false;
  if (email) {
    const sub = await store.getSubscriber(email);
    premium = !!(sub && sub.status === 'active' && sub.expires_at && new Date(sub.expires_at) > new Date());
  }

  const candles = await getCandlesFor(key);
  const closes = candles.map(c => c.close);
  const payload = {
    key,
    label: LABELS[key],
    candles, // full OHLC, for candlestick rendering
    closes,  // convenience array, for line rendering
    high: candles.length ? Math.max(...candles.map(c => c.high)) : null,
    low: candles.length ? Math.min(...candles.map(c => c.low)) : null,
    premium,
  };

  if (premium && closes.length) {
    payload.ema8 = emaSeries(closes, EMA_FAST_PERIOD);
    payload.ema21 = emaSeries(closes, EMA_SLOW_PERIOD);
    payload.insight = runEngine(candles);
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
  res.json({ subscribers: await store.listSubscribers() });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const subs = await store.listSubscribers();
  const now = new Date();
  const active = subs.filter(s => s.status === 'active' && s.expires_at && new Date(s.expires_at) > now);
  const expired = subs.filter(s => s.status === 'active' && (!s.expires_at || new Date(s.expires_at) <= now));
  const pending = subs.filter(s => s.status === 'pending');
  const inactive = subs.filter(s => s.status === 'inactive');
  const priceAmount = parseFloat(String(PRICE_MONTHLY).replace(/[^\d.]/g, '')) || 0;

  const signals = await store.listSignals(1000);

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
    },
    revenue: {
      priceLabel: PRICE_MONTHLY,
      estimatedMRR: Math.round(active.length * priceAmount * 100) / 100,
      note: 'Estimate = active subscribers × plan price. No real payment records are tracked yet (manual PayPal activation).',
    },
    signals: computePerformanceStats(signals),
  });
});

app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const days = Number(req.body?.days || 30);
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, days);
  sendMail(email, 'Your TradingAnalysis subscription is active', `Thanks for your payment — your access is now active for ${days} days. You can view your insights any time you're logged in.`);
  res.json({ ok: true });
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
