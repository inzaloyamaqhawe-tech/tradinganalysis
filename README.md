# TradingAnalysis

Live market dashboard (10 major crypto pairs + GBP/USD + Gold) with a paid
buy/sell insights tier.

## How it works
- Free: live prices, refreshed every 30s in the browser, polled server-side every 10 min from public market data (Crypto.com public exchange API for crypto, Frankfurter for GBP/USD, gold-api.com for XAU/USD).
- Paid (R45/month via PayPal.me/IYTechnologies): unlocks a simple BUY/SELL/HOLD read per market, computed from our own tracked price history (SMA-crossover). Informational only, not financial advice.
- Subscriptions are activated **manually** for now: a customer pays via the PayPal link, then an admin marks them active in `/admin.html` using the admin key. There is no PayPal subscriptions/webhook integration yet — that would be the next step to fully automate billing.

## Environment variables
- `DATABASE_URL` — Postgres connection string
- `ADMIN_KEY` — secret required to use `/admin.html` and the admin API
- `PAYPAL_LINK` — defaults to `https://paypal.me/IYTechnologies/45`
- `PRICE_LABEL` — defaults to `R45/month`

## Local dev
```
npm install
DATABASE_URL=postgres://... ADMIN_KEY=devkey npm start
```
