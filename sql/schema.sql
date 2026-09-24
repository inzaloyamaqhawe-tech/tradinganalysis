-- TradingAnalysis — MySQL schema (Xneelo hosting)
--
-- Source of truth for both this app and the Telegram-signal bot. The bot
-- only ever touches `signals` (see BOT_INSTRUCTIONS.md) — everything else
-- is this app's own. Run this once against a fresh database; every
-- statement is idempotent (CREATE TABLE IF NOT EXISTS / safe ADD COLUMN
-- guards further down) so re-running it after a later schema update is safe.

CREATE TABLE IF NOT EXISTS users (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  -- Nullable: a visitor who just types their email on the Pricing page
  -- (before ever completing full signup) gets a lightweight 'pending' row
  -- with none of these set yet — see upsertPending in storage.js. A full
  -- signup (name/surname/username/password) fills them in.
  first_name        VARCHAR(80)  NULL,
  last_name         VARCHAR(80)  NULL,
  username          VARCHAR(40)  NULL,
  email             VARCHAR(190) NOT NULL,
  password_hash     VARCHAR(255) NULL,
  plan              ENUM('free','premium','pro','elite','elite_max') NOT NULL DEFAULT 'free',
  status            ENUM('pending','active','inactive') NOT NULL DEFAULT 'pending',
  expires_at        DATETIME NULL,
  -- `role` (not just is_admin) matches the column your existing PHP admin
  -- tooling already looks for by convention (see inzalo_yamaqhawe_dashboard's
  -- db.php resolve_agents_schema — 'role' is a recognized candidate there).
  -- is_admin is kept alongside it as a plain boolean for quick app-side
  -- checks; the two are always kept in sync (role='admin' <=> is_admin=1).
  role              ENUM('trader','admin') NOT NULL DEFAULT 'trader',
  is_admin          TINYINT(1) NOT NULL DEFAULT 0,
  favourites        JSON NULL,
  risk_accepted_at  DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token       VARCHAR(64) PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS price_history (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  instrument  VARCHAR(20) NOT NULL,
  price       DECIMAL(24,8) NOT NULL,
  polled_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_price_history_inst_time (instrument, polled_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per recommended setup, whichever produced it. `source` is what
-- separates "our own engine picked this" from "the professional-signal bot
-- posted this" — everything else (status, outcome, hit_history) is read
-- and written the exact same way regardless of source, which is what lets
-- /api/performance poll and display both uniformly.
CREATE TABLE IF NOT EXISTS signals (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source          ENUM('system','bot') NOT NULL DEFAULT 'system',
  instrument      VARCHAR(20) NOT NULL,
  strategy        VARCHAR(40) NULL,
  regime          VARCHAR(30) NULL,
  side            ENUM('BUY','SELL') NOT NULL,
  entry           DECIMAL(24,8) NULL,
  sl              DECIMAL(24,8) NULL,
  tp1             DECIMAL(24,8) NULL,
  tp2             DECIMAL(24,8) NULL,
  tp3             DECIMAL(24,8) NULL,
  tp4             DECIMAL(24,8) NULL,
  confidence      TINYINT UNSIGNED NULL,
  status          ENUM('open','closed') NOT NULL DEFAULT 'open',
  -- The win/loss column you asked for: which target was reached, or SL
  -- (stopped out with none reached), or INVALIDATED (structure changed
  -- before either happened). NULL while still open. "LOST" in plain
  -- English maps to the 'SL' value here — kept as SL rather than a
  -- separate "LOST" enum value so this matches the same vocabulary the
  -- system side of the app already uses everywhere else (API responses,
  -- the Track Record page, this file's own outcome logic).
  outcome         ENUM('TP1','TP2','TP3','TP4','SL','INVALIDATED') NULL,
  best_level      VARCHAR(4) NULL,
  hit_history     JSON NULL,
  posted_by       VARCHAR(80) NULL,   -- bot rows only: which professional/channel this came from (optional, informational)
  alerted_new     TINYINT(1) NOT NULL DEFAULT 0,
  alerted_levels  JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at       DATETIME NULL,
  KEY idx_signals_status (status),
  KEY idx_signals_instrument_time (instrument, created_at DESC),
  KEY idx_signals_source (source)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Global notification feed (a "strong signal generated" event, whether
-- system-detected or bot-posted). `min_plan` gates who sees it, matching
-- the existing Pro+ alert-eligibility rule. Per-user read state is a
-- separate join table below rather than a column here, since one
-- notification is shown to many users.
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  signal_id   BIGINT UNSIGNED NULL,
  type        ENUM('new_signal','level_touch','bot_signal') NOT NULL,
  min_plan    ENUM('free','premium','pro','elite','elite_max') NOT NULL DEFAULT 'pro',
  title       VARCHAR(160) NOT NULL,
  body        VARCHAR(500) NULL,
  instrument  VARCHAR(20) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notifications_signal FOREIGN KEY (signal_id) REFERENCES signals(id) ON DELETE SET NULL,
  KEY idx_notifications_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notification_reads (
  user_id           BIGINT UNSIGNED NOT NULL,
  notification_id   BIGINT UNSIGNED NOT NULL,
  read_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, notification_id),
  CONSTRAINT fk_nr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_nr_notification FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deliberately no pre-seeded admin row here — a blank/placeholder
-- password_hash in SQL is a real login hole waiting to happen. Instead,
-- the app itself checks the signup/login email against ADMIN_EMAIL
-- (server.js) and grants Elite Max + is_admin the moment that account is
-- created with a real, user-chosen password — see server.js's auth routes.
