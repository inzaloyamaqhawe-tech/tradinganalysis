# Instructions for the Telegram XAU signal bot

This is the exact contract for how the bot posts a new signal and later
updates it when it wins or loses. The bot only ever touches the `signals`
table (see `schema.sql`) — nothing else in this database is its concern.

Everything below assumes the bot only posts **XAU/USD** signals sourced from
professional Telegram channels. If that ever changes, the `instrument`
column already supports any symbol — nothing else needs to change.

## 0. Dedupe across channels before posting

If the bot watches multiple professional channels and more than one of them
calls the **same direction** (e.g. all 3 say SELL) within a short window of
each other, post **one** row for that call, not one per channel. Two or
three simultaneous rows for what's really the same signal just fills the
table with noise and makes the track record misleading (it would look like
3 separate calls with 3 separate outcomes for what was actually one trade
idea). If different channels genuinely disagree (one says BUY, another
SELL), that's a real conflict — use your own judgement on which one to post,
or skip posting until they agree; don't post both.

## 1. Posting a brand-new signal

The instant a professional's XAU call is picked up, insert one row:

```sql
INSERT INTO signals
  (source, instrument, strategy, side, entry, sl, tp1, tp2, tp3, tp4, confidence, status, posted_by, created_at)
VALUES
  ('bot', 'XAUUSD', 'PROFESSIONAL', 'BUY', 4310.50, 4295.00, 4318.00, 4326.00, 4334.00, 4342.00, NULL, 'open', 'channel-name-or-handle', NOW());
```

Field notes:
- `source` — always the literal string `'bot'` for anything you post. This is how the app tells your rows apart from its own.
- `instrument` — always `'XAUUSD'` for now.
- `strategy` — always the literal string `'PROFESSIONAL'`. The app shows this to users as "Analyzed by our professional trading team."
- `side` — `'BUY'` or `'SELL'`, exactly (uppercase).
- `entry` / `sl` / `tp1`-`tp4` — plain decimal numbers, no currency symbols or commas. `tp1`-`tp4` don't all have to be filled in if the professional only gave one or two targets — leave the rest `NULL`.
- `confidence` — optional, `0`-`100` if the professional gives one, otherwise `NULL`.
- `posted_by` — optional, whatever identifies which channel/professional this came from. Purely informational, never shown as a guarantee.
- `created_at` — **must be the real time you're posting it**, in UTC. This timestamp is what the app uses to decide whether XAU is "fresh enough" (posted within the last 20 minutes of a user's login) to show as the top-priority setup — an old or backdated timestamp will make it look stale immediately.
- `status` — always `'open'` on the initial insert.

The insert returns/generates an auto-increment `id` — keep it, you'll need it for the update below.

## 2. Updating a signal once it wins or loses

**Do not insert a new row for the same call.** Update the same row by its `id`:

**If a target was hit (win):**
```sql
UPDATE signals
SET status = 'closed', outcome = 'TP2', closed_at = NOW()
WHERE id = 123;
```
`outcome` must be exactly one of `'TP1'`, `'TP2'`, `'TP3'`, or `'TP4'` — whichever target was actually reached. If more than one target was hit before it closed, use the **highest** one reached (TP4 beats TP3 beats TP2 beats TP1) — never downgrade a reached target to a loss even if price later reversed hard, and never post two updates for one trade.

**If it was stopped out with no target reached (loss):**
```sql
UPDATE signals
SET status = 'closed', outcome = 'SL', closed_at = NOW()
WHERE id = 123;
```
Use `'SL'` for a straightforward loss. (In the app's own UI this is shown to users as the trade having lost — "SL" is just the internal value.)

**If the professional themselves cancelled/invalidated the call before it hit anything:**
```sql
UPDATE signals
SET status = 'closed', outcome = 'INVALIDATED', closed_at = NOW()
WHERE id = 123;
```

That's the entire contract — one INSERT to post, one UPDATE to resolve. The
app polls this table on its own; you never need to tell it anything beyond
keeping these rows accurate.

## 3. A couple of things NOT to do

- Never post more than one **open** XAU row at a time. If a new professional
  call comes in while a previous one is still open, either wait for the
  current one to resolve, or update/close the stale one first (e.g. as
  `INVALIDATED`) before inserting the new one. Two simultaneously-open XAU
  rows will confuse which one the app treats as "the" current pick.
- Never edit `entry`, `sl`, or `tp1`-`tp4` after the initial insert — only
  `status`, `outcome`, and `closed_at` change on the update.
- Timestamps are UTC, not SAST (South Africa is UTC+2) — make sure whatever
  posts to `created_at`/`closed_at` accounts for that, or the 20-minute
  freshness window will be off by 2 hours.
