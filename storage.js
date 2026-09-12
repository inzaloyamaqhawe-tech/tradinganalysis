// Storage abstraction: uses Postgres when DATABASE_URL is set, otherwise
// falls back to a simple in-memory store so the app can run in "demo mode"
// with zero setup (no DB, no real payments).

// Kept generous so the multi-strategy engine (signals.js) has enough raw
// samples to bucket into synthetic candles for instruments without a real
// candle feed (FX/gold). At a 10-minute poll interval, 600 samples ≈ 4 days.
const HISTORY_LIMIT = 600;

function createMemoryStorage() {
  const subscribers = new Map(); // email -> { email, status, expires_at, created_at, password_hash }
  const history = new Map(); // instrument -> [{ price, polled_at }] most-recent-first
  const sessions = new Map(); // token -> email

  return {
    mode: 'memory',
    async init() {},

    async setPassword(email, passwordHash) {
      const existing = subscribers.get(email);
      if (existing) existing.password_hash = passwordHash;
      else subscribers.set(email, { email, status: 'pending', expires_at: null, created_at: new Date().toISOString(), password_hash: passwordHash });
    },

    async createSession(token, email) { sessions.set(token, email); },
    async getSessionEmail(token) { return sessions.get(token) || null; },
    async deleteSession(token) { sessions.delete(token); },

    async addPollBatch(rows) {
      const now = new Date().toISOString();
      for (const { instrument, price } of rows) {
        const arr = history.get(instrument) || [];
        arr.unshift({ price, polled_at: now });
        if (arr.length > HISTORY_LIMIT) arr.length = HISTORY_LIMIT;
        history.set(instrument, arr);
      }
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
    },

    async deactivate(email) {
      const s = subscribers.get(email);
      if (s) s.status = 'inactive';
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
