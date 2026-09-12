const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';
const PAYPAL_LINK = process.env.PAYPAL_LINK || 'https://paypal.me/IYTechnologies/45';
const PRICE_MONTHLY = process.env.PRICE_LABEL || 'R45/month';

// ---- DB ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id SERIAL PRIMARY KEY,
      instrument TEXT NOT NULL,
      price NUMERIC NOT NULL,
      polled_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_price_history_inst_time ON price_history (instrument, polled_at DESC);`);
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
  { key: 'TON_USDT', label: 'TON/USDT' },
];
const FX_INSTRUMENTS = [
  { key: 'GBPUSD', label: 'GBP/USD' },
  { key: 'XAUUSD', label: 'XAU/USD (Gold)' },
];
const ALL_KEYS = [...CRYPTO_INSTRUMENTS, ...FX_INSTRUMENTS].map(a => a.key);
const LABELS = Object.fromEntries([...CRYPTO_INSTRUMENTS, ...FX_INSTRUMENTS].map(a => [a.key, a.label]));

// In-memory cache of latest prices (fast reads for /api/prices)
let latestCache = {}; // key -> { price, changePct, updatedAt }

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
    if (rows.length) {
      const values = [];
      const params = [];
      rows.forEach((r, idx) => {
        params.push(r.instrument, r.price);
        values.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
      });
      await pool.query(
        `INSERT INTO price_history (instrument, price) VALUES ${values.join(',')}`,
        params
      );
    }
    console.log(`[poll] stored ${rows.length} price points @ ${new Date().toISOString()}`);
  } catch (e) {
    console.error('poll failed', e);
  }
}

// Simple SMA-crossover signal from our own stored history.
async function computeSignal(instrument) {
  const { rows } = await pool.query(
    `SELECT price FROM price_history WHERE instrument = $1 ORDER BY polled_at DESC LIMIT 20`,
    [instrument]
  );
  if (rows.length < 8) {
    return { signal: 'HOLD', note: 'Gathering data — check back in a few hours for a confident signal.' };
  }
  const prices = rows.map(r => parseFloat(r.price));
  const sma = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const short = sma(prices.slice(0, Math.min(5, prices.length)));
  const long = sma(prices);
  const diffPct = ((short - long) / long) * 100;
  let signal = 'HOLD';
  if (diffPct > 0.15) signal = 'BUY';
  else if (diffPct < -0.15) signal = 'SELL';
  return {
    signal,
    note: `Short-term avg is ${diffPct >= 0 ? 'above' : 'below'} the recent trend by ${Math.abs(diffPct).toFixed(2)}% (based on our own tracked price history, not financial advice).`,
  };
}

// ---- Routes ----
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/prices', (req, res) => {
  const assets = ALL_KEYS.map(key => ({
    key,
    label: LABELS[key],
    price: latestCache[key]?.price ?? null,
    changePct: latestCache[key]?.changePct ?? null,
    updatedAt: latestCache[key]?.updatedAt ?? null,
  }));
  res.json({ assets, payLink: PAYPAL_LINK, price: PRICE_MONTHLY });
});

app.post('/api/subscribe', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  await pool.query(
    `INSERT INTO subscribers (email, status) VALUES ($1, 'pending')
     ON CONFLICT (email) DO NOTHING`,
    [email]
  );
  res.json({
    ok: true,
    payLink: PAYPAL_LINK,
    price: PRICE_MONTHLY,
    instructions: `Pay ${PRICE_MONTHLY} via the link, then message us your payment reference with this email (${email}) so we can activate your access. Activation is manual for now — usually within a few hours.`,
  });
});

app.get('/api/insights', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });

  const { rows } = await pool.query(`SELECT * FROM subscribers WHERE email = $1`, [email]);
  const sub = rows[0];
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
  const { rows } = await pool.query(`SELECT email, status, expires_at, created_at FROM subscribers ORDER BY created_at DESC`);
  res.json({ subscribers: rows });
});

app.post('/api/admin/activate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const days = Number(req.body?.days || 30);
  if (!email) return res.status(400).json({ error: 'email required' });
  await pool.query(
    `INSERT INTO subscribers (email, status, expires_at) VALUES ($1, 'active', now() + ($2 || ' days')::interval)
     ON CONFLICT (email) DO UPDATE SET status = 'active', expires_at = now() + ($2 || ' days')::interval, updated_at = now()`,
    [email, days]
  );
  res.json({ ok: true });
});

app.post('/api/admin/deactivate', requireAdmin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  await pool.query(`UPDATE subscribers SET status = 'inactive', updated_at = now() WHERE email = $1`, [email]);
  res.json({ ok: true });
});

// ---- Startup ----
initDb()
  .then(() => pollAllAndStore())
  .then(() => {
    setInterval(pollAllAndStore, 10 * 60 * 1000); // every 10 minutes
    app.listen(PORT, () => console.log(`tradinganalysis listening on ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
