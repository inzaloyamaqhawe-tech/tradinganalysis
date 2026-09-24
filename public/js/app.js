// Display-only labels: the engine's internal signal stays BUY/SELL/HOLD
// (used for TP/SL direction math), but we never present it as a buy/sell
// instruction — this is a market-structure read, not a trade instruction.
const BIAS_LABEL = { BUY: 'BULLISH BIAS', SELL: 'BEARISH BIAS', HOLD: 'NEUTRAL' };

// A reached target (TP1-TP4) is a win even if the position later gave back
// the remainder and stopped out on the rest — the server never labels those
// 'SL' (see server.js's resolveSignalFromCandles/WIN_OUTCOMES), so this set
// keeps the frontend's win/loss styling in sync with that same rule.
const WIN_OUTCOMES = new Set(['TP1', 'TP2', 'TP3', 'TP4']);

function formatDuration(ms) {
  if (ms == null) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h${remMins ? ` ${remMins}m` : ''}`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d${remHours ? ` ${remHours}h` : ''}`;
}

// Standard pip size per instrument, for the Long/Short drag tool's live
// distance readout. Crypto has no real "pip" convention, so those just show
// a plain price distance instead of a fabricated pip count.
const PIP_SIZE = { EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01, XAUUSD: 0.01 };
function formatDistance(priceDist, instrumentKey) {
  const pipSize = PIP_SIZE[instrumentKey];
  const abs = Math.abs(priceDist);
  if (pipSize) return `${(abs / pipSize).toFixed(1)} pips`;
  return `${abs.toFixed(abs >= 100 ? 2 : abs >= 1 ? 4 : 6)}`;
}

// ---------- Nav / routing (simple hash-based SPA, no framework needed) ----------
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.mainnav-item');

function showView(name) {
  views.forEach(v => v.classList.toggle('active', v.dataset.view === name));
  navItems.forEach(b => b.classList.toggle('active', b.dataset.view === name));
  window.location.hash = `/${name}`;
}
navItems.forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));

function routeFromHash() {
  const name = (window.location.hash.replace('#/', '') || 'dashboard').trim();
  const valid = [...views].some(v => v.dataset.view === name);
  showView(valid ? name : 'dashboard');
  if (name === 'track') loadTrackRecord();
}
window.addEventListener('hashchange', routeFromHash);

async function loadTrackRecord() {
  const statsHost = document.getElementById('trackStats');
  const rowsHost = document.getElementById('trackRows');
  try {
    const email = currentUser?.email || knownEmail();
    const res = await fetch(`/api/performance${email ? `?email=${encodeURIComponent(email)}` : ''}`, { headers: authHeaders() });
    const data = await res.json();
    const s = data.stats;
    statsHost.innerHTML = `
      <div class="stat-chip"><div class="n">${s.total}</div><div class="l">Setups logged</div></div>
      <div class="stat-chip"><div class="n">${s.winRate != null ? s.winRate + '%' : '—'}</div><div class="l">Win rate</div></div>
      <div class="stat-chip"><div class="n">${s.wins}</div><div class="l">Reached TP4</div></div>
      <div class="stat-chip"><div class="n">${s.losses}</div><div class="l">Stopped out</div></div>
      <div class="stat-chip"><div class="n">${s.open}</div><div class="l">Still open</div></div>
    `;
    const bestBox = document.getElementById('trackBestMarketsBox');
    if (data.bestMarkets?.length) {
      bestBox.style.display = 'block';
      document.getElementById('trackBestMarketsList').innerHTML = data.bestMarkets.slice(0, 8).map(m => `
        <div class="sp-row"><span>${m.label}</span><b>${m.winRate != null ? m.winRate + '% win rate' : '—'} (${m.wins}W / ${m.losses}L)</b></div>
      `).join('');
    } else {
      bestBox.style.display = 'none';
    }
    if (!data.recent.length) {
      rowsHost.innerHTML = `<tr><td colspan="8" class="note">No setups logged yet — check back once the engine has surfaced a few.</td></tr>`;
      return;
    }
    rowsHost.innerHTML = data.recent.map(r => {
      if (r.locked) {
        return `<tr>
          <td>${new Date(r.created_at).toLocaleDateString()}</td>
          <td colspan="4" class="note">🔒 Live setup — <a href="#/pricing">subscribe</a> to see which market and bias this is</td>
          <td><span class="outcome-pill open">Open</span></td>
          <td>—</td>
          <td>—</td>
        </tr>`;
      }
      const outcomeClass = r.status === 'open' ? 'open' : WIN_OUTCOMES.has(r.outcome) ? 'win' : r.outcome === 'SL' ? 'loss' : 'invalidated';
      const outcomeText = r.status === 'open' ? 'Open' : (r.outcome === 'SL' ? 'SL' : WIN_OUTCOMES.has(r.outcome) ? `${r.outcome} (then gave back remainder)` : (r.outcome || '—'));
      // Trail of TPs actually touched (walked from real candle history), not
      // just the final best level — e.g. "TP1 → TP2" shows partial progress
      // even on a setup that hasn't reached TP4 yet.
      const trail = (r.hit_history || []).map(h => h.level).join(' → ') || r.best_level || '—';
      return `<tr>
        <td>${new Date(r.created_at).toLocaleDateString()}</td>
        <td>${r.label || r.instrument}</td>
        <td>${BIAS_LABEL[r.side] || r.side}</td>
        <td>${r.strategy || '—'}</td>
        <td>${r.confidence != null ? r.confidence + '/100' : '—'}</td>
        <td><span class="outcome-pill ${outcomeClass}">${outcomeText}</span></td>
        <td>${trail}</td>
        <td>${formatDuration(r.resolved_in_ms)}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    rowsHost.innerHTML = `<tr><td colspan="8" class="note">Failed to load track record.</td></tr>`;
  }
}

document.getElementById('goPricingBtn')?.addEventListener('click', () => showView('pricing'));

// ---------- Config / demo mode ----------
let isDemo = false;
let planPriceZar = 45;
let availableTimeframes = ['1h'];
let PLANS = null;
let marketCount = 14;
let aiConfigured = false;

fetch('/api/config').then(r => r.json()).then(cfg => {
  isDemo = !!cfg.demoMode;
  document.getElementById('demoBanner').style.display = isDemo ? 'block' : 'none';
  document.getElementById('demoPill').style.display = isDemo ? 'inline-block' : 'none';
  if (cfg.price) {
    document.getElementById('lockedPrice').textContent = cfg.price;
    planPriceZar = parseFloat(cfg.price.replace(/[^\d.]/g, '')) || 45;
  }
  if (Array.isArray(cfg.timeframes)) {
    availableTimeframes = cfg.timeframes;
    renderTimeframeGroup();
  }
  if (cfg.plans) PLANS = cfg.plans;
  if (cfg.marketCount) marketCount = cfg.marketCount;
  aiConfigured = !!cfg.aiConfigured;
  document.getElementById('statMarketCount').textContent = marketCount;
  document.getElementById('lockedMarketCount').textContent = marketCount;
  renderPlanGrid();
}).catch(() => {});

// ---------- Pricing: 4-tier plan grid ----------
function renderPlanGrid() {
  const host = document.getElementById('planGrid');
  if (!host || !PLANS) return;
  const currentPlan = currentUser?.plan || 'free';
  host.innerHTML = Object.values(PLANS).map(p => `
    <div class="plan-card ${p.key === currentPlan ? 'current' : ''}">
      ${p.key === currentPlan ? '<div class="plan-badge">YOUR CURRENT PLAN</div>' : ''}
      <div class="label" style="color:var(--gold); font-weight:700; letter-spacing:.05em; font-size:.8rem;">${p.label.toUpperCase()}</div>
      <div class="plan-price">${p.price === 0 ? 'Free' : `R${p.price}`} ${p.price === 0 ? '' : '<span>/ month</span>'}</div>
      <ul class="plan-list">${p.features.map(f => `<li>${f}</li>`).join('')}</ul>
      ${p.key === 'free'
        ? `<button class="secondary" data-plan-action="free">Already included</button>`
        : `<div class="row"><button data-plan-action="subscribe" data-plan="${p.key}">Get ${p.label}</button></div>
           ${isDemo ? `<div class="row" style="margin-top:8px;"><button class="secondary" data-plan-action="demo" data-plan="${p.key}">🧪 Simulate Payment</button></div>` : ''}`}
    </div>
  `).join('');

  host.querySelectorAll('[data-plan-action="subscribe"]').forEach(btn => btn.addEventListener('click', () => subscribeToPlan(btn.dataset.plan)));
  host.querySelectorAll('[data-plan-action="demo"]').forEach(btn => btn.addEventListener('click', () => demoActivatePlan(btn.dataset.plan)));
}

async function subscribeToPlan(plan) {
  const email = currentUser?.email || subEmailInput.value.trim();
  const subResult = document.getElementById('subResult');
  if (!email) { subResult.textContent = 'Enter your email first, or create an account on the Dashboard.'; return; }
  if (!currentUser) rememberEmail(email);
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ email, plan }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.innerHTML = `${data.instructions}${data.demoMode ? '' : `<br><br><a href="${data.payLink}" target="_blank" rel="noopener">👉 Pay ${data.price} via PayPal</a>`}`;
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  }
}

async function demoActivatePlan(plan) {
  const email = currentUser?.email || subEmailInput.value.trim();
  const subResult = document.getElementById('subResult');
  if (!email) { subResult.textContent = 'Enter your email first (above), or create an account on the Dashboard.'; return; }
  if (!currentUser) rememberEmail(email);
  try {
    const res = await fetch('/api/demo/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify({ email, plan }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.textContent = `Simulated payment successful for ${email} — ${PLANS[plan]?.label || plan}. Go to Insights to see it unlocked.`;
    checkEmailInput.value = email;
    if (currentUser) await refreshMe();
    renderPlanGrid();
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  }
}

// ---------- Currency conversion (display only — billing stays in ZAR via PayPal) ----------
const CURRENCY_SYMBOL = { ZAR: 'R', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', NGN: '₦', KES: 'KSh', INR: '₹' };
document.getElementById('currencySelect')?.addEventListener('change', async (e) => {
  const to = e.target.value;
  const altPrice = document.getElementById('altPrice');
  if (to === 'ZAR') { altPrice.textContent = ''; return; }
  altPrice.textContent = 'converting…';
  try {
    const res = await fetch(`/api/currency/convert?amount=${planPriceZar}&to=${to}`);
    const data = await res.json();
    altPrice.textContent = data.converted != null ? `≈ ${CURRENCY_SYMBOL[to] || to}${data.converted} ${to}` : '';
  } catch (e) { altPrice.textContent = ''; }
});

// ---------- Dashboard: live prices (table, searchable, paginated) ----------
const priceGrid = document.getElementById('priceGrid'); // <tbody>
const statUp = document.getElementById('statUp');
const marketSearchInput = document.getElementById('marketSearch');
const marketSearchCount = document.getElementById('marketSearchCount');
const marketPagination = document.getElementById('marketPagination');
const MARKETS_PAGE_SIZE = 25;
let marketPage = 1;

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 100 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

let lastPricesData = null; // cached /api/prices result, reused by the symbol ribbon + side panel

function filteredMarketAssets() {
  if (!lastPricesData) return [];
  const q = marketSearchInput.value.trim().toLowerCase();
  if (!q) return lastPricesData.assets;
  return lastPricesData.assets.filter(a => a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q));
}

function marketRowHtml(a) {
  const cls = a.changePct > 0.001 ? 'up' : a.changePct < -0.001 ? 'down' : 'flat';
  const arrow = a.changePct > 0.001 ? '▲' : a.changePct < -0.001 ? '▼' : '·';
  const chg = a.changePct != null ? `${arrow} ${Math.abs(a.changePct).toFixed(2)}%` : 'loading…';
  return `<tr class="market-row" data-key="${a.key}" data-label="${a.label}">
    <td><span class="label">${a.label}</span></td>
    <td><span class="price">${a.price != null ? fmtPrice(a.price) : '…'}</span></td>
    <td><span class="chg ${cls}">${chg}</span></td>
  </tr>`;
}

function renderMarketPagination(totalPages) {
  if (totalPages <= 1) { marketPagination.innerHTML = ''; return; }
  const btn = (label, page, opts = {}) => `<button class="page-btn ${opts.active ? 'active' : ''}" data-page="${page}" ${opts.disabled ? 'disabled' : ''}>${label}</button>`;
  let html = btn('← Prev', marketPage - 1, { disabled: marketPage <= 1 });
  for (let p = 1; p <= totalPages; p++) html += btn(String(p), p, { active: p === marketPage });
  html += btn('Next →', marketPage + 1, { disabled: marketPage >= totalPages });
  marketPagination.innerHTML = html;
  marketPagination.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => {
    const p = parseInt(b.dataset.page, 10);
    if (p >= 1 && p <= totalPages) { marketPage = p; renderMarketTable(); }
  }));
}

function renderMarketTable() {
  const filtered = filteredMarketAssets();
  const totalPages = Math.max(1, Math.ceil(filtered.length / MARKETS_PAGE_SIZE));
  if (marketPage > totalPages) marketPage = totalPages;
  const start = (marketPage - 1) * MARKETS_PAGE_SIZE;
  const pageAssets = filtered.slice(start, start + MARKETS_PAGE_SIZE);

  priceGrid.innerHTML = pageAssets.length
    ? pageAssets.map(marketRowHtml).join('')
    : `<tr><td colspan="3" class="note">No markets match "${marketSearchInput.value}".</td></tr>`;
  priceGrid.querySelectorAll('.market-row').forEach(el => el.addEventListener('click', () => openChart(el.dataset.key, el.dataset.label)));

  marketSearchCount.textContent = marketSearchInput.value.trim()
    ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}`
    : '';
  renderMarketPagination(totalPages);
}

marketSearchInput.addEventListener('input', () => { marketPage = 1; renderMarketTable(); });

async function loadPrices() {
  try {
    const res = await fetch('/api/prices');
    const data = await res.json();
    lastPricesData = data;
    const upCount = data.assets.filter(a => a.changePct > 0).length;
    statUp.textContent = `${upCount}/${data.assets.length}`;
    renderMarketTable();
    if (chartModal.classList.contains('open')) renderSymbolRibbon();
  } catch (e) {
    priceGrid.innerHTML = '<tr><td colspan="3" class="note">Failed to load prices — retrying…</td></tr>';
  }
}
loadPrices();
setInterval(loadPrices, 30000);

// ---------- Live crypto ticks via Binance's free public WebSocket ----------
// Every one of these is verified tradeable on both Crypto.com (our backend
// candle/signal source — see server.js's CRYPTO_INSTRUMENTS) and Binance
// (this live ticker/kline source), so every crypto row genuinely ticks live
// off Binance, not just a curated subset. EUR/GBP/JPY/XAU still come from
// the 30s poll above (Twelve Data via our own server, untouched) — Binance
// has no FX/gold market at all.
const BINANCE_SYMBOL = {
  BTC_USDT: 'btcusdt', ETH_USDT: 'ethusdt', SOL_USDT: 'solusdt', XRP_USDT: 'xrpusdt', ARB_USDT: 'arbusdt',
  DOGE_USDT: 'dogeusdt', ADA_USDT: 'adausdt', BCH_USDT: 'bchusdt', AAVE_USDT: 'aaveusdt', LTC_USDT: 'ltcusdt',
  NEAR_USDT: 'nearusdt', SUI_USDT: 'suiusdt', AVAX_USDT: 'avaxusdt', DOT_USDT: 'dotusdt', UNI_USDT: 'uniusdt',
  LINK_USDT: 'linkusdt', TRUMP_USDT: 'trumpusdt', SHIB_USDT: 'shibusdt', HBAR_USDT: 'hbarusdt', FIL_USDT: 'filusdt',
  PAXG_USDT: 'paxgusdt', PEPE_USDT: 'pepeusdt', PYTH_USDT: 'pythusdt', XLM_USDT: 'xlmusdt', PUMP_USDT: 'pumpusdt',
  WLD_USDT: 'wldusdt', QNT_USDT: 'qntusdt', FET_USDT: 'fetusdt', VIRTUAL_USDT: 'virtualusdt', BONK_USDT: 'bonkusdt',
  INJ_USDT: 'injusdt', OP_USDT: 'opusdt', SEI_USDT: 'seiusdt', WIF_USDT: 'wifusdt', ATOM_USDT: 'atomusdt',
  LDO_USDT: 'ldousdt', PENGU_USDT: 'penguusdt', APT_USDT: 'aptusdt', ONDO_USDT: 'ondousdt', APE_USDT: 'apeusdt',
  VET_USDT: 'vetusdt', ETC_USDT: 'etcusdt', CRV_USDT: 'crvusdt', XAUT_USDT: 'xautusdt', ENA_USDT: 'enausdt',
};
const BINANCE_TO_KEY = Object.fromEntries(Object.entries(BINANCE_SYMBOL).map(([key, sym]) => [sym.toUpperCase(), key]));

function setLiveBadge(connected) {
  document.getElementById('liveBadge')?.classList.toggle('connected', connected);
}

function updateCardLive(key, price, changePct) {
  // Keep the cached snapshot (used by the symbol ribbon + chart side panel,
  // and re-rendered on the next search/page change) in sync regardless of
  // whether this row happens to be on the currently displayed page.
  const asset = lastPricesData?.assets.find(a => a.key === key);
  if (asset) { asset.price = price; asset.changePct = changePct; }

  const row = priceGrid.querySelector(`.market-row[data-key="${key}"]`);
  if (!row || price == null || !isFinite(price)) return;
  const priceEl = row.querySelector('.price');
  const chgEl = row.querySelector('.chg');
  const prevText = priceEl.textContent;
  const nextText = fmtPrice(price);
  if (prevText === nextText) return; // no visible change — skip the animation churn

  const wentUp = parseFloat(nextText.replace(/,/g, '')) >= parseFloat((prevText || '0').replace(/,/g, ''));
  priceEl.textContent = nextText;
  if (isFinite(changePct)) {
    const cls = changePct > 0.001 ? 'up' : changePct < -0.001 ? 'down' : 'flat';
    const arrow = changePct > 0.001 ? '▲' : changePct < -0.001 ? '▼' : '·';
    chgEl.className = `chg ${cls}`;
    chgEl.textContent = `${arrow} ${Math.abs(changePct).toFixed(2)}%`;
  }

  priceEl.classList.remove('flash-up', 'flash-down');
  void priceEl.offsetWidth; // restart the CSS transition
  priceEl.classList.add(wentUp ? 'flash-up' : 'flash-down');
  setTimeout(() => priceEl.classList.remove('flash-up', 'flash-down'), 50);
}

let binanceWs = null;
let binanceReconnectDelay = 1000;
function connectBinanceLive() {
  const streams = Object.values(BINANCE_SYMBOL).map(s => `${s}@ticker`).join('/');
  try { binanceWs = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`); }
  catch (e) { scheduleReconnect(); return; }

  binanceWs.addEventListener('open', () => { binanceReconnectDelay = 1000; setLiveBadge(true); });
  binanceWs.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      const d = msg?.data;
      const key = d && BINANCE_TO_KEY[d.s];
      if (!key) return;
      updateCardLive(key, parseFloat(d.c), parseFloat(d.P));
    } catch (e) { /* one bad frame shouldn't kill the feed */ }
  });
  binanceWs.addEventListener('close', () => { setLiveBadge(false); scheduleReconnect(); });
  binanceWs.addEventListener('error', () => { binanceWs.close(); });
}
function scheduleReconnect() {
  setTimeout(connectBinanceLive, binanceReconnectDelay);
  binanceReconnectDelay = Math.min(binanceReconnectDelay * 1.6, 20000);
}
connectBinanceLive();

// ---------- Remember the visitor's email so card clicks know if they're premium ----------
function rememberEmail(email) { try { localStorage.setItem('ta_email', email); } catch (e) {} }
function knownEmail() { try { return localStorage.getItem('ta_email') || ''; } catch (e) { return ''; } }

// ---------- Chart modal: click a card to see its data. ----------
// Free: line/candle chart of tracked price history.
// Premium: + EMA8/EMA21 overlay, the live signal, and drawing tools
// (trendline, rectangle, and an MT5-style Long/Short position tool that
// bands a reward zone vs a risk zone off wherever you drag, at a 1:2 R:R —
// so you can compare your own read of the chart against the algo's).
const chartModal = document.getElementById('chartModal');
const chartCanvas = document.getElementById('chartCanvas');
const drawCanvas = document.getElementById('drawCanvas');
const chartCtx = chartCanvas.getContext('2d');
const drawCtx = drawCanvas.getContext('2d');

let chartState = null;   // { candles, closes, ema8, ema21, levels }
let chartType = 'line';  // 'line' | 'candles'
let activeTool = null;   // 'trendline' | 'hline' | 'rect' | 'fib' | 'position' | null
let objects = [];        // drawn shapes: { tool, x1,y1,x2,y2 }
let liveObj = null;      // the shape currently being dragged
let priceScale = { min: 0, max: 1, h: 0 }; // set by renderChart, reused to label drawn levels
let currentChartKey = null;
let showEma8 = true, showEma21 = true, showPatterns = true;

function resizeCanvases() {
  const wrap = chartCanvas.parentElement;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  [chartCanvas, drawCanvas].forEach(c => { c.width = w; c.height = h; });
  if (chartState) renderChart();
  redrawObjects();
}
window.addEventListener('resize', resizeCanvases);

function priceToY(p, min, max, h) {
  if (max === min) return h / 2;
  return h - ((p - min) / (max - min)) * (h - 20) - 10;
}
function yToPrice(y, min, max, h) {
  return min + ((h - 10 - y) / (h - 20)) * (max - min);
}

function renderChart() {
  const { candles, closes, ema8, ema21, levels } = chartState;
  const w = chartCanvas.width, h = chartCanvas.height;
  chartCtx.clearRect(0, 0, w, h);
  if (!closes.length) {
    chartCtx.fillStyle = '#8b98ad'; chartCtx.font = '13px sans-serif';
    chartCtx.fillText('Not enough data yet — check back soon.', 14, h / 2);
    return;
  }
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  const all = [...highs, ...lows, ...(ema8 || []), ...(ema21 || []), ...(levels ? [levels.sl, levels.tp4] : [])];
  const min = Math.min(...all), max = Math.max(...all);
  priceScale = { min, max, h };

  if (chartType === 'candles') {
    const n = candles.length;
    const slot = w / n;
    const bodyW = Math.max(1, slot * 0.6);
    candles.forEach((c, i) => {
      const x = i * slot + slot / 2;
      const up = c.close >= c.open;
      const color = up ? '#2fd480' : '#ff5d6c';
      chartCtx.strokeStyle = color; chartCtx.fillStyle = color; chartCtx.lineWidth = 1;
      chartCtx.beginPath();
      chartCtx.moveTo(x, priceToY(c.high, min, max, h));
      chartCtx.lineTo(x, priceToY(c.low, min, max, h));
      chartCtx.stroke();
      const yOpen = priceToY(c.open, min, max, h), yClose = priceToY(c.close, min, max, h);
      chartCtx.fillRect(x - bodyW / 2, Math.min(yOpen, yClose), bodyW, Math.max(1, Math.abs(yClose - yOpen)));
    });
  } else {
    // subtle fill under the price line
    chartCtx.beginPath();
    closes.forEach((p, i) => {
      const x = (i / (closes.length - 1 || 1)) * w, y = priceToY(p, min, max, h);
      i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    });
    chartCtx.lineTo(w, h); chartCtx.lineTo(0, h); chartCtx.closePath();
    chartCtx.fillStyle = 'rgba(79,140,255,.08)'; chartCtx.fill();

    const plotLine = (series, color, width) => {
      chartCtx.beginPath(); chartCtx.strokeStyle = color; chartCtx.lineWidth = width;
      series.forEach((p, i) => {
        const x = (i / (series.length - 1 || 1)) * w;
        const y = priceToY(p, min, max, h);
        i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
      });
      chartCtx.stroke();
    };
    plotLine(closes, '#4f8cff', 2);
  }

  if (ema8 && showEma8) {
    chartCtx.beginPath(); chartCtx.strokeStyle = '#f2b84b'; chartCtx.lineWidth = 1.4;
    ema8.forEach((p, i) => { const x = (i / (ema8.length - 1 || 1)) * w, y = priceToY(p, min, max, h); i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y); });
    chartCtx.stroke();
  }
  if (ema21 && showEma21) {
    chartCtx.beginPath(); chartCtx.strokeStyle = '#ff5d6c'; chartCtx.lineWidth = 1.4;
    ema21.forEach((p, i) => { const x = (i / (ema21.length - 1 || 1)) * w, y = priceToY(p, min, max, h); i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y); });
    chartCtx.stroke();
  }

  if (levels) {
    const drawLevel = (price, color, label) => {
      const y = priceToY(price, min, max, h);
      chartCtx.setLineDash([4, 4]); chartCtx.strokeStyle = color; chartCtx.lineWidth = 1;
      chartCtx.beginPath(); chartCtx.moveTo(0, y); chartCtx.lineTo(w, y); chartCtx.stroke();
      chartCtx.setLineDash([]);
      chartCtx.fillStyle = color; chartCtx.font = '10px sans-serif';
      chartCtx.fillText(label, w - 46, y - 3);
    };
    drawLevel(levels.sl, '#ff5d6c', 'SL');
    drawLevel(levels.tp4, '#2fd480', 'TP4');
  }

  // Detected classic chart patterns — drawn on the engine layer (not the
  // user drawing layer) since these are the algorithm's own read, offered so
  // a premium user can visually sanity-check it against what they see.
  const patterns = chartState.patterns;
  if (patterns && patterns.length && showPatterns) {
    const n = candles.length;
    const xFor = (index) => (index / (n - 1 || 1)) * w;
    patterns.forEach((p) => {
      const color = p.confirmed ? '#7ad1ff' : '#c98bff';
      chartCtx.strokeStyle = color; chartCtx.fillStyle = color; chartCtx.lineWidth = 1.5;
      chartCtx.setLineDash(p.confirmed ? [] : [5, 4]);
      chartCtx.beginPath();
      p.points.forEach((pt, i) => {
        const x = xFor(pt.index), y = priceToY(pt.price, min, max, h);
        i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
      });
      chartCtx.stroke();
      chartCtx.setLineDash([]);
      const last = p.points.at(-1);
      chartCtx.font = '10px sans-serif';
      chartCtx.fillText(`${p.label}${p.confirmed ? '' : ' (forming)'}`, xFor(last.index) + 4, priceToY(last.price, min, max, h) - 6);
    });
  }
}

// ---- Drawing tools (trendline / rectangle / long-short position) ----
function drawOneObject(ctx, o) {
  const { tool, x1, y1, x2, y2 } = o;
  if (tool === 'trendline') {
    ctx.strokeStyle = '#f2b84b'; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const p1 = yToPrice(y1, priceScale.min, priceScale.max, priceScale.h);
    const p2 = yToPrice(y2, priceScale.min, priceScale.max, priceScale.h);
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#f2b84b';
    ctx.fillText(formatDistance(p2 - p1, currentChartKey), (x1 + x2) / 2 + 6, (y1 + y2) / 2 - 6);
  } else if (tool === 'hline') {
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(drawCanvas.width, y1); ctx.stroke();
    const price = yToPrice(y1, priceScale.min, priceScale.max, priceScale.h);
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#4f8cff';
    ctx.fillText(price.toFixed(4), drawCanvas.width - 60, y1 - 3);
  } else if (tool === 'rect') {
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (tool === 'fib') {
    // Standard retracement levels between the two dragged points (swing high/low).
    const left = Math.min(x1, x2), width = Math.abs(x2 - x1) || (drawCanvas.width - left);
    const ratios = [0, 0.236, 0.382, 0.5, 0.618, 1];
    ctx.font = '10px sans-serif';
    ratios.forEach(r => {
      const y = y1 + (y2 - y1) * r;
      ctx.strokeStyle = 'rgba(242,184,75,.7)'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
      ctx.setLineDash([]);
      const price = yToPrice(y, priceScale.min, priceScale.max, priceScale.h);
      ctx.fillStyle = '#f2b84b'; ctx.fillText(`${(r * 100).toFixed(1)}%  ${price.toFixed(4)}`, left + 4, y - 3);
    });
  } else if (tool === 'position') {
    // Drag from entry (y1) toward your target (y2). Reward zone spans
    // entry->target; risk zone auto-mirrors on the other side at half that
    // height (1:2 R:R), same convention as the computed TP/SL ladder.
    const isLong = y2 < y1; // canvas y shrinks upward = higher price = long
    const rewardH = Math.abs(y2 - y1);
    const riskH = rewardH / 2;
    const left = Math.min(x1, x2), width = Math.abs(x2 - x1) || (drawCanvas.width - left);
    const rewardTop = Math.min(y1, y2);
    const riskTop = isLong ? y1 : y1 - riskH;

    ctx.fillStyle = 'rgba(47,212,128,.18)';
    ctx.fillRect(left, rewardTop, width, rewardH);
    ctx.fillStyle = 'rgba(255,93,108,.18)';
    ctx.fillRect(left, riskTop, width, riskH);

    ctx.strokeStyle = '#f2b84b'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y1); ctx.lineTo(left + width, y1); ctx.stroke();
    ctx.setLineDash([]);

    const entryPrice = yToPrice(y1, priceScale.min, priceScale.max, priceScale.h);
    const targetPrice = yToPrice(y2, priceScale.min, priceScale.max, priceScale.h);
    const stopPrice = isLong ? entryPrice - (entryPrice - targetPrice) / 2 : entryPrice + (targetPrice - entryPrice) / 2;
    const rewardDist = formatDistance(targetPrice - entryPrice, currentChartKey);
    const riskDist = formatDistance(stopPrice - entryPrice, currentChartKey);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#e7edf7';
    ctx.fillText(`${isLong ? 'LONG' : 'SHORT'} entry ${entryPrice.toFixed(4)}`, left + 4, y1 - 4);
    ctx.fillStyle = '#2fd480'; ctx.fillText(`target ${targetPrice.toFixed(4)}  (+${rewardDist})`, left + 4, rewardTop + 12);
    ctx.fillStyle = '#ff5d6c'; ctx.fillText(`stop ${stopPrice.toFixed(4)}  (-${riskDist})`, left + 4, riskTop + riskH - 4);
  }
}

function redrawObjects() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  objects.forEach(o => drawOneObject(drawCtx, o));
  if (liveObj) drawOneObject(drawCtx, liveObj);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Used by the Erase tool to find which single drawing a click landed on,
// so removing one line/box/level doesn't force clearing everything.
function distanceToObject(px, py, o) {
  const { tool, x1, y1, x2, y2 } = o;
  if (tool === 'trendline') return distToSegment(px, py, x1, y1, x2, y2);
  if (tool === 'hline') return Math.abs(py - y1);
  if (tool === 'rect') {
    const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
    if (px < left - 8 || px > right + 8 || py < top - 8 || py > bottom + 8) return Infinity;
    return Math.min(Math.abs(px - left), Math.abs(px - right), Math.abs(py - top), Math.abs(py - bottom));
  }
  if (tool === 'fib') {
    const left = Math.min(x1, x2), width = Math.abs(x2 - x1) || 1;
    if (px < left || px > left + width) return Infinity;
    return Math.min(...[0, 0.236, 0.382, 0.5, 0.618, 1].map(r => Math.abs(py - (y1 + (y2 - y1) * r))));
  }
  if (tool === 'position') {
    const left = Math.min(x1, x2), width = Math.abs(x2 - x1) || (drawCanvas.width - left);
    if (px < left || px > left + width) return Infinity;
    const isLong = y2 < y1;
    const rewardTop = Math.min(y1, y2), rewardBottom = rewardTop + Math.abs(y2 - y1);
    const riskH = Math.abs(y2 - y1) / 2, riskTop = isLong ? y1 : y1 - riskH, riskBottom = riskTop + riskH;
    return (py >= rewardTop && py <= rewardBottom) || (py >= riskTop && py <= riskBottom) ? 0 : Infinity;
  }
  return Infinity;
}

function eraseObjectNear(px, py) {
  let bestIdx = -1, bestDist = 12; // px tolerance
  objects.forEach((o, i) => { const d = distanceToObject(px, py, o); if (d < bestDist) { bestDist = d; bestIdx = i; } });
  if (bestIdx >= 0) { objects.splice(bestIdx, 1); redrawObjects(); }
}

function enableDrawing(enabled) {
  drawCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
  document.querySelectorAll('#drawToolGroup .tool-btn').forEach(b => b.disabled = !enabled);
}

function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('#drawToolGroup [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}
document.querySelectorAll('#drawToolGroup [data-tool]').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
document.getElementById('clearDrawBtn').addEventListener('click', () => { objects = []; liveObj = null; redrawObjects(); });

document.querySelectorAll('[data-type]').forEach(btn => btn.addEventListener('click', () => {
  chartType = btn.dataset.type;
  document.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('active', b.dataset.type === chartType));
  if (chartState) renderChart();
}));

document.getElementById('toggleEma8').addEventListener('change', (e) => { showEma8 = e.target.checked; if (chartState) renderChart(); });
document.getElementById('toggleEma21').addEventListener('change', (e) => { showEma21 = e.target.checked; if (chartState) renderChart(); });
document.getElementById('togglePatterns').addEventListener('change', (e) => { showPatterns = e.target.checked; if (chartState) renderChart(); });

function renderSymbolRibbon() {
  const ribbon = document.getElementById('symbolRibbon');
  if (!lastPricesData) { ribbon.innerHTML = ''; return; }
  ribbon.innerHTML = lastPricesData.assets.map(a => `
    <button class="symbol-pill ${a.key === currentChartKey ? 'active' : ''}" data-key="${a.key}" data-label="${a.label}">${a.label}</button>
  `).join('');
  ribbon.querySelectorAll('.symbol-pill').forEach(btn => btn.addEventListener('click', () => openChart(btn.dataset.key, btn.dataset.label)));
}

function updateSidePanel(key, data) {
  const priceEntry = lastPricesData?.assets.find(a => a.key === key);
  document.getElementById('spPrice').textContent = priceEntry?.price != null ? fmtPrice(priceEntry.price) : '—';

  const insight = data.insight;
  const hasSignal = data.premium && insight;
  document.getElementById('spSignal').textContent = hasSignal
    ? `${BIAS_LABEL[insight.signal]}${insight.confidence != null ? ` (${insight.confidence}/100)` : ''}`
    : (data.premium ? 'NEUTRAL' : '🔒');
  document.getElementById('spRegime').textContent = hasSignal ? (insight.regime || '').replace('_', ' ').toLowerCase() : '—';

  const levels = insight?.levels;
  const setRow = (id, val) => document.getElementById(id).textContent = val != null ? val : '—';
  setRow('spEntry', levels?.entry);
  setRow('spTp1', levels?.tp1);
  setRow('spTp2', levels?.tp2);
  setRow('spTp3', levels?.tp3);
  setRow('spTp4', levels?.tp4);
  setRow('spSl', levels?.sl);
  document.getElementById('spLockedNote').style.display = data.premium ? 'none' : 'block';

  const explainBox = document.getElementById('spExplainBox');
  if (data.premium && (insight?.explanation || insight?.zoneNote)) {
    explainBox.style.display = 'block';
    document.getElementById('spExplanation').innerHTML = [
      insight.explanation,
      insight.zoneNote ? `<span style="color:#7ad1ff;">${insight.zoneNote}</span>` : null,
    ].filter(Boolean).join('<br>');
    document.getElementById('spInvalidation').textContent = insight.invalidation || '';
    const aiBtn = document.getElementById('spAiExplainBtn');
    aiBtn.style.display = currentUser?.plan === 'elite' ? 'inline-block' : 'none';
    document.getElementById('spAiExplainResult').textContent = '';
  } else {
    explainBox.style.display = 'none';
  }

  const favBtn = document.getElementById('favToggleBtn');
  favBtn.style.display = data.proTools ? 'inline-block' : 'none';
  favBtn.textContent = currentFavourites.includes(key) ? '★ Remove from favourites' : '☆ Add to favourites';
}

document.getElementById('favToggleBtn').addEventListener('click', async () => {
  if (currentChartKey) { await toggleFavourite(currentChartKey); updateSidePanel(currentChartKey, lastChartData); }
});

document.getElementById('spAiExplainBtn').addEventListener('click', async () => {
  if (!currentChartKey) return;
  const email = currentUser?.email || knownEmail();
  const resultEl = document.getElementById('spAiExplainResult');
  resultEl.textContent = 'Thinking…';
  try {
    const res = await fetch(`/api/ai/explain?key=${encodeURIComponent(currentChartKey)}&email=${encodeURIComponent(email)}`, { headers: authHeaders() });
    const d = await res.json();
    resultEl.textContent = d.explanation || d.message || 'No explanation available.';
  } catch (e) { resultEl.textContent = 'Network error — try again.'; }
});

let isDragging = false;
drawCanvas.addEventListener('mousedown', (e) => {
  if (!activeTool) return;
  const r = drawCanvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (activeTool === 'erase') { eraseObjectNear(x, y); return; } // instant on click, no drag needed
  liveObj = { tool: activeTool, x1: x, y1: y, x2: x, y2: y };
  isDragging = true;
});
drawCanvas.addEventListener('mousemove', (e) => {
  if (!isDragging || !liveObj) return;
  const r = drawCanvas.getBoundingClientRect();
  liveObj.x2 = e.clientX - r.left; liveObj.y2 = e.clientY - r.top;
  redrawObjects();
});
window.addEventListener('mouseup', () => {
  if (isDragging && liveObj) { objects.push(liveObj); liveObj = null; redrawObjects(); }
  isDragging = false;
});

let currentTimeframe = '1h';

function renderTimeframeGroup() {
  const host = document.getElementById('timeframeGroup');
  host.innerHTML = availableTimeframes.map(tf => `<button class="tool-btn ${tf === currentTimeframe ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('');
  host.querySelectorAll('[data-tf]').forEach(btn => btn.addEventListener('click', () => {
    currentTimeframe = btn.dataset.tf;
    host.querySelectorAll('[data-tf]').forEach(b => b.classList.toggle('active', b.dataset.tf === currentTimeframe));
    if (currentChartKey) {
      loadChartData(currentChartKey);
      connectChartLive(currentChartKey, currentTimeframe);
    }
  }));
}

let lastChartData = null;

async function loadChartData(key) {
  document.getElementById('chartSub').textContent = 'Loading…';
  const email = currentUser?.email || knownEmail();
  try {
    const res = await fetch(`/api/history?key=${encodeURIComponent(key)}&timeframe=${encodeURIComponent(currentTimeframe)}${email ? `&email=${encodeURIComponent(email)}` : ''}`, { headers: authHeaders() });
    const data = await res.json();
    lastChartData = data;
    chartState = { candles: data.candles || [], closes: data.closes || [], ema8: data.ema8, ema21: data.ema21, levels: data.insight?.levels, patterns: data.patterns || [] };
    updateSidePanel(key, data);
    resizeCanvases();

    const isLiveCapable = !!(BINANCE_SYMBOL[key] && BINANCE_KLINE_INTERVAL[currentTimeframe]);
    const liveTag = isLiveCapable ? ' 🔴 live candle' : '';
    const rangeTxt = data.high != null
      ? `Range (${currentTimeframe}, tracked window): ${data.low} – ${data.high}${liveTag}`
      : `No candles yet at ${currentTimeframe} — try 1h, or add a Twelve Data key for full FX timeframe coverage.`;
    document.getElementById('chartSub').textContent = rangeTxt;

    // proTools gates the chart-tool layer (EMA overlays, pattern overlays,
    // drawing tools); premium (checked separately in updateSidePanel) gates
    // the signal/levels themselves — a Premium-only subscriber sees the
    // suggested trade in the side panel but not these chart overlays.
    if (data.proTools) {
      enableDrawing(true);
      const legend = document.getElementById('chartLegend');
      const insight = data.insight;
      const sigColor = insight?.signal === 'BUY' ? '#2fd480' : insight?.signal === 'SELL' ? '#ff5d6c' : '#8b98ad';
      const patternNames = (data.patterns || []).map(p => `${p.label}${p.confirmed ? '' : ' (forming)'}`);
      const patternTxt = patternNames.length ? ` &nbsp;·&nbsp; <span style="color:#7ad1ff;">Detected: ${patternNames.join(', ')}</span>` : '';
      legend.innerHTML = `<span style="color:#f2b84b;">■</span> EMA8 &nbsp; <span style="color:#ff5d6c;">■</span> EMA21` +
        (insight ? ` &nbsp;·&nbsp; <strong style="color:${sigColor};">${BIAS_LABEL[insight.signal]}</strong>${insight.confidence != null ? ` (${insight.confidence}/100)` : ''}${insight.strategy ? ` · ${insight.strategy}` : ''} <span class="note" style="margin:0;">(engine reads 1h structure regardless of chart view)</span>` : '') +
        patternTxt;
      document.getElementById('chartLockedNote').style.display = 'none';
    } else {
      enableDrawing(false);
      document.getElementById('chartLockedNote').style.display = 'block';
    }
  } catch (e) {
    document.getElementById('chartSub').textContent = 'Failed to load chart data.';
  }
}

// ---------- Live candle feed for the open chart (Binance kline WS) ----------
// Same trick the old CRT dashboard used: a kline stream carries the whole
// currently-forming candle on every tick, plus a `closed` flag. Same
// timestamp as our last stored candle → the bar is still forming, replace it
// in place; a genuinely new timestamp once closed → push a new bar. History
// never moves; only the live edge does. Crypto only — Binance has no FX/gold,
// so those charts stay on the periodic /api/history refresh as before.
const BINANCE_KLINE_INTERVAL = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1D': '1d', '1W': '1w', '1M': '1M' };
let chartKlineWs = null;

function disconnectChartLive() {
  if (chartKlineWs) { try { chartKlineWs.close(); } catch (e) {} chartKlineWs = null; }
}

function connectChartLive(key, timeframe) {
  disconnectChartLive();
  const symbol = BINANCE_SYMBOL[key];
  const interval = BINANCE_KLINE_INTERVAL[timeframe];
  if (!symbol || !interval) return; // FX/gold, or a timeframe Binance doesn't expose — no live edge, static chart only

  try { chartKlineWs = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`); }
  catch (e) { return; }

  chartKlineWs.addEventListener('message', (event) => {
    if (!chartState || currentChartKey !== key || currentTimeframe !== timeframe) return; // stale connection from a since-switched view
    try {
      const k = JSON.parse(event.data)?.k;
      if (!k) return;
      const candle = { open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), time: k.t };
      const candles = chartState.candles;
      const last = candles[candles.length - 1];
      if (last && last.time === candle.time) {
        candles[candles.length - 1] = candle;
      } else if (k.x) {
        candles.push(candle);
        if (candles.length > 300) candles.shift();
      } else {
        candles[candles.length - 1] = candle;
      }
      chartState.closes = candles.map(c => c.close);
      renderChart();
    } catch (e) { /* one bad frame shouldn't kill the live edge */ }
  });
  chartKlineWs.addEventListener('error', () => { try { chartKlineWs.close(); } catch (e) {} });
}

async function openChart(key, label) {
  currentChartKey = key;
  currentTimeframe = '1h';
  renderTimeframeGroup();
  document.getElementById('chartTitle').textContent = label;
  document.getElementById('chartSub').textContent = 'Loading…';
  document.getElementById('chartLegend').textContent = '';
  document.getElementById('chartLockedNote').style.display = 'none';
  document.getElementById('chartTools').innerHTML = '<span class="note" id="chartLegend"></span>';
  objects = []; liveObj = null; activeTool = null;
  document.querySelectorAll('#drawToolGroup [data-tool]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
  chartModal.classList.add('open');
  renderSymbolRibbon();
  resizeCanvases();
  await loadChartData(key);
  connectChartLive(key, currentTimeframe);
}

document.getElementById('chartClose').addEventListener('click', () => { chartModal.classList.remove('open'); disconnectChartLive(); });
chartModal.addEventListener('click', (e) => { if (e.target === chartModal) { chartModal.classList.remove('open'); disconnectChartLive(); } });
document.getElementById('chartPricingLink')?.addEventListener('click', () => { chartModal.classList.remove('open'); disconnectChartLive(); });

// ---------- Auth: one account, used everywhere instead of retyping email ----------
let authToken = null;
try { authToken = localStorage.getItem('ta_token'); } catch (e) {}
let currentUser = null; // { email, status, expiresAt, active }

function authHeaders() { return authToken ? { Authorization: `Bearer ${authToken}` } : {}; }
function setToken(token) { authToken = token; try { localStorage.setItem('ta_token', token); } catch (e) {} }
function clearToken() { authToken = null; currentUser = null; try { localStorage.removeItem('ta_token'); } catch (e) {} }

async function refreshMe() {
  if (!authToken) { currentUser = null; updateAuthUI(); return; }
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (!res.ok) { clearToken(); } else { currentUser = await res.json(); currentFavourites = currentUser.favourites || []; }
  } catch (e) { /* leave currentUser as-is on a network blip */ }
  updateAuthUI();
}

function updateAuthUI() {
  const loggedIn = !!currentUser;
  document.getElementById('authLoggedOut').style.display = loggedIn ? 'none' : 'block';
  document.getElementById('authLoggedIn').style.display = loggedIn ? 'block' : 'none';
  document.getElementById('authPill').style.display = loggedIn ? 'inline-block' : 'none';
  document.getElementById('acctLoggedInBox').style.display = loggedIn ? 'block' : 'none';
  document.getElementById('acctLoggedOutBox').style.display = loggedIn ? 'none' : 'block';

  if (loggedIn) {
    // Username, not email, everywhere the frontend displays "who you are" —
    // the email stays purely a backend/login credential from here on.
    const displayName = currentUser.username ? `@${currentUser.username}` : currentUser.email;
    document.getElementById('authPill').textContent = displayName;
    document.getElementById('authWhoEmail').textContent = displayName;
    const planLabel = PLANS?.[currentUser.plan]?.label || currentUser.plan;
    document.getElementById('authStatusNote').textContent = currentUser.active
      ? `${planLabel} active — expires ${new Date(currentUser.expiresAt).toLocaleDateString()}.`
      : 'No active subscription yet — Free Market Watch.';
    document.getElementById('acctEmailShown').textContent = displayName;
    document.getElementById('acctStatus').textContent = currentUser.active ? `Active (${planLabel})` : (currentUser.status || 'pending');
    document.getElementById('acctExpires').textContent = currentUser.expiresAt ? new Date(currentUser.expiresAt).toLocaleDateString() : '—';

    // No more retyping email on every screen — prefill + lock it in from the session.
    [subEmailInput, checkEmailInput].forEach(el => { el.value = currentUser.email; el.readOnly = true; });
  } else {
    [subEmailInput, checkEmailInput].forEach(el => { el.readOnly = false; });
  }
  renderPlanGrid();
}

function setAuthMode(mode) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('authSubmitBtn').textContent = mode === 'signup' ? 'Create free account' : 'Log in';
  document.getElementById('authMsg').textContent = '';
  const isSignup = mode === 'signup';
  document.querySelectorAll('.auth-signup-only').forEach(el => { el.style.display = isSignup ? '' : 'none'; });
  document.getElementById('authEmail').placeholder = isSignup ? 'you@example.com' : 'Username or email';
}
document.querySelectorAll('.auth-tab').forEach(tab => tab.addEventListener('click', () => setAuthMode(tab.dataset.mode)));
setAuthMode('signup');

document.querySelectorAll('.pw-toggle').forEach(btn => btn.addEventListener('click', () => {
  const input = document.getElementById(btn.dataset.target);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'Show' : 'Hide';
}));

document.getElementById('authSubmitBtn').addEventListener('click', async () => {
  const mode = document.querySelector('.auth-tab.active').dataset.mode;
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const msg = document.getElementById('authMsg');
  if (!email || !password) { msg.textContent = mode === 'signup' ? 'Enter both email and password.' : 'Enter your username/email and password.'; return; }

  const body = { email, password };
  if (mode === 'signup') {
    body.firstName = document.getElementById('authFirstName').value.trim();
    body.lastName = document.getElementById('authLastName').value.trim();
    body.username = document.getElementById('authUsername').value.trim();
    body.confirmPassword = document.getElementById('authConfirmPassword').value;
    if (!body.firstName || !body.lastName) { msg.textContent = 'Enter your first and last name.'; return; }
    if (!body.username) { msg.textContent = 'Choose a username.'; return; }
    if (password !== body.confirmPassword) { msg.textContent = 'Passwords do not match.'; return; }
  }

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || 'Something went wrong.'; return; }
    setToken(data.token);
    msg.textContent = '';
    await refreshMe();
  } catch (e) {
    msg.textContent = 'Network error — try again.';
  }
});

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }); } catch (e) {}
  clearToken();
  updateAuthUI();
}
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('acctLogoutBtn').addEventListener('click', logout);
document.getElementById('goInsightsFromHero').addEventListener('click', () => showView('insights'));
document.getElementById('acctPricingBtn').addEventListener('click', () => showView('pricing'));
document.getElementById('acctGoHeroBtn').addEventListener('click', () => showView('dashboard'));

// ---------- Pricing: element refs used by subscribeToPlan/demoActivatePlan above ----------
const subEmailInput = document.getElementById('subEmail');
const checkEmailInput = document.getElementById('checkEmail');

// ---------- Insights ----------
const checkBtn = document.getElementById('checkBtn');
const insightsMsg = document.getElementById('insightsMsg');
const lockedBox = document.getElementById('lockedBox');
const riskGate = document.getElementById('riskGate');
const signalsWrap = document.getElementById('signalsWrap');
const signalsList = document.getElementById('signalsList');

function riskAccepted() { try { return localStorage.getItem('ta_risk_accepted') === '1'; } catch (e) { return false; } }
function acceptRisk() { try { localStorage.setItem('ta_risk_accepted', '1'); } catch (e) {} }

document.getElementById('riskAcceptCheck').addEventListener('change', (e) => {
  document.getElementById('riskAcceptBtn').disabled = !e.target.checked;
});
document.getElementById('riskAcceptBtn').addEventListener('click', () => {
  acceptRisk();
  riskGate.style.display = 'none';
  if (lastInsightsData) renderInsights(lastInsightsData);
});

let lastInsightsData = null;
let currentFavourites = [];

async function toggleFavourite(key) {
  const email = currentUser?.email || checkEmailInput.value.trim();
  if (!email) return;
  const idx = currentFavourites.indexOf(key);
  if (idx >= 0) currentFavourites.splice(idx, 1); else currentFavourites.push(key);
  try {
    await fetch('/api/favourites', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ email, favourites: currentFavourites }),
    });
  } catch (e) {}
  if (lastInsightsData) renderInsights(lastInsightsData);
}

function applyFilters(signals) {
  const minConf = parseInt(document.getElementById('filterConfidence').value, 10) || 0;
  const strategy = document.getElementById('filterStrategy').value;
  const direction = document.getElementById('filterDirection').value;
  const favOnly = document.getElementById('filterFavOnly').checked;
  return signals.filter(s => {
    if (s.confidence != null && s.confidence < minConf) return false;
    if (strategy && s.strategy !== strategy) return false;
    if (direction && s.signal !== direction) return false;
    if (favOnly && !currentFavourites.includes(s.key)) return false;
    return true;
  });
}

function signalRowHtml(s, proTools) {
  const isFav = currentFavourites.includes(s.key);
  return `
    <div class="signal-row">
      <div>
        <div class="name">${s.label} ${proTools ? `<button class="ghost fav-star" data-fav-key="${s.key}" title="Toggle favourite" style="padding:0 4px;">${isFav ? '★' : '☆'}</button>` : ''}</div>
        <div class="regime">${(s.regime || '').replace('_', ' ').toLowerCase() || ''}${s.strategy ? ' · ' + s.strategy : ''}</div>
      </div>
      <div class="badge ${s.signal}">${BIAS_LABEL[s.signal]}${s.confidence != null ? ` · ${s.confidence}/100` : ''}</div>
      <div></div>
      <div class="sig-note">${s.note}${s.explanation ? `<br><em>${s.explanation}</em>` : ''}${s.zoneNote ? `<br><span style="color:#7ad1ff;">${s.zoneNote}</span>` : ''}</div>
      ${s.levels ? `
        <div class="levels-strip">
          <span class="level-chip sl">SL <b>${s.levels.sl}</b></span>
          <span class="level-chip">TP1 <b>${s.levels.tp1}</b></span>
          <span class="level-chip">TP2 <b>${s.levels.tp2}</b></span>
          <span class="level-chip">TP3 <b>${s.levels.tp3}</b></span>
          <span class="level-chip tp4">TP4 <b>${s.levels.tp4}</b> (${s.levels.riskReward})</span>
        </div>` : ''}
    </div>
  `;
}

async function loadAiElite(data) {
  const box = document.getElementById('aiEliteBox');
  box.style.display = 'block';
  const summaryEl = document.getElementById('aiDailySummary');
  summaryEl.textContent = 'Loading…';
  try {
    const email = currentUser?.email || checkEmailInput.value.trim();
    const res = await fetch(`/api/ai/daily-summary?email=${encodeURIComponent(email)}`, { headers: authHeaders() });
    const d = await res.json();
    summaryEl.textContent = d.summary || 'No summary available.';
  } catch (e) { summaryEl.textContent = 'Could not load AI summary.'; }
}

document.getElementById('aiAskBtn').addEventListener('click', async () => {
  const question = document.getElementById('aiQuestionInput').value.trim();
  const answerBox = document.getElementById('aiAnswerBox');
  if (!question) return;
  const email = currentUser?.email || checkEmailInput.value.trim();
  answerBox.textContent = 'Thinking…';
  try {
    const res = await fetch('/api/ai/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ email, key: lastInsightsData?.topPick?.key, question }),
    });
    const d = await res.json();
    answerBox.textContent = d.answer || d.message || 'No answer available.';
  } catch (e) { answerBox.textContent = 'Network error — try again.'; }
});

function renderInsights(data) {
  lastInsightsData = data;
  currentFavourites = data.favourites || currentFavourites;
  insightsMsg.textContent = `Active (${PLANS?.[data.plan]?.label || data.plan}) — renews/expires ${new Date(data.expiresAt).toLocaleDateString()}`;
  signalsWrap.style.display = 'block';

  const topPickBox = document.getElementById('topPickBox');
  const p = data.topPick;
  topPickBox.innerHTML = !p ? `
    <div class="top-pick"><span class="tp-empty">No high-confidence setup across any tracked market right now — all ${marketCount} are neutral or low-conviction. Check back soon rather than forcing a trade.</span></div>
  ` : `
    <div class="top-pick">
      <div class="eyebrow">⭐ Best opportunity right now</div>
      <div class="tp-head">
        <div class="tp-name">${p.label} — ${BIAS_LABEL[p.signal]}</div>
        <div class="badge ${p.signal}">${p.confidence}/100</div>
      </div>
      <div class="regime" style="margin-bottom:8px;">${(p.regime || '').replace('_', ' ').toLowerCase()}${p.strategy ? ' · ' + p.strategy : ''}</div>
      <div class="sig-note" style="margin-bottom:8px;">${p.note}${p.explanation ? `<br><em>${p.explanation}</em>` : ''}${p.zoneNote ? `<br><span style="color:#7ad1ff;">${p.zoneNote}</span>` : ''}</div>
      ${p.levels ? `
        <div class="levels-strip">
          <span class="level-chip sl">SL <b>${p.levels.sl}</b></span>
          <span class="level-chip">TP1 <b>${p.levels.tp1}</b></span>
          <span class="level-chip">TP2 <b>${p.levels.tp2}</b></span>
          <span class="level-chip">TP3 <b>${p.levels.tp3}</b></span>
          <span class="level-chip tp4">TP4 <b>${p.levels.tp4}</b> (${p.levels.riskReward})</span>
        </div>` : ''}
    </div>
  `;

  document.getElementById('filterBox').style.display = data.proTools ? 'block' : 'none';
  if (data.proTools) {
    const stratSelect = document.getElementById('filterStrategy');
    const strategies = [...new Set(data.signals.map(s => s.strategy).filter(Boolean))];
    if (stratSelect.dataset.built !== strategies.join(',')) {
      stratSelect.innerHTML = '<option value="">All strategies</option>' + strategies.map(s => `<option value="${s}">${s}</option>`).join('');
      stratSelect.dataset.built = strategies.join(',');
    }
  }

  const bestBox = document.getElementById('bestMarketsBox');
  if (data.proTools && data.bestMarkets?.length) {
    bestBox.style.display = 'block';
    document.getElementById('bestMarketsList').innerHTML = data.bestMarkets.slice(0, 5).map(m => `
      <div class="sp-row"><span>${m.label}</span><b>${m.winRate != null ? m.winRate + '% win rate' : '—'} (${m.wins}W / ${m.losses}L)</b></div>
    `).join('');
  } else {
    bestBox.style.display = 'none';
  }

  if (data.elite && aiConfigured !== null) loadAiElite(data);
  else document.getElementById('aiEliteBox').style.display = 'none';

  let ordered = applyFilters(data.signals);
  if (data.proTools) ordered = [...ordered].sort((a, b) => (currentFavourites.includes(b.key) ? 1 : 0) - (currentFavourites.includes(a.key) ? 1 : 0));
  signalsList.innerHTML = ordered.map(s => signalRowHtml(s, data.proTools)).join('') || '<p class="note">No signals match the current filters.</p>';
  signalsList.querySelectorAll('[data-fav-key]').forEach(btn => btn.addEventListener('click', () => toggleFavourite(btn.dataset.favKey)));
}

[document.getElementById('filterConfidence'), document.getElementById('filterStrategy'), document.getElementById('filterDirection'), document.getElementById('filterFavOnly')]
  .forEach(el => el.addEventListener('input', () => { if (lastInsightsData) renderInsights(lastInsightsData); }));

checkBtn.addEventListener('click', async () => {
  const email = currentUser?.email || checkEmailInput.value.trim();
  if (!email) { insightsMsg.textContent = 'Enter your email first, or log in from the Dashboard.'; return; }
  if (!currentUser) rememberEmail(email);
  checkBtn.disabled = true;
  lockedBox.style.display = 'none';
  riskGate.style.display = 'none';
  signalsWrap.style.display = 'none';
  insightsMsg.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/insights?email=${encodeURIComponent(email)}`, { headers: authHeaders() });
    const data = await res.json();
    if (res.status === 402) {
      insightsMsg.textContent = '';
      lockedBox.style.display = 'block';
      return;
    }
    if (!res.ok) { insightsMsg.textContent = data.error || 'Something went wrong.'; return; }

    if (!riskAccepted()) {
      insightsMsg.textContent = '';
      riskGate.style.display = 'block';
      lastInsightsData = data;
      return;
    }
    renderInsights(data);
  } catch (e) {
    insightsMsg.textContent = 'Network error — try again.';
  } finally {
    checkBtn.disabled = false;
  }
});

// Now that every element referenced by updateAuthUI()/loadTrackRecord() is
// declared, resolve the current session and route to whatever the URL hash
// says (both reference currentUser/authHeaders, which don't exist earlier).
refreshMe();
routeFromHash();
