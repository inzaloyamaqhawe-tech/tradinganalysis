// The 4-tier package structure, in one place so server.js and the frontend
// (via /api/config) both read the same source of truth — no risk of the
// UI advertising a price or feature the backend doesn't actually enforce.
//
// Rank order matters: gating checks use `RANK[plan] >= RANK[required]`, so
// every tier above `required` automatically qualifies too (Elite gets
// everything Pro gets, Pro gets everything Premium gets, etc).

const PLANS = {
  free: {
    key: 'free', label: 'Free Market Watch', price: 0, rank: 0,
    features: [
      'Live prices for every tracked market',
      'Basic charts (line/candles, all timeframes)',
      'Locked premium tools shown clearly, with an upgrade path',
    ],
  },
  premium: {
    key: 'premium', label: 'Premium Insights', price: 45, rank: 1,
    features: [
      'Everything in Free',
      'Bias (bullish/bearish/neutral) on every market',
      'Entry, stop loss, TP1–TP4 on every setup',
      'Confidence score + plain-language explanation',
      'Full, honest track record (wins and losses)',
    ],
  },
  pro: {
    key: 'pro', label: 'Pro Trader Tools', price: 149, rank: 2,
    features: [
      'Everything in Premium Insights',
      'Chart tools: EMA overlays, pattern overlays, Fibonacci, trendline, rectangle, horizontal line, long/short',
      'Save favourite markets',
      'Filter signals by confidence, market, strategy, direction',
      'Email alerts on high-confidence setups and TP/SL touches',
      'Best-performing markets, ranked by real track record',
    ],
  },
  elite: {
    key: 'elite', label: 'AI Elite', price: 299, rank: 3,
    features: [
      'Everything in Pro Trader Tools',
      'AI explanation for every signal — what confirms it, what weakens it, what invalidates it',
      'Ask the AI about any market or setup',
      'Daily AI market summary',
      'AI never promises profit — it explains risk, always',
    ],
  },
};

const RANK = Object.fromEntries(Object.values(PLANS).map(p => [p.key, p.rank]));

// A signed-up-but-never-paid account, or one whose subscription lapsed,
// still gets Free — everyone gets at least that tier just by existing.
function planOf(sub) {
  const active = !!(sub && sub.status === 'active' && sub.plan && sub.expires_at && new Date(sub.expires_at) > new Date());
  return active ? sub.plan : 'free';
}
function atLeast(planKey, requiredKey) {
  return (RANK[planKey] ?? 0) >= (RANK[requiredKey] ?? 0);
}

module.exports = { PLANS, RANK, planOf, atLeast };
