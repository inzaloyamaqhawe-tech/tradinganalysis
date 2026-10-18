const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PLANS } = require('./plans');

const BANK = Object.freeze({ bank: 'Capitec Bank', accountHolder: 'Inzalo Yamaqhawe Technologies', accountNumber: '2542120109', accountType: 'Entrepreneur', branchCode: '470010' });
const MAX_PROOF_BYTES = 2 * 1024 * 1024;
function proofType(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PROOF_BYTES) return null;
  if (bytes.subarray(0, 5).toString() === '%PDF-') return ['application/pdf', 'pdf'];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg'];
  return null;
}

// Private records share the application's database, never the public web directory.
function createBilling({ pool, mode, store, file = process.env.BILLING_DATA_FILE || path.join(__dirname, '.billing-data.json') }) {
  const memory = new Map();
  let queue = Promise.resolve();
  const keyFor = email => `proof:${email}`;
  const eventKey = key => `event:${crypto.createHash('sha256').update(key).digest('hex')}`;
  async function query(db, sql, args = []) {
    if (mode === 'postgres') {
      let i = 0;
      return (await db.query(sql.replace(/\?/g, () => `$${++i}`), args)).rows;
    }
    return (await db.query(sql, args))[0];
  }
  async function get(key, db = pool, lock = false) {
    if (!pool) return memory.get(key) || null;
    const rows = await query(db, `SELECT payload FROM billing_records WHERE record_key = ?${lock ? ' FOR UPDATE' : ''}`, [key]);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }
  async function put(key, value, db = pool) {
    if (!pool) { memory.set(key, value); return; }
    const tail = mode === 'postgres' ? 'ON CONFLICT (record_key) DO UPDATE SET payload = EXCLUDED.payload' : 'ON DUPLICATE KEY UPDATE payload = VALUES(payload)';
    await query(db, `INSERT INTO billing_records (record_key, payload) VALUES (?, ?) ${tail}`, [key, JSON.stringify(value)]);
  }
  async function all(prefix, metadataOnly = false) {
    if (!pool) return [...memory.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    const column = metadataOnly ? (mode === 'postgres' ? "(payload::jsonb - 'data')::text" : "JSON_REMOVE(payload, '$.data')") : 'payload';
    return (await query(pool, `SELECT ${column} AS payload FROM billing_records WHERE record_key LIKE ?`, [`${prefix}%`])).map(r => typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload);
  }
  async function atomic(work) {
    const run = async () => {
      const db = pool ? (mode === 'postgres' ? await pool.connect() : await pool.getConnection()) : null;
      const snapshot = !pool ? new Map(memory) : null;
      try {
        if (db) await query(db, 'BEGIN');
        const value = await work(db);
        if (db) await query(db, 'COMMIT');
        else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(`${file}.tmp`, JSON.stringify([...memory]));
          fs.renameSync(`${file}.tmp`, file);
        }
        return value;
      } catch (e) {
        if (db) await query(db, 'ROLLBACK');
        else { memory.clear(); for (const [k, v] of snapshot) memory.set(k, v); }
        throw e;
      } finally { if (db) db.release(); }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }
  async function event(email, title, body, unique, db) {
    const key = eventKey(unique);
    if (await get(key, db)) return;
    await put(key, { id: key, email, title, body, type: 'subscription', read: false, created_at: new Date().toISOString() }, db);
  }
  function metadata(row) {
    if (!row) return null;
    const { data, ...meta } = row;
    return meta;
  }
  return {
    async init() {
      if (pool) await query(pool, `CREATE TABLE IF NOT EXISTS billing_records (record_key VARCHAR(320) PRIMARY KEY, payload ${mode === 'postgres' ? 'TEXT' : 'LONGTEXT'} NOT NULL)`);
      else if (fs.existsSync(file)) for (const [k, v] of JSON.parse(fs.readFileSync(file, 'utf8'))) memory.set(k, v);
    },
    metadata,
    getProof: email => get(keyFor(email)),
    async listProofs() { return (await all('proof:', true)).map(metadata).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)); },
    async upload(sub, plan, bytes) {
      const type = proofType(bytes);
      if (!type) throw new Error('Upload a PDF, PNG or JPEG, up to 2 MB.');
      return atomic(async db => {
        const row = { email: sub.email, firstName: sub.first_name || '', lastName: sub.last_name || '', username: sub.username,
          reference: sub.username, plan, amount: PLANS[plan].price, currency: 'ZAR', version: crypto.randomUUID(), uploadedAt: new Date().toISOString(), status: 'pending',
          mime: type[0], filename: `payment-proof.${type[1]}`, size: bytes.length, data: bytes.toString('base64') };
        await put(keyFor(sub.email), row, db);
        return metadata(row);
      });
    },
    async approve(email, version) {
      return atomic(async db => {
        const key = keyFor(email);
        const proof = await get(key, db, true);
        if (!proof || proof.version !== version || proof.status !== 'pending') throw new Error('This proof has changed or has already been reviewed. Refresh the table.');
        let sub;
        if (db) sub = (await query(db, `SELECT * FROM ${mode === 'postgres' ? 'subscribers' : 'users'} WHERE email = ? FOR UPDATE`, [email]))[0];
        else sub = await store.getSubscriber(email);
        if (!sub) throw new Error('Account no longer exists.');
        const expiresAt = new Date(Math.max(Date.now(), sub.status === 'active' ? new Date(sub.expires_at || 0).getTime() : 0) + 30 * 86400000).toISOString();
        if (db) await query(db, `UPDATE ${mode === 'postgres' ? 'subscribers' : 'users'} SET status = 'active', plan = ?, expires_at = ? WHERE email = ?`, [proof.plan, mode === 'postgres' ? expiresAt : expiresAt.slice(0, 19).replace('T', ' '), email]);
        else await store.activate(email, (new Date(expiresAt) - Date.now()) / 86400000, proof.plan);
        await put(key, { ...proof, status: 'approved', reviewedAt: new Date().toISOString(), expiresAt }, db);
        await event(email, 'Your subscription is active', `Your ${PLANS[proof.plan].label} subscription is active. Expiry: ${expiresAt}.`, `activation:${proof.version}`, db);
        return { expiresAt, plan: proof.plan };
      });
    },
    async reject(email, version) {
      return atomic(async db => {
        const row = await get(keyFor(email), db, true);
        if (!row || row.version !== version || row.status !== 'pending') throw new Error('This proof has changed or has already been reviewed.');
        await put(keyFor(email), { ...row, status: 'rejected', reviewedAt: new Date().toISOString() }, db);
        await event(email, 'Payment needs attention', 'Your proof could not be verified. Please contact support or upload a corrected proof of payment.', `rejected:${version}`, db);
      });
    },
    async notify(email, title, body, unique) { return atomic(db => event(email, title, body, unique, db)); },
    async notifications(email) { return (await all('event:')).filter(n => n.email === email).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
    async markRead(email, id = null) {
      return atomic(async db => {
        for (const row of await all('event:')) if (row.email === email && (!id || row.id === id)) await put(row.id, { ...row, read: true }, db);
      });
    },
  };
}
module.exports = { createBilling, BANK, proofType, MAX_PROOF_BYTES };
