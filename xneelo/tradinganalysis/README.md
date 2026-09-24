# TradingAnalysis on Xneelo

TradingAnalysis itself is a Node.js app and **stays on Render** — Xneelo's
hosting doesn't run Node processes. This folder is everything that *does*
belong on Xneelo: the URL redirect and the keepalive cron script. It's kept
separate from `inzalo_yamaqhawe_dashboard/` (the shop) on purpose — its own
project, not nested under shop.

## 1. Where this goes

Upload this whole `tradinganalysis/` folder to your Xneelo docroot, as a
sibling of `inzalo_yamaqhawe_dashboard/` — so you end up with:

```
/ (docroot)
├── inzalo_yamaqhawe_dashboard/   (unchanged, the shop)
├── tradinganalysis/              (this folder)
│   └── keepalive.php
└── .htaccess
```

## 2. The `/tradinganalysis` URL

Add the rule in `htaccess-snippet.txt` to your root `.htaccess` (the one
with the `/shop` rule) — see that file for exactly where. It's a **redirect**
to the Render app, not a reverse proxy.

Why a redirect and not a seamless same-domain proxy: TradingAnalysis's
frontend calls its own API with root-relative paths (`/api/prices`, etc).
A proxy would need those calls to still land back on Render even though the
page is served from `iytechnologies.co.za/tradinganalysis/...` — which
either needs Apache to proxy `/api/*` at your domain's root too (risky if
anything else ever needs that path) or a frontend rework to use a
configurable base path. A redirect has none of that risk: the visitor's
browser bar shows the Render URL after clicking through, but everything
about the app — including live prices and the signal engine — keeps working
exactly as tested. If you'd rather have the seamless version later, it's
doable, just a separate, larger piece of work.

## 3. Keeping the Render free tier awake

Render's free tier spins the app down after ~15 minutes with no requests;
the next real visitor then eats a 30-60 second cold start. `keepalive.php`
pings the app's `/health` endpoint (a trivial, instant, no-database route
built for exactly this) on a schedule so that never happens.

**Set up a cron job in cPanel:**
1. cPanel → **Cron Jobs**.
2. Add a new cron job, schedule **every 10 minutes** (if your plan only
   allows coarser intervals, use the smallest one available under 15 min —
   anything less frequent risks missing the sleep window).
3. Command:
   ```
   php /home/YOUR_CPANEL_USER/public_html/tradinganalysis/keepalive.php > /dev/null 2>&1
   ```
   (adjust the path to wherever this folder actually landed under your
   account — cPanel's Cron Jobs page shows you the exact home directory
   path to use).
4. Save. After ~10-20 minutes, check `tradinganalysis/keepalive.log` in
   this folder (via File Manager or FTP) — you should see timestamped lines
   like `status=200 time=312ms body={"ok":true}`. If you instead see
   `error="..."` or no file appears at all, the cron isn't reaching the
   script — double check the path in step 3.

That's the whole setup — no code on the Render side needed, `/health`
already exists and does nothing but return `{"ok":true}` instantly.
