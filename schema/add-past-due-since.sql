-- v1.0.7 migration: add the past_due grace anchor column.
-- Run BEFORE deploying the v1.0.7 worker (the new code reads/writes this column):
--   npx wrangler d1 execute stacked-captions-db --remote --file schema/add-past-due-since.sql --yes
-- Idempotency: SQLite has no "ADD COLUMN IF NOT EXISTS"; run once. Re-running
-- errors with "duplicate column name" (harmless, means it's already applied).
ALTER TABLE licenses ADD COLUMN past_due_since INTEGER;

-- Backfill: stamp currently-past_due licenses so their 3-day grace is anchored
-- to when they actually went past_due (updated_at = the moment the
-- payment_failed webhook set status='past_due'). Without this they'd fail OPEN
-- (unlimited grace) because past_due_since would be NULL.
UPDATE licenses SET past_due_since = updated_at WHERE status = 'past_due' AND past_due_since IS NULL;
