// Transactional email via SMTP (works with a free Gmail App Password, or
// any SMTP provider) — configured entirely through env vars so the app
// keeps working with zero setup: no SMTP_HOST means every send just logs
// to the console instead of throwing.
//
// Required env vars to actually send: SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS. Optional: MAIL_FROM (defaults to SMTP_USER).

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (e) { /* dependency not installed yet — sendMail just logs */ }

const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && nodemailer);

const transport = configured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendMail(to, subject, text) {
  if (!configured) {
    console.log(`[mailer] (not configured — no-op) would send to ${to}: "${subject}"`);
    return { sent: false };
  }
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (e) {
    console.error(`[mailer] send failed to ${to}:`, e.message);
    return { sent: false, error: e.message };
  }
}

module.exports = { sendMail, isConfigured: () => configured };
