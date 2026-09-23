# TradingAnalysis

Live market dashboard (10 major crypto pairs + EUR/USD, GBP/USD, USD/JPY, XAU/USD
— 14 markets tracked) with a 4-tier subscription structure.

## Packages
- **Free Market Watch** (free) — live prices, basic charts, all 14 markets.
- **Premium Insights** (R45/month) — bias, entry/SL/TP1-4, confidence score, plain-language explanation, full track record.
- **Pro Trader Tools** (R149/month) — everything in Premium + EMA/pattern/Fibonacci/trendline chart tools, favourite markets, signal filters, email alerts on high-confidence setups and TP/SL touches, best-performing-markets leaderboard.
- **AI Elite** (R299/month) — everything in Pro + AI signal explanations, ask-the-AI, daily AI market summary. Falls back to templated (non-AI) explanations if no `GEMINI_API_KEY` is set — never blocks the feature, just skips the AI layer.

Plan structure lives in one place: [`plans.js`](plans.js). Both the backend gating (`server.js`) and the frontend pricing page (`public/js/app.js` via `/api/config`) read from it, so a price/feature can't drift between what's advertised and what's enforced.

## How it works
- Signal engine (`signals.js`, ported from `BOTS/universal.py`): ATR-relative regime classification (ranging/trending/breakout/quiet) with 5 regime-matched strategies (CRT, trend-pullback, breakout, mean-reversion, classic chart pattern), TP1-4/SL ladder at a disciplined 1:2 risk:reward. Three higher-priority strategies run ahead of that regime-based cascade, each a strict, deliberately rare-firing setup — crypto only (see `smc.js`'s integration note in `server.js` for why FX/gold are excluded: Twelve Data's free-tier daily quota):
  - `wyckoff.js` — accumulation/distribution range, a volume-confirmed Spring/Upthrust liquidity sweep, then a Change-of-Character confirmation candle.
  - `smc.js` — Smart Money Concepts: 4H market structure for directional bias, an unmitigated 1H order block/fair value gap as the key zone, a 15min liquidity-sweep-and-reclaim as entry confirmation.
  - `volatility.js` — ATR(14)/ATR(50) compression below 0.6 flags a pre-breakout state, then a Donchian(20) breakout on 1.5x+ volume, filtered to only fire with the higher-timeframe trend.
- The `/api/insights` page still shows a live read for every tracked market — a Premium+ user can go for their own pick even when a higher-confidence setup exists elsewhere. The **database** (and therefore the Track Record page) only ever logs a single active recommendation at a time: the highest-confidence actionable setup across every market, posted once nothing is already pending, and resolved (win/loss/invalidated) via real candle history (`resolveSignalFromCandles` in `server.js`) before the next one is considered. This keeps stored data small, keeps the track record an honest one-call-at-a-time history instead of 14 markets' worth of simultaneous rows, and means every visitor sees the exact same recommendation regardless of when they log in — posting is driven by server-side poll state, not by who's asking.
- Alerts (Pro+): a new high-confidence signal or a TP/SL touch emails active Pro/Elite subscribers, deduplicated per signal so a redeploy or slow poll cycle never double-sends.
- AI layer (`ai.js`, Elite only): Gemini-backed per-signal explanations, market Q&A, and daily summaries — always risk-framed, never promises profit. Ships with a templated fallback so nothing breaks without a key.
- Subscriptions are activated **manually** for now: a customer picks a plan, pays via the PayPal link, then an admin activates them (with the matching plan) in `/admin.html` using the admin key. There is no PayPal subscriptions/PayFast/Yoco/Stripe webhook integration yet — that's the next step to fully automate billing.

## Environment variables
- `DATABASE_URL` — Postgres connection string (omit for in-memory demo mode)
- `ADMIN_KEY` — secret required to use `/admin.html` and the admin API
- `PAYPAL_HANDLE` — PayPal.me handle, defaults to `IYTechnologies`
- `TWELVEDATA_API_KEY` — real OHLC candles for FX/gold (optional; falls back to a synthetic candle bootstrap without it)
- `GOLD_API_KEY` — optional, raises gold-api.com's anonymous rate limit
- `GEMINI_API_KEY` / `GEMINI_MODEL` — enables the AI Elite layer (optional; templated fallback otherwise)

## Local dev
```
npm install
DATABASE_URL=postgres://... ADMIN_KEY=devkey npm start
```
