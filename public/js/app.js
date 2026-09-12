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
      return `<div class="card">
        <div class="label">${a.label}</div>
        <div class="price">${a.price != null ? fmtPrice(a.price) : '…'}</div>
        <div class="chg ${cls}">${chg}</div>
      </div>`;
    }).join('');
    statUp.textContent = `${upCount}/${data.assets.length}`;
  } catch (e) {
    priceGrid.innerHTML = '<div class="card">Failed to load prices — retrying…</div>';
  }
}
loadPrices();
setInterval(loadPrices, 30000);

// ---------- Pricing: subscribe + demo simulate ----------
const subBtn = document.getElementById('subBtn');
const demoBtn = document.getElementById('demoBtn');
const subResult = document.getElementById('subResult');

subBtn.addEventListener('click', async () => {
  const email = document.getElementById('subEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first.'; return; }
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
