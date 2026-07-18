-- Stacked Captions backend schema (D1 / SQLite).
-- Timestamps are JS-style ms-since-epoch (Date.now()).

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  customer_id TEXT,                     -- Lemon Squeezy customer id (filled in Phase 4c)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  key                TEXT    PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'active',  -- active | trial | paused | expired | refunded
  plan               TEXT,                               -- monthly | annual | trial
  expires_at         INTEGER,                            -- ms epoch, null = no expiry
  machines_allowed   INTEGER NOT NULL DEFAULT 2,
  subscription_id    TEXT,                               -- Lemon Squeezy subscription id (Phase 4c)
  ai_calls_today          INTEGER NOT NULL DEFAULT 0,    -- legacy call counter, kept for stats only
  ai_calls_reset_at       INTEGER NOT NULL DEFAULT 0,    -- ms epoch of next counter reset (midnight UTC)
  ai_cost_today_micro_usd INTEGER NOT NULL DEFAULT 0,    -- accumulated cost today in micro-USD (1 µUSD = $1e-6)
  past_due_since     INTEGER,                            -- ms epoch the license first entered past_due (v1.0.7 grace anchor); NULL when not past_due
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS machines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key   TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  os            TEXT,                                   -- "windows" / "darwin"
  app_version   TEXT,                                   -- plugin version string
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  FOREIGN KEY (license_key) REFERENCES licenses(key),
  UNIQUE (license_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_licenses_user      ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_sub       ON licenses(subscription_id);
CREATE INDEX IF NOT EXISTS idx_machines_license   ON machines(license_key);
CREATE INDEX IF NOT EXISTS idx_machines_lastseen  ON machines(last_seen_at);
