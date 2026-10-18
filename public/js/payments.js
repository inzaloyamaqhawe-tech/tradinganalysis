let paymentAlertVersions = new Set();
let paymentAudio;
const paymentLabels = { pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' };

async function loadPaymentDetails() {
  const form = document.getElementById('proofForm');
  if (!form) return;
  const host = document.getElementById('paymentBank');
  const latest = document.getElementById('latestProof');
  if (!currentUser) {
    host.textContent = 'Log in to see your payment reference and submit proof of payment.';
    form.hidden = true;
    latest.textContent = '';
    document.getElementById('proofFile').value = '';
    document.getElementById('proofMessage').textContent = '';
    return;
  }
  const accountEmail = currentUser.email;
  try {
    const response = await fetch('/api/payments/latest', { headers: authHeaders() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load payment details.');
    if (currentUser?.email !== accountEmail) return;
    const b = data.bank;
    host.innerHTML = `<dl class="bank-details"><dt>Bank</dt><dd>${escapeHtml(b.bank)}</dd><dt>Account holder</dt><dd>${escapeHtml(b.accountHolder)}</dd><dt>Account number</dt><dd>${escapeHtml(b.accountNumber)}</dd><dt>Account type</dt><dd>${escapeHtml(b.accountType)}</dd><dt>Branch code</dt><dd>${escapeHtml(b.branchCode)}</dd><dt>Payment reference</dt><dd><strong>${escapeHtml(data.reference || 'Set your username in My Account')}</strong></dd></dl><p>Use your username as the payment reference. Access starts after admin approval.</p>`;
    const select = document.getElementById('proofPlan');
    if (!select.options.length && PLANS) select.innerHTML = Object.values(PLANS).filter(p => p.key !== 'free').map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)} (R ${Number(p.price).toFixed(2)})</option>`).join('');
    form.hidden = false;
    latest.textContent = data.proof ? `Latest proof: ${new Date(data.proof.uploadedAt).toLocaleString()}, ${paymentLabels[data.proof.status]}. Reference: ${data.proof.reference}. Your next upload replaces this document.` : 'No proof uploaded yet. Your latest proof stays on file after subscription expiry.';
  } catch (e) { if (currentUser?.email === accountEmail) host.textContent = e.message; }
}

document.getElementById('proofForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.getElementById('proofMessage');
  const file = document.getElementById('proofFile').files[0];
  if (!currentUser) { message.textContent = 'Please log in first.'; return; }
  if (!file || !file.size || file.size > 2 * 1024 * 1024) { message.textContent = 'Choose a PDF, PNG or JPEG, up to 2 MB.'; return; }
  if (!confirm('Submit this proof for review? It will replace your previous proof.')) return;
  const button = document.getElementById('proofSubmit');
  button.disabled = true;
  message.textContent = 'Uploading proof...';
  try {
    const response = await fetch(`/api/payments/proof?plan=${encodeURIComponent(document.getElementById('proofPlan').value)}`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed. Your previous proof remains on file.');
    message.textContent = 'Proof received. Awaiting admin approval.';
    document.getElementById('proofFile').value = '';
    await loadPaymentDetails();
  } catch (e) { message.textContent = e.message; }
  finally { button.disabled = false; }
});

function announcePendingPayments(users) {
  const pending = users.filter(u => u.payment?.status === 'pending');
  const alertBox = document.getElementById('paymentAlert');
  const badge = document.getElementById('adminPaymentBadge');
  if (alertBox) { alertBox.hidden = !pending.length; alertBox.textContent = `${pending.length} payment proof${pending.length === 1 ? '' : 's'} awaiting approval.`; }
  if (badge) { badge.hidden = !pending.length; badge.textContent = String(pending.length); }
  const fresh = pending.some(u => !paymentAlertVersions.has(u.payment.version));
  if (fresh && document.getElementById('paymentSound')?.checked && paymentAudio) {
    const oscillator = paymentAudio.createOscillator();
    const gain = paymentAudio.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.12, paymentAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, paymentAudio.currentTime + 0.5);
    oscillator.connect(gain).connect(paymentAudio.destination);
    oscillator.start(); oscillator.stop(paymentAudio.currentTime + 0.5);
  }
  paymentAlertVersions = new Set(pending.map(u => u.payment.version));
}

function bindPaymentActions(host) {
  host.querySelectorAll('.payment-download').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const headers = typeof authHeaders === 'function' ? authHeaders() : { 'x-admin-key': document.getElementById('adminKey').value.trim() };
      const response = await fetch(`/api/admin/payments/proof?email=${encodeURIComponent(button.dataset.email)}&version=${encodeURIComponent(button.dataset.version)}`, { headers });
      if (!response.ok) throw new Error((await response.json()).error || 'Download failed.');
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement('a'); a.href = url; a.download = `payment-proof.${response.headers.get('Content-Type').includes('pdf') ? 'pdf' : response.headers.get('Content-Type').includes('png') ? 'png' : 'jpg'}`;
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { alert(e.message); }
    finally { button.disabled = false; }
  }));
  for (const action of ['approve', 'reject']) host.querySelectorAll(`.payment-${action}`).forEach(button => button.addEventListener('click', async () => {
    if (!confirm(action === 'approve' ? 'Confirm the bank statement matches this proof and approve 30 days on the selected package?' : 'Reject this proof of payment?')) return;
    button.disabled = true;
    try {
      const request = typeof adminApi === 'function' ? adminApi : api;
      const result = await request(`/api/admin/payments/${action}`, { method: 'POST', body: JSON.stringify({ email: button.dataset.email, version: button.dataset.version }) });
      if (result.error) throw new Error(result.error);
      if (typeof loadAdmin === 'function') await loadAdmin(); else await load();
    } catch (e) { alert(e.message); }
    finally { button.disabled = false; }
  }));
}
document.getElementById('refreshPayments')?.addEventListener('click', () => loadAdmin());
document.getElementById('paymentSound')?.addEventListener('change', async event => {
  if (event.target.checked) {
    try { paymentAudio = paymentAudio || new (window.AudioContext || window.webkitAudioContext)(); await paymentAudio.resume(); }
    catch (e) { event.target.checked = false; }
  }
});
window.addEventListener('hashchange', () => {
  if (location.hash === '#/pricing') loadPaymentDetails();
});
if (typeof currentUser !== 'undefined') loadPaymentDetails();
