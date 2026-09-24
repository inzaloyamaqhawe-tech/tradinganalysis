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
  const subscribers = new Map(); // email -> { email, status, plan, expires_at, created_at, password_hash, favourites }
  const history = new Map(); // instrument -> [{ price, polled_at }] most-recent-first
  const sessions = new Map(); // token -> email
  const signalLog = []; // { id, instrument, strategy, regime, side, entry, sl, tp1-4, confidence, status, outcome, best_level, created_at, closed_at, alerted_new, alerted_levels }
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

    async setPassword(email, passwordHash, profile = {}) {
      const existing = subscribers.get(email);
      if (existing) {
        existing.password_hash = passwordHash;
        if (profile.firstName) existing.first_name = profile.firstName;
        if (profile.lastName) existing.last_name = profile.lastName;
        if (profile.username) existing.username = profile.username;
      } else {
        subscribers.set(email, {
          email, status: 'pending', plan: null, expires_at: null, created_at: new Date().toISOString(),
          password_hash: passwordHash, favourites: [], is_admin: false,
          first_name: profile.firstName || '', last_name: profile.lastName || '', username: profile.username || '',
        });
      }
      scheduleSave();
    },

    async createSession(token, email) { sessions.set(token, email); scheduleSave(); },
    async getSessionEmail(token) { return sessions.get(token) || null; },
    async deleteSession(token) { sessions.delete(token); scheduleSave(); },

    async logSignal(rec) {
      const row = { id: signalLogSeq++, status: 'open', outcome: null, best_level: null, hit_history: [], closed_at: null, alerted_new: false, alerted_levels: [], created_at: new Date().toISOString(), ...rec };
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
      return (history.get(instrument) || []).slice(0, limit).map(r => ({ price: r.price, time: new Date(r.polled_at).getTime() }));
    },

    async getSubscriber(email) {
      return subscribers.get(email) || null;
    },

    async upsertPending(email) {
      if (!subscribers.has(email)) {
        subscribers.set(email, { email, status: 'pending', plan: null, expires_at: null, created_at: new Date().toISOString(), favourites: [] });
        scheduleSave();
      }
    },

    async activate(email, days, plan = 'premium') {
      const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const existing = subscribers.get(email);
      subscribers.set(email, {
        ...existing,
        email,
        status: 'active',
        plan,
        expires_at: expires,
        created_at: existing?.created_at || new Date().toISOString(),
        favourites: existing?.favourites || [],
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

    async setFavourites(email, favourites) {
      const s = subscribers.get(email);
      if (s) { s.favourites = favourites; scheduleSave(); }
    },

    async isUsernameTaken(username, excludeEmail = null) {
      for (const s of subscribers.values()) {
        if (s.username && s.username.toLowerCase() === username.toLowerCase() && s.email !== excludeEmail) return true;
      }
      return false;
    },

    async setAdmin(email, plan, expiresAt) {
      const existing = subscribers.get(email);
      subscribers.set(email, { ...existing, email, is_admin: true, plan, status: 'active', expires_at: expiresAt });
      scheduleSave();
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
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS plan TEXT;`);
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS favourites JSONB NOT NULL DEFAULT '[]'::jsonb;`);
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS first_name TEXT;`);
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS last_name TEXT;`);
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS username TEXT;`);
      await pool.query(`ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_subscribers_username ON subscribers (LOWER(username)) WHERE username IS NOT NULL;`);
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
          hit_history JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          closed_at TIMESTAMPTZ
        );
      `);
      // Safe no-op if the column already exists — picks up hit-history
      // tracking on an existing deployed DB with no manual migration.
      await pool.query(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS hit_history JSONB NOT NULL DEFAULT '[]'::jsonb;`);
      await pool.query(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS alerted_new BOOLEAN NOT NULL DEFAULT false;`);
      await pool.query(`ALTER TABLE signal_log ADD COLUMN IF NOT EXISTS alerted_levels JSONB NOT NULL DEFAULT '[]'::jsonb;`);
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
      // jsonb columns need the JS array/object serialized before it hits the wire.
      const values = fields.map(f => ((f === 'hit_history' || f === 'alerted_levels') ? JSON.stringify(patch[f]) : patch[f]));
      await pool.query(`UPDATE signal_log SET ${sets} WHERE id = $1`, [id, ...values]);
    },
    async listSignals(limit = 200) {
      const { rows } = await pool.query(`SELECT * FROM signal_log ORDER BY created_at DESC LIMIT $1`, [limit]);
      return rows;
    },

    async setPassword(email, passwordHash, profile = {}) {
      await pool.query(
        `INSERT INTO subscribers (email, status, password_hash, first_name, last_name, username)
         VALUES ($1, 'pending', $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET password_hash = $2,
           first_name = COALESCE($3, subscribers.first_name), last_name = COALESCE($4, subscribers.last_name),
           username = COALESCE($5, subscribers.username), updated_at = now()`,
        [email, passwordHash, profile.firstName || null, profile.lastName || null, profile.username || null]
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
        `SELECT price, polled_at FROM price_history WHERE instrument = $1 ORDER BY polled_at DESC LIMIT $2`,
        [instrument, limit]
      );
      return rows.map(r => ({ price: parseFloat(r.price), time: new Date(r.polled_at).getTime() }));
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

    async activate(email, days, plan = 'premium') {
      await pool.query(
        `INSERT INTO subscribers (email, status, plan, expires_at) VALUES ($1, 'active', $3, now() + ($2 || ' days')::interval)
         ON CONFLICT (email) DO UPDATE SET status = 'active', plan = $3, expires_at = now() + ($2 || ' days')::interval, updated_at = now()`,
        [email, days, plan]
      );
    },

    async deactivate(email) {
      await pool.query(`UPDATE subscribers SET status = 'inactive', updated_at = now() WHERE email = $1`, [email]);
    },

    async listSubscribers() {
      const { rows } = await pool.query(`SELECT email, status, plan, expires_at, created_at FROM subscribers ORDER BY created_at DESC`);
      return rows;
    },

    async setFavourites(email, favourites) {
      await pool.query(`UPDATE subscribers SET favourites = $2, updated_at = now() WHERE email = $1`, [email, JSON.stringify(favourites)]);
    },

    async isUsernameTaken(username, excludeEmail = null) {
      const { rows } = await pool.query(
        `SELECT 1 FROM subscribers WHERE LOWER(username) = LOWER($1) AND email IS DISTINCT FROM $2 LIMIT 1`,
        [username, excludeEmail]
      );
      return rows.length > 0;
    },

    async setAdmin(email, plan, expiresAt) {
      await pool.query(
        `INSERT INTO subscribers (email, status, plan, expires_at, is_admin) VALUES ($1, 'active', $2, $3, true)
         ON CONFLICT (email) DO UPDATE SET status = 'active', plan = $2, expires_at = $3, is_admin = true, updated_at = now()`,
        [email, plan, expiresAt]
      );
    },
  };
}

// MySQL (Xneelo hosting, shared with the PHP admin panel and the
// Telegram signal bot — see sql/schema.sql and sql/BOT_INSTRUCTIONS.md for
// the table contract). `pool` is a mysql2/promise Pool. This app never
// creates the schema here — schema.sql is the single source of truth,
// applied once by hand (or by the PHP admin's own migration step) so the
// bot's own posts can never race a table that doesn't exist yet.
function jsonOrNull(v) { return v == null ? null : JSON.stringify(v); }
function parseJsonCol(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v; // mysql2 may already have parsed a JSON column
  try { return JSON.parse(v); } catch (e) { return fallback; }
}
function toMysqlDatetime(d) {
  return new Date(d).toISOString().slice(0, 19).replace('T', ' ');
}
function mapUserRow(row) {
  if (!row) return null;
  return {
    ...row,
    favourites: parseJsonCol(row.favourites, []),
    is_admin: !!row.is_admin,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}
function numOrNull(v) { return v == null ? null : parseFloat(v); }
function mapSignalRow(row) {
  if (!row) return null;
  return {
    ...row,
    // mysql2 returns DECIMAL columns as strings (to avoid float precision
    // loss on the wire) — every other storage backend and every caller
    // downstream expects numbers here, so parse them back explicitly.
    entry: numOrNull(row.entry), sl: numOrNull(row.sl),
    tp1: numOrNull(row.tp1), tp2: numOrNull(row.tp2), tp3: numOrNull(row.tp3), tp4: numOrNull(row.tp4),
    hit_history: parseJsonCol(row.hit_history, []),
    alerted_levels: parseJsonCol(row.alerted_levels, []),
    alerted_new: !!row.alerted_new,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    closed_at: row.closed_at ? new Date(row.closed_at).toISOString() : null,
  };
}

function createMysqlStorage(pool) {
  return {
    mode: 'mysql',
    async init() {
      // Schema is applied via sql/schema.sql, not here — just confirm we can reach it.
      await pool.query('SELECT 1');
    },

    async logSignal(rec) {
      const [result] = await pool.execute(
        `INSERT INTO signals (source, instrument, strategy, regime, side, entry, sl, tp1, tp2, tp3, tp4, confidence, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open')`,
        [rec.source || 'system', rec.instrument, rec.strategy || null, rec.regime || null, rec.side,
          rec.entry ?? null, rec.sl ?? null, rec.tp1 ?? null, rec.tp2 ?? null, rec.tp3 ?? null, rec.tp4 ?? null, rec.confidence ?? null]
      );
      const [rows] = await pool.execute(`SELECT * FROM signals WHERE id = ?`, [result.insertId]);
      return mapSignalRow(rows[0]);
    },
    async getOpenSignals() {
      const [rows] = await pool.query(`SELECT * FROM signals WHERE status = 'open'`);
      return rows.map(mapSignalRow);
    },
    async getLatestSignalFor(instrument) {
      const [rows] = await pool.execute(`SELECT * FROM signals WHERE instrument = ? ORDER BY created_at DESC LIMIT 1`, [instrument]);
      return mapSignalRow(rows[0]) || null;
    },
    async updateSignalOutcome(id, patch) {
      const fields = Object.keys(patch);
      if (!fields.length) return;
      const sets = fields.map(f => `${f} = ?`).join(', ');
      const values = fields.map(f => ((f === 'hit_history' || f === 'alerted_levels') ? jsonOrNull(patch[f]) : patch[f]));
      await pool.execute(`UPDATE signals SET ${sets} WHERE id = ?`, [...values, id]);
    },
    async listSignals(limit = 200) {
      const [rows] = await pool.execute(`SELECT * FROM signals ORDER BY created_at DESC LIMIT ?`, [limit]);
      return rows.map(mapSignalRow);
    },

    async setPassword(email, passwordHash, profile = {}) {
      await pool.execute(
        `INSERT INTO users (email, status, password_hash, first_name, last_name, username)
         VALUES (?, 'pending', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
           first_name = COALESCE(VALUES(first_name), first_name), last_name = COALESCE(VALUES(last_name), last_name),
           username = COALESCE(VALUES(username), username)`,
        [email, passwordHash, profile.firstName || null, profile.lastName || null, profile.username || null]
      );
    },

    async createSession(token, email) {
      const [rows] = await pool.execute(`SELECT id FROM users WHERE email = ?`, [email]);
      if (!rows[0]) throw new Error(`createSession: no user for ${email}`);
      await pool.execute(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`, [token, rows[0].id]);
    },
    async getSessionEmail(token) {
      const [rows] = await pool.execute(
        `SELECT u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]
      );
      return rows[0]?.email || null;
    },
    async deleteSession(token) {
      await pool.execute(`DELETE FROM sessions WHERE token = ?`, [token]);
    },

    async addPollBatch(rows) {
      if (!rows.length) return;
      const values = [];
      const placeholders = rows.map(r => { values.push(r.instrument, r.price); return '(?, ?)'; }).join(',');
      await pool.query(`INSERT INTO price_history (instrument, price) VALUES ${placeholders}`, values);
    },

    async getHistory(instrument, limit = HISTORY_LIMIT) {
      const [rows] = await pool.execute(
        `SELECT price, polled_at FROM price_history WHERE instrument = ? ORDER BY polled_at DESC LIMIT ?`,
        [instrument, limit]
      );
      return rows.map(r => ({ price: parseFloat(r.price), time: new Date(r.polled_at).getTime() }));
    },

    async getSubscriber(email) {
      const [rows] = await pool.execute(`SELECT * FROM users WHERE email = ?`, [email]);
      return mapUserRow(rows[0]);
    },

    async upsertPending(email) {
      await pool.execute(
        `INSERT INTO users (email, status) VALUES (?, 'pending') ON DUPLICATE KEY UPDATE email = email`,
        [email]
      );
    },

    async activate(email, days, plan = 'premium') {
      const expires = toMysqlDatetime(Date.now() + days * 24 * 60 * 60 * 1000);
      await pool.execute(
        `UPDATE users SET status = 'active', plan = ?, expires_at = ? WHERE email = ?`,
        [plan, expires, email]
      );
    },

    async deactivate(email) {
      await pool.execute(`UPDATE users SET status = 'inactive' WHERE email = ?`, [email]);
    },

    async listSubscribers() {
      const [rows] = await pool.query(`SELECT * FROM users ORDER BY created_at DESC`);
      return rows.map(mapUserRow);
    },

    async setFavourites(email, favourites) {
      await pool.execute(`UPDATE users SET favourites = ? WHERE email = ?`, [jsonOrNull(favourites), email]);
    },

    async isUsernameTaken(username, excludeEmail = null) {
      const [rows] = await pool.execute(
        `SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) AND email <> ? LIMIT 1`,
        [username, excludeEmail || '']
      );
      return rows.length > 0;
    },

    async setAdmin(email, plan, expiresAt) {
      await pool.execute(
        `UPDATE users SET plan = ?, status = 'active', expires_at = ?, is_admin = 1 WHERE email = ?`,
        [plan, toMysqlDatetime(expiresAt), email]
      );
    },
  };
}

module.exports = { createMemoryStorage, createPgStorage, createMysqlStorage };
