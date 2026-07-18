-- ============================================================================
-- Migration: add `events` table for per-customer audit trail.
-- ============================================================================
-- Run via:
--   wrangler d1 execute stacked-captions-db --remote --file=./schema/add-events.sql
--
-- Idempotent — re-running is safe.
--
-- Event types currently logged:
--   license_minted          new license created (LS webhook or admin endpoint)
--   license_status_changed  status field changed value (cancelled, past_due, ...)
--   license_plan_changed    plan changed (monthly -> annual)
--   license_renewed         subscription_payment_success
--   license_payment_failed  past_due triggered
--   machine_activated       first time a fingerprint was seen
--   ai_call                 AI proxy call (Anthropic or ElevenLabs). cost_micro_usd populated.
--   update_downloaded       installer download initiated via /v1/download-installer
--
-- The `detail` column holds event-specific JSON (e.g. {"from":"active","to":"cancelled"}).
-- Most queries should filter by license_key + created_at.
-- ============================================================================

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,        -- ms since epoch
  license_key     TEXT,                    -- nullable: some events are system-wide
  email           TEXT,                    -- denormalised for lookup-without-join
  event_type      TEXT    NOT NULL,
  detail          TEXT,                    -- JSON-encoded event-specific data
  cost_micro_usd  INTEGER DEFAULT 0        -- only populated for ai_call events
);

CREATE INDEX IF NOT EXISTS idx_events_license_key ON events(license_key, created_at);
CREATE INDEX IF NOT EXISTS idx_events_email       ON events(email,       created_at);
CREATE INDEX IF NOT EXISTS idx_events_type        ON events(event_type,  created_at);
