// AI Elite tier: Gemini-backed enrichment on top of the deterministic signal
// engine (signals.js). The engine always decides the signal first — AI only
// explains it afterward. Same "ships now, upgrades automatically once a key
// is set" pattern as ResumeBuilderAI's resume.js: with no GEMINI_API_KEY,
// every function below falls back to the templated explanation already
// produced by signals.js, so nothing here is ever a hard dependency.
//
// Risk protection (per spec item 9): every prompt below explicitly forbids
// profit promises and requires risk framing, and every fallback path is
// already risk-framed (signals.js's explainSignal/invalidationNote never
// promise an outcome).

const { explainSignal, invalidationNote, PATTERN_LABEL, STRATEGY_LABEL } = require('./signals');

const isAiConfigured = () => !!process.env.GEMINI_API_KEY;

async function callGemini(prompt, { json = false } = {}) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: json ? { responseMimeType: 'application/json' } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const RISK_RULES = `Rules you must always follow:
- Never promise or imply guaranteed profit, or state a probability of winning as fact.
- Always frame this as educational/informational market structure analysis, not financial advice.
- Always mention what would invalidate the setup.
- Never tell the user how much money or what position size to risk.
- Keep it concise — 3-5 short sentences, plain language, no jargon dump.`;

// Per-signal explanation: why it appeared, what confirms/weakens/invalidates it.
async function explainSignalAi(signal) {
  const fallback = {
    mode: 'template',
    explanation: signal.explanation || explainSignal(signal.strategy, signal.signal, signal.regime),
    invalidation: signal.invalidation || invalidationNote(signal.strategy, signal.signal, signal.levels),
  };
  if (!isAiConfigured()) return fallback;

  const strategyName = signal.strategy === 'PATTERN'
    ? (PATTERN_LABEL[signal.patternName] || 'chart pattern')
    : (STRATEGY_LABEL[signal.strategy] || signal.strategy);

  const prompt = `You are a trading-education assistant explaining a market-structure signal that a rules-based engine already generated (you are not deciding the signal, only explaining it).

Signal: ${signal.instrument} — ${signal.signal} (${signal.regime}, strategy: ${strategyName}, confidence ${signal.confidence}/100)
Entry: ${signal.levels?.entry}, Stop loss: ${signal.levels?.sl}, Targets: ${signal.levels?.tp1}, ${signal.levels?.tp2}, ${signal.levels?.tp3}, ${signal.levels?.tp4}

${RISK_RULES}

Return ONLY valid JSON, no markdown fences: {"explanation": "<why this setup appeared>", "confirms": "<what would confirm/strengthen it>", "invalidation": "<what would invalidate it>"}`;

  try {
    const raw = await callGemini(prompt, { json: true });
    const parsed = JSON.parse(raw.trim().replace(/^```json?\s*/i, '').replace(/```\s*$/, ''));
    return { mode: 'ai', explanation: parsed.explanation, confirms: parsed.confirms, invalidation: parsed.invalidation };
  } catch (e) {
    console.error('[ai] explainSignalAi failed, falling back to template:', e.message);
    return fallback;
  }
}

// Free-form Q&A about a market/setup, scoped to the signal context provided.
async function answerQuestion(question, context) {
  if (!isAiConfigured()) {
    return { mode: 'template', answer: 'AI Q&A needs an AI Elite connection to be configured on the server. In the meantime, check the signal\'s explanation and invalidation notes above for the reasoning behind it.' };
  }
  const prompt = `You are a trading-education assistant. A user is asking about a market you have this context for:

${JSON.stringify(context, null, 2)}

Question: "${question}"

${RISK_RULES}
Answer only using the context given; if the context doesn't cover it, say so rather than guessing.`;
  try {
    const answer = await callGemini(prompt);
    return { mode: 'ai', answer: answer.trim() };
  } catch (e) {
    console.error('[ai] answerQuestion failed:', e.message);
    return { mode: 'template', answer: 'The AI assistant is temporarily unavailable — please try again shortly.' };
  }
}

// Daily summary across all currently-open signals.
async function dailySummary(openSignals) {
  if (!isAiConfigured() || !openSignals.length) {
    return {
      mode: 'template',
      summary: openSignals.length
        ? `${openSignals.length} setup(s) currently open across tracked markets. Review each market's Insights page for full entry/SL/TP detail. Informational only — confirm with your own analysis before acting.`
        : 'No open setups right now — check back after the next signal appears.',
    };
  }
  const brief = openSignals.map(s => `${s.instrument}: ${s.side} via ${s.strategy}, confidence ${s.confidence}`).join('\n');
  const prompt = `You are a trading-education assistant writing a short daily market summary for a subscriber, based on today's open setups from a rules-based signal engine:

${brief}

${RISK_RULES}
Write a single short paragraph summarizing the overall picture across these markets (common themes, standout confidence levels) — do not repeat each line verbatim.`;
  try {
    const summary = await callGemini(prompt);
    return { mode: 'ai', summary: summary.trim() };
  } catch (e) {
    console.error('[ai] dailySummary failed:', e.message);
    return { mode: 'template', summary: `${openSignals.length} setup(s) currently open. Informational only — confirm with your own analysis before acting.` };
  }
}

module.exports = { isAiConfigured, explainSignalAi, answerQuestion, dailySummary };
