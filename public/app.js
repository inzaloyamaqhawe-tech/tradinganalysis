const priceGrid = document.getElementById('priceGrid');
const priceLabel = document.getElementById('priceLabel');
const subBtn = document.getElementById('subBtn');
const demoBtn = document.getElementById('demoBtn');
const demoBanner = document.getElementById('demoBanner');
const checkBtn = document.getElementById('checkBtn');
const subResult = document.getElementById('subResult');
const insightsPanel = document.getElementById('insightsPanel');
const signalsList = document.getElementById('signalsList');
let isDemo = false;

fetch('/api/config').then(r => r.json()).then(cfg => {
  isDemo = !!cfg.demoMode;
  demoBanner.style.display = isDemo ? 'block' : 'none';
  demoBtn.style.display = isDemo ? 'inline-block' : 'none';
}).catch(() => {});

function fmtPrice(p) {
  if (p == null) return '—';
  if (p >= 100) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return p.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function loadPrices() {
  try {
    const res = await fetch('/api/prices');
    const data = await res.json();
    priceLabel.textContent = data.price || 'R45/month';
    priceGrid.innerHTML = data.assets.map(a => {
      const cls = a.changePct > 0.001 ? 'up' : a.changePct < -0.001 ? 'down' : 'flat';
      const arrow = a.changePct > 0.001 ? '▲' : a.changePct < -0.001 ? '▼' : '·';
      const chg = a.changePct != null ? `${arrow} ${Math.abs(a.changePct).toFixed(2)}%` : 'loading…';
      return `<div class="card">
        <div class="label">${a.label}</div>
        <div class="price">${a.price != null ? fmtPrice(a.price) : '…'}</div>
        <div class="chg ${cls}">${chg}</div>
      </div>`;
    }).join('');
  } catch (e) {
    priceGrid.innerHTML = '<div class="card">Failed to load prices — retrying…</div>';
  }
}

subBtn.addEventListener('click', async () => {
  const email = document.getElementById('subEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first.'; return; }
  subBtn.disabled = true;
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.innerHTML = `${data.instructions}<br><br><a href="${data.payLink}" target="_blank" rel="noopener">👉 Pay ${data.price} via PayPal</a>`;
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  } finally {
    subBtn.disabled = false;
  }
});

demoBtn.addEventListener('click', async () => {
  const email = document.getElementById('subEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first (in the box above).'; return; }
  demoBtn.disabled = true;
  try {
    const res = await fetch('/api/demo/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.textContent = `Simulated payment successful for ${email} — now click "View My Insights" below using the same email.`;
    document.getElementById('checkEmail').value = email;
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  } finally {
    demoBtn.disabled = false;
  }
});

checkBtn.addEventListener('click', async () => {
  const email = document.getElementById('checkEmail').value.trim();
  if (!email) { subResult.textContent = 'Enter your email first.'; return; }
  checkBtn.disabled = true;
  try {
    const res = await fetch(`/api/insights?email=${encodeURIComponent(email)}`);
    const data = await res.json();
    if (res.status === 402) {
      subResult.innerHTML = `${data.message} <a href="${data.payLink}" target="_blank" rel="noopener">Subscribe (${data.price})</a>`;
      insightsPanel.style.display = 'none';
      return;
    }
    if (!res.ok) { subResult.textContent = data.error || 'Something went wrong.'; return; }
    subResult.textContent = '';
    insightsPanel.style.display = 'block';
    signalsList.innerHTML = data.signals.map(s => `
      <div class="signal-row">
        <div><strong>${s.label}</strong></div>
        <div class="badge ${s.signal}">${s.signal}</div>
        <div class="sig-note">${s.note}</div>
      </div>
    `).join('');
  } catch (e) {
    subResult.textContent = 'Network error — try again.';
  } finally {
    checkBtn.disabled = false;
  }
});

loadPrices();
setInterval(loadPrices, 30000);
