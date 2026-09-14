-- PULSE x VIBE/VIBE PUBLIC DEMO — D1 SCHEMA
-- =============================================
-- Isolated demo schema. NOT a copy of data/pulse.db (the private production
-- database). No fixture rows are shipped here — the deployed Worker builds
-- its own clean LIVE dataset by polling the public vibe/vibe API.

-- Single-flight guard (added Phase 4.5, after a production incident where an
-- overlapping cron trigger stacked concurrent sync invocations). At most one
-- row ever exists (lock_name is a fixed constant, "vibe_sync") — a sync
-- invocation atomically acquires it via INSERT...ON CONFLICT DO UPDATE...
-- WHERE expires_at < now, which only succeeds if no lock exists or the
-- existing one has expired. See src/lock.js for full reasoning and TTL.
CREATE TABLE IF NOT EXISTS sync_lock (
  lock_name   TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- Incremental sync watermark (added for the GitHub Actions free-tier
-- redesign — see docs/DEPLOYMENT.md). A single row (state_name='vibe_sync')
-- lets each cycle process only launches newer than last_seen_created_at
-- instead of rescanning/recomputing the full historical dataset every run.
-- Advanced ONLY after a cycle completes successfully — a failed/aborted
-- cycle leaves the watermark untouched so nothing is silently skipped.
CREATE TABLE IF NOT EXISTS sync_state (
  state_name             TEXT PRIMARY KEY,
  last_seen_created_at   TEXT,
  last_successful_sync   TEXT,
  launch_cursor          TEXT,
  enrichment_cursor      TEXT,
  creator_refresh_cursor TEXT,
  updated_at             TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  run_id            TEXT PRIMARY KEY,
  run_type          TEXT NOT NULL,               -- 'SYNC' | 'CRON_SYNC'
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,                -- 'RUNNING'|'COMPLETED'|'FAILED'|'SKIPPED_LOCKED'|'FAILED_LOCK_LOST'|'FAILED_TIME_BUDGET'|'FAILED_OPERATION_TIMEOUT'
  source            TEXT,                          -- 'LIVE' (no fixture fallback in the public demo)
  pages_fetched     INTEGER DEFAULT 0,
  launches_seen     INTEGER DEFAULT 0,
  launches_new      INTEGER DEFAULT 0,
  snapshots_written INTEGER DEFAULT 0,
  creators_updated  INTEGER DEFAULT 0,
  scores_written    INTEGER DEFAULT 0,
  error             TEXT,
  notes_json        TEXT
);

CREATE TABLE IF NOT EXISTS launches (
  token_address         TEXT PRIMARY KEY,
  chain_id              INTEGER NOT NULL,
  launch_id             TEXT,
  name                  TEXT,
  symbol                TEXT,
  decimals              INTEGER,
  creator_address       TEXT,
  creator_vault_address TEXT,
  curve_address         TEXT,
  quote_asset_address   TEXT,
  created_at            TEXT,
  description           TEXT,
  image_uri             TEXT,
  metadata_uri          TEXT,
  metadata_integrity    TEXT,
  project_url           TEXT,
  source                TEXT NOT NULL DEFAULT 'LIVE',
  is_own_project        INTEGER NOT NULL DEFAULT 0,
  first_seen_at         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_run_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_launches_creator ON launches(creator_address);
CREATE INDEX IF NOT EXISTS idx_launches_created_at ON launches(created_at);

CREATE TABLE IF NOT EXISTS market_snapshots (
  snapshot_id              TEXT PRIMARY KEY,
  token_address            TEXT NOT NULL,
  observed_at              TEXT NOT NULL,
  as_of_block              TEXT,
  run_id                   TEXT,
  lifecycle                TEXT,
  progress_bps             INTEGER,
  tokens_sold_base_units   TEXT,
  net_raised_wei           TEXT,
  net_target_wei           TEXT,
  last_price_wei_per_token TEXT,
  volume_1h_wei            TEXT,
  volume_24h_wei           TEXT,
  price_change_1h_bps      TEXT,
  price_change_24h_bps     TEXT,
  buy_count_1h             INTEGER,
  sell_count_1h            INTEGER,
  unique_buyers_1h         INTEGER,
  holder_count             INTEGER,
  analytics_status         TEXT,
  UNIQUE(token_address, as_of_block)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_token_time ON market_snapshots(token_address, observed_at);

CREATE TABLE IF NOT EXISTS creators (
  creator_address                TEXT PRIMARY KEY,
  first_observed_at              TEXT,
  latest_observed_at             TEXT,
  total_launches_tracked         INTEGER NOT NULL DEFAULT 0,
  best_ath_price_wei_observed    TEXT,
  best_ath_token_address_observed TEXT,
  official_rank_alltime          INTEGER,
  official_launch_count_alltime  INTEGER,
  official_rank_season           INTEGER,
  official_launch_count_season   INTEGER,
  official_pace_label            TEXT,
  official_source                TEXT,
  official_fetched_at            TEXT,
  updated_at                     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  token_address         TEXT NOT NULL,
  computed_at           TEXT NOT NULL,
  run_id                TEXT,
  status                TEXT NOT NULL,
  score                 INTEGER NOT NULL,
  earlyness_component   INTEGER,
  momentum_component    INTEGER,
  activity_component    INTEGER,
  creator_component     INTEGER,
  confidence_component  INTEGER,
  flags_json            TEXT,
  breakdown_json        TEXT,
  thresholds_version    TEXT,
  PRIMARY KEY(token_address, computed_at)
);
CREATE INDEX IF NOT EXISTS idx_scores_token_time ON scores(token_address, computed_at);

CREATE TABLE IF NOT EXISTS holder_enrichment (
  token_address              TEXT NOT NULL,
  observed_at                TEXT NOT NULL,
  run_id                     TEXT,
  holder_count_returned      INTEGER,
  protocol_excluded_count    INTEGER,
  top1_address                TEXT,
  top1_share_bps              INTEGER,
  top1_excluded_as_protocol   INTEGER,
  top_nonprotocol_share_bps   INTEGER,
  top3_nonprotocol_share_bps  INTEGER,
  top5_nonprotocol_share_bps  INTEGER,
  concentration_flags_json    TEXT,
  PRIMARY KEY(token_address, observed_at)
);

CREATE TABLE IF NOT EXISTS activity_enrichment (
  token_address           TEXT NOT NULL,
  observed_at             TEXT NOT NULL,
  run_id                  TEXT,
  trade_count_returned    INTEGER,
  buy_count               INTEGER,
  sell_count              INTEGER,
  unique_buyers           INTEGER,
  unique_sellers          INTEGER,
  last_trade_occurred_at  TEXT,
  last_trade_age_seconds  REAL,
  buy_count_acceleration  INTEGER,
  PRIMARY KEY(token_address, observed_at)
);
