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
}
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

document.getElementById('goPricingBtn')?.addEventListener('click', () => showView('pricing'));

// ---------- Config / demo mode ----------
let isDemo = false;
fetch('/api/config').then(r => r.json()).then(cfg => {
  isDemo = !!cfg.demoMode;
  document.getElementById('demoBanner').style.display = isDemo ? 'block' : 'none';
  document.getElementById('demoPill').style.display = isDemo ? 'inline-block' : 'none';
  document.getElementById('demoBtn').style.display = isDemo ? 'inline-block' : 'none';
  if (cfg.price) {
    document.getElementById('planPrice').innerHTML = `${cfg.price.split('/')[0]} <span>/ month</span>`;
    document.getElementById('lockedPrice').textContent = cfg.price;
  }
}).catch(() => {});

// ---------- Dashboard: live prices ----------
const priceGrid = document.getElementById('priceGrid');
const statUp = document.getElementById('statUp');

function fmtPrice(p) {
  if (p == null) return '—';
  return p >= 100 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function loadPrices() {
  try {
    const res = await fetch('/api/prices');
    const data = await res.json();
    let upCount = 0;
    priceGrid.innerHTML = data.assets.map(a => {
      const cls = a.changePct > 0.001 ? 'up' : a.changePct < -0.001 ? 'down' : 'flat';
      if (a.changePct > 0) upCount++;
      const arrow = a.changePct > 0.001 ? '▲' : a.changePct < -0.001 ? '▼' : '·';
      const chg = a.changePct != null ? `${arrow} ${Math.abs(a.changePct).toFixed(2)}%` : 'loading…';
      return `<button class="card" data-key="${a.key}" data-label="${a.label}">
        <div class="label">${a.label} <span class="hint">view chart →</span></div>
        <div class="price">${a.price != null ? fmtPrice(a.price) : '…'}</div>
        <div class="chg ${cls}">${chg}</div>
      </button>`;
    }).join('');
    statUp.textContent = `${upCount}/${data.assets.length}`;
    priceGrid.querySelectorAll('.card').forEach(el => el.addEventListener('click', () => openChart(el.dataset.key, el.dataset.label)));
  } catch (e) {
    priceGrid.innerHTML = '<div class="card">Failed to load prices — retrying…</div>';
  }
}
loadPrices();
setInterval(loadPrices, 30000);

// ---------- Remember the visitor's email so card clicks know if they're premium ----------
function rememberEmail(email) { try { localStorage.setItem('ta_email', email); } catch (e) {} }
function knownEmail() { try { return localStorage.getItem('ta_email') || ''; } catch (e) { return ''; } }

// ---------- Chart modal: click a card to see its data; premium adds EMA overlays + a trendline tool ----------
const chartModal = document.getElementById('chartModal');
const chartCanvas = document.getElementById('chartCanvas');
const drawCanvas = document.getElementById('drawCanvas');
const chartCtx = chartCanvas.getContext('2d');
const drawCtx = drawCanvas.getContext('2d');
let chartState = null; // { closes, ema8, ema21, levels, min, max }
let drawing = null; // { x1,y1,x2,y2 } trendline the user is sketching

function resizeCanvases() {
  const wrap = chartCanvas.parentElement;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  [chartCanvas, drawCanvas].forEach(c => { c.width = w; c.height = h; });
  if (chartState) renderChart();
}
window.addEventListener('resize', resizeCanvases);

function priceToY(p, min, max, h) {
  if (max === min) return h / 2;
  return h - ((p - min) / (max - min)) * (h - 20) - 10;
}

function renderChart() {
  const { closes, ema8, ema21, levels } = chartState;
  const w = chartCanvas.width, h = chartCanvas.height;
  chartCtx.clearRect(0, 0, w, h);
  if (!closes.length) {
    chartCtx.fillStyle = '#8b98ad'; chartCtx.font = '13px sans-serif';
    chartCtx.fillText('Not enough data yet — check back soon.', 14, h / 2);
    return;
  }
  const all = [...closes, ...(ema8 || []), ...(ema21 || []), ...(levels ? [levels.sl, levels.tp4] : [])];
  const min = Math.min(...all), max = Math.max(...all);

  const plotLine = (series, color, width) => {
    chartCtx.beginPath(); chartCtx.strokeStyle = color; chartCtx.lineWidth = width;
    series.forEach((p, i) => {
      const x = (i / (series.length - 1 || 1)) * w;
      const y = priceToY(p, min, max, h);
      i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
    });
    chartCtx.stroke();
  };

  // subtle fill under the price line
  chartCtx.beginPath();
  closes.forEach((p, i) => {
    const x = (i / (closes.length - 1 || 1)) * w, y = priceToY(p, min, max, h);
    i === 0 ? chartCtx.moveTo(x, y) : chartCtx.lineTo(x, y);
  });
  chartCtx.lineTo(w, h); chartCtx.lineTo(0, h); chartCtx.closePath();
  chartCtx.fillStyle = 'rgba(79,140,255,.08)'; chartCtx.fill();

  plotLine(closes, '#4f8cff', 2);
  if (ema8) plotLine(ema8, '#f2b84b', 1.4);
  if (ema21) plotLine(ema21, '#ff5d6c', 1.4);

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
}

function redrawTrendline() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  if (!drawing) return;
  drawCtx.strokeStyle = '#f2b84b'; drawCtx.lineWidth = 2; drawCtx.setLineDash([]);
  drawCtx.beginPath(); drawCtx.moveTo(drawing.x1, drawing.y1); drawCtx.lineTo(drawing.x2, drawing.y2); drawCtx.stroke();
}

function enableDrawing(enabled) {
  drawCanvas.style.pointerEvents = enabled ? 'auto' : 'none';
}

let isDrawingLine = false;
drawCanvas.addEventListener('mousedown', (e) => {
  const r = drawCanvas.getBoundingClientRect();
  drawing = { x1: e.clientX - r.left, y1: e.clientY - r.top, x2: e.clientX - r.left, y2: e.clientY - r.top };
  isDrawingLine = true;
});
drawCanvas.addEventListener('mousemove', (e) => {
  if (!isDrawingLine || !drawing) return;
  const r = drawCanvas.getBoundingClientRect();
  drawing.x2 = e.clientX - r.left; drawing.y2 = e.clientY - r.top;
  redrawTrendline();
});
window.addEventListener('mouseup', () => { isDrawingLine = false; });

async function openChart(key, label) {
  document.getElementById('chartTitle').textContent = label;
  document.getElementById('chartSub').textContent = 'Loading…';
  document.getElementById('chartLegend').textContent = '';
  document.getElementById('chartLockedNote').style.display = 'none';
  document.getElementById('chartTools').innerHTML = '<span class="note" id="chartLegend"></span>';
  drawing = null;
  chartModal.classList.add('open');
  resizeCanvases();

  const email = knownEmail();
  try {
    const res = await fetch(`/api/history?key=${encodeURIComponent(key)}${email ? `&email=${encodeURIComponent(email)}` : ''}`);
    const data = await res.json();
    chartState = { closes: data.closes || [], ema8: data.ema8, ema21: data.ema21, levels: data.insight?.levels };
    resizeCanvases();

    const rangeTxt = data.high != null ? `Range (tracked window): ${data.low} – ${data.high}` : '';
    document.getElementById('chartSub').textContent = rangeTxt;

    if (data.premium) {
      enableDrawing(true);
      const legend = document.getElementById('chartLegend');
      const insight = data.insight;
      const sigColor = insight?.signal === 'BUY' ? '#2fd480' : insight?.signal === 'SELL' ? '#ff5d6c' : '#8b98ad';
      legend.innerHTML = `<span style="color:#f2b84b;">■</span> EMA8 &nbsp; <span style="color:#ff5d6c;">■</span> EMA21` +
        (insight ? ` &nbsp;·&nbsp; Signal: <strong style="color:${sigColor};">${insight.signal}</strong>${insight.strategy ? ` (${insight.strategy})` : ''}` : '');
      const toolsHost = document.getElementById('chartTools');
      const clearBtn = document.createElement('button');
      clearBtn.className = 'secondary'; clearBtn.textContent = '✏️ Clear my trendline';
      clearBtn.addEventListener('click', () => { drawing = null; redrawTrendline(); });
      toolsHost.appendChild(clearBtn);
    } else {
      enableDrawing(false);
      document.getElementById('chartLockedNote').style.display = 'block';
    }
  } catch (e) {
    document.getElementById('chartSub').textContent = 'Failed to load chart data.';
  }
}

document.getElementById('chartClose').addEventListener('click', () => chartModal.classList.remove('open'));
chartModal.addEventListener('click', (e) => { if (e.target === chartModal) chartModal.classList.remove('open'); });
document.getElementById('chartPricingLink')?.addEventListener('click', () => chartModal.classList.remove('open'));

// ---------- Pricing: subscribe + demo simulate ----------
const subBtn = document.getElementById('subBtn');
const demoBtn = document.getElementById('demoBtn');
const subResult = document.getElementById('subResult');

subBtn.addEventListener('click', async () => {
  const email = document.getElementById('subEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first.'; return; }
  rememberEmail(email);
  subBtn.disabled = true;
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.innerHTML = `${data.instructions}${data.demoMode ? '' : `<br><br><a href="${data.payLink}" target="_blank" rel="noopener">👉 Pay ${data.price} via PayPal</a>`}`;
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  } finally {
    subBtn.disabled = false;
  }
});

demoBtn.addEventListener('click', async () => {
  const email = document.getElementById('subEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first (above).'; return; }
  rememberEmail(email);
  demoBtn.disabled = true;
  try {
    const res = await fetch('/api/demo/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.textContent = `Simulated payment successful for ${email}. Go to Insights and check your email there.`;
    document.getElementById('checkEmail').value = email;
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  } finally {
    demoBtn.disabled = false;
  }
});

// ---------- Insights ----------
const checkBtn = document.getElementById('checkBtn');
const insightsMsg = document.getElementById('insightsMsg');
const lockedBox = document.getElementById('lockedBox');
const signalsWrap = document.getElementById('signalsWrap');
const signalsList = document.getElementById('signalsList');

checkBtn.addEventListener('click', async () => {
  const email = document.getElementById('checkEmail').value.trim();
  if (!email) { insightsMsg.textContent = 'Enter your email first.'; return; }
  rememberEmail(email);
  checkBtn.disabled = true;
  lockedBox.style.display = 'none';
  signalsWrap.style.display = 'none';
  insightsMsg.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/insights?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    if (res.status === 402) {
      insightsMsg.textContent = '';
      lockedBox.style.display = 'block';
      return;
    }
    if (!res.ok) { insightsMsg.textContent = data.error || 'Something went wrong.'; return; }
    insightsMsg.textContent = `Active — renews/expires ${new Date(data.expiresAt).toLocaleDateString()}`;
    signalsWrap.style.display = 'block';
    signalsList.innerHTML = data.signals.map(s => `
      <div class="signal-row">
        <div>
          <div class="name">${s.label}</div>
          <div class="regime">${(s.regime || '').replace('_', ' ').toLowerCase() || ''}${s.strategy ? ' · ' + s.strategy : ''}</div>
        </div>
        <div class="badge ${s.signal}">${s.signal}</div>
        <div></div>
        <div class="sig-note">${s.note}</div>
        ${s.levels ? `
          <div class="levels-strip">
            <span class="level-chip sl">SL <b>${s.levels.sl}</b></span>
            <span class="level-chip">TP1 <b>${s.levels.tp1}</b></span>
            <span class="level-chip">TP2 <b>${s.levels.tp2}</b></span>
            <span class="level-chip">TP3 <b>${s.levels.tp3}</b></span>
            <span class="level-chip tp4">TP4 <b>${s.levels.tp4}</b> (${s.levels.riskReward})</span>
          </div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    insightsMsg.textContent = 'Network error — try again.';
  } finally {
    checkBtn.disabled = false;
  }
});

// ---------- Account ----------
document.getElementById('acctBtn').addEventListener('click', async () => {
  const email = document.getElementById('acctEmail').value.trim();
  const out = document.getElementById('acctResult');
  if (!email) { out.textContent = 'Enter your email first.'; return; }
  rememberEmail(email);
  out.textContent = 'Checking…';
  try {
    const res = await fetch(`/api/insights?email=${encodeURIComponent(email)}`);
    if (res.status === 402) { out.innerHTML = 'No active subscription for this email. <a href="#/pricing">See pricing →</a>'; return; }
    const data = await res.json();
    out.textContent = `Active — expires ${new Date(data.expiresAt).toLocaleDateString()}.`;
  } catch (e) {
    out.textContent = 'Network error — try again.';
  }
});
