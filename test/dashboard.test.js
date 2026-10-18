const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('dashboard refetches results, avoids overlapping requests and recovers after failure', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const start = source.indexOf('let dashboardChartsLoading');
  const end = source.indexOf('// ---------- Notifications', start);
  let active = true;
  let rate = 50;
  let calls = 0;
  let fail = false;
  const elements = new Map();
  const draws = [];
  const events = {};
  const document = {
    hidden: false,
    querySelector: () => ({ classList: { contains: () => active } }),
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, { id, style: {}, textContent: '' });
      return elements.get(id);
    },
    addEventListener: (name, handler) => { events[name] = handler; },
  };
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    document, window: { addEventListener: (name, handler) => { events[name] = handler; } },
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/dashboard-stats'); assert.equal(options.cache, 'no-store');
      return { ok: !fail, json: async () => ({ topAssets: [], weekly: { sell: [{ winRate: rate }], buy: [{ winRate: rate }] }, updatedAt: new Date().toISOString() }) };
    },
    drawBarChart: () => {}, drawLineChart: (canvas, points) => draws.push({ id: canvas.id, rate: points[0].winRate }),
  });
  vm.runInContext(source.slice(start, end), context);
  const first = context.loadDashboardCharts();
  const duplicate = context.loadDashboardCharts();
  await Promise.all([first, duplicate]);
  assert.equal(calls, 1);
  rate = 75;
  await context.loadDashboardCharts();
  assert.equal(draws.at(-1).rate, 75);
  assert.match(elements.get('dashboardUpdated').textContent, /^Updated /);
  fail = true;
  await context.loadDashboardCharts();
  assert.match(elements.get('dashboardUpdated').textContent, /Update failed/);
  fail = false;
  await context.loadDashboardCharts();
  assert.match(elements.get('dashboardUpdated').textContent, /^Updated /);
  document.hidden = true;
  await context.loadDashboardCharts();
  assert.equal(calls, 4);
  document.hidden = false; active = false;
  await context.loadDashboardCharts();
  assert.equal(calls, 4);
  active = true;
  events.visibilitychange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 5);
});
