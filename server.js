const express = require('express');
const cors = require('cors');
const { createMemoryStorage, createPgStorage } = require('./storage');
const { runEngine, buildSyntheticCandles } = require('./signals');

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
    console.log(`[poll] stored ${rows.length} price points + refreshed crypto candles @ ${new Date().toISOString()}`);
  } catch (e) {
    console.error('poll failed', e);
  }
}

const CRYPTO_KEYS = new Set(CRYPTO_INSTRUMENTS.map(c => c.key));

// Multi-strategy engine (signals.js, ported from BOTS/universal.py):
// - Crypto gets real 1h candles straight from the exchange.
// - FX/gold don't have a free real-time candle feed, so we bucket our own
//   10-minute price polls into synthetic hourly candles instead. Same engine
//   either way, just a lower-fidelity input for FX/gold until more history
//   builds up.
async function computeSignal(instrument) {
  let candles;
  if (CRYPTO_KEYS.has(instrument)) {
    candles = cryptoCandleCache[instrument] || [];
  } else {
    const recentFirst = await store.getHistory(instrument, 600);
    candles = buildSyntheticCandles(recentFirst.slice().reverse(), 6);
  }
  return runEngine(candles);
}

// ---- Routes ----
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ demoMode: DEMO_MODE, payLink: PAYPAL_LINK, price: PRICE_MONTHLY });
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
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, 30);
  res.json({ ok: true });
});

app.get('/api/insights', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });

  const sub = await store.getSubscriber(email);
  const active = sub && sub.status === 'active' && sub.expires_at && new Date(sub.expires_at) > new Date();

  if (!active) {
    return res.status(402).json({
      locked: true,
      payLink: PAYPAL_LINK,
      price: PRICE_MONTHLY,
      message: 'Subscribe to unlock buy/sell insights for all 12 tracked markets.',
    });
  }

  const signals = [];
  for (const key of ALL_KEYS) {
    const s = await computeSignal(key);
    signals.push({ key, label: LABELS[key], ...s });
  }
  res.json({ locked: false, expiresAt: sub.expires_at, signals });
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

app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const days = Number(req.body?.days || 30);
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.activate(email, days);
  res.json({ ok: true });
});

app.post('/api/admin/deactivate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await store.deactivate(email);
  res.json({ ok: true });
});

// ---- Startup ----
store.init()
  .then(() => pollAllAndStore())
  .then(() => {
    setInterval(pollAllAndStore, 10 * 60 * 1000); // every 10 minutes
    app.listen(PORT, () => console.log(`tradinganalysis listening on ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
