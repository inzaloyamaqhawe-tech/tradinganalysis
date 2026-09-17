// Real OHLC candles for FX/metals via Twelve Data's free-tier REST API
// (https://twelvedata.com — free signup, no cost, ~800 requests/day).
//
// Without this, GBPUSD/XAUUSD charts have no real candle feed at all (unlike
// crypto, which gets real candles straight from the exchange) — they rely on
// bucketing our OWN polled price history into synthetic hourly candles,
// which needs ~42 hours of uninterrupted uptime before the engine has enough
// data to read. On a service that redeploys often, that basically never
// finishes, so the "fan favourite" gold/FX charts always look broken. Once
// TWELVEDATA_API_KEY is set, this replaces that synthetic bootstrap with
// real candles immediately, exactly like the crypto path already has.

const configured = () => !!process.env.TWELVEDATA_API_KEY;

async function getCandles(symbol, interval = '1h', outputsize = 100) {
  const params = new URLSearchParams({
    symbol, interval, outputsize: String(outputsize),
    timezone: 'UTC', // so `datetime` is unambiguous and safely parseable as UTC below
    apikey: process.env.TWELVEDATA_API_KEY,
  });
  const res = await fetch(`https://api.twelvedata.com/time_series?${params}`);
  const json = await res.json();
  if (json.status === 'error' || !Array.isArray(json.values)) {
    throw new Error(`Twelve Data error for ${symbol}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
  }
  // Twelve Data returns most-recent-first; the engine needs chronological order.
  return json.values
    .map(v => ({ open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close), time: new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() }))
    .reverse();
}

module.exports = { getCandles, isConfigured: configured };
