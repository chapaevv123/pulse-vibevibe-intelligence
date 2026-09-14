-- Migration 0002: single-flight sync lock table (Phase 4.5 safety fix,
-- after a production incident where an overlapping cron trigger stacked
-- concurrent sync invocations). See src/lock.js and ../schema.sql for the
-- full column-level comments and locking reasoning. Apply with:
--   npx wrangler d1 migrations apply pulse-vibe-demo --remote

CREATE TABLE IF NOT EXISTS sync_lock (
  lock_name   TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
