-- Migration 0003: incremental sync watermark table (GitHub Actions free-tier
-- redesign). Additive, non-destructive — does not touch launches,
-- sync_runs, or sync_lock. See ../schema.sql for column comments. Apply
-- with:
--   npx wrangler d1 migrations apply pulse-vibe-demo --remote

CREATE TABLE IF NOT EXISTS sync_state (
  state_name             TEXT PRIMARY KEY,
  last_seen_created_at   TEXT,
  last_successful_sync   TEXT,
  launch_cursor          TEXT,
  enrichment_cursor      TEXT,
  creator_refresh_cursor TEXT,
  updated_at             TEXT NOT NULL
);
