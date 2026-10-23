const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SESSION_TTL_MS } = require('../session');

test('cookie sessions survive reloads, expire seven hours after login and support logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-sessions-'));
  for (const name of ['DB_HOST', 'MYSQL_HOST', 'DATABASE_URL', 'SMTP_HOST']) delete process.env[name];
  process.env.DATA_FILE = path.join(dir, 'accounts.json');
  process.env.BILLING_DATA_FILE = path.join(dir, 'billing.json');
  const { app, store, billing } = require('../server');
  await store.init(); await billing.init();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realNow = Date.now;
  const signup = { firstName: 'Session', lastName: 'Test', username: 'sessiontest', email: 'session@example.test', password: 'session-test-password', confirmPassword: 'session-test-password' };
  try {
    const registered = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify(signup) });
    assert.equal(registered.status, 200);
    const header = registered.headers.get('set-cookie');
    assert.match(header, /Max-Age=25200/); assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Lax/); assert.match(header, /Secure/);
    const cookie = header.split(';')[0];
    const identity = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal(identity.status, 200); assert.equal((await identity.json()).username, signup.username);
    assert.equal(identity.headers.get('set-cookie'), null); // Reading a session never renews its lifetime.
    await new Promise(resolve => setTimeout(resolve, 250));
    const restored = require('../storage').createMemoryStorage(); await restored.init();
    assert.equal(await restored.getSessionEmail(cookie.split('=')[1]), signup.email);
    const denied = await fetch(`${base}/api/account/username`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://another-site.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'changed' }) });
    assert.equal(denied.status, 403);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: signup.email, password: signup.password }) });
    assert.equal(login.status, 200);
    const loggedInAt = realNow();
    const loginCookie = login.headers.get('set-cookie').split(';')[0];
    const { token } = await login.json();
    Date.now = () => loggedInAt + SESSION_TTL_MS - 60000;
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: loginCookie } })).status, 200);
    Date.now = () => loggedInAt + SESSION_TTL_MS + 1000;
    const expired = await fetch(`${base}/api/auth/me`, { headers: { Cookie: loginCookie } });
    assert.equal(expired.status, 401); assert.match(expired.headers.get('set-cookie'), /ta_session=;/);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    Date.now = realNow;
    const again = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: signup.email, password: signup.password }) });
    const freshCookie = again.headers.get('set-cookie').split(';')[0];
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: freshCookie } });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /ta_session=;/);
    assert.equal((await fetch(`${base}/api/auth/me`, { headers: { Cookie: freshCookie } })).status, 401);
    if (process.env.PLAYWRIGHT_MODULE) {
      const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
      const browser = await chromium.launch({ channel: 'chrome', headless: true });
      try {
        const context = await browser.newContext();
        const response = await context.request.post(`${base}/api/auth/login`, { data: { email: signup.email, password: signup.password } });
        assert.equal(response.status(), 200);
        const cookies = await context.cookies();
        assert.equal(cookies.find(c => c.name === 'ta_session').httpOnly, true);
        const page = await context.newPage();
        await page.goto(`${base}/#/account`);
        await page.locator('#acctUsernameShown').getByText(signup.username, { exact: true }).waitFor();
        await page.reload();
        await page.locator('#acctUsernameShown').getByText(signup.username, { exact: true }).waitFor();
        const secondTab = await context.newPage();
        await secondTab.goto(`${base}/#/account`);
        await secondTab.locator('#acctUsernameShown').getByText(signup.username, { exact: true }).waitFor();
        await context.request.post(`${base}/api/auth/logout`);
        await secondTab.reload();
        await secondTab.locator('#acctLoggedOutBox').waitFor({ state: 'visible' });
        await context.close();
        console.log('Browser checks passed: reload, new tab, cookie persistence and logout.');
      } finally { await browser.close(); }
    }
  } finally {
    Date.now = realNow;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session restoration works without an in-memory token and keeps login on transient failures', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const start = source.indexOf('let authToken = null;');
  const end = source.indexOf('function updateAuthUI()', start);
  let status = 200;
  const context = vm.createContext({
    fetch: async (url, options) => {
      assert.equal(url, '/api/auth/me'); assert.equal(options.credentials, 'same-origin');
      return { status, ok: status === 200, json: async () => ({ email: 'session@example.test', favourites: [] }) };
    },
    updateAuthUI: () => {}, refreshNotifBadge: () => {}, currentFavourites: [],
  });
  vm.runInContext(source.slice(start, end), context);
  await context.refreshMe();
  assert.equal(vm.runInContext('currentUser.email', context), 'session@example.test');
  status = 503; await context.refreshMe();
  assert.equal(vm.runInContext('currentUser.email', context), 'session@example.test');
  assert.equal(vm.runInContext('sessionRestoreNeedsRetry', context), true);
  status = 200; await context.refreshMe();
  assert.equal(vm.runInContext('sessionRestoreNeedsRetry', context), false);
  status = 401; await context.refreshMe();
  assert.equal(vm.runInContext('currentUser', context), null);
});

test('database session lookups enforce the same fixed lifetime', async () => {
  const { createMysqlStorage, createPgStorage } = require('../storage');
  const mysql = createMysqlStorage({ execute: async (sql, args) => {
    assert.match(sql, /s.created_at > \?/); assert.equal(args[0], 'test-token');
    assert.equal(args[1].length, 19); return [[{ email: 'session@example.test' }]];
  } });
  assert.equal(await mysql.getSessionEmail('test-token'), 'session@example.test');
  const pg = createPgStorage({ query: async (sql, args) => {
    assert.match(sql, /created_at > \$2/); assert.equal(args[0], 'test-token');
    assert.ok(Math.abs(args[1].getTime() - (Date.now() - SESSION_TTL_MS)) < 1000);
    return { rows: [{ email: 'session@example.test' }] };
  } });
  assert.equal(await pg.getSessionEmail('test-token'), 'session@example.test');
});
