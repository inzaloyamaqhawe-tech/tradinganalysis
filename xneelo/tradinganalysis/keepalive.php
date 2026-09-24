<?php
// Pings the Render-hosted TradingAnalysis app on a schedule (via a Xneelo
// cron job — see README.md in this folder) so its free-tier instance never
// sits idle long enough to spin down. Render's free tier sleeps after ~15
// minutes with no requests; a cold start after that takes the next real
// visitor 30-60+ seconds. Run this every 10 minutes and it never happens.
//
// Hits /health specifically — a tiny, side-effect-free endpoint that does
// no DB work and returns instantly, so this never itself becomes a load
// problem. Logs each run so you can confirm the cron is actually firing.

$target = 'https://tradinganalysis-w9gz.onrender.com/health';
$logFile = __DIR__ . '/keepalive.log';

$start = microtime(true);
$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 25,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_USERAGENT => 'IYT-Xneelo-Keepalive/1.0',
]);
$body = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);
$elapsedMs = round((microtime(true) - $start) * 1000);

$line = sprintf(
    "[%s] status=%s time=%dms %s\n",
    date('Y-m-d H:i:s'),
    $httpCode ?: 'no-response',
    $elapsedMs,
    $error ? "error=\"$error\"" : "body=" . trim((string)$body)
);

// Keep the log from growing forever — trim to the last ~500 lines every run.
$existing = is_file($logFile) ? file($logFile, FILE_IGNORE_NEW_LINES) : [];
$existing[] = trim($line);
if (count($existing) > 500) $existing = array_slice($existing, -500);
file_put_contents($logFile, implode("\n", $existing) . "\n");

// Cron output is normally discarded, but echo too in case this is ever hit
// directly in a browser to sanity-check it's working.
echo $line;
