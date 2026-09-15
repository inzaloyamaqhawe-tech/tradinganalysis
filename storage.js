// Storage abstraction: uses Postgres when DATABASE_URL is set, otherwise
// falls back to a simple in-memory store so the app can run in "demo mode"
// with zero setup (no DB, no real payments).

const fs = require('fs');
const path = require('path');

// Kept generous so the multi-strategy engine (signals.js) has enough raw
// samples to bucket into synthetic candles for instruments without a real
// candle feed (FX/gold). At a 10-minute poll interval, 600 samples ≈ 4 days.
const HISTORY_LIMIT = 600;

function createMemoryStorage() {
  const subscribers = new Map(); // email -> { email, status, expires_at, created_at, password_hash }
  const history = new Map(); // instrument -> [{ price, polled_at }] most-recent-first
  const sessions = new Map(); // token -> email
  const signalLog = []; // { id, instrument, strategy, regime, side, entry, sl, tp1-4, confidence, status, outcome, best_level, created_at, closed_at }
  let signalLogSeq = 1;

  // Persist accounts/sessions/signal history to a local JSON file so a
  // simple process restart (idle spin-down/wake, a crash) doesn't force
  // everyone to re-register. This does NOT survive a fresh deploy (a new
  // container has no disk history) — only Postgres/a real DB survives that.
  const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.demo-data.json');
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
          subscribers: [...subscribers.entries()],
          sessions: [...sessions.entries()],
          signalLog,
          signalLogSeq,
          history: [...history.entries()],
        }));
      } catch (e) { console.error('[storage] persist failed (non-fatal):', e.message); }
    }, 200);
  }
  function load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      (data.subscribers || []).forEach(([k, v]) => subscribers.set(k, v));
      (data.sessions || []).forEach(([k, v]) => sessions.set(k, v));
      (data.signalLog || []).forEach(row => signalLog.push(row));
      signalLogSeq = data.signalLogSeq || 1;
      (data.history || []).forEach(([k, v]) => history.set(k, v));
      console.log(`[storage] restored ${subscribers.size} account(s), ${sessions.size} session(s), ${[...history.values()].reduce((n, a) => n + a.length, 0)} price point(s) from ${DATA_FILE}`);
    } catch (e) { console.error('[storage] load failed (non-fatal):', e.message); }
  }

  return {
    mode: 'memory',
    async init() { load(); },

    async setPassword(email, passwordHash) {
      const existing = subscribers.get(email);
      if (existing) existing.password_hash = passwordHash;
      else subscribers.set(email, { email, status: 'pending', expires_at: null, created_at: new Date().toISOString(), password_hash: passwordHash });
      scheduleSave();
    },

    async createSession(token, email) { sessions.set(token, email); scheduleSave(); },
    async getSessionEmail(token) { return sessions.get(token) || null; },
    async deleteSession(token) { sessions.delete(token); scheduleSave(); },

    async logSignal(rec) {
      const row = { id: signalLogSeq++, status: 'open', outcome: null, best_level: null, closed_at: null, created_at: new Date().toISOString(), ...rec };
      signalLog.push(row);
      scheduleSave();
      return row;
    },
    async getOpenSignals() { return signalLog.filter(s => s.status === 'open'); },
    async getLatestSignalFor(instrument) {
      for (let i = signalLog.length - 1; i >= 0; i--) if (signalLog[i].instrument === instrument) return signalLog[i];
      return null;
    },
    async updateSignalOutcome(id, patch) {
      const row = signalLog.find(s => s.id === id);
      if (row) { Object.assign(row, patch); scheduleSave(); }
    },
    async listSignals(limit = 200) {
      return signalLog.slice(-limit).reverse();
    },

    async addPollBatch(rows) {
      const now = new Date().toISOString();
      for (const { instrument, price } of rows) {
        const arr = history.get(instrument) || [];
        arr.unshift({ price, polled_at: now });
        if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT;
        history.set(instrument, arr);
      }
      scheduleSave();
    },

    async getHistory(instrument, limit = HISTORY_LIMIT) {
      return (history.get(instrument) || []).slice(0, limit).map(r => r.price);
    },

    async getSubscriber(email) {
      return subscribers.get(email) || null;
    },

    async upsertPending(email) {
      if (!subscribers.has(email)) {
        subscribers.set(email, { email, status: 'pending', expires_at: null, created_at: new Date().toISOString() });
        scheduleSave();
      }
    },

    async activate(email, days) {
      const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const existing = subscribers.get(email);
      subscribers.set(email, {
        ...existing,
        email,
        status: 'active',
        expires_at: expires,
        created_at: existing?.created_at || new Date().toISOString(),
      });
      scheduleSave();
    },

    async deactivate(email) {
      const s = subscribers.get(email);
      if (s) { s.status = 'inactive'; scheduleSave(); }
    },

    async listSubscribers() {
      return [...subscribers.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },
  };
}

function createPgStorage(pool) {
  return {
    mode: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS subscribers (
          email TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          password_hash TEXT
        );
      `);
      // Safe no-op if the column already exists — lets an existing deployed
      // DB pick up account support without a manual migration.
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS price_history (
          id SERIAL PRIMARY KEY,
          instrument TEXT NOT NULL,
          price NUMERIC NOT NULL,
          polled_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_price_history_inst_time ON price_history (instrument, polled_at DESC);`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS signal_log (
          id SERIAL PRIMARY KEY,
          instrument TEXT NOT NULL,
          strategy TEXT,
          regime TEXT,
          side TEXT NOT NULL,
          entry NUMERIC, sl NUMERIC, tp1 NUMERIC, tp2 NUMERIC, tp3 NUMERIC, tp4 NUMERIC,
          confidence INTEGER,
          status TEXT NOT NULL DEFAULT 'open',
          outcome TEXT,
          best_level TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          closed_at TIMESTAMPTZ
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_signal_log_status ON signal_log (status);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_signal_log_instrument ON signal_log (instrument, created_at DESC);`);
    },

    async logSignal(rec) {
      const { rows } = await pool.query(
        `INSERT INTO signal_log (instrument, strategy, regime, side, entry, sl, tp1, tp2, tp3, tp4, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [rec.instrument, rec.strategy, rec.regime, rec.side, rec.entry, rec.sl, rec.tp1, rec.tp2, rec.tp3, rec.tp4, rec.confidence]
      );
      return rows[0];
    },
    async getOpenSignals() {
      const { rows } = await pool.query(`SELECT * FROM signal_log WHERE status = 'open'`);
      return rows;
    },
    async getLatestSignalFor(instrument) {
      const { rows } = await pool.query(`SELECT * FROM signal_log WHERE instrument = $1 ORDER BY created_at DESC LIMIT 1`, [instrument]);
      return rows[0] || null;
    },
    async updateSignalOutcome(id, patch) {
      const fields = Object.keys(patch);
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE signal_log SET ${sets} WHERE id = $1`, [id, ...fields.map(f => patch[f])]);
    },
    async listSignals(limit = 200) {
      const { rows } = await pool.query(`SELECT * FROM signal_log ORDER BY created_at DESC LIMIT $1`, [limit]);
      return rows;
    },

    async setPassword(email, passwordHash) {
      await pool.query(
        `INSERT INTO subscribers (email, status, password_hash) VALUES ($1, 'pending', $2)
         ON CONFLICT (email) DO UPDATE SET password_hash = $2, updated_at = now()`,
        [email, passwordHash]
      );
    },

    async createSession(token, email) {
      await pool.query(`INSERT INTO sessions (token, email) VALUES ($1, $2)`, [token, email]);
    },
    async getSessionEmail(token) {
      const { rows } = await pool.query(`SELECT email FROM sessions WHERE token = $1`, [token]);
      return rows[0]?.email || null;
    },
    async deleteSession(token) {
      await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    },

    async addPollBatch(rows) {
      if (!rows.length) return;
      const values = [];
      const params = [];
      rows.forEach((r, idx) => {
        params.push(r.instrument, r.price);
        values.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
      });
      await pool.query(`INSERT INTO price_history (instrument, price) VALUES ${values.join(',')}`, params);
    },

    async getHistory(instrument, limit = HISTORY_LIMIT) {
      const { rows } = await pool.query(
        `SELECT price FROM price_history WHERE instrument = $1 ORDER BY polled_at DESC LIMIT $2`,
        [instrument, limit]
      );
      return rows.map(r => parseFloat(r.price));
    },

    async getSubscriber(email) {
      const { rows } = await pool.query(`SELECT * FROM subscribers WHERE email = $1`, [email]);
      return rows[0] || null;
    },

    async upsertPending(email) {
      await pool.query(
        `INSERT INTO subscribers (email, status) VALUES ($1, 'pending') ON CONFLICT (email) DO NOTHING`,
        [email]
      );
    },

    async activate(email, days) {
      await pool.query(
        `INSERT INTO subscribers (email, status, expires_at) VALUES ($1, 'active', now() + ($2 || ' days')::interval)
         ON CONFLICT (email) DO UPDATE SET status = 'active', expires_at = now() + ($2 || ' days')::interval, updated_at = now()`,
        [email, days]
      );
    },

    async deactivate(email) {
      await pool.query(`UPDATE subscribers SET status = 'inactive', updated_at = now() WHERE email = $1`, [email]);
    },

    async listSubscribers() {
      const { rows } = await pool.query(`SELECT email, status, expires_at, created_at FROM subscribers ORDER BY created_at DESC`);
      return rows;
    },
  };
}

module.exports = { createMemoryStorage, createPgStorage };
