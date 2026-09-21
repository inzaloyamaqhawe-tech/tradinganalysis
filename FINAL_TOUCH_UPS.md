# TradingAnalysis Final Touch-Ups

Use this file as the final simulation checklist before selling TradingAnalysis as a paid Inzalo Yamaqhawe Technologies product.

Current verified state:
- The app is still safe for simulation if `DATABASE_URL` is not set.
- `server.js` passes syntax check.
- `public/js/app.js` passes syntax check.
- The platform tracks 14 markets: 10 crypto markets plus EUR/USD, GBP/USD, USD/JPY, and XAU/USD.
- The project already has 4 package tiers in `plans.js`.
- The project already has demo activation per paid package.
- PayFast is not added yet. Do not add PayFast until simulation is approved.
- PayPal.me is still the current manual payment path for live mode.
- AI Elite already has a Gemini-based AI layer, but it falls back to template explanations when `GEMINI_API_KEY` is not configured.

## 1. VERIFY SIMULATION MODE FIRST

BOT, do this:

1. Open the project folder.
2. Confirm that I am not using a real `DATABASE_URL`.
3. Start the app with normal `npm start`.
4. Open the app in the browser.
5. Confirm that the demo banner appears.
6. Confirm that payment buttons say "Simulate Payment" for paid tiers.
7. Do not add PayFast.
8. Do not connect real billing yet.
9. Do not promise that a real payment was taken.

Expected result:
- I can create an account.
- I can choose a package.
- I can simulate payment.
- The selected package unlocks the correct features.
- No real money is charged.

## 2. VERIFY THE 4 PACKAGES

BOT, verify these packages exactly.

### Package 1: Free Market Watch

Price:
- Free

This package must work like this:
1. The user opens the platform without paying.
2. The user sees live prices for all 14 markets.
3. The user can open basic charts.
4. The user does not see premium signal details.
5. The user does not see entry, stop loss, TP1-TP4, confidence, AI explanation, or Pro tools.
6. The user sees locked premium areas with a clear upgrade path.

Verify:
- Free users can view prices.
- Free users are blocked from premium insights.
- Free users are encouraged to upgrade without being confused.

### Package 2: Premium Insights

Current price:
- R45/month

This package must work like this:
1. The user chooses Premium Insights.
2. The user simulates payment.
3. The system activates the account as `premium`.
4. The user can open Market Insights.
5. The user sees bias for each market: bullish, bearish, or neutral.
6. The user sees entry, stop loss, TP1, TP2, TP3, and TP4 when a setup exists.
7. The user sees confidence score.
8. The user sees the strategy name, such as CRT, Trend, Breakout, Mean Reversion, or Pattern.
9. The user sees a plain-language explanation.
10. The user sees risk wording that says this is informational only.

Verify:
- Premium unlocks insights.
- Premium does not unlock Pro-only favourites if those are gated.
- Premium does not unlock AI Elite Q&A.

### Package 3: Pro Trader Tools

Current price:
- R149/month

This package must work like this:
1. The user chooses Pro Trader Tools.
2. The user simulates payment.
3. The system activates the account as `pro`.
4. The user gets everything from Premium Insights.
5. The user can use advanced chart tools.
6. The user can see EMA overlays and pattern overlays.
7. The user can use Fibonacci, trendline, rectangle, horizontal line, and long/short drawing tools.
8. The user can save favourite markets.
9. The user can access stronger track-record context.
10. The user should eventually receive email alerts for high-confidence setups and TP/SL touches.

Verify:
- Pro unlocks Premium features.
- Pro unlocks chart tools.
- Pro unlocks favourites.
- Pro does not unlock AI Elite Q&A unless the account is Elite.

### Package 4: AI Elite

Current price:
- R299/month

Decision:
- Keep R299/month for simulation unless I am ready to position this as the highest premium package.
- Later, I can raise it to R369.99/month after AI Q&A, daily summaries, alerts, and trade-journal feedback feel complete.

This package must work like this:
1. The user chooses AI Elite.
2. The user simulates payment.
3. The system activates the account as `elite`.
4. The user gets everything from Pro Trader Tools.
5. The user can request AI explanation for a market setup.
6. The AI explains why the setup appeared.
7. The AI explains what confirms the setup.
8. The AI explains what weakens the setup.
9. The AI explains what invalidates the setup.
10. The AI must never promise profit.
11. The AI must never tell the user exactly how much money to risk.
12. If no `GEMINI_API_KEY` exists, the system must still show safe template explanations.

Verify:
- Elite unlocks AI-only routes.
- Non-Elite users are blocked from AI-only routes.
- AI output is educational, not financial advice.

## 3. FIX WORDING BEFORE SELLING

BOT, update wording wherever needed.

Do this:
1. Replace old "12 markets" wording with "14 markets".
2. Replace old "simple SMA crossover" wording with "market-structure engine".
3. Replace "buy/sell signals" wording with safer wording like "bullish/bearish market bias".
4. Keep "informational only" visible on premium screens.
5. Update the risk disclosure so it does not only mention R45/month, because there are now 4 packages.
6. Update README so it matches the current system.

Correct wording to use:
- "TradingAnalysis provides market-structure insights across 14 tracked markets."
- "The platform is informational only and does not provide financial advice."
- "Premium tiers unlock deeper analysis, chart tools, and AI explanations depending on the selected package."
- "Past performance and track record statistics do not guarantee future results."

## 4. KEEP PAYMENT SIMPLE FOR NOW

BOT, do not add PayFast now.

Do this now:
1. Keep simulation payment working.
2. Keep PayPal.me as the manual live-payment placeholder.
3. Keep admin/manual activation available.
4. Make sure the user understands that real billing is not automated yet.

Do later:
1. Add PayFast only after simulation is approved.
2. Add webhook payment confirmation.
3. Add automatic package activation.
4. Add failed-payment handling.
5. Add cancellation handling.
6. Add upgrade/downgrade handling.

Final payment rule:
- Simulation first.
- Manual PayPal second.
- PayFast automation later.

## 5. VERIFY THE TRADING FEATURES STEP BY STEP

BOT, test the signal system like this:

1. Open the dashboard.
2. Confirm that all 14 markets appear.
3. Open a crypto chart.
4. Confirm candles load.
5. Open an FX or gold chart.
6. If candles are missing, remember that Twelve Data needs `TWELVEDATA_API_KEY`.
7. Log in as a Free user.
8. Confirm premium insights are locked.
9. Activate Premium in simulation.
10. Confirm insights unlock.
11. Check one market with a setup.
12. Confirm entry, SL, TP1, TP2, TP3, TP4 appear.
13. Confirm confidence score appears.
14. Confirm the strategy name appears.
15. Confirm the explanation appears.
16. Confirm the risk wording appears.

Expected result:
- The user understands what the engine sees.
- The user is not told that profit is guaranteed.
- The user can compare the signal with the chart.

## 6. VERIFY TRACK RECORD HONESTY

BOT, test the track record like this:

1. Open Track Record as a logged-out user.
2. Confirm closed historical setups can be shown.
3. Confirm open live setups do not leak paid signal details to Free users.
4. Log in as Premium or higher.
5. Confirm premium users can see more detail on open setups.
6. Confirm wins and losses both appear.
7. Confirm invalidated setups appear honestly.

Expected result:
- The platform does not look like a fake highlight reel.
- Members can trust that losses are not hidden.

## 7. VERIFY ADMIN FLOW

BOT, test admin like this:

1. Open `/admin.html`.
2. Enter the admin key.
3. Load subscribers.
4. Activate a test email for 30 days.
5. Activate each plan one by one: premium, pro, elite.
6. Confirm the account page shows the correct active plan.
7. Deactivate the test user.
8. Confirm the user goes back to Free access.

Important:
- Before going live, change `ADMIN_KEY`.
- Do not use `change-me-admin-key` in production.

## 8. VERIFY AI ELITE SAFETY

BOT, test AI Elite like this:

1. Activate a user as Elite in simulation.
2. Open a chart.
3. Click AI explanation if available.
4. Confirm the response explains the setup.
5. Confirm the response mentions risk or invalidation.
6. Confirm the response does not promise profit.
7. Confirm Premium and Pro users cannot access Elite AI routes.
8. Test with no `GEMINI_API_KEY`.
9. Confirm template fallback still works.
10. Test with `GEMINI_API_KEY` later.

Expected result:
- Elite works with AI when configured.
- Elite still works safely without AI key.
- AI is an education layer, not the trading engine itself.

## 9. FINAL COPY TO SHOW USERS

Use this product description:

"TradingAnalysis is a market-structure insight platform powered by Inzalo Yamaqhawe Technologies. It tracks 14 markets and helps members understand bullish, bearish, or neutral conditions using structured analysis, risk levels, historical track record, and optional AI explanations. It is informational only and does not provide financial advice."

Use this pricing intro:

"Choose the level that fits how you trade. Free users can monitor live markets. Premium members unlock market insights. Pro members unlock deeper chart tools and workflow features. AI Elite members unlock AI-assisted explanations and summaries. No result is guaranteed."

Use this risk line:

"Trading carries risk. Every setup shown here is for educational and informational purposes only. Confirm all ideas with your own analysis before making any trading decision."

## 10. DO NOT LAUNCH UNTIL THESE PASS

BOT, only mark the product ready for early members after this checklist passes:

1. Signup works.
2. Login works.
3. Logout works.
4. Free package works.
5. Premium package works.
6. Pro package works.
7. Elite package works.
8. Demo activation works.
9. Admin activation works.
10. Insights page works.
11. Chart modal works.
12. Track record works.
13. Risk disclosure is visible.
14. README matches the real product.
15. Admin key is not the default.
16. No PayFast promise appears in the UI.
17. No guaranteed-profit wording appears anywhere.

Final instruction:
- Keep building in simulation.
- Verify every tier.
- Polish wording.
- Only add real payment automation after the simulated member journey feels complete.
