@echo off
REM Pings the Render-hosted TradingAnalysis app every 25 minutes so its free
REM tier never sits idle long enough to spin down (Render free tier sleeps
REM after ~15 minutes with no requests). Just double-click this and leave the
REM window open, or run it from a terminal whenever you're at your PC — it's
REM a local backup alongside the Xneelo cron / cron-job.org pingers, not a
REM replacement for either.
REM
REM Press Ctrl+C to stop.

setlocal
set "URL=https://tradinganalysis-w9gz.onrender.com/health"
set "INTERVAL_SECONDS=1500"

echo TradingAnalysis keepalive - pinging every 25 minutes.
echo Target: %URL%
echo Press Ctrl+C to stop.
echo.

:loop
echo [%date% %time%] pinging...
curl -s -o NUL -w "  -> status=%%{http_code} time=%%{time_total}s" %URL%
echo.
timeout /t %INTERVAL_SECONDS% /nobreak >nul
goto loop
